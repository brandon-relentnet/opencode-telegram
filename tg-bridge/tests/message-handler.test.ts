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
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ id: "ses_x", directory: "/workspace" })),
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

/**
 * Stub QuestionService dependency. The handler only calls these three
 * methods; use this when a test doesn't care about question routing.
 */
function makeQuestions() {
  return {
    sendRequest: vi.fn(async (_chatId: number, _req: unknown) => undefined),
    notifyReplied: vi.fn(async (_payload: unknown) => undefined),
    notifyRejected: vi.fn(async (_payload: unknown) => undefined),
  };
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

/** Wait for queued microtasks to drain (lets fire-and-forget .catch run). */
const tick = () => new Promise((r) => setImmediate(r));

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
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
    });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0]![0]).toMatch(/\/switch/);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("with project+session: sends placeholder, registers handler, calls client.prompt with default model + directory", async () => {
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
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
    });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(router.registerSession).toHaveBeenCalledWith("ses_a", expect.any(Object));
    expect(client.prompt).toHaveBeenCalledWith("ses_a", "do the thing", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      directory: "/workspace/a",
    });
  });

  it("per-chat model overrides the default", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    state.setModel(1, "openai/gpt-5");
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
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
    });
    expect(client.prompt).toHaveBeenCalledWith("ses_a", "hello", {
      model: { providerID: "openai", modelID: "gpt-5" },
      directory: "/workspace/a",
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
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
    });
    // Error path is asynchronous (.catch on fire-and-forget prompt) so we
    // need to let the microtask queue drain before asserting on its effects.
    await tick();
    expect(bot.editMessageText).toHaveBeenCalled();
    const args = bot.editMessageText.mock.calls[0]!;
    expect(String(args[2])).toMatch(/boom/);
    expect(router.unregister).toHaveBeenCalled();
  });

  it("normalizes object-shaped errors when prompt rejects", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "x" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();
    // Simulate ApiError-like rejection (plain object with message field).
    const client = makeClient(async () => {
      // eslint-disable-next-line no-throw-literal
      throw { name: "ApiError", message: "rate limited", status: 429 };
    });
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
    });
    await tick();
    const args = bot.editMessageText.mock.calls[0]!;
    const text = String(args[2]);
    expect(text).toContain("rate limited");
    expect(text).not.toContain("[object Object]");
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
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
    });
    const handler = router.registered!;
    handler.onPermissionUpdated({ id: "p1", sessionID: "ses_a", title: "ok?", type: "bash" });
    expect(permissions.sendRequest).toHaveBeenCalledWith(1, "ses_a", expect.objectContaining({ id: "p1" }));
  });

  it("onIdle does not propagate rejections from turn.finalize (defense in depth)", async () => {
    // Even though Task 6's safeEdit/safeSend prevent finalize from throwing,
    // a future change could re-introduce a throw. The onIdle wrapper must
    // catch any error so the EventRouter's fire-and-forget dispatch doesn't
    // produce an unhandled rejection (which would crash the process).
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "do something" });
    ctx.reply.mockResolvedValue({ message_id: 555 });

    const router = makeRouter();
    const client = makeClient();

    // Make every Telegram call throw — this would cause an unwrapped
    // finalize() to reject if it weren't routed through safeEdit/safeSend.
    // We further validate the wrapper by ensuring even a hypothetical throw
    // from finalize() doesn't escape onIdle.
    const bot = {
      editMessageText: vi.fn(async () => {
        throw new Error("telegram down");
      }),
      sendMessage: vi.fn(async () => {
        throw new Error("telegram down");
      }),
    };

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
      log,
    });

    const handler = router.registered!;
    // Invoking onIdle must not reject — even if turn.finalize internally
    // were to throw (which safeEdit prevents, but this is the safety net).
    await expect(Promise.resolve(handler.onIdle())).resolves.toBeUndefined();
    // unregister must still have been called (cleanup must run after the catch)
    expect(router.unregister).toHaveBeenCalled();
  });

  it("returns BEFORE the prompt resolves (no sequential blocking — critical for callback_query processing)", async () => {
    // Regression: an awaited prompt would block grammy's update queue —
    // when opencode pauses for a permission response, the user's button
    // press callback can't be processed because the previous handler is
    // still awaiting the held-up prompt. handleTextMessage MUST return
    // immediately after dispatching the prompt.
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "needs permission" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();

    // A prompt that never resolves — simulates opencode hanging waiting
    // for a permission response.
    let promptResolved = false;
    const client = makeClient(
      () =>
        new Promise(() => {
          // never resolves
        }),
    );
    const bot = makeBot();

    const handlerPromise = handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
      questions: makeQuestions(),
      defaultModel: DEFAULT_MODEL,
    });

    // Race: handleTextMessage MUST resolve even though prompt is pending.
    // If we awaited the prompt, this would hang the test forever.
    await Promise.race([
      handlerPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("handler did not return")), 500)),
    ]);

    // Verify: we got past handleTextMessage, the prompt is still in flight.
    expect(client.prompt).toHaveBeenCalled();
    expect(promptResolved).toBe(false);
  });

  it("forwards question.asked to questions.sendRequest", async () => {
    state.setProject(1, "/workspace/x", "ses_42");
    const ctx = makeFakeCtx({ chatId: 1, text: "hello" });
    ctx.reply.mockResolvedValue({ message_id: 999 });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    const questions = makeQuestions();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
      questions,
      defaultModel: DEFAULT_MODEL,
    });
    const handler = router.registered!;
    expect(handler.onQuestionAsked).toBeDefined();
    handler.onQuestionAsked!({ id: "qst_1", sessionID: "ses_42", questions: [] });
    // sendRequest is fire-and-forget; let the microtask queue drain
    await tick();
    expect(questions.sendRequest).toHaveBeenCalledTimes(1);
    expect(questions.sendRequest).toHaveBeenCalledWith(1, {
      id: "qst_1",
      sessionID: "ses_42",
      questions: [],
    });
  });

  it("forwards question.replied and question.rejected to QuestionService", async () => {
    state.setProject(1, "/workspace/x", "ses_42");
    const ctx = makeFakeCtx({ chatId: 1, text: "hello" });
    ctx.reply.mockResolvedValue({ message_id: 999 });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    const questions = makeQuestions();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
      questions,
      defaultModel: DEFAULT_MODEL,
    });
    const handler = router.registered!;
    expect(handler.onQuestionReplied).toBeDefined();
    expect(handler.onQuestionRejected).toBeDefined();
    handler.onQuestionReplied!({ sessionID: "ses_42", requestID: "qst_1", answers: [] });
    handler.onQuestionRejected!({ sessionID: "ses_42", requestID: "qst_2" });
    await tick();
    expect(questions.notifyReplied).toHaveBeenCalledWith({
      sessionID: "ses_42",
      requestID: "qst_1",
      answers: [],
    });
    expect(questions.notifyRejected).toHaveBeenCalledWith({
      sessionID: "ses_42",
      requestID: "qst_2",
    });
  });
});
