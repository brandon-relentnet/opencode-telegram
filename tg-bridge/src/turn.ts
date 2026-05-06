import {
  renderTransparentView,
  escapeMarkdownV2,
  buildCancelKeyboard,
  type RenderablePart,
} from "./format.js";
import { safeEdit } from "./safe-telegram.js";

export interface TurnBot {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode?: "MarkdownV2" | "HTML"; reply_markup?: object },
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
   * dropped mid-turn) and self-finalizes. Default 5 minutes. Reset on
   * every part.
   *
   * Why 5 min, not 60s: long-running tools (npm install, full builds,
   * multi-step agent reasoning) can legitimately go silent for over a
   * minute. A 60s watchdog produced the "— done —" empty-finalize bug
   * where the bridge gave up before opencode finished a 112s multi-step
   * turn. The original "stuck on thinking" bug this guards against
   * happens when SSE genuinely drops + session.idle is lost; 5 min still
   * catches that, just slower.
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
  /**
   * Cancel button callback data (C2): when set, the streaming-view edits
   * (and heartbeat ticks) attach an inline keyboard with a single
   * "⏹ Cancel" button. Format: `cancel:<sessionId>`. The bridge's
   * callback_query router matches the prefix to look up the active Turn
   * and call `Turn.cancel()` + `client.abortSession()`.
   *
   * Final view edits (`finalize`) and error/cancel paths intentionally
   * do NOT carry the keyboard — Telegram strips reply_markup whenever an
   * editMessageText call omits the field, which gives us "remove button
   * on completion" for free.
   */
  cancelCallbackData?: string;
  /**
   * The user's most recent prompt text. Threaded into the renderer so
   * assistant text-parts that just restate the user's question get
   * filtered (see prompt-echo.ts).
   */
  lastUserPrompt?: string;
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
  // Stored as the sessionId only (any leading "cancel:" prefix is stripped
  // at construction). buildCancelKeyboard re-applies the prefix so the
  // callback data convention lives in one place. `undefined` disables the
  // Cancel button entirely (test harnesses, /clone-style flows that own
  // the placeholder lifecycle themselves).
  private readonly cancelSessionId: string | undefined;
  /**
   * Latest session.status retry payload, or null when the agent is in idle
   * or busy state. Set by setSessionStatus(); consumed by editNow() to
   * render the rate-limit banner instead of the normal thinking line.
   */
  private retryStatus: { attempt: number; message: string; next: number } | null = null;
  private readonly lastUserPrompt: string | undefined;

  constructor(
    private bot: TurnBot,
    private chatId: number,
    private placeholderMessageId: number,
    options: TurnOptions = {},
  ) {
    this.throttleMs = options.throttleMs ?? 1000;
    this.idleWatchdogMs = options.idleWatchdogMs ?? 300_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.startedAt = Date.now();
    this.lastEditAt = this.startedAt;
    this.cancelSessionId = options.cancelCallbackData?.replace(/^cancel:/, "");
    this.lastUserPrompt = options.lastUserPrompt;
  }

  appendPart(part: IncomingPart): void {
    if (this.finalized) return;
    if (!this.parts.has(part.id)) this.partOrder.push(part.id);
    this.parts.set(part.id, part);
    this.scheduleEdit();
    this.resetWatchdog();
    this.ensureHeartbeat();
  }

  /**
   * Update the agent's session status. opencode emits `session.status`
   * with `type: "retry" | "idle" | "busy"`. The retry shape (attempt,
   * message, next) tells us the provider returned a retryable error
   * (typically 429 rate limit). The bridge:
   *
   *   - Renders "⏳ <message> · attempt N · retry in Ns" in the streaming
   *     view (replacing the thinking placeholder)
   *   - Resets the idle watchdog so it doesn't fire during a long backoff
   *     (some retries are 60+ seconds out)
   *   - Pushes a fresh edit immediately so the user sees the banner
   *     without waiting for the next throttle window
   *
   * `idle` and `busy` clear the retry state.
   */
  setSessionStatus(status: unknown): void {
    if (this.finalized) return;
    const s = status as { type?: string; attempt?: number; message?: string; next?: number };
    if (s.type === "retry" && typeof s.attempt === "number" && typeof s.next === "number") {
      this.retryStatus = {
        attempt: s.attempt,
        message: typeof s.message === "string" ? s.message : "Provider returned a retryable error",
        next: s.next,
      };
      this.resetWatchdog();
      // Push a fresh edit immediately — the user shouldn't wait for the
      // throttle window to learn we're rate-limited.
      this.cancelTimer();
      this.lastEditAt = Date.now();
      this.inFlightEdit = this.editNow();
    } else if (s.type === "idle" || s.type === "busy") {
      const wasRetrying = this.retryStatus != null;
      this.retryStatus = null;
      if (wasRetrying) {
        // Clear the banner promptly when the retry resolves.
        this.cancelTimer();
        this.lastEditAt = Date.now();
        this.inFlightEdit = this.editNow();
      }
    }
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

  /**
   * Finalize the turn: append a terminal marker, do one last edit with the
   * transparent view, then stop. The marker depends on `reason`:
   *
   *   - "idle" (default, opencode reported clean session.idle): "─ done ─"
   *   - "watchdog" (no events for idleWatchdogMs; likely opencode crash or
   *     SSE drop): "⚠️ stalled — no events for N minutes. opencode may
   *     have crashed; check the web UI to confirm the agent's actual state."
   *
   * The distinction matters because the user can't otherwise tell whether
   * the agent ACTUALLY finished or the bridge gave up. opencode crashes
   * (OOM-kills under memory pressure) and SSE drops are common enough that
   * silently rendering "─ done ─" in those cases is dishonest.
   */
  async finalize(options: { userMessageIds?: Set<string>; reason?: "idle" | "watchdog" } = {}): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    this.cancelWatchdog();
    this.cancelHeartbeat();
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);

    const text = renderTransparentView(
      this.partsArray() as unknown as readonly RenderablePart[],
      {
        ...(options.userMessageIds ? { userMessageIds: options.userMessageIds } : {}),
        ...(this.lastUserPrompt ? { lastUserPrompt: this.lastUserPrompt } : {}),
        final: true,
        ...(options.reason === "watchdog" ? { finalReason: "watchdog" as const } : {}),
      },
    );
    if (text.length === 0) return;

    // Telegram caps at 4096 chars; if the full transparent view exceeds it,
    // truncate from the FRONT (preserving most-recent activity + done marker).
    // This is intentional vs. the prior chunk-and-multi-send approach: the
    // user wants a single message that reflects current state, not a chain.
    const safe = text.length > 4000 ? `<i>(truncated; older activity dropped)</i>\n${text.slice(text.length - 3900)}` : text;

    await safeEdit(this.bot, this.chatId, this.placeholderMessageId, safe, undefined, "HTML");
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
      void this.finalize({ reason: "watchdog" }).catch(() => undefined);
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
    // Retry status takes priority over elapsed-seconds heartbeat. When the
    // agent is rate-limited, the user wants to see "⏳ retrying in Ns",
    // not a generic thinking counter.
    const opts: {
      retryStatus?: { attempt: number; message: string; next: number };
      elapsedSeconds?: number;
      lastUserPrompt?: string;
    } = this.retryStatus != null
      ? { retryStatus: this.retryStatus }
      : elapsedSeconds != null
        ? { elapsedSeconds }
        : {};
    if (this.lastUserPrompt) opts.lastUserPrompt = this.lastUserPrompt;
    const text = renderTransparentView(
      this.partsArray() as unknown as readonly RenderablePart[],
      opts,
    );
    if (text.length === 0) return;
    const safe = text.length > 4000 ? `<i>(truncated; older activity dropped)</i>\n${text.slice(text.length - 3900)}` : text;
    // C2: attach the [⏹ Cancel] inline keyboard to every streaming edit
    // (and heartbeat tick) when a session ID was wired in.
    const replyMarkup = this.cancelSessionId
      ? buildCancelKeyboard(this.cancelSessionId)
      : undefined;
    try {
      // Transparent view is HTML throughout (was: MarkdownV2 for streaming,
      // HTML for final). Single render path = single set of escape rules.
      await safeEdit(
        this.bot,
        this.chatId,
        this.placeholderMessageId,
        safe,
        undefined,
        "HTML",
        replyMarkup,
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
