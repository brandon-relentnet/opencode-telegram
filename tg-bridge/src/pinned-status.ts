import type { Logger } from "pino";
import type { ChatStateRepo } from "./chat-state.js";
import { getCurrentBranch, getGitInfo } from "./branch-info.js";
import { renderPinnedStatus, type PinnedStatusState } from "./format.js";

export interface PinnedStatusBot {
  api: {
    sendMessage(chatId: number, text: string, opts: object): Promise<{ message_id: number }>;
    editMessageText(chatId: number, messageId: number, text: string, opts: object): Promise<unknown>;
    pinChatMessage(chatId: number, messageId: number, opts?: object): Promise<unknown>;
    unpinChatMessage(chatId: number, messageId: number): Promise<unknown>;
  };
}

export type StatusKind = "idle" | "working" | "failed" | "aborted";

/**
 * Narrow surface PSM exposes to slash-command handlers and the message
 * handler. Deps interfaces depend on this rather than the full
 * PinnedStatusManager class so test fixtures don't have to instantiate a
 * real manager (with debounce timers + a Telegram bot stub).
 */
export interface PinnedStatusDeps {
  setIdle(chatId: number, detail?: string): void;
  setWorking(chatId: number, detail: string): void;
  setFailed(chatId: number, detail: string): void;
  setAborted(chatId: number): void;
  notifyStateChange(chatId: number): void;
}

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
    const text = await this.renderStatus(chatId);
    const pinnedId = this.repo.getPinnedMessageId(chatId);
    if (pinnedId == null) {
      await this.createAndPin(chatId, text);
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
      await this.createAndPin(chatId, text);
    }
  }

  private async createAndPin(chatId: number, prerendered?: string): Promise<void> {
    const text = prerendered ?? (await this.renderStatus(chatId));
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

  /**
   * Build the 5-line pinned-status HTML by reading chat_state and
   * refreshing the branch + git info from disk. Branch is also persisted
   * back to chat_state so the next `/info` invocation can render it
   * without another shell-out.
   */
  private async renderStatus(chatId: number): Promise<string> {
    const row = this.repo.get(chatId);
    const projectPath = row?.projectPath ?? null;
    const projectName = projectPath
      ? projectPath.split("/").pop() ?? "(none)"
      : "(none)";

    // Refresh branch + git info from disk (cached 5s by branch-info).
    // Wrapped in try/catch so a transient git failure doesn't break the
    // pinned flush — fall through to "no git" rendering.
    let branch: string | null = null;
    let ahead = 0;
    let dirty = 0;
    if (projectPath) {
      try {
        branch = await getCurrentBranch(projectPath);
        const info = await getGitInfo(projectPath);
        ahead = info.ahead;
        dirty = info.status.modified + info.status.untracked;
      } catch (err) {
        this.log?.warn?.({ err, projectPath }, "branch-info failed; rendering without git");
      }
      // Persist live branch so /info and other consumers can read it.
      this.repo.setBranch(chatId, branch);
    }

    const stats = this.repo.getCumulativeStats(chatId);
    const tokensUsed = stats.tokensInput + stats.tokensOutput;

    const coolify = projectPath
      ? this.repo.getCoolifyApp(chatId, projectPath)
      : null;

    const state: PinnedStatusState = {
      projectName,
      branch,
      agentMode: this.repo.getAgentMode(chatId),
      modelId: row?.model ?? null,
      // tokensUsed > 0 → render real number; 0 → null so the renderer shows
      // an em-dash on the very first turn (before any assistant message).
      tokensUsed: tokensUsed > 0 ? tokensUsed : null,
      contextLimit: this.repo.getContextLimit(chatId),
      // Same em-dash treatment for cost: 0 micros pre-first-turn looks like
      // "$0.00" which is misleading on metered providers.
      costMicros: stats.costMicros > 0 ? stats.costMicros : null,
      coolifyFqdn: coolify?.fqdn ?? null,
      lastDeployAgo: this.formatDeployAgo(this.repo.getLastDeployAt(chatId)),
      ahead,
      dirty,
    };
    return renderPinnedStatus(state);
  }

  /**
   * Render a "12m ago" / "2h ago" / "just now" relative timestamp from a
   * unix-ms value, or null when the deploy time is unknown.
   */
  private formatDeployAgo(ts: number | null): string | null {
    if (ts == null) return null;
    const ageMs = Date.now() - ts;
    if (ageMs < 60_000) return "just now";
    const min = Math.floor(ageMs / 60_000);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  }

  /**
   * Compact 4-button row for the pinned message inline keyboard:
   *   [Sessions] [Model] [Deploy] [Info]
   *
   * Drops [Switch project] (use Sessions with project context) and
   * [New session] (less common — user can type /new). Adds [Info]
   * which routes to the new /info command (Task 8).
   */
  private buildKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: "Sessions", callback_data: "pin:sessions" },
          { text: "Model", callback_data: "pin:model" },
          { text: "Deploy", callback_data: "pin:deploy" },
          { text: "Info", callback_data: "pin:info" },
        ],
      ],
    };
  }
}
