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
    // Transparent view: prose IS shown live + thinking tail.
    const text = String(bot.calls.edits[0]![2]);
    expect(text).toContain("hello");
    expect(text).toContain("<i>thinking…</i>");
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
    const text = String(bot.calls.edits[0]![2]);
    expect(text).toContain("📄"); // read tool emoji
    expect(text).toContain("a.py");
    expect(text).toContain("⚡"); // bash tool emoji
    expect(text).toContain("pwd");
    expect(text).toContain("<i>thinking…</i>");
  });

  it("finalize edits placeholder with the final render and clears any pending timer", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "first" });
    await turn.finalize();
    // Transparent finalize = single edit with prose + done marker.
    expect(bot.calls.edits).toHaveLength(1);
    const text = String(bot.calls.edits[0]![2]);
    expect(text).toContain("first");
    expect(text).toContain("─ done ─");
    // No follow-up edits after finalize
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.sends).toHaveLength(0);
  });

  it("finalize truncates very long content from the front", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    const huge = "z".repeat(8000);
    turn.appendPart({ id: "p1", type: "text", text: huge });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    const text = String(bot.calls.edits[0]![2]);
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain("─ done ─");
    // Multi-send no longer used in transparent mode.
    expect(bot.calls.sends).toHaveLength(0);
  });

  it("finalize with no parts emits a 'no agent activity captured' notice (not bare done marker)", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    // No parts → user gets a helpful explanation, not a bare "─ done ─".
    const text = String(bot.calls.edits[0]![2]);
    expect(text).toContain("no agent activity captured");
    expect(text).toContain("opencode may still be working");
  });

  it("finalize renders tool + prose inline (no separate summary header)", async () => {
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
    const text = String(bot.calls.edits[0]![2]);
    expect(text).toContain("bash");
    expect(text).toContain("pwd");
    expect(text).toContain("Working dir is /workspace");
    expect(text).toContain("─ done ─");
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

  it("cancel prevents pending streaming-view timer from firing afterward", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "pwd" } },
    });
    // Pending timer is queued (will fire at t=1000). Cancel before it does.
    await turn.cancel();
    // Advance past the throttle window — the timer should NOT fire because cancel
    // cleared it and set finalized=true.
    await vi.advanceTimersByTimeAsync(2000);
    expect(bot.calls.edits).toHaveLength(0);
    expect(bot.calls.sends).toHaveLength(0);
  });

  it("cancel writes nothing (caller is responsible for the final placeholder content)", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "intermediate" });
    await turn.cancel();
    // No edit should have been issued by Turn itself.
    expect(bot.calls.edits).toHaveLength(0);
    expect(bot.calls.sends).toHaveLength(0);
  });

  it("cancel is idempotent and no-ops after finalize", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    await turn.cancel(); // already finalized, must early-return
    expect(bot.calls.edits).toHaveLength(1);
  });
});

describe("Turn idle watchdog", () => {
  it("calls finalize() if no part updates arrive for IDLE_WATCHDOG_MS", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000, idleWatchdogMs: 60000 });
    turn.appendPart({ id: "p1", type: "text", text: "thinking..." });
    await vi.advanceTimersByTimeAsync(1500);
    expect(bot.calls.edits.length).toBeGreaterThan(0);
    // Streaming edit before watchdog: NO done marker.
    expect(String(bot.calls.edits[0]![2])).not.toContain("─ done ─");
    // No more parts arrive; advance past watchdog
    await vi.advanceTimersByTimeAsync(60000);
    // Watchdog should have triggered finalize() — that produces a final edit
    // with the done marker.
    expect(bot.calls.edits.length).toBeGreaterThanOrEqual(2);
    expect(String(bot.calls.edits[bot.calls.edits.length - 1]![2])).toContain("─ done ─");
    // After finalize, further parts are ignored
    turn.appendPart({ id: "p2", type: "text", text: "late" });
    const finalEditCount = bot.calls.edits.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(bot.calls.edits.length).toBe(finalEditCount);
    vi.useRealTimers();
  });

  it("watchdog resets when new part arrives within window", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000, idleWatchdogMs: 60000 });
    turn.appendPart({ id: "p1", type: "text", text: "first" });
    await vi.advanceTimersByTimeAsync(50000); // approaching deadline
    turn.appendPart({ id: "p2", type: "text", text: "second" });
    await vi.advanceTimersByTimeAsync(50000); // reset by p2; total elapsed > 60s but no fire
    // Should not have finalized yet because watchdog reset on p2
    turn.appendPart({ id: "p3", type: "text", text: "third" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(bot.calls.edits.length).toBeGreaterThan(0);
    // No edit so far should carry the done marker — watchdog has not fired.
    for (const call of bot.calls.edits) {
      expect(String(call[2])).not.toContain("─ done ─");
    }
    vi.useRealTimers();
  });

  it("explicit finalize cancels the watchdog", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000, idleWatchdogMs: 60000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await turn.finalize();
    const editsAfterFinalize = bot.calls.edits.length;
    expect(editsAfterFinalize).toBeGreaterThan(0);
    // Watchdog should be cancelled; no double-finalize
    await vi.advanceTimersByTimeAsync(60000);
    // No second finalize edit beyond what finalize() already did
    expect(bot.calls.edits.length).toBe(editsAfterFinalize);
    vi.useRealTimers();
  });
});

