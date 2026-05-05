import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PinnedStatusManager } from "../src/pinned-status.js";
import { ChatStateRepo } from "../src/chat-state.js";

// Mock branch-info so the PSM doesn't actually shell out to git in tests.
// Each test resets the mocks via vi.mocked(...).mockResolvedValue(...).
vi.mock("../src/branch-info.js", () => ({
  getCurrentBranch: vi.fn(async () => null),
  getGitInfo: vi.fn(async () => ({
    branch: null,
    status: { modified: 0, untracked: 0 },
    ahead: 0,
    behind: 0,
    lastCommit: null,
    remote: null,
  })),
}));

import { getCurrentBranch, getGitInfo } from "../src/branch-info.js";

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
  // Reset branch-info mocks to "no git" defaults so each test starts clean.
  vi.mocked(getCurrentBranch).mockResolvedValue(null);
  vi.mocked(getGitInfo).mockResolvedValue({
    branch: null,
    status: { modified: 0, untracked: 0 },
    ahead: 0,
    behind: 0,
    lastCommit: null,
    remote: null,
  });
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
    // Use a chat_state mutation (project change) since that DOES change the
    // rendered pinned text. setIdle → setWorking would render identically
    // (status detail was dropped from the pinned layout in Task 6) and the
    // fingerprint cache would correctly suppress the edit.
    repo.setProject(1, "/workspace/new-proj", "ses_xyz");
    psm.notifyStateChange(1);
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

  it("renders project + model + Coolify deploy line", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    repo.setModel(1, "anthropic/claude-sonnet-4-5");
    repo.setCoolifyApp(1, "/workspace/site", "uuid-1", "site.example.com");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    // Project basename on line 1.
    expect(sentText).toContain("<b>site</b>");
    // Shortened model id on line 2.
    expect(sentText).toContain("sonnet-4-5");
    // Coolify line 3.
    expect(sentText).toContain("site.example.com");
    // Sessions/Model/Deploy/Info button row (no Switch project / New session).
    const opts = bot.sent[0]![2] as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    const flat = opts.reply_markup.inline_keyboard.flat();
    const labels = flat.map((b) => b.text);
    expect(labels).toEqual(["Sessions", "Model", "Deploy", "Info"]);
    const cbs = flat.map((b) => b.callback_data);
    expect(cbs).toEqual(["pin:sessions", "pin:model", "pin:deploy", "pin:info"]);
  });

  it("renders em-dash placeholders when project has no model/branch/tokens yet", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setWorking(1, "fixing navbar mobile responsive");
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    // Line 1: project · — · —  (no branch, no agent mode).
    expect(sentText).toContain("<b>site</b>");
    expect(sentText).toContain("· — · —");
    // Line 2: all em-dashes for unknown model + tokens + cost.
    expect(sentText).toContain("— · —/— ctx · —");
  });

  it("shows branch on line 1 when project has a git branch", async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue("feature-x");
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    repo.setAgentMode(1, "build");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    const firstLine = sentText.split("\n")[0]!;
    expect(firstLine).toBe("🟢 <b>site</b> · feature-x · build");
    // chat_state.branch is persisted from the live read so /info can show it.
    expect(repo.getBranch(1)).toBe("feature-x");
  });

  it("shows cumulative token usage on line 2 when chat_state has tokens", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    repo.setModel(1, "anthropic/claude-sonnet-4-5");
    repo.setContextLimit(1, 200_000);
    repo.incrementCumulativeStats(1, {
      tokensInput: 20_000,
      tokensOutput: 3_000,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      costMicros: 420_000,
    });
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    const secondLine = sentText.split("\n")[1]!;
    // 23k = 20k input + 3k output, /200k limit, $0.42 cost.
    expect(secondLine).toBe("sonnet-4-5 · 23k/200k ctx · $0.42");
  });

  it("shows ahead+dirty git line when getGitInfo returns ahead > 0", async () => {
    vi.mocked(getCurrentBranch).mockResolvedValue("main");
    vi.mocked(getGitInfo).mockResolvedValue({
      branch: "main",
      status: { modified: 2, untracked: 1 },
      ahead: 3,
      behind: 0,
      lastCommit: null,
      remote: null,
    });
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    // Find the git line — should contain 3 ahead and 3 dirty (2+1).
    expect(sentText).toContain("🔀 3 ahead · 3 dirty");
  });
});

