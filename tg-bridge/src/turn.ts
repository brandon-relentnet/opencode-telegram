import { renderStreamingView, renderFinalView, escapeMarkdownV2, type RenderablePart } from "./format.js";
import { chunkForTelegram } from "./chunker.js";
import { safeEdit, safeSend } from "./safe-telegram.js";

export interface TurnBot {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode?: "MarkdownV2" | "HTML" },
  ): Promise<unknown>;
  sendMessage(
    chatId: number,
    text: string,
    opts: { parse_mode?: "MarkdownV2" | "HTML" },
  ): Promise<{ message_id: number }>;
}

export interface IncomingPart {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  state?: { status: string; input?: unknown; output?: string };
}

export interface TurnOptions {
  throttleMs?: number;
  /**
   * Idle watchdog: if no `appendPart` activity arrives for this long, the
   * Turn assumes opencode's `session.idle` event was lost (e.g. SSE stream
   * dropped mid-turn) and self-finalizes. Default 60s. Reset on every part.
   */
  idleWatchdogMs?: number;
  /**
   * Heartbeat interval (C1): once at least one part has arrived, refresh
   * the streaming-view placeholder every `heartbeatMs` so the user sees the
   * elapsed-time counter advance ("_thinking · 12s elapsed_"). Distinct
   * from the watchdog: heartbeat fires repeatedly during activity, the
   * watchdog fires once after total silence. Default 10s.
   */
  heartbeatMs?: number;
}

export class Turn {
  private parts: Map<string, IncomingPart> = new Map();
  private partOrder: string[] = [];
  // Initialized to construction time so the very first edit is throttled by
  // `throttleMs`, matching the spec ("absorbs rapid updates into a single
  // edit per throttle window"). Without this, the first scheduleEdit sees
  // `lastEditAt = 0` and computes `delay = max(0, throttleMs - Date.now())`
  // which collapses to 0, causing an immediate edit.
  private lastEditAt: number;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private inFlightEdit: Promise<void> | null = null;
  private throttleMs: number;
  private readonly idleWatchdogMs: number;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeatMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt: number;

  constructor(
    private bot: TurnBot,
    private chatId: number,
    private placeholderMessageId: number,
    options: TurnOptions = {},
  ) {
    this.throttleMs = options.throttleMs ?? 1000;
    this.idleWatchdogMs = options.idleWatchdogMs ?? 60_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.startedAt = Date.now();
    this.lastEditAt = this.startedAt;
  }

  appendPart(part: IncomingPart): void {
    if (this.finalized) return;
    if (!this.parts.has(part.id)) this.partOrder.push(part.id);
    this.parts.set(part.id, part);
    this.scheduleEdit();
    this.resetWatchdog();
    this.ensureHeartbeat();
  }

  async showError(error: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    this.cancelWatchdog();
    this.cancelHeartbeat();
    // showError uses MarkdownV2 (matches the escaping applied to `error`).
    // Final-view edits switched to HTML, but error placeholders are tiny
    // single-line strings produced from MarkdownV2-escaped input — keeping
    // them in MarkdownV2 mode avoids re-escaping into HTML.
    await safeEdit(
      this.bot,
      this.chatId,
      this.placeholderMessageId,
      `❌ ${escapeMarkdownV2(error)}`,
      undefined,
      "MarkdownV2",
    );
  }

