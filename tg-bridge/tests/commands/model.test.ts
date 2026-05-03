import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleModel } from "../../src/commands/model.js";
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
        { id: "anthropic", models: { "claude-sonnet-4-5": {} } },
        { id: "openai", models: { "gpt-5": {} } },
      ],
      default: { anthropic: "claude-sonnet-4-5", openai: "gpt-5" },
    })),
    respondToPermission: vi.fn(async () => true),
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("handleModel", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("with no arg, lists providers and shows current model", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    const ctx = makeFakeCtx({ chatId: 1, match: "" });
    const client = makeFakeClient();
    await handleModel(ctx as never, { client, state });
    const text = ctx.reply.mock.calls[0]![0] as string;
    // Telegram MarkdownV2 escapes `-`, so we tolerate the backslashes.
    expect(text).toMatch(/claude\\?-sonnet\\?-4\\?-5/);
    expect(text).toMatch(/anthropic/);
    expect(text).toMatch(/openai/);
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
