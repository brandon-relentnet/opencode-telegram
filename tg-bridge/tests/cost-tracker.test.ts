import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../src/chat-state.js";
import { CostTracker } from "../src/cost-tracker.js";

let repo: ChatStateRepo;
let tracker: CostTracker;

beforeEach(() => {
  const db = new Database(":memory:");
  repo = new ChatStateRepo(db);
  tracker = new CostTracker(repo);
});

describe("CostTracker", () => {
  it("records assistant message tokens + cost into chat_state", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 0 } },
      cost: 0.0042,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(100);
    expect(stats.tokensOutput).toBe(50);
    expect(stats.tokensReasoning).toBe(10);
    expect(stats.tokensCacheRead).toBe(200);
    expect(stats.tokensCacheWrite).toBe(0);
    expect(stats.costMicros).toBe(4_200);
  });

  it("ignores duplicate message IDs (idempotent)", () => {
    const msg = {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    };
    tracker.recordAssistantMessage(1, msg);
    tracker.recordAssistantMessage(1, msg); // duplicate
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
  });

  it("treats different message IDs as separate", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    });
    tracker.recordAssistantMessage(1, {
      id: "msg_2",
      tokens: { input: 200, output: 75, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.002,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(300);
    expect(stats.costMicros).toBe(3_000);
  });

  it("handles missing/null cost as 0", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: null as unknown as number, // simulating Anthropic Pro/Max OAuth
    });
    expect(repo.getCumulativeStats(1).costMicros).toBe(0);
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
  });

  it("handles missing tokens gracefully", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: undefined as unknown as { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
      cost: 0.001,
    });
    expect(repo.getCumulativeStats(1).tokensInput).toBe(0);
    expect(repo.getCumulativeStats(1).costMicros).toBe(1_000);
  });

  it("reset clears the seen-IDs cache and chat_state cumulative", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    });
    tracker.reset(1);
    expect(repo.getCumulativeStats(1).tokensInput).toBe(0);
    // After reset, the same msg_1 ID should be countable again
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    });
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
  });

  it("isolates seen-IDs across chats", () => {
    const msg = {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    };
    tracker.recordAssistantMessage(1, msg);
    tracker.recordAssistantMessage(2, msg); // different chat, same msg ID
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
    expect(repo.getCumulativeStats(2).tokensInput).toBe(100);
  });
});
