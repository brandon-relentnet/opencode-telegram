import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PinnedStatusManager } from "../src/pinned-status.js";
import { ChatStateRepo } from "../src/chat-state.js";

function makeBot() {
  const sent: Array<unknown[]> = [];
  const edits: Array<unknown[]> = [];
  const pins: Array<unknown[]> = [];
  return {
    sent,
    edits,
    pins,
    api: {
      sendMessage: vi.fn(async (...args: unknown[]) => { sent.push(args); return { message_id: 999 }; }),
      editMessageText: vi.fn(async (...args: unknown[]) => { edits.push(args); }),
      pinChatMessage: vi.fn(async (...args: unknown[]) => { pins.push(args); }),
      unpinChatMessage: vi.fn(async () => undefined),
    },
  };
}

let repo: ChatStateRepo;
beforeEach(() => {
  const db = new Database(":memory:");
  repo = new ChatStateRepo(db);
});

describe("PinnedStatusManager", () => {
  it("creates + pins a fresh status message on first flush", async () => {
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    expect(bot.sent).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
    expect(repo.getPinnedMessageId(1)).toBe(999);
  });

  it("edits the existing pinned message on subsequent flushes", async () => {
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    psm.setWorking(1, "fixing navbar");
    await psm.flushNow(1);
    expect(bot.sent).toHaveLength(1);
    expect(bot.edits).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
  });

  it("debounces multiple state changes within window", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 1000 });
    psm.setIdle(1);
    psm.setWorking(1, "a");
    psm.setWorking(1, "b");
    await vi.advanceTimersByTimeAsync(500);
    expect(bot.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(bot.sent).toHaveLength(1);
    vi.useRealTimers();
  });

  it("respects pin_paused: skips flush entirely", async () => {
    const bot = makeBot();
    repo.setPinPaused(1, true);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    expect(bot.sent).toHaveLength(0);
    expect(bot.edits).toHaveLength(0);
  });

  it("re-creates pinned message when edit fails (message gone)", async () => {
    const bot = makeBot();
    // Override the first call to push the args (so bot.edits records the
    // attempt) and then reject. mockRejectedValueOnce alone would replace
    // the implementation entirely and skip the push.
    bot.api.editMessageText.mockImplementationOnce(async (...args: unknown[]) => {
      bot.edits.push(args);
      throw new Error("message to edit not found");
    });
    repo.setPinnedMessageId(1, 999);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    expect(bot.edits).toHaveLength(1); // First attempt
    expect(bot.sent).toHaveLength(1); // Recreate
    expect(bot.pins).toHaveLength(1);
  });

  it("enablePin: clears pin_paused, sends + pins fresh message", async () => {
    const bot = makeBot();
    repo.setPinPaused(1, true);
    repo.setPinnedMessageId(1, 555);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.enablePin(1);
    expect(repo.getPinPaused(1)).toBe(false);
    expect(bot.sent).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
  });

  it("pausePin: sets pin_paused", async () => {
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    await psm.pausePin(1);
    expect(repo.getPinPaused(1)).toBe(true);
  });

  it("renders Idle status with project + session + model + deploy", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    repo.setModel(1, "anthropic/claude-sonnet-4-5");
    repo.setCoolifyApp(1, "/workspace/site", "uuid-1", "site.example.com");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    expect(sentText).toContain("Idle");
    expect(sentText).toContain("site"); // project name (last segment)
    expect(sentText).toContain("ses_abc");
    expect(sentText).toContain("claude-sonnet-4-5");
    expect(sentText).toContain("site.example.com");
  });

  it("renders Working status with detail line", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setWorking(1, "fixing navbar mobile responsive");
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    expect(sentText).toContain("Working");
    expect(sentText).toContain("fixing navbar");
  });
});
