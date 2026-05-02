import { describe, it, expect, beforeEach, vi } from "vitest";
import { Turn, type TurnBot } from "../src/turn.js";

function makeBot(): TurnBot & { calls: { edits: unknown[][]; sends: unknown[][] } } {
  const calls = { edits: [] as unknown[][], sends: [] as unknown[][] };
  return {
    calls,
    async editMessageText(chatId, messageId, text, opts) {
      calls.edits.push([chatId, messageId, text, opts]);
    },
    async sendMessage(chatId, text, opts) {
      calls.sends.push([chatId, text, opts]);
      return { message_id: 100 + calls.sends.length };
    },
  };
}

describe("Turn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not edit before any part arrives", () => {
    const bot = makeBot();
    new Turn(bot, 1, 50, { throttleMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(bot.calls.edits).toHaveLength(0);
  });

  it("edits the placeholder once after throttle window when a part arrives", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "hello" });
    expect(bot.calls.edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe("hello");
  });

  it("absorbs rapid updates into a single edit per throttle window", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "h" });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({ id: "p1", type: "text", text: "he" });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({ id: "p1", type: "text", text: "hello" });
    await vi.advanceTimersByTimeAsync(800);
    // After throttle window completes, exactly one edit with latest state
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe("hello");
  });

  it("finalize edits placeholder with the final render and clears any pending timer", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "first" });
    await turn.finalize();
    // The pending timer would have fired at +1000ms; finalize ran immediately.
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe("first");
    // No follow-up edits after finalize
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.sends).toHaveLength(0);
  });

  it("finalize splits long output: edits placeholder with first chunk, sends remaining as new messages", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const para3 = "c".repeat(2000);
    turn.appendPart({ id: "p1", type: "text", text: `${para1}\n\n${para2}\n\n${para3}` });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.sends.length).toBeGreaterThanOrEqual(1);
    const allText =
      (bot.calls.edits[0]![2] as string) +
      bot.calls.sends.map((c) => c[1] as string).join("");
    expect(allText).toContain(para1);
    expect(allText).toContain(para2);
    expect(allText).toContain(para3);
  });

  it("finalize with no parts edits placeholder with a 'no response' marker", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toMatch(/no response/i);
  });

  it("showError edits placeholder with the error text and prevents further edits", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "partial" });
    await turn.showError("boom");
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toMatch(/boom/);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.calls.edits).toHaveLength(1);
  });

  it("ignores appendPart after finalize", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    await turn.finalize();
    turn.appendPart({ id: "p1", type: "text", text: "late" });
    await vi.advanceTimersByTimeAsync(2000);
    // Only the finalize edit
    expect(bot.calls.edits).toHaveLength(1);
  });
});
