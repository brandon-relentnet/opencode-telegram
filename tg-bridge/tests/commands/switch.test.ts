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

  it("creates a new session, seeds it with project context, and stores state", async () => {
    const ctx = makeFakeCtx({ chatId: 42, match: "myapp" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });

    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.prompt).toHaveBeenCalledOnce();
    const promptCall = (client.prompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(promptCall[0]).toBe("ses_new");
    expect(promptCall[1]).toMatch(new RegExp(join(workspaceRoot, "myapp")));

    const stored = state.get(42)!;
    expect(stored.projectPath).toBe(join(workspaceRoot, "myapp"));
    expect(stored.sessionId).toBe("ses_new");

    expect(ctx.reply.mock.calls[0]![0]).toMatch(/myapp/);
  });
});
