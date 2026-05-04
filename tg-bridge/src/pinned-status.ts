import type { Logger } from "pino";
import { escapeHtml } from "./markdown-to-html.js";
import type { ChatStateRepo } from "./chat-state.js";

export interface PinnedStatusBot {
  api: {
    sendMessage(chatId: number, text: string, opts: object): Promise<{ message_id: number }>;
    editMessageText(chatId: number, messageId: number, text: string, opts: object): Promise<unknown>;
    pinChatMessage(chatId: number, messageId: number, opts?: object): Promise<unknown>;
    unpinChatMessage(chatId: number, messageId: number): Promise<unknown>;
  };
}

export type StatusKind = "idle" | "working" | "failed" | "aborted";

interface LiveState {
  status: StatusKind;
  statusDetail: string | null;
  lastActivityAt: number;
}

interface Options {
  debounceMs?: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export class PinnedStatusManager {
  private live = new Map<number, LiveState>();
  private timers = new Map<number, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly log: Options["log"];

  constructor(
    private bot: PinnedStatusBot,
    private repo: ChatStateRepo,
    options: Options = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1000;
    this.log = options.log;
  }

  setIdle(chatId: number, detail?: string): void {
    this.live.set(chatId, {
      status: "idle",
      statusDetail: detail ?? null,
      lastActivityAt: Date.now(),
    });
    this.schedule(chatId);
  }

  setWorking(chatId: number, detail: string): void {
    this.live.set(chatId, {
      status: "working",
      statusDetail: detail,
      lastActivityAt: Date.now(),
    });
    this.schedule(chatId);
  }

  setFailed(chatId: number, detail: string): void {
    this.live.set(chatId, {
      status: "failed",
      statusDetail: detail,
      lastActivityAt: Date.now(),
    });
    this.schedule(chatId);
  }

  setAborted(chatId: number): void {
    this.live.set(chatId, {
      status: "aborted",
      statusDetail: null,
      lastActivityAt: Date.now(),
    });
    this.schedule(chatId);
  }

  /**
   * Called by chat-state mutation hooks (project/session/model/coolify
   * changes) to refresh the pinned status without altering live status.
   */
  notifyStateChange(chatId: number): void {
    this.schedule(chatId);
  }

  async enablePin(chatId: number): Promise<void> {
    this.repo.setPinPaused(chatId, false);
    // Force a fresh message + pin
    const live = this.live.get(chatId) ?? {
      status: "idle" as const,
      statusDetail: null,
      lastActivityAt: Date.now(),
    };
    this.live.set(chatId, live);
    await this.createAndPin(chatId);
  }

  async pausePin(chatId: number): Promise<void> {
    this.repo.setPinPaused(chatId, true);
  }

  async flushNow(chatId: number): Promise<void> {
    const t = this.timers.get(chatId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(chatId);
    }
    await this.flush(chatId);
  }

  private schedule(chatId: number): void {
    // Always go through setTimeout (even when debounceMs === 0) so that
    // flushNow() can deterministically cancel a pending flush. This avoids
    // a race where setIdle() fires an in-flight flush() that interleaves
    // with a subsequent await flushNow() and produces a duplicate send.
    const existing = this.timers.get(chatId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      chatId,
      setTimeout(() => {
        this.timers.delete(chatId);
        void this.flush(chatId);
      }, this.debounceMs),
    );
  }

  private async flush(chatId: number): Promise<void> {
    if (this.repo.getPinPaused(chatId)) return;
    const text = this.renderStatus(chatId);
    const pinnedId = this.repo.getPinnedMessageId(chatId);
    if (pinnedId == null) {
      await this.createAndPin(chatId);
      return;
    }
    try {
      await this.bot.api.editMessageText(chatId, pinnedId, text, {
        parse_mode: "HTML",
        reply_markup: this.buildKeyboard(),
      });
    } catch (err) {
      this.log?.warn?.(
        { err, chatId, pinnedId },
        "edit pinned status failed; recreating",
      );
      await this.createAndPin(chatId);
    }
  }

  private async createAndPin(chatId: number): Promise<void> {
    const text = this.renderStatus(chatId);
    let msgId: number;
    try {
      const sent = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: this.buildKeyboard(),
        disable_notification: true,
      });
      msgId = sent.message_id;
    } catch (err) {
      this.log?.warn?.(
        { err, chatId },
        "sendMessage for pinned status failed; pausing pin",
      );
      this.repo.setPinPaused(chatId, true);
      return;
    }
    try {
      await this.bot.api.pinChatMessage(chatId, msgId, {
        disable_notification: true,
      });
      this.repo.setPinnedMessageId(chatId, msgId);
    } catch (err) {
      this.log?.warn?.(
        { err, chatId, msgId },
        "pinChatMessage failed; pausing pin",
      );
      this.repo.setPinPaused(chatId, true);
    }
  }

  private renderStatus(chatId: number): string {
    const row = this.repo.get(chatId);
    const live =
      this.live.get(chatId) ?? {
        status: "idle" as StatusKind,
        statusDetail: null,
        lastActivityAt: Date.now(),
      };
    const projectName = row?.projectPath
      ? row.projectPath.split("/").pop() ?? "(none)"
      : "(none)";
    const sessionId = row?.sessionId ?? "(none)";
    const model = row?.model ?? "(default)";
    const coolify = row?.projectPath
      ? this.repo.getCoolifyApp(chatId, row.projectPath)
      : null;
    const elapsedMin = Math.floor((Date.now() - live.lastActivityAt) / 60000);

    const statusEmoji = { idle: "🟢", working: "⏳", failed: "❌", aborted: "⏸" }[
      live.status
    ];
    const statusLabel = {
      idle: "Idle",
      working: "Working",
      failed: "Failed",
      aborted: "Aborted",
    }[live.status];

    const lines: string[] = [];
    lines.push(
      `<b>${statusEmoji} ${statusLabel} · ${escapeHtml(projectName)}</b>`,
    );
    if (live.statusDetail) {
      lines.push(`<i>${escapeHtml(live.statusDetail)}</i>`);
    }
    lines.push(`<i>Session</i>: <code>${escapeHtml(sessionId)}</code>`);
    lines.push(`<i>Model</i>: <code>${escapeHtml(model)}</code>`);
    if (coolify) {
      lines.push(
        `<i>Deploy</i>: ✅ <a href="https://${escapeHtml(coolify.fqdn)}">${escapeHtml(coolify.fqdn)}</a>`,
      );
    }
    lines.push(
      `<i>Last activity</i>: ${elapsedMin === 0 ? "just now" : `${elapsedMin} min ago`}`,
    );
    return lines.join("\n");
  }

  private buildKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: "Switch project", callback_data: "pin:switch" },
          { text: "Sessions", callback_data: "pin:sessions" },
        ],
        [
          { text: "New session", callback_data: "pin:new" },
          { text: "Models", callback_data: "pin:models" },
        ],
        [{ text: "Deploy", callback_data: "pin:deploy" }],
      ],
    };
  }
}
