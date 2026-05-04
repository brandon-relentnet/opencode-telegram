/**
 * Process-wide registry of in-flight Turns keyed by opencode session ID.
 *
 * Why a singleton module instead of plumbing a Map through deps: the
 * cancel-button callback is routed in index.ts's `callback_query:data`
 * handler, but the Turn it needs to cancel was created two layers down
 * inside message-handler.ts. Threading a shared Map through every
 * intermediate dep object adds noise without adding clarity. The map is
 * write-only from message-handler (set on Turn create, delete on
 * idle/error/cancel) and read-only from index.ts (get on cancel callback).
 *
 * Memory bound: only one entry per concurrent in-flight session. Sessions
 * are deleted from the map as soon as they finalize, error, or are
 * cancelled, so leaks would require a Turn that never reaches any
 * terminal state — guarded by the watchdog (60s default) on every Turn.
 *
 * Concurrency: Node is single-threaded; the bot processes updates
 * sequentially by default and prompts run via `void`/fire-and-forget
 * promises that synchronously call `set` before any await. No locking
 * needed.
 */
import type { Turn } from "./turn.js";

/**
 * Per-session entry. Carries the Turn (so the cancel callback can call
 * Turn.cancel()) plus the chat + user message IDs so the same callback
 * can react to the user's original prompt with ⏸ via reactCancelled.
 * Tracking the user message ID here avoids a second lookup keyed by
 * sessionId in chat-state, which doesn't store it.
 */
export interface ActiveTurnEntry {
  turn: Turn;
  chatId: number;
  userMessageId: number;
}

const activeTurns = new Map<string, ActiveTurnEntry>();

export const ActiveTurns = {
  set(sessionId: string, entry: ActiveTurnEntry): void {
    activeTurns.set(sessionId, entry);
  },
  delete(sessionId: string): void {
    activeTurns.delete(sessionId);
  },
  get(sessionId: string): ActiveTurnEntry | undefined {
    return activeTurns.get(sessionId);
  },
  /** Test-only: clear the map between vitest cases. */
  _clear(): void {
    activeTurns.clear();
  },
};
