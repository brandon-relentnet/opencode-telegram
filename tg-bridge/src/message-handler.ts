import type { Context } from "grammy";
import type { Logger } from "pino";
import { escapeMarkdownV2 } from "./format.js";
import { Turn, type TurnBot } from "./turn.js";
import { describeError } from "./errors.js";
import { parseModelId } from "./config.js";
import { reactProcessing, reactDone, reactFailed } from "./reactions.js";
import type { OpencodeClient } from "./opencode-client.js";
import type { ChatStateRepo } from "./chat-state.js";
import type { SessionEventHandler } from "./event-router.js";
import type { PermissionService } from "./permissions.js";
import type { PinnedStatusDeps } from "./pinned-status.js";
import { ActiveTurns } from "./active-turns.js";

export interface MessageHandlerDeps {
  state: ChatStateRepo;
  client: OpencodeClient;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
  };
  permissions: Pick<PermissionService, "sendRequest">;
  /**
   * Question service for rendering opencode's question tool calls as
   * Telegram inline keyboards. The handler forwards onQuestionAsked /
   * onQuestionReplied / onQuestionRejected here.
   */
  questions: {
    sendRequest(chatId: number, req: unknown): Promise<void>;
    notifyReplied(payload: unknown): Promise<void>;
    notifyRejected(payload: unknown): Promise<void>;
  };
  bot: TurnBot;
  /**
   * Default model used when the chat has no per-chat model override.
   * Format: "<providerID>/<modelID>" (e.g. "anthropic/claude-sonnet-4-5").
   */
  defaultModel: string;
  /**
   * Pinned-status manager. Each turn lifecycle event (receive / idle /
   * error) drives a status update so the pinned message reflects current
   * activity. Optional so tests that don't care about the pinned message
   * can omit it; the call sites no-op when undefined.
   */
  pinnedStatus?: PinnedStatusDeps;
  /**
   * Optional logger. When present, the handler logs permission-event
   * receipts and any errors that occur dispatching them. Without this,
   * silent failures in permission delivery are very hard to debug.
   */
  log?: Pick<Logger, "info" | "warn" | "error">;
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
  // Capture the user's message id up-front so we can react to it on receipt
  // and again on completion. Reactions are best-effort UX; the helpers
  // swallow failures internally so we don't need to await them.
  const userMessageId = ctx.message!.message_id;

  const stateRow = deps.state.get(chatId);
  if (!stateRow?.projectPath || !stateRow.sessionId) {
    await ctx.reply(
      escapeMarkdownV2("No active session. Use /projects then /switch <name>."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  // 👍 — acknowledge receipt immediately. Done before any heavy work so the
  // user gets feedback even if opencode is slow to respond.
  void reactProcessing(deps.bot as never, chatId, userMessageId, deps.log);

  // Flip the pinned status to "Working" with a short preview of the prompt
  // so the chat header reflects the in-flight turn. PSM debounces edits
  // internally; calling here is fire-and-forget by design.
  deps.pinnedStatus?.setWorking(chatId, text.slice(0, 60));

  const placeholder = await ctx.reply(escapeMarkdownV2("thinking…"), {
    parse_mode: "MarkdownV2",
  });
  const placeholderId =
    typeof (placeholder as { message_id?: number }).message_id === "number"
      ? (placeholder as { message_id: number }).message_id
      : 0;

  const sessionId = stateRow.sessionId;
  // C2: pass cancelCallbackData so every streaming-view edit attaches the
  // [⏹ Cancel] inline keyboard. The button's callback_data is consumed
  // by the `cancel:` route in index.ts, which looks up this Turn via the
  // ActiveTurns registry below.
  const turn = new Turn(deps.bot, chatId, placeholderId, {
    cancelCallbackData: `cancel:${sessionId}`,
  });
  // Register the in-flight Turn so the cancel-button callback can find it.
  // Removed from the map in every terminal branch (idle / error / prompt
  // failure) so the registry tracks only currently-cancellable turns.
  ActiveTurns.set(sessionId, { turn, chatId, userMessageId });
  let unregistered = false;

  // Track message IDs that opencode tags with role="user" so we can filter
  // the user's echoed prompt out of the assistant's final view. opencode's
  // promptAsync creates a user message containing the prompt text BEFORE
  // emitting events for the assistant's response, and that user message's
  // text parts arrive via the same `message.part.updated` stream.
  const userMessageIds = new Set<string>();

  const handler: SessionEventHandler = {
    onMessageCreated(msg) {
      const m = msg as { info?: { id?: string; role?: string } };
      if (m.info?.role === "user" && typeof m.info.id === "string") {
        userMessageIds.add(m.info.id);
      }
    },
    onPartUpdated(part) {
      const p = part as IncomingTextPart;
      if (typeof p.id === "string") turn.appendPart(p);
    },
    onSessionStatus(properties) {
      const status = (properties as { status?: unknown }).status;
      if (status) turn.setSessionStatus(status);
    },
    async onIdle() {
      try {
        await turn.finalize({ userMessageIds });
      } catch (err) {
        deps.log?.error?.(
          { chatId, sessionId, err: describeError(err) },
          "turn.finalize threw despite safeEdit/safeSend wrappers",
        );
      }
      // ✅ — turn finalized successfully. Replaces the prior 👍.
      void reactDone(deps.bot as never, chatId, userMessageId, deps.log);
      // Flip the pinned status back to Idle now that the turn finished.
      deps.pinnedStatus?.setIdle(chatId);
      // Drop from the cancel registry — turn is no longer cancellable.
      ActiveTurns.delete(sessionId);
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    async onError(err) {
      const msg = describeError(err);
      try {
        await turn.showError(msg);
      } catch (showErr) {
        deps.log?.error?.(
          { chatId, sessionId, err: describeError(showErr) },
          "turn.showError threw",
        );
      }
      // ❌ — session-level error. Replaces the prior 👍.
      void reactFailed(deps.bot as never, chatId, userMessageId, deps.log);
      // Surface the failure on the pinned message too. Truncate to 80 chars
      // to keep the line skim-readable in the pinned header.
      deps.pinnedStatus?.setFailed(chatId, msg.slice(0, 80));
      ActiveTurns.delete(sessionId);
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    onPermissionUpdated(perm) {
      // Log receipt so silent permission delivery failures aren't a mystery.
      // We `.catch` instead of `void` so rejections from sendRequest land in
      // the bridge log rather than as unhandled promise rejections.
      const permId = (perm as { id?: string })?.id;
      deps.log?.info({ chatId, sessionId, permId }, "permission event received");
      deps.permissions
        .sendRequest(chatId, sessionId, perm as never)
        .catch((err) => {
          deps.log?.error(
            { chatId, sessionId, permId, err: describeError(err) },
            "failed to send permission prompt to telegram",
          );
        });
    },
    onQuestionAsked(req) {
      const requestId = (req as { id?: string })?.id;
      deps.log?.info?.({ chatId, sessionId, requestId }, "question.asked event received");
      deps.questions
        .sendRequest(chatId, req)
        .catch((err) => {
          deps.log?.error?.(
            { chatId, sessionId, requestId, err: describeError(err) },
            "questions.sendRequest failed",
          );
        });
    },
    onQuestionReplied(payload) {
      const requestId = (payload as { requestID?: string })?.requestID;
      deps.log?.info?.({ chatId, sessionId, requestId }, "question.replied event received");
      deps.questions.notifyReplied(payload).catch((err) => {
        deps.log?.error?.(
          { chatId, sessionId, requestId, err: describeError(err) },
          "questions.notifyReplied failed",
        );
      });
    },
    onQuestionRejected(payload) {
      const requestId = (payload as { requestID?: string })?.requestID;
      deps.log?.info?.({ chatId, sessionId, requestId }, "question.rejected event received");
      deps.questions.notifyRejected(payload).catch((err) => {
        deps.log?.error?.(
          { chatId, sessionId, requestId, err: describeError(err) },
          "questions.notifyRejected failed",
        );
      });
    },
  };

  const unregister = deps.router.registerSession(sessionId, handler);

  // Resolve the effective model: per-chat override → bridge-wide default.
  // We always pass *something* — letting opencode pick its own default lands
  // on whatever provider's first model alphabetically, which may not match
  // the auth account the bridge has.
  const effectiveModelId = stateRow.model ?? deps.defaultModel;
  const model = parseModelId(effectiveModelId);

  // Fire-and-forget the prompt request. SSE events drive UI updates via the
  // registered handler; onIdle handles success cleanup; the .catch handles
  // network/HTTP errors.
  //
  // We MUST NOT await this. grammy processes updates sequentially by default,
  // so an awaited prompt would block every other update — including the
  // user's permission button presses — until opencode's response returns.
  // For prompts that need permission, opencode pauses waiting for the
  // permission response, which is itself blocked behind the held-up
  // callback_query. That's a perfect deadlock that produces "button glows
  // for 20 seconds and then stops" because Telegram times out the callback.
  deps.client
    .prompt(sessionId, text, {
      ...(model ? { model } : {}),
      directory: stateRow.projectPath,
    })
    .catch(async (err) => {
      const msg = describeError(err);
      try {
        await turn.showError(`prompt failed: ${msg}`);
      } finally {
        // ❌ — network/HTTP error before opencode emitted any events.
        void reactFailed(deps.bot as never, chatId, userMessageId, deps.log);
        deps.pinnedStatus?.setFailed(chatId, msg.slice(0, 80));
        ActiveTurns.delete(sessionId);
        if (!unregistered) {
          unregistered = true;
          unregister();
        }
      }
    });
}
