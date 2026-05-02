import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../src/chat-state.js";
import { handleTextMessage } from "../src/message-handler.js";
import { makeFakeCtx } from "./helpers/fake-ctx.js";
import type { OpencodeClient } from "../src/opencode-client.js";
import type { SessionEventHandler } from "../src/event-router.js";

interface FakeRouter {
  registerSession: ReturnType<typeof vi.fn>;
  registered: SessionEventHandler | null;
  unregister: ReturnType<typeof vi.fn>;
}

function makeRouter(): FakeRouter {
  const router: FakeRouter = {
    registered: null,
    unregister: vi.fn(),
    registerSession: vi.fn(),
  };
  router.registerSession.mockImplementation((_id: string, handler: SessionEventHandler) => {
    router.registered = handler;
    return router.unregister;
  });
  return router;
}

function makeClient(promptImpl?: (...a: unknown[]) => Promise<unknown>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(promptImpl ?? (async () => ({}))),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

function makeBot() {
  return {
    editMessageText: vi.fn(
      async (_chatId: number, _messageId: number, _text: string, _opts: unknown) => undefined,
    ),
    sendMessage: vi.fn(
      async (_chatId: number, _text: string, _opts: unknown) => ({ message_id: 999 }),
    ),
  };
}

describe("handleTextMessage", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("prompts the user to /switch when no project is set", async () => {
    const ctx = makeFakeCtx({ chatId: 1, text: "hi" });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/\/switch/);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("with project+session: sends placeholder, registers handler, calls client.prompt", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "do the thing" });
    // Emulate placeholder send via ctx.reply (returning the placeholder message id)
    ctx.reply.mockResolvedValue({ message_id: 555 });

    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(router.registerSession).toHaveBeenCalledWith("ses_a", expect.any(Object));
    expect(client.prompt).toHaveBeenCalledWith("ses_a", "do the thing", undefined);
  });

  it("passes the configured model to client.prompt", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    const ctx = makeFakeCtx({ chatId: 1, text: "hello" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(client.prompt).toHaveBeenCalledWith("ses_a", "hello", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    });
  });

  it("on prompt rejection: shows error via the placeholder message and unregisters", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "x" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();
    const client = makeClient(async () => {
      throw new Error("boom");
    });
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(bot.editMessageText).toHaveBeenCalled();
    const args = bot.editMessageText.mock.calls[0]!;
    expect(String(args[2])).toMatch(/boom/);
    expect(router.unregister).toHaveBeenCalled();
  });

  it("permission events route to PermissionService.sendRequest", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "x" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    const permissions = { sendRequest: vi.fn(async () => undefined) };
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: permissions as never,
    });
    const handler = router.registered!;
    handler.onPermissionUpdated({ id: "p1", sessionID: "ses_a", title: "ok?", type: "bash" });
    expect(permissions.sendRequest).toHaveBeenCalledWith(1, "ses_a", expect.objectContaining({ id: "p1" }));
  });
});
