import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleNew } from "../../src/commands/new.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(overrides: Partial<OpencodeClient> = {}): OpencodeClient {
  return {
    createSession: vi.fn(async () => ({ id: "ses_new" })),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(async () => ({})),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
    ...overrides,
  } as OpencodeClient;
}

describe("handleNew", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("prompts the user to /switch first when no project is set", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleNew(ctx as never, { client, state });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/\/switch/);
  });

  it("creates a new session anchored to the current project and updates state", async () => {
    state.setProject(1, "/workspace/myapp", "ses_old");
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleNew(ctx as never, { client, state });

    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.createSession).toHaveBeenCalledWith("tg:myapp", {
      directory: "/workspace/myapp",
    });
    expect(client.prompt).not.toHaveBeenCalled();
    const stored = state.get(1)!;
    expect(stored.projectPath).toBe("/workspace/myapp");
    expect(stored.sessionId).toBe("ses_new");
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/new session/i);
  });

  it("surfaces a friendly error when createSession fails", async () => {
    state.setProject(1, "/workspace/myapp", "ses_old");
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient({
      createSession: vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal
        throw { name: "BadRequest", message: "boom" };
      }),
    });
    await handleNew(ctx as never, { client, state });
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/failed to start new session.*boom/i);
    // Session id wasn't updated since create failed
    expect(state.get(1)!.sessionId).toBe("ses_old");
  });
});
