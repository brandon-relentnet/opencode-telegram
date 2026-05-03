import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleAbort } from "../../src/commands/abort.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(abortImpl?: (id: string) => Promise<boolean>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(abortImpl ?? (async () => true)),
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

describe("handleAbort", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("replies with an instruction when no session is active", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleAbort(ctx as never, { client, state });
    expect(client.abortSession).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/no active session/i);
  });

  it("calls client.abortSession with the current session id", async () => {
    state.setProject(1, "/workspace/a", "ses_x");
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleAbort(ctx as never, { client, state });
    expect(client.abortSession).toHaveBeenCalledWith("ses_x");
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/aborted/i);
  });

  it("reports failure if abort returns false", async () => {
    state.setProject(1, "/workspace/a", "ses_x");
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient(async () => false);
    await handleAbort(ctx as never, { client, state });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/could not abort|nothing to abort/i);
  });
});
