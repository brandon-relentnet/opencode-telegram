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

  it("skips records with missing tokens (placeholder semantic)", () => {
    // opencode emits message.updated TWICE per assistant message: first as
    // a placeholder with tokens.input + tokens.output both === 0, then again
    // at completion with the populated counts. We must skip the placeholder
    // — counting it would lock in a zero record, and the dedup-by-id check
    // would then ignore the populated update. Records with tokens entirely
    // missing follow the same skip rule (it's a malformed/early state).
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: undefined as unknown as { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
      cost: 0.001,
    });
    expect(repo.getCumulativeStats(1).tokensInput).toBe(0);
    expect(repo.getCumulativeStats(1).costMicros).toBe(0);
  });

  it("(Bug C2) skips placeholder events with input=0 and output=0", () => {
    // The opencode placeholder shape — exactly what message.updated emits
    // first, before the model runs. Must not be recorded.
    tracker.recordAssistantMessage(1, {
      id: "msg_placeholder",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(0);
    expect(stats.tokensOutput).toBe(0);
  });

  it("(Bug C2) records the populated update after a skipped placeholder", () => {
    // First emission: placeholder, must be skipped.
    tracker.recordAssistantMessage(1, {
      id: "msg_X",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    });
    // Second emission: same id, populated tokens. Must record.
    tracker.recordAssistantMessage(1, {
      id: "msg_X",
      tokens: { input: 370, output: 151, reasoning: 0, cache: { read: 148480, write: 0 } },
      cost: 0.04,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(370);
    expect(stats.tokensOutput).toBe(151);
    expect(stats.tokensCacheRead).toBe(148480);
    expect(stats.costMicros).toBe(40_000);
  });

  it("(Bug C2) still dedups two non-zero emissions for the same id", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_Y",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.005,
    });
    tracker.recordAssistantMessage(1, {
      id: "msg_Y",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.005,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(100);
    expect(stats.tokensOutput).toBe(50);
    expect(stats.costMicros).toBe(5_000);
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
