import { renderStreamingView, renderFinalView, escapeMarkdownV2, type RenderablePart } from "./format.js";
import { chunkForTelegram } from "./chunker.js";
import { safeEdit, safeSend } from "./safe-telegram.js";

export interface TurnBot {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode: "MarkdownV2" },
  ): Promise<unknown>;
  sendMessage(
    chatId: number,
    text: string,
    opts: { parse_mode: "MarkdownV2" },
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

  constructor(
    private bot: TurnBot,
    private chatId: number,
    private placeholderMessageId: number,
    options: TurnOptions = {},
  ) {
    this.throttleMs = options.throttleMs ?? 1000;
    this.lastEditAt = Date.now();
  }

  appendPart(part: IncomingPart): void {
    if (this.finalized) return;
    if (!this.parts.has(part.id)) this.partOrder.push(part.id);
    this.parts.set(part.id, part);
    this.scheduleEdit();
  }

  async showError(error: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    await safeEdit(
      this.bot,
      this.chatId,
      this.placeholderMessageId,
      `❌ ${escapeMarkdownV2(error)}`,
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
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);

    const text = renderFinalView(this.partsArray() as unknown as readonly RenderablePart[]);
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
      this.inFlightEdit = this.editNow();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private async editNow(): Promise<void> {
    if (this.finalized) return;
    const text = renderStreamingView(this.partsArray() as unknown as readonly RenderablePart[]);
    if (text.length === 0) return;
    const [first] = chunkForTelegram(text);
    if (!first) return;
    try {
      await safeEdit(this.bot, this.chatId, this.placeholderMessageId, first);
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