describe("PinnedStatusManager no-spam (Bug A)", () => {
  it("isMessageNotModifiedError detects telegram's no-op response", async () => {
    const { isMessageNotModifiedError } = await import("../src/pinned-status.js");
    expect(isMessageNotModifiedError({ description: "Bad Request: message is not modified" })).toBe(true);
    expect(isMessageNotModifiedError({ message: "Bad Request: message is not modified: ..." })).toBe(true);
    // Case-insensitive
    expect(isMessageNotModifiedError({ description: "MESSAGE IS NOT MODIFIED" })).toBe(true);
    // Other errors should NOT match
    expect(isMessageNotModifiedError({ description: "Bad Request: message to edit not found" })).toBe(false);
    expect(isMessageNotModifiedError({ description: "Forbidden: bot was blocked" })).toBe(false);
    expect(isMessageNotModifiedError(null)).toBe(false);
    expect(isMessageNotModifiedError(undefined)).toBe(false);
    expect(isMessageNotModifiedError("string error")).toBe(false);
  });

  it("skips Telegram API call when content fingerprint unchanged", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/x", "ses_abc");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    expect(bot.sent).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
    // Second flush with no state change — should NOT call edit at all.
    psm.notifyStateChange(1);
    await psm.flushNow(1);
    expect(bot.edits).toHaveLength(0);
    expect(bot.sent).toHaveLength(1); // still just the initial pin
  });

  it("treats 'message is not modified' error as success (no recreate)", async () => {
    const bot = makeBot();
    // Simulate the cache being out of sync (e.g. PSM restarted): editMessageText
    // is called and Telegram replies with "not modified". Bridge must NOT
    // recreate the pinned message in this case.
    bot.api.editMessageText = vi.fn(async () => {
      const err: { description: string } = {
        description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content",
      };
      throw err;
    });
    repo.setProject(1, "/workspace/x", "ses_abc");
    repo.setPinnedMessageId(1, 999);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    // editMessageText was attempted (bot.api.editMessageText was called)
    expect(vi.mocked(bot.api.editMessageText)).toHaveBeenCalledTimes(1);
    // sendMessage was NOT called (no recreate)
    expect(bot.sent).toHaveLength(0);
    expect(bot.pins).toHaveLength(0);
    // pinned_message_id stays at 999
    expect(repo.getPinnedMessageId(1)).toBe(999);
  });

  it("still recreates on real 'message to edit not found' error", async () => {
    const bot = makeBot();
    bot.api.editMessageText = vi.fn(async () => {
      throw { description: "Bad Request: message to edit not found" };
    });
    repo.setProject(1, "/workspace/x", "ses_abc");
    repo.setPinnedMessageId(1, 999);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    // edit attempted, then recreate path fires
    expect(bot.sent).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
    expect(repo.getPinnedMessageId(1)).toBe(999);
  });

  it("fingerprint cache is per-chat (chat 2 doesn't see chat 1's cache)", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/x", "ses_abc");
    repo.setProject(2, "/workspace/y", "ses_def");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    psm.setIdle(2);
    await psm.flushNow(2);
    // Both chats got their own pin
    expect(bot.sent).toHaveLength(2);
  });

  it("successful edit caches new fingerprint to short-circuit subsequent flush", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/x", "ses_abc");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    // Triggering a REAL render change (project change) → edit fires
    repo.setProject(1, "/workspace/y", "ses_def");
    psm.notifyStateChange(1);
    await psm.flushNow(1);
    expect(bot.edits).toHaveLength(1);
    // Same state again → fingerprint short-circuits, no second edit
    psm.notifyStateChange(1);
    await psm.flushNow(1);
    expect(bot.edits).toHaveLength(1);
  });
});