  /**
   * Stop streaming + cancel any pending streaming-view edit, WITHOUT writing
   * the final view. Use this when an upstream caller (createProject's
   * performAutoSwitch, /deploy's success branches) is going to overwrite the
   * placeholder itself with a different message — without `cancel()`, a
   * queued setTimeout from `scheduleEdit` could fire AFTER that overwrite
   * and replace the upstream message with the streaming view again.
   */
  async cancel(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    this.cancelWatchdog();
    this.cancelHeartbeat();
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);
  }

  async finalize(options: { userMessageIds?: Set<string> } = {}): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    this.cancelWatchdog();
    this.cancelHeartbeat();
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);

    const text = renderFinalView(
      this.partsArray() as unknown as readonly RenderablePart[],
      options.userMessageIds ? { userMessageIds: options.userMessageIds } : {},
    );
    const chunks = chunkForTelegram(text);
    const first = chunks[0];
    // renderFinalView always returns at least "_\(no response\)_" so chunks[0] should
    // always exist; the guard is defensive against future renderer changes.
    if (!first) return;

    await safeEdit(this.bot, this.chatId, this.placeholderMessageId, first);
    // safeSend returns null on persistent failure; we deliberately ignore it
    // and continue with subsequent chunks. Partial delivery is preferred over
    // no delivery if a single chunk fails to send.
    for (const chunk of chunks.slice(1)) {
      await safeSend(this.bot, this.chatId, chunk);
    }
  }

  private scheduleEdit(): void {
    if (this.pendingTimer || this.finalized) return;
    const now = Date.now();
    const due = this.lastEditAt + this.throttleMs;
    const delay = Math.max(0, due - now);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.lastEditAt = Date.now();
      // appendPart-driven edits omit the elapsed-time suffix — fresh activity
      // already signals liveness. Only the heartbeat tick (silence path)
      // renders "_thinking · Ns elapsed_" so the user sees the counter
      // advance when no parts are arriving.
      this.inFlightEdit = this.editNow();
    }, delay);
  }

  private currentElapsedSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /**
   * Heartbeat (C1): once any part has arrived, refresh the placeholder
   * every `heartbeatMs` so the elapsed-time counter advances even when
   * opencode is silent (e.g. a long-running tool with no streamed output).
   * Idempotent — only the first appendPart starts the timer.
   *
   * The heartbeat tick re-runs `editNow` directly (not `scheduleEdit`) so
   * the elapsed-seconds bump is unconditional, not coalesced with a
   * pending throttle that might already have fired. Heartbeats are 10s
   * apart by default and the throttle is 1s, so we never collide.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.finalized) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.finalized) {
        this.cancelHeartbeat();
        return;
      }
      this.lastEditAt = Date.now();
      this.inFlightEdit = this.editNow(this.currentElapsedSeconds());
    }, this.heartbeatMs);
  }

  private cancelHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cancelTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  /**
   * Idle watchdog: defends against the stuck-on-thinking class of bug.
   * Live opencode SSE streams sometimes drop mid-turn (observed: repeated
   * `terminated: other side closed` reconnect storms). When that happens
   * the `session.idle` event is emitted on the dead connection and never
   * reaches us, so the placeholder hangs at "_thinking…_" forever.
   *
   * Reset on every `appendPart` so an active stream is never cut off
   * prematurely. If no part arrives for `idleWatchdogMs`, treat the turn
   * as silently done and self-finalize. Cleared by finalize/cancel/showError
   * to prevent double-finalize.
   */
  private resetWatchdog(): void {
    if (this.finalized) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.finalized) return;
      void this.finalize().catch(() => undefined);
    }, this.idleWatchdogMs);
  }

  private cancelWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private async editNow(elapsedSeconds?: number): Promise<void> {
    if (this.finalized) return;
    const text = renderStreamingView(
      this.partsArray() as unknown as readonly RenderablePart[],
      elapsedSeconds != null ? { elapsedSeconds } : {},
    );
    if (text.length === 0) return;
    const [first] = chunkForTelegram(text);
    if (!first) return;
    try {
      // Streaming view is MarkdownV2 (italic-marker `_thinking…_` + tool
      // lines with inline code). Final view is HTML — see finalize().
      await safeEdit(
        this.bot,
        this.chatId,
        this.placeholderMessageId,
        first,
        undefined,
        "MarkdownV2",
      );
    } finally {
      this.inFlightEdit = null;
    }
  }

  /** Return parts in arrival order as an array (for renderers that need a sequence). */
  private partsArray(): IncomingPart[] {
    const result: IncomingPart[] = [];
    for (const id of this.partOrder) {
      const p = this.parts.get(id);
      if (p) result.push(p);
    }
    return result;
  }
}
