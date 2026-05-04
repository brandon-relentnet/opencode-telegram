import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { handleProjects, handleProjectCallback } from "../../src/commands/projects.js";
import { ChatStateRepo } from "../../src/chat-state.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(): OpencodeClient {
  return {
    createSession: vi.fn(async (_title: string, _opts?: { directory?: string }) => ({
      id: "ses_new",
    })),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ id: "ses_x", directory: "/workspace" })),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("handleProjects", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "ws-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("renders an inline keyboard with one button per subdirectory", async () => {
    mkdirSync(join(workspaceRoot, "myapp"));
    mkdirSync(join(workspaceRoot, "blog"));
    mkdirSync(join(workspaceRoot, "scripts"));
    writeFileSync(join(workspaceRoot, "README.md"), "ignore me");

    const ctx = makeFakeCtx();
    await handleProjects(ctx as never, { workspaceRoot });

    expect(ctx.reply).toHaveBeenCalledOnce();
    const opts = ctx.reply.mock.calls[0]![1] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    const rows = opts?.reply_markup?.inline_keyboard ?? [];
    expect(rows.length).toBe(3);
    // Alphabetical
    expect(rows[0]![0]!.text).toBe("blog");
    expect(rows[1]![0]!.text).toBe("myapp");
    expect(rows[2]![0]!.text).toBe("scripts");
    expect(rows[0]![0]!.callback_data).toBe("proj:blog");
    expect(rows[1]![0]!.callback_data).toBe("proj:myapp");
    expect(rows[2]![0]!.callback_data).toBe("proj:scripts");
  });

  it("ignores hidden directories", async () => {
    mkdirSync(join(workspaceRoot, ".git"));
    mkdirSync(join(workspaceRoot, "myapp"));
    const ctx = makeFakeCtx();
    await handleProjects(ctx as never, { workspaceRoot });
    const opts = ctx.reply.mock.calls[0]![1] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> };
    };
    const datas = (opts.reply_markup?.inline_keyboard ?? []).map((r) => r[0]!.callback_data);
    expect(datas).toEqual(["proj:myapp"]);
  });

  it("reports when no projects are present", async () => {
    const ctx = makeFakeCtx();
    await handleProjects(ctx as never, { workspaceRoot });
    const [text] = ctx.reply.mock.calls[0]!;
    expect(String(text)).toMatch(/no projects/i);
  });
});

describe("handleProjectCallback", () => {
  let workspaceRoot: string;
  let state: ChatStateRepo;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "ws-"));
    state = new ChatStateRepo(new Database(":memory:"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeCtx(opts: { chatId?: number; data?: string }) {
    const reply = vi.fn(
      async (_text: string, _opts?: Record<string, unknown>) => ({ message_id: 999 }),
    );
    const answerCallbackQuery = vi.fn(async (_text?: string) => undefined);
    return {
      chat: { id: opts.chatId ?? 1 },
      reply,
      answerCallbackQuery,
      callbackQuery: opts.data ? { data: opts.data } : undefined,
    };
  }

  it("creates a session in the picked project, persists state, and notifies", async () => {
    mkdirSync(join(workspaceRoot, "site"));
    const ctx = makeCtx({ chatId: 7, data: "proj:site" });
    const router = { ensureDirectory: vi.fn(() => true) };
    const pinnedStatus = { notifyStateChange: vi.fn() };
    const client = makeFakeClient();

    await handleProjectCallback(ctx as never, {
      client,
      state,
      workspaceRoot,
      router,
      pinnedStatus: pinnedStatus as never,
    });

    expect(client.createSession).toHaveBeenCalledWith("tg:site", {
      directory: join(workspaceRoot, "site"),
    });
    expect(state.get(7)?.projectPath).toBe(join(workspaceRoot, "site"));
    expect(state.get(7)?.sessionId).toBe("ses_new");
    expect(router.ensureDirectory).toHaveBeenCalledWith(join(workspaceRoot, "site"));
    expect(pinnedStatus.notifyStateChange).toHaveBeenCalledWith(7);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("ignores callback data without proj: prefix", async () => {
    const ctx = makeCtx({ chatId: 7, data: "other:foo" });
    const router = { ensureDirectory: vi.fn(() => true) };
    const pinnedStatus = { notifyStateChange: vi.fn() };
    const client = makeFakeClient();

    await handleProjectCallback(ctx as never, {
      client,
      state,
      workspaceRoot,
      router,
      pinnedStatus: pinnedStatus as never,
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("rejects unsafe project names without creating a session", async () => {
    const ctx = makeCtx({ chatId: 7, data: "proj:../etc" });
    const router = { ensureDirectory: vi.fn(() => true) };
    const pinnedStatus = { notifyStateChange: vi.fn() };
    const client = makeFakeClient();

    await handleProjectCallback(ctx as never, {
      client,
      state,
      workspaceRoot,
      router,
      pinnedStatus: pinnedStatus as never,
    });

    expect(client.createSession).not.toHaveBeenCalled();
    expect(pinnedStatus.notifyStateChange).not.toHaveBeenCalled();
  });
});
