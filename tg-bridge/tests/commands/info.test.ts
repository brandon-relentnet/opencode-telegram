import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

// Mock branch-info so /info doesn't shell out to git in tests. Each test
// sets the desired return value via vi.mocked(getGitInfo).mockResolvedValue.
vi.mock("../../src/branch-info.js", () => ({
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

import { getGitInfo } from "../../src/branch-info.js";
import { handleInfo } from "../../src/commands/info.js";

function makeFakeClient(overrides?: Partial<OpencodeClient>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    getSession: vi.fn(async () => ({
      id: "ses_20c68175dffel3P1LclRHnoz2v",
      directory: "/workspace/bltft-gold",
      slug: "clever-meadow",
      time: { created: Date.now() - 47 * 60_000, updated: Date.now() },
    })),
    getModelContextLimit: vi.fn(async () => 200_000),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
    ...overrides,
  } as OpencodeClient;
}

describe("handleInfo", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
    vi.mocked(getGitInfo).mockClear();
    // Default: a fully-populated git repo.
    vi.mocked(getGitInfo).mockResolvedValue({
      branch: "main",
      status: { modified: 3, untracked: 1 },
      ahead: 3,
      behind: 0,
      lastCommit: {
        sha: "abc123",
        message: "feat: add auth",
        ageMs: 15 * 60_000,
      },
      remote: "brandon-relentnet/bltft-gold",
    });
  });

  it("renders all sections when fully populated", async () => {
    state.setProject(1, "/workspace/bltft-gold", "ses_20c68175dffel3P1LclRHnoz2v");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    state.setSessionSlug(1, "clever-meadow");
    state.setBranch(1, "main");
    state.setAgentMode(1, "build");
    state.setSessionStartedAt(1, Date.now() - 47 * 60_000);
    state.setContextLimit(1, 200_000);
    state.setLastDeployAt(1, Date.now() - 12 * 60_000);
    state.setCoolifyApp(1, "/workspace/bltft-gold", "abc-123", "bltft.relentnet.dev");
    state.incrementCumulativeStats(1, {
      tokensInput: 23_000,
      tokensOutput: 481,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      costMicros: 420_000, // $0.42
    });

    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleInfo(ctx as never, { client, state });

    const text = ctx.reply.mock.calls[0]![0] as string;
    const opts = ctx.reply.mock.calls[0]![1] as { parse_mode?: string };
    expect(opts.parse_mode).toBe("HTML");
    // Project section (📁 + project basename)
    expect(text).toMatch(/📁/);
    expect(text).toMatch(/bltft-gold/);
    expect(text).toMatch(/<code>\/workspace\/bltft-gold<\/code>/);
    expect(text).toMatch(/brandon-relentnet\/bltft-gold/);
    // Git section
    expect(text).toMatch(/Branch.*main/s);
    expect(text).toMatch(/3 modified/);
    expect(text).toMatch(/1 untracked/);
    expect(text).toMatch(/feat: add auth/);
    // Session section
    expect(text).toMatch(/clever-meadow/);
    expect(text).toMatch(/ses_20c68175/); // ID present (full or truncated)
    // Model section
    expect(text).toMatch(/anthropic\/claude-sonnet-4-5/);
    expect(text).toMatch(/build/);
    expect(text).toMatch(/200,000/);
    expect(text).toMatch(/\$0\.42/);
    // Deploy section
    expect(text).toMatch(/bltft\.relentnet\.dev/);
    expect(text).toMatch(/abc-123/);
  });

  it("falls back when no project is switched", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleInfo(ctx as never, { client, state });

    const text = ctx.reply.mock.calls[0]![0] as string;
    expect(text).toMatch(/no project|\/switch/i);
    // No git/session/etc. sections should be rendered without a project.
    expect(client.getSession).not.toHaveBeenCalled();
    expect(getGitInfo).not.toHaveBeenCalled();
  });

  it("renders 'not a git repository' for non-git project", async () => {
    state.setProject(1, "/workspace/notgit", "ses_x");
    vi.mocked(getGitInfo).mockResolvedValue({
      branch: null,
      status: { modified: 0, untracked: 0 },
      ahead: 0,
      behind: 0,
      lastCommit: null,
      remote: null,
    });

    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleInfo(ctx as never, { client, state });

    const text = ctx.reply.mock.calls[0]![0] as string;
    expect(text).toMatch(/not a git repository/i);
    // The project section still renders.
    expect(text).toMatch(/notgit/);
  });

  it("omits the Deploy section when no Coolify app is set", async () => {
    state.setProject(1, "/workspace/bltft-gold", "ses_x");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    // No setCoolifyApp call.

    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleInfo(ctx as never, { client, state });

    const text = ctx.reply.mock.calls[0]![0] as string;
    expect(text).not.toMatch(/Deploy/);
    expect(text).not.toMatch(/Dashboard/);
  });

  it("falls back to chat_state values when client.getSession throws", async () => {
    state.setProject(1, "/workspace/bltft-gold", "ses_cached");
    state.setSessionSlug(1, "cached-slug");
    state.setSessionStartedAt(1, Date.now() - 10 * 60_000);

    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient({
      getSession: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    // Should not throw.
    await handleInfo(ctx as never, { client, state });

    const text = ctx.reply.mock.calls[0]![0] as string;
    // Cached slug + ID must still appear.
    expect(text).toMatch(/cached-slug/);
    expect(text).toMatch(/ses_cached/);
  });
});
