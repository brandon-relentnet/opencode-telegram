import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleModel, handleModelCallback } from "../../src/commands/model.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({
      providers: [
        { id: "anthropic", models: { "claude-sonnet-4-5": {}, "claude-opus-4-7": {} } },
        { id: "openai", models: { "gpt-5": {} } },
      ],
      default: { anthropic: "claude-sonnet-4-5", openai: "gpt-5" },
    })),
    respondToPermission: vi.fn(async () => true),
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ id: "ses_x", directory: "/workspace" })),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("handleModel (no arg)", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("renders an inline keyboard listing provider/model IDs", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, match: "" });
    const client = makeFakeClient();
    await handleModel(ctx as never, { client, state });

    const opts = ctx.reply.mock.calls[0]![1] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    };
    const rows = opts?.reply_markup?.inline_keyboard ?? [];
    const datas = rows.map((r) => r[0]!.callback_data);
    expect(datas).toContain("model:anthropic/claude-sonnet-4-5");
    expect(datas).toContain("model:anthropic/claude-opus-4-7");
    expect(datas).toContain("model:openai/gpt-5");
    // Texts are the human-readable provider/model strings
    expect(rows[0]![0]!.text).toMatch(/\//);
  });

  it("falls back to a friendly message when listProviders fails", async () => {
    const ctx = makeFakeCtx({ chatId: 1, match: "" });
    const client = makeFakeClient();
    (client.listProviders as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await handleModel(ctx as never, { client, state });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/failed to list providers/i);
  });
});

describe("handleModel (with arg) — preserves text-set behaviour", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("rejects an arg without a slash", async () => {
    const ctx = makeFakeCtx({ chatId: 1, match: "anthropic" });
    const client = makeFakeClient();
    await handleModel(ctx as never, { client, state });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/format/i);
  });

  it("stores a valid providerID/modelID and confirms", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, match: "openai/gpt-5" });
    const client = makeFakeClient();
    await handleModel(ctx as never, { client, state });
    expect(state.get(1)!.model).toBe("openai/gpt-5");
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/gpt\\?-5/);
  });
});

describe("handleModelCallback", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
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

  it("sets the model and notifies pinned status", async () => {
    state.setProject(7, "/workspace/site", "ses_a");
    const pinnedStatus = { notifyStateChange: vi.fn() };
    const client = makeFakeClient();
    const ctx = makeCtx({ chatId: 7, data: "model:openai/gpt-5" });

    await handleModelCallback(ctx as never, {
      client,
      state,
      pinnedStatus: pinnedStatus as never,
    });

    expect(state.get(7)?.model).toBe("openai/gpt-5");
    expect(pinnedStatus.notifyStateChange).toHaveBeenCalledWith(7);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("ignores callback data without model: prefix", async () => {
    const pinnedStatus = { notifyStateChange: vi.fn() };
    const client = makeFakeClient();
    const ctx = makeCtx({ chatId: 7, data: "other:foo" });
    await handleModelCallback(ctx as never, {
      client,
      state,
      pinnedStatus: pinnedStatus as never,
    });
    expect(pinnedStatus.notifyStateChange).not.toHaveBeenCalled();
  });

  it("rejects malformed model IDs without persisting", async () => {
    const pinnedStatus = { notifyStateChange: vi.fn() };
    const client = makeFakeClient();
    const ctx = makeCtx({ chatId: 7, data: "model:bogus" });
    await handleModelCallback(ctx as never, {
      client,
      state,
      pinnedStatus: pinnedStatus as never,
    });
    expect(state.get(7)?.model).toBeFalsy();
    expect(pinnedStatus.notifyStateChange).not.toHaveBeenCalled();
  });
});
