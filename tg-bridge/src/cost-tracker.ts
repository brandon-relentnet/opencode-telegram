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
    let seen = this.seenByChat.get(chatId);
    if (!seen) {
      seen = new Set();
      this.seenByChat.set(chatId, seen);
    }
    if (seen.has(info.id)) return;
    seen.add(info.id);

    const tokens = info.tokens ?? {};
    const cache = tokens.cache ?? {};
    this.state.incrementCumulativeStats(chatId, {
      tokensInput: tokens.input ?? 0,
      tokensOutput: tokens.output ?? 0,
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