describe("Turn heartbeat (C1)", () => {
  it("starts heartbeat after first appendPart", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100, heartbeatMs: 10000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150); // first edit fires
    const editsBefore = bot.calls.edits.length;
    await vi.advanceTimersByTimeAsync(10000); // heartbeat tick
    expect(bot.calls.edits.length).toBeGreaterThan(editsBefore);
    const lastEditText = bot.calls.edits[bot.calls.edits.length - 1]![2] as string;
    expect(lastEditText).toMatch(/elapsed/);
    vi.useRealTimers();
  });

  it("heartbeat stops on finalize", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100, heartbeatMs: 10000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await turn.finalize();
    const editsAfterFinalize = bot.calls.edits.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(bot.calls.edits.length).toBe(editsAfterFinalize);
    vi.useRealTimers();
  });
});

describe("Turn cancel button (C2)", () => {
  it("attaches reply_markup with Cancel button when cancelCallbackData provided", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, {
      throttleMs: 100,
      cancelCallbackData: "cancel:ses_xyz",
    });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150);
    const lastEdit = bot.calls.edits[bot.calls.edits.length - 1];
    const opts = lastEdit?.[3] as
      | { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }
      | undefined;
    const button = opts?.reply_markup?.inline_keyboard?.[0]?.[0];
    expect(button?.callback_data).toBe("cancel:ses_xyz");
    vi.useRealTimers();
  });

  it("does NOT attach reply_markup when cancelCallbackData is omitted", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150);
    const lastEdit = bot.calls.edits[bot.calls.edits.length - 1];
    const opts = lastEdit?.[3] as { reply_markup?: unknown } | undefined;
    expect(opts?.reply_markup).toBeUndefined();
    vi.useRealTimers();
  });

  it("removes the Cancel button on finalize (final view has no reply_markup)", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, {
      throttleMs: 100,
      cancelCallbackData: "cancel:ses_xyz",
    });
    turn.appendPart({ id: "p1", type: "text", text: "done" });
    await vi.advanceTimersByTimeAsync(150);
    // Confirm streaming edit had reply_markup attached
    const streamingEdit = bot.calls.edits[bot.calls.edits.length - 1];
    const streamingOpts = streamingEdit?.[3] as { reply_markup?: unknown } | undefined;
    expect(streamingOpts?.reply_markup).toBeDefined();
    await turn.finalize();
    // The final-view edit must NOT carry reply_markup (button removed).
    const finalEdit = bot.calls.edits[bot.calls.edits.length - 1];
    const finalOpts = finalEdit?.[3] as { reply_markup?: unknown } | undefined;
    expect(finalOpts?.reply_markup).toBeUndefined();
    vi.useRealTimers();
  });

  it("heartbeat ticks continue to attach the Cancel button while streaming", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, {
      throttleMs: 100,
      heartbeatMs: 1000,
      cancelCallbackData: "cancel:ses_xyz",
    });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150); // first throttled edit
    await vi.advanceTimersByTimeAsync(1100); // heartbeat tick
    const lastEdit = bot.calls.edits[bot.calls.edits.length - 1];
    const opts = lastEdit?.[3] as
      | { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } }
      | undefined;
    expect(opts?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
      "cancel:ses_xyz",
    );
    vi.useRealTimers();
  });
});

describe("Turn session status (rate-limit retry banner)", () => {
  it("setSessionStatus with type='retry' renders the rate-limit banner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150); // initial streaming edit
    turn.setSessionStatus({
      type: "retry",
      attempt: 2,
      message: "rate_limit_exceeded",
      next: 1_000_000_030_000,
    });
    // Retry status pushes an immediate edit (no throttle wait)
    await vi.advanceTimersByTimeAsync(0);
    const lastEdit = bot.calls.edits[bot.calls.edits.length - 1];
    expect(String(lastEdit?.[2])).toContain("⏳");
    expect(String(lastEdit?.[2])).toContain("attempt 2");
    expect(String(lastEdit?.[2])).toContain("retry in 30s");
    vi.useRealTimers();
  });

  it("setSessionStatus with type='idle' clears the retry banner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150);
    turn.setSessionStatus({
      type: "retry",
      attempt: 1,
      message: "msg",
      next: 1_000_000_010_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const retryEdit = bot.calls.edits[bot.calls.edits.length - 1];
    expect(String(retryEdit?.[2])).toContain("⏳");
    // Now signal idle — banner should clear
    turn.setSessionStatus({ type: "idle" });
    await vi.advanceTimersByTimeAsync(0);
    const clearedEdit = bot.calls.edits[bot.calls.edits.length - 1];
    expect(String(clearedEdit?.[2])).not.toContain("⏳");
    vi.useRealTimers();
  });

  it("setSessionStatus retry resets the watchdog so it doesn't fire during long backoff", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100, idleWatchdogMs: 10_000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150); // streaming edit
    // Drain 9 seconds of silence
    await vi.advanceTimersByTimeAsync(9_000);
    // Now signal retry — should reset the watchdog
    turn.setSessionStatus({
      type: "retry",
      attempt: 1,
      message: "msg",
      next: Date.now() + 30_000,
    });
    // Drain another 9 seconds — watchdog would have fired by now without the reset
    await vi.advanceTimersByTimeAsync(9_000);
    // Turn should NOT be finalized — no chunkForTelegram-style multi-edit final view
    expect(bot.calls.sends).toHaveLength(0);
    vi.useRealTimers();
  });

  it("setSessionStatus is a no-op after finalize", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await turn.finalize();
    const editsBefore = bot.calls.edits.length;
    turn.setSessionStatus({
      type: "retry",
      attempt: 1,
      message: "msg",
      next: Date.now() + 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.calls.edits.length).toBe(editsBefore);
    vi.useRealTimers();
  });
});
