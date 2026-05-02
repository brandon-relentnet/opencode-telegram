import { renderParts, escapeMarkdownV2, type RenderablePart } from "./format.js";
import { chunkForTelegram } from "./chunker.js";

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
    await this.bot.editMessageText(
      this.chatId,
      this.placeholderMessageId,
      `❌ ${escapeMarkdownV2(error)}`,
      { parse_mode: "MarkdownV2" },
    );
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);

    const text = this.renderCurrent();
    if (text.length === 0) {
      await this.bot.editMessageText(
        this.chatId,
        this.placeholderMessageId,
        escapeMarkdownV2("(no response)"),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const chunks = chunkForTelegram(text);
    await this.bot.editMessageText(this.chatId, this.placeholderMessageId, chunks[0]!, {
      parse_mode: "MarkdownV2",
    });
    for (const chunk of chunks.slice(1)) {
      await this.bot.sendMessage(this.chatId, chunk, { parse_mode: "MarkdownV2" });
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
    const text = this.renderCurrent();
    if (text.length === 0) return;
    const [first] = chunkForTelegram(text);
    if (!first) return;
    try {
      await this.bot.editMessageText(this.chatId, this.placeholderMessageId, first, {
        parse_mode: "MarkdownV2",
      });
    } catch {
      // Swallow transient edit errors (Telegram 429, "message is not modified", etc.).
      // Finalize will produce the authoritative state.
    } finally {
      this.inFlightEdit = null;
    }
  }

  private renderCurrent(): string {
    const ordered: RenderablePart[] = this.partOrder
      .map((id) => this.parts.get(id))
      .filter((p): p is IncomingPart => Boolean(p))
      .map((p) => {
        if (p.type === "text" && typeof p.text === "string") {
          return { type: "text", text: p.text };
        }
        if (p.type === "tool" && typeof p.tool === "string" && p.state) {
          return {
            type: "tool",
            tool: p.tool,
            state: {
              status: p.state.status as "pending" | "running" | "completed" | "error",
              input: p.state.input,
              output: p.state.output,
            },
          };
        }
        return { type: p.type } as RenderablePart;
      });
    return renderParts(ordered);
  }
}
