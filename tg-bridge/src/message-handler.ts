import type { Context } from "grammy";
import { escapeMarkdownV2 } from "./format.js";
import { Turn, type TurnBot } from "./turn.js";
import type { OpencodeClient } from "./opencode-client.js";
import type { ChatStateRepo } from "./chat-state.js";
import type { SessionEventHandler } from "./event-router.js";
import type { PermissionService } from "./permissions.js";

export interface MessageHandlerDeps {
  state: ChatStateRepo;
  client: OpencodeClient;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
  };
  permissions: Pick<PermissionService, "sendRequest">;
  bot: TurnBot;
}

interface IncomingTextPart {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  state?: { status: string; input?: unknown; output?: string };
}

/**
 * Convert any thrown value into a human-readable string. The opencode SDK
 * rejects with discriminated-union plain objects (e.g. `ApiError`) that are
 * not `Error` instances, so `String(err)` produces "[object Object]".
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

function parseModel(modelId: string): { providerID: string; modelID: string } | undefined {
  const idx = modelId.indexOf("/");
  if (idx <= 0 || idx === modelId.length - 1) return undefined;
  return { providerID: modelId.slice(0, idx), modelID: modelId.slice(idx + 1) };
}

export async function handleTextMessage(ctx: Context, deps: MessageHandlerDeps): Promise<void> {
  const text = ctx.message?.text;
  if (typeof text !== "string" || text.startsWith("/")) return;

  const chatId = ctx.chat!.id;
  const stateRow = deps.state.get(chatId);
  if (!stateRow?.projectPath || !stateRow.sessionId) {
    await ctx.reply(
      escapeMarkdownV2("No active session. Use /projects then /switch <name>."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  const placeholder = await ctx.reply(escapeMarkdownV2("thinking…"), {
    parse_mode: "MarkdownV2",
  });
  const placeholderId =
    typeof (placeholder as { message_id?: number }).message_id === "number"
      ? (placeholder as { message_id: number }).message_id
      : 0;

  const turn = new Turn(deps.bot, chatId, placeholderId);
  const sessionId = stateRow.sessionId;
  let unregistered = false;

  const handler: SessionEventHandler = {
    onPartUpdated(part) {
      const p = part as IncomingTextPart;
      if (typeof p.id === "string") turn.appendPart(p);
    },
    async onIdle() {
      await turn.finalize();
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    async onError(err) {
      const msg = describeError(err);
      await turn.showError(msg);
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    onPermissionUpdated(perm) {
      void deps.permissions.sendRequest(chatId, sessionId, perm as never);
    },
  };

  const unregister = deps.router.registerSession(sessionId, handler);

  const model = stateRow.model ? parseModel(stateRow.model) : undefined;
  try {
    await deps.client.prompt(sessionId, text, model ? { model } : undefined);
  } catch (err) {
    const msg = describeError(err);
    await turn.showError(`prompt failed: ${msg}`);
    if (!unregistered) {
      unregistered = true;
      unregister();
    }
  }
}
