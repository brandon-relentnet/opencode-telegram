import type { ChatStateRepo } from "./chat-state.js";

export interface AssistantMessageInfo {
  id: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
}

export class CostTracker {
  /**
   * Per-chat seen-message IDs. opencode emits multiple message.created /
   * message.part.updated events for the same message ID; we only count once.
   * Cleared by reset() on /new and /switch.
   */
  private seenByChat = new Map<number, Set<string>>();

  constructor(private state: ChatStateRepo) {}

  recordAssistantMessage(chatId: number, info: AssistantMessageInfo): void {
    if (typeof info.id !== "string" || info.id.length === 0) return;

    const tokens = info.tokens ?? {};
    const inputTokens = tokens.input ?? 0;
    const outputTokens = tokens.output ?? 0;
    // opencode emits message.updated TWICE per assistant message: first as
    // a placeholder with tokens.input + tokens.output both === 0, then
    // again at completion with the populated counts. We must skip the
    // empty placeholder — otherwise the dedup-by-id check below would lock
    // in the zero record and ignore the populated one. Only count when at
    // least one of input/output tokens is non-zero (the model has actually
    // produced output worth metering).
    if (inputTokens === 0 && outputTokens === 0) return;

    let seen = this.seenByChat.get(chatId);
    if (!seen) {
      seen = new Set();
      this.seenByChat.set(chatId, seen);
    }
    if (seen.has(info.id)) return;
    seen.add(info.id);

    const cache = tokens.cache ?? {};
    this.state.incrementCumulativeStats(chatId, {
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
      tokensReasoning: tokens.reasoning ?? 0,
      tokensCacheRead: cache.read ?? 0,
      tokensCacheWrite: cache.write ?? 0,
      costMicros: typeof info.cost === "number" ? Math.round(info.cost * 1_000_000) : 0,
    });
  }

  reset(chatId: number): void {
    this.seenByChat.delete(chatId);
    this.state.resetCumulativeStats(chatId);
  }
}
