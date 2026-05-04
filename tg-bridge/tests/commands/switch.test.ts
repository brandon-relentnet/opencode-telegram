import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleSwitch, isSafeProjectName, buildSwitchConfirmation } from "../../src/commands/switch.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(overrides: Partial<OpencodeClient> = {}): OpencodeClient {
  return {
    createSession: vi.fn(async () => ({ id: "ses_new" })),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(async () => ({ data: { info: {}, parts: [] } })),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn((_signal) => (async function* () {})()),
    ...overrides,
  } as OpencodeClient;
}

function makeRouter() {
  return { ensureDirectory: vi.fn(() => true) };
}

describe("handleSwitch", () => {
  let workspaceRoot: string;
  let state: ChatStateRepo;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(workspaceRoot, "myapp"));
    state = new ChatStateRepo(new Database(":memory:"));
  });

  afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  it("rejects when no argument is given", async () => {
    const ctx = makeFakeCtx({ match: "" });
    const client = makeFakeClient();
    const router = makeRouter();
    await handleSwitch(ctx as never, { client, state, workspaceRoot, router });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/usage/i);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(router.ensureDirectory).not.toHaveBeenCalled();
  });

  it("rejects an unknown project", async () => {
    const ctx = makeFakeCtx({ match: "missing" });
    const client = makeFakeClient();
    const router = makeRouter();
    await handleSwitch(ctx as never, { client, state, workspaceRoot, router });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/no such project/i);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(router.ensureDirectory).not.toHaveBeenCalled();
  });

  it("rejects path-traversal arguments", async () => {
    const ctx = makeFakeCtx({ match: "../etc" });
    const client = makeFakeClient();
    const router = makeRouter();
    await handleSwitch(ctx as never, { client, state, workspaceRoot, router });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/invalid/i);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(router.ensureDirectory).not.toHaveBeenCalled();
  });

  it("creates a new session anchored to the project directory, stores state, AND opens an SSE subscription for the directory", async () => {
    const ctx = makeFakeCtx({ chatId: 42, match: "myapp" });
    const client = makeFakeClient();
    const router = makeRouter();
    await handleSwitch(ctx as never, { client, state, workspaceRoot, router });

    // Session created with the directory query param so opencode anchors the
    // session to the worktree (auto-creating a Project record). NO seed prompt
    // is sent — the directory parameter conveys the worktree natively.
    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.createSession).toHaveBeenCalledWith("tg:myapp", {
      directory: join(workspaceRoot, "myapp"),
    });
    expect(client.prompt).not.toHaveBeenCalled();

    const stored = state.get(42)!;
    expect(stored.projectPath).toBe(join(workspaceRoot, "myapp"));
    expect(stored.sessionId).toBe("ses_new");

    // Critical: SSE subscription opened for this directory so the user's
    // first prompt's events route correctly.
    expect(router.ensureDirectory).toHaveBeenCalledWith(join(workspaceRoot, "myapp"));

    expect(ctx.reply.mock.calls[0]![0]).toMatch(/myapp/);
  });

  it("resets CostTracker + persists session slug/started_at + clears agent_mode after switching", async () => {
    const ctx = makeFakeCtx({ chatId: 42, match: "myapp" });
    const client = makeFakeClient({
      // Widen the createSession mock to also return slug + time, mirroring
      // the v1 SDK's actual response shape (Task 4).
      createSession: vi.fn(async () => ({
        id: "ses_new",
        slug: "clever-meadow",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      })),
    });
    const router = makeRouter();
    // Pre-populate stale agent_mode so we can verify it gets cleared.
    state.setAgentMode(42, "build");
    const costTracker = { recordAssistantMessage: vi.fn(), reset: vi.fn() };
    await handleSwitch(ctx as never, {
      client,
      state,
      workspaceRoot,
      router,
      costTracker: costTracker as never,
    });

    expect(costTracker.reset).toHaveBeenCalledWith(42);
    expect(state.getSessionSlug(42)).toBe("clever-meadow");
    expect(state.getSessionStartedAt(42)).toBe(1_700_000_000_000);
    // agent_mode reset to null until the next assistant message
    expect(state.getAgentMode(42)).toBeNull();
  });

  it("surfaces a friendly error when createSession fails (instead of crashing the bot)", async () => {
    const ctx = makeFakeCtx({ chatId: 42, match: "myapp" });
    const client = makeFakeClient({
      createSession: vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal
        throw { name: "BadRequest", message: "model not found" };
      }),
    });
    const router = makeRouter();
    await handleSwitch(ctx as never, { client, state, workspaceRoot, router });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/failed to switch.*model not found/i);
    expect(state.get(42)).toBeNull();
    expect(router.ensureDirectory).not.toHaveBeenCalled();
  });
});

describe("isSafeProjectName", () => {
  it("accepts standard project names", () => {
    expect(isSafeProjectName("my-project")).toBe(true);
    expect(isSafeProjectName("foo_bar")).toBe(true);
    expect(isSafeProjectName("a")).toBe(true);
  });

  it("rejects empty, dot-prefixed, separator-containing, or absolute names", () => {
    expect(isSafeProjectName("")).toBe(false);
    expect(isSafeProjectName(".hidden")).toBe(false);
    expect(isSafeProjectName("foo/bar")).toBe(false);
    expect(isSafeProjectName("foo\\bar")).toBe(false);
    expect(isSafeProjectName("/abs/path")).toBe(false);
  });

  it("rejects whitespace and shell-meta characters", () => {
    expect(isSafeProjectName("foo bar")).toBe(false);
    expect(isSafeProjectName("foo\tbar")).toBe(false);
    expect(isSafeProjectName("foo;bar")).toBe(false);
    expect(isSafeProjectName("foo$(rm)")).toBe(false);
    expect(isSafeProjectName("foo*bar")).toBe(false);
    expect(isSafeProjectName('foo"bar')).toBe(false);
  });

  it("rejects names starting with a dash (parses like a CLI flag)", () => {
    // Regression for the /init-remote Telegram-routing bug: when /init-remote
    // got matched by the /init handler, "-remote test-repo" was passed as
    // the project name. We need to reject such inputs even before the command
    // routing is fixed.
    expect(isSafeProjectName("-remote")).toBe(false);
    expect(isSafeProjectName("-rf")).toBe(false);
  });
});

describe("buildSwitchConfirmation", () => {
  it("formats the standard switch reply with escaped fields", () => {
    expect(buildSwitchConfirmation("my-proj", "/workspace/my-proj", "ses_abc")).toBe(
      "*Switched to my\\-proj*\nProject: /workspace/my\\-proj\nSession: ses\\_abc",
    );
  });
});
