import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleSwitch } from "../../src/commands/switch.js";
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
    await handleSwitch(ctx as never, { client, state, workspaceRoot });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/usage/i);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown project", async () => {
    const ctx = makeFakeCtx({ match: "missing" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/no such project/i);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("rejects path-traversal arguments", async () => {
    const ctx = makeFakeCtx({ match: "../etc" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/invalid/i);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("creates a new session anchored to the project directory and stores state", async () => {
    const ctx = makeFakeCtx({ chatId: 42, match: "myapp" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });

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

    expect(ctx.reply.mock.calls[0]![0]).toMatch(/myapp/);
  });

  it("surfaces a friendly error when createSession fails (instead of crashing the bot)", async () => {
    const ctx = makeFakeCtx({ chatId: 42, match: "myapp" });
    const client = makeFakeClient({
      createSession: vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal
        throw { name: "BadRequest", message: "model not found" };
      }),
    });
    await handleSwitch(ctx as never, { client, state, workspaceRoot });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/failed to switch.*model not found/i);
    expect(state.get(42)).toBeNull();
  });
});
