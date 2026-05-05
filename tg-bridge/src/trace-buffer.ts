/**
 * Per-chat ring buffer of recent bridge events.
 *
 * The bridge logs every meaningful event at info level via pino with an
 * `evt: "..."` discriminator field, which makes post-hoc analysis via
 * `journalctl -u tg-bridge | jq 'select(.chatId==X)'` trivial. But on a
 * live session with no SSH access, the operator (you, debugging via
 * Telegram) needs a way to inspect what the bridge is seeing.
 *
 * `/trace` reads from this buffer and renders the last N events as a
 * Telegram message. ~100 events per chat is enough to see one full turn.
 *
 * Events are JSON-serializable; PII-bearing fields (free-text from the
 * agent or user) are truncated to 80 chars before recording.
 */

const MAX_EVENTS_PER_CHAT = 100;
const MAX_TEXT_LEN = 80;

export interface TraceEvent {
  /** unix ms */
  ts: number;
  /** discriminator like "user.message", "sse.event", "turn.edit", etc. */
  evt: string;
  /** Free-form key/value payload. Strings auto-truncated to MAX_TEXT_LEN. */
  data: Record<string, unknown>;
}

export class TraceBuffer {
  private buffers = new Map<number, TraceEvent[]>();

  record(chatId: number, evt: string, data: Record<string, unknown> = {}): void {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string" && v.length > MAX_TEXT_LEN) {
        sanitized[k] = `${v.slice(0, MAX_TEXT_LEN)}…`;
      } else {
        sanitized[k] = v;
      }
    }
    const buf = this.buffers.get(chatId) ?? [];
    buf.push({ ts: Date.now(), evt, data: sanitized });
    if (buf.length > MAX_EVENTS_PER_CHAT) buf.shift();
    this.buffers.set(chatId, buf);
  }

  /** Return the last `limit` events (most recent last). */
  read(chatId: number, limit = 50): TraceEvent[] {
    const buf = this.buffers.get(chatId) ?? [];
    return buf.slice(-limit);
  }

  clear(chatId: number): void {
    this.buffers.delete(chatId);
  }
}
