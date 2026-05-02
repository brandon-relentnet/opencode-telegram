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

export interface PermissionRequest {
  id: string;
  sessionID?: string;
  title?: string;
  type?: string;
  input?: unknown;
}

export interface CallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

export interface PermissionServiceOptions {
  timeoutMs: number;
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
    const title = perm.title ?? `Permission requested${perm.type ? ` (${perm.type})` : ""}`;
    const text = `🔐 ${escapeMarkdownV2(title)}`;
    const sent = await this.bot.sendMessage(chatId, text, {
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
