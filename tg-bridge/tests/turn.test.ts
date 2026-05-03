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
    // Text parts are hidden during streaming; only the thinking marker shows.
    expect(bot.calls.edits[0]![2]).toBe("_thinking…_");
  });

  it("absorbs rapid updates into a single edit per throttle window", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "running", input: { filePath: "a.py" } },
    });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "a.py" }, output: "ignored" },
    });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({
      id: "t2",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "pwd" } },
    });
    await vi.advanceTimersByTimeAsync(800);
    // After throttle window completes, exactly one edit reflecting the latest state.
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe(
      "📄 read `a.py`\n⚡ bash `pwd`\n_thinking…_",
    );
  });

  it("finalize edits placeholder with the final render and clears any pending timer", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "first" });
    await turn.finalize();
    // The pending timer would have fired at +1000ms; finalize ran immediately.
    expect(bot.calls.edits).toHaveLength(1);
    // No tools used → final view is just the escaped text.
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
    // renderFinalView for empty input returns "_(no response)_" (with parens escaped per MarkdownV2).
    expect(bot.calls.edits[0]![2]).toBe("_\\(no response\\)_");
  });

  it("finalize includes a tool summary header when tools were used", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "pwd" } },
    });
    turn.appendPart({ id: "p1", type: "text", text: "Working dir is /workspace." });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe(
      "_used 1 tool · 1 bash_\n\nWorking dir is /workspace\\.",
    );
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

  it("editNow does not crash the process when Telegram rejects the edit", async () => {
    const bot = makeBot();
    // Make every editMessageText call throw.
    bot.editMessageText = vi.fn(async () => {
      throw new Error("can't parse entities");
    });
    // sendMessage is a no-op for this test (not used by editNow).
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "pwd" } },
    });
    // Advance past the throttle to trigger editNow.
    await vi.advanceTimersByTimeAsync(1000);
    // safeEdit retries with plain text (also throws here), then logs and returns.
    // No unhandled rejection; the test reaches this assertion.
    expect(bot.editMessageText).toHaveBeenCalled();
  });

  it("finalize does not crash the process when Telegram rejects the edit", async () => {
    const bot = makeBot();
    bot.editMessageText = vi.fn(async () => {
      throw new Error("can't parse entities");
    });
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "anything" });
    await expect(turn.finalize()).resolves.toBeUndefined();
    expect(bot.editMessageText).toHaveBeenCalled();
  });
});
