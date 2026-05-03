import type { Context } from "grammy";
import { escapeMarkdownV2 } from "./format.js";
import { Turn, type TurnBot } from "./turn.js";
import { describeError } from "./errors.js";
import { parseModelId } from "./config.js";
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
  /**
   * Default model used when the chat has no per-chat model override.
   * Format: "<providerID>/<modelID>" (e.g. "anthropic/claude-sonnet-4-5").
   */
  defaultModel: string;
}

interface IncomingTextPart {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  state?: { status: string; input?: unknown; output?: string };
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

  // Resolve the effective model: per-chat override → bridge-wide default.
  // We always pass *something* — letting opencode pick its own default lands
  // on whatever provider's first model alphabetically, which may not match
  // the auth account the bridge has.
  const effectiveModelId = stateRow.model ?? deps.defaultModel;
  const model = parseModelId(effectiveModelId);
  try {
    await deps.client.prompt(sessionId, text, {
      ...(model ? { model } : {}),
      directory: stateRow.projectPath,
    });
  } catch (err) {
    const msg = describeError(err);
    await turn.showError(`prompt failed: ${msg}`);
    if (!unregistered) {
      unregistered = true;
      unregister();
    }
  }
}
