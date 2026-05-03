import type { Logger } from "pino";
import { escapeMarkdownV2 } from "./format.js";
import type { OpencodeClient } from "./opencode-client.js";

export interface PermissionBot {
  sendMessage(
    chatId: number,
    text: string,
    opts: {
      parse_mode: "MarkdownV2";
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    },
  ): Promise<{ message_id: number }>;

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode: "MarkdownV2" },
  ): Promise<unknown>;

  answerCallbackQuery(id: string, opts?: { text?: string }): Promise<unknown>;
}

/**
 * Shape of the `permission.asked` (and legacy `permission.updated`) event
 * payload from opencode 1.14.32. Fields beyond `id` are best-effort —
 * opencode may add more in future versions.
 *
 * Real example:
 *   {
 *     id: "per_...",
 *     sessionID: "ses_...",
 *     permission: "bash",
 *     patterns: ["pwd"],
 *     metadata: {},
 *     always: ["pwd *"],
 *     tool: { messageID, callID }
 *   }
 */
export interface PermissionRequest {
  id: string;
  sessionID?: string;
  /** Permission type, e.g. "bash" / "webfetch". */
  permission?: string;
  /** What's being asked, e.g. ["pwd"] or ["https://example.com/foo"]. */
  patterns?: string[];
  /** Pattern that "Always" would extend permission to (e.g. "pwd *"). */
  always?: string[];
  /** Legacy/SDK field name for `permission`. */
  type?: string;
  /** Legacy human-readable title (older opencode versions). */
  title?: string;
  /** Extra structured input (older opencode versions). */
  input?: unknown;
  /** Tool call context. */
  tool?: { messageID?: string; callID?: string };
  metadata?: Record<string, unknown>;
}

export interface CallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

export interface PermissionServiceOptions {
  timeoutMs: number;
  /**
   * Optional logger for diagnostic output. Highly recommended in
   * production — silent failures here are very hard to debug otherwise.
   */
  log?: Pick<Logger, "info" | "warn" | "error">;
}

interface Pending {
  sessionId: string;
  chatId: number;
  messageId: number;
  timer: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

export class PermissionService {
  private pending = new Map<string, Pending>();

  constructor(
    private bot: PermissionBot,
    private client: OpencodeClient,
    private options: PermissionServiceOptions,
  ) {}

  async sendRequest(chatId: number, sessionId: string, perm: PermissionRequest): Promise<void> {
    const text = renderPermissionPrompt(perm);
    this.options.log?.info(
      { chatId, sessionId, permId: perm.id, kind: perm.permission ?? perm.type, textLen: text.length },
      "sending permission prompt to telegram",
    );
    let sent: { message_id: number };
    try {
      sent = await this.bot.sendMessage(chatId, text, {
        parse_mode: "MarkdownV2",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Once", callback_data: `perm:${perm.id}:once` },
              { text: "✓ Always", callback_data: `perm:${perm.id}:always` },
              { text: "❌ Deny", callback_data: `perm:${perm.id}:deny` },
            ],
          ],
        },
      });
    } catch (err) {
      this.options.log?.error(
        { chatId, sessionId, permId: perm.id, err: err instanceof Error ? err.message : String(err) },
        "bot.sendMessage failed for permission prompt",
      );
      throw err;
    }
    this.options.log?.info(
      { chatId, sessionId, permId: perm.id, messageId: sent.message_id },
      "permission prompt sent",
    );

    const timer = setTimeout(() => {
      void this.autoDeny(perm.id);
    }, this.options.timeoutMs);

    this.pending.set(perm.id, {
      sessionId,
      chatId,
      messageId: sent.message_id,
      timer,
      resolved: false,
    });
  }

  async handleCallback(cb: CallbackQuery): Promise<void> {
    const data = cb.data ?? "";
    if (!data.startsWith("perm:")) return;
    const parts = data.split(":");
    if (parts.length !== 3) return;
    const [, permId, action] = parts as [string, string, string];

    const entry = this.pending.get(permId);
    if (!entry || entry.resolved) {
      await this.bot.answerCallbackQuery(cb.id, { text: "Already responded" }).catch(() => {});
      return;
    }
    entry.resolved = true;
    clearTimeout(entry.timer);

    let response: "allow" | "deny";
    let remember = false;
    if (action === "once") {
      response = "allow";
    } else if (action === "always") {
      response = "allow";
      remember = true;
    } else if (action === "deny") {
      response = "deny";
    } else {
      return;
    }

    try {
      await this.client.respondToPermission(entry.sessionId, permId, response, remember);
    } finally {
      const status =
        response === "allow" ? (remember ? "✓ Allowed (always)" : "✅ Allowed once") : "❌ Denied";
      await this.bot
        .editMessageText(entry.chatId, entry.messageId, escapeMarkdownV2(status), {
          parse_mode: "MarkdownV2",
        })
        .catch(() => undefined);
      await this.bot.answerCallbackQuery(cb.id).catch(() => undefined);
      this.pending.delete(permId);
    }
  }

  private async autoDeny(permId: string): Promise<void> {
    const entry = this.pending.get(permId);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    try {
      await this.client.respondToPermission(entry.sessionId, permId, "deny", false);
    } finally {
      await this.bot
        .editMessageText(
          entry.chatId,
          entry.messageId,
          escapeMarkdownV2("⏱ Timed out — denied"),
          { parse_mode: "MarkdownV2" },
        )
        .catch(() => undefined);
      this.pending.delete(permId);
    }
  }
}

/**
 * Build the user-facing prompt text for a permission request.
 *
 * opencode emits structured fields (`permission`, `patterns`, `always`),
 * but older versions used `title`/`type`/`input`. We try the new fields
 * first, fall back to the legacy `title`, and finally use a generic
 * label when neither is present.
 *
 * Output is MarkdownV2-escaped and ready to send.
 */
export function renderPermissionPrompt(perm: PermissionRequest): string {
  const kind = perm.permission ?? perm.type;
  const lines: string[] = [];
  // Header
  if (kind) {
    lines.push(`🔐 *${escapeMarkdownV2(`Permission requested: ${kind}`)}*`);
  } else if (perm.title) {
    lines.push(`🔐 *${escapeMarkdownV2(perm.title)}*`);
  } else {
    lines.push(`🔐 *${escapeMarkdownV2("Permission requested")}*`);
  }
  // What's being asked (specific patterns)
  if (perm.patterns && perm.patterns.length > 0) {
    for (const p of perm.patterns) {
      lines.push("`" + p.replace(/`/g, "\\`") + "`");
    }
  }
  // What "Always" would extend to (informational)
  if (perm.always && perm.always.length > 0) {
    const allowsLabel = `Always allows: ${perm.always.join(", ")}`;
    lines.push("_" + escapeMarkdownV2(allowsLabel) + "_");
  }
  return lines.join("\n");
}
