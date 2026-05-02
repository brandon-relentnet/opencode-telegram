import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleStatus } from "../../src/commands/status.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

describe("handleStatus", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("reports 'no project' when chat state is empty", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    await handleStatus(ctx as never, { state });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/no project/i);
  });

  it("includes project, session, and default-model marker when partially set", async () => {
    state.setProject(1, "/workspace/blog", "ses_42");
    const ctx = makeFakeCtx({ chatId: 1 });
    await handleStatus(ctx as never, { state });
    const text = ctx.reply.mock.calls[0]![0] as string;
    expect(text).toMatch(/blog/);
    // Telegram MarkdownV2 escapes `_`, so the rendered text contains `ses\_42`.
    expect(text).toMatch(/ses\\?_42/);
    expect(text).toMatch(/default/i);
  });

  it("includes the explicitly-set model", async () => {
    state.setProject(1, "/workspace/blog", "ses_42");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    const ctx = makeFakeCtx({ chatId: 1 });
    await handleStatus(ctx as never, { state });
    const text = ctx.reply.mock.calls[0]![0] as string;
    // Telegram MarkdownV2 escapes `-`, so the rendered text contains `claude\-sonnet\-4\-5`.
    expect(text).toMatch(/claude\\?-sonnet\\?-4\\?-5/);
  });
});
