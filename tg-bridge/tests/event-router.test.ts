import { describe, it, expect, vi } from "vitest";
import { EventRouter, type SessionEventHandler } from "../src/event-router.js";
import type { OpencodeClient } from "../src/opencode-client.js";

interface Pushable<T> {
  push(value: T): void;
  end(): void;
  iterable(): AsyncIterable<T>;
}

function makePushable<T>(): Pushable<T> {
  const queue: T[] = [];
  let resolveNext: ((value: IteratorResult<T>) => void) | null = null;
  let ended = false;
  return {
    push(v) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: v, done: false });
      } else {
        queue.push(v);
      }
    },
    end() {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
    iterable() {
      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          return {
            next() {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false });
              }
              if (ended) {
                return Promise.resolve({ value: undefined as never, done: true });
              }
              return new Promise<IteratorResult<T>>((resolve) => {
                resolveNext = resolve;
              });
            },
          };
        },
      };
    },
  };
}

const TEST_DIR = "/workspace/test";

/**
 * Build a client that, for any subscribeToEvents(signal, directory) call,
 * returns the single supplied stream. Used by tests that only need one
 * directory's worth of events.
 */
function makeClientWithStream(stream: AsyncIterable<unknown>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => stream),
  } as OpencodeClient;
}

/**
 * Build a client that returns a different stream per `directory` argument.
 * Use to test that events from one dir don't leak to another's handlers.
 */
function makeClientWithStreamMap(map: Map<string, AsyncIterable<unknown>>): OpencodeClient {
  const subscribe = vi.fn(
    (_signal: AbortSignal, directory?: string): AsyncIterable<unknown> => {
      if (!directory) throw new Error("test: subscribe called without directory");
      const stream = map.get(directory);
      if (!stream) throw new Error(`test: no stream registered for ${directory}`);
      return stream;
    },
  );
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    subscribeToEvents: subscribe,
  } as OpencodeClient;
}

function makeHandler(): SessionEventHandler {
  return {
    onPartUpdated: vi.fn(),
    onIdle: vi.fn(),
    onError: vi.fn(),
    onPermissionUpdated: vi.fn(),
  };
}

/** Wait for the next microtask tick to let async iteration drain. */
const tick = () => new Promise((r) => setImmediate(r));

describe("EventRouter — dispatch", () => {
  it("dispatches message.part.updated to the handler for that session", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    pushable.push({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" },
        delta: "hi",
      },
    });

    await tick();
    expect(handler.onPartUpdated).toHaveBeenCalledWith({
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "hi",
    });

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("ignores events for unregistered sessions", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    pushable.push({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_x", sessionID: "ses_unknown", messageID: "msg_x", type: "text", text: "hi" },
        delta: "hi",
      },
    });
    await tick();

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches session.idle and session.error", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    pushable.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
    pushable.push({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "Boom", message: "x" } },
    });
    await tick();

    expect(handler.onIdle).toHaveBeenCalledOnce();
    expect(handler.onError).toHaveBeenCalledOnce();

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches permission.asked (the actual event opencode 1.14.32 emits) to the handler", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    // Real shape captured from opencode 1.14.32 server.
    const perm = {
      id: "per_real",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["pwd"],
      metadata: {},
      always: ["pwd *"],
      tool: { messageID: "msg_1", callID: "toolu_1" },
    };
    pushable.push({ type: "permission.asked", properties: perm });
    await tick();

    expect(handler.onPermissionUpdated).toHaveBeenCalledWith(perm);

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches permission.updated to the handler for the matching sessionID", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    const perm = {
      id: "perm_x",
      sessionID: "ses_1",
      title: "Allow bash?",
      type: "bash",
      input: { command: "ls" },
    };
    pushable.push({ type: "permission.updated", properties: perm });
    await tick();

    expect(handler.onPermissionUpdated).toHaveBeenCalledWith(perm);

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("logs a warning when a known event type has no routable sessionID", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const log = { warn: vi.fn() };
    const router = new EventRouter(client, log);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    // session.error with no sessionID — must not be silently dropped.
    pushable.push({
      type: "session.error",
      properties: { error: { name: "ApiError", message: "infra failure" } },
    });
    await tick();

    expect(log.warn).toHaveBeenCalledWith(
      { eventType: "session.error" },
      "unrouted opencode event",
    );

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("does not warn for unknown/ignored event types with no sessionID", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const log = { warn: vi.fn() };
    const router = new EventRouter(client, log);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    pushable.push({ type: "server.connected", properties: {} });
    await tick();

    expect(log.warn).not.toHaveBeenCalled();

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("unregister stops further dispatch to the handler", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    const unregister = router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    unregister();
    pushable.push({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_y", sessionID: "ses_1", messageID: "msg_y", type: "text", text: "x" },
        delta: "x",
      },
    });
    await tick();
    expect(handler.onPartUpdated).not.toHaveBeenCalled();

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches question.asked to onQuestionAsked", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const onQuestionAsked = vi.fn();
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle: vi.fn(),
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      onQuestionAsked,
    });
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    const questionRequest = {
      id: "qst_1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
        },
      ],
    };
    pushable.push({ type: "question.asked", properties: questionRequest });
    await tick();

    expect(onQuestionAsked).toHaveBeenCalledTimes(1);
    expect(onQuestionAsked.mock.calls[0]![0]).toEqual(questionRequest);

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches question.replied to onQuestionReplied", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const onQuestionReplied = vi.fn();
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle: vi.fn(),
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      onQuestionReplied,
    });
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    const reply = { sessionID: "ses_1", requestID: "qst_1", answers: [["A"]] };
    pushable.push({ type: "question.replied", properties: reply });
    await tick();

    expect(onQuestionReplied).toHaveBeenCalledTimes(1);
    expect(onQuestionReplied.mock.calls[0]![0]).toEqual(reply);

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches question.rejected to onQuestionRejected", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const onQuestionRejected = vi.fn();
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle: vi.fn(),
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      onQuestionRejected,
    });
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    const rejection = { sessionID: "ses_1", requestID: "qst_1" };
    pushable.push({ type: "question.rejected", properties: rejection });
    await tick();

    expect(onQuestionRejected).toHaveBeenCalledTimes(1);
    expect(onQuestionRejected.mock.calls[0]![0]).toEqual(rejection);

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("does not crash when handler omits optional question methods, and continues dispatching", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const onIdle = vi.fn();
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle,
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      // intentionally no onQuestionAsked / onQuestionReplied / onQuestionRejected
    });
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    const questionRequest = {
      id: "qst_1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick one",
          header: "Choice",
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
        },
      ],
    };
    pushable.push({ type: "question.asked", properties: questionRequest });
    // Following event must still be delivered — proves the dispatch loop
    // didn't swallow the iteration on the optional-method no-op.
    pushable.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await tick();

    expect(onIdle).toHaveBeenCalledOnce();

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("isolates handler exceptions so dispatch loop continues past a throwing handler", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const log = { error: vi.fn() };
    const router = new EventRouter(client, log);
    const onQuestionAsked = vi.fn(() => {
      throw new Error("handler boom");
    });
    const onIdle = vi.fn();
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle,
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      onQuestionAsked,
    });
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, [TEST_DIR]);

    pushable.push({
      type: "question.asked",
      properties: { id: "qst_1", sessionID: "ses_1", questions: [] },
    });
    // If the throw escaped, the for-await-of in subscriptionLoop would catch
    // it and break out before processing the next event. Asserting onIdle
    // fires proves dispatch survived.
    pushable.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await tick();

    expect(onQuestionAsked).toHaveBeenCalledOnce();
    expect(onIdle).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "question.asked", sessionId: "ses_1" }),
      "session event handler threw",
    );

    ac.abort();
    pushable.end();
    await runPromise;
  });
});

describe("EventRouter — multi-directory subscriptions", () => {
  it("opens one subscription per initial directory and passes the directory to subscribeToEvents", async () => {
    const a = makePushable<unknown>();
    const b = makePushable<unknown>();
    const map = new Map<string, AsyncIterable<unknown>>([
      ["/workspace/a", a.iterable()],
      ["/workspace/b", b.iterable()],
    ]);
    const client = makeClientWithStreamMap(map);
    const router = new EventRouter(client);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, ["/workspace/a", "/workspace/b"]);

    await tick();
    const calls = (client.subscribeToEvents as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const dirs = calls.map((c) => c[1]).sort();
    expect(dirs).toEqual(["/workspace/a", "/workspace/b"]);

    ac.abort();
    a.end();
    b.end();
    await runPromise;
  });

  it("ensureDirectory is idempotent — duplicate calls don't open extra subscriptions", async () => {
    const a = makePushable<unknown>();
    const map = new Map<string, AsyncIterable<unknown>>([
      ["/workspace/a", a.iterable()],
    ]);
    const client = makeClientWithStreamMap(map);
    const router = new EventRouter(client);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, []);

    expect(router.ensureDirectory("/workspace/a")).toBe(true);
    expect(router.ensureDirectory("/workspace/a")).toBe(false); // already open
    expect(router.ensureDirectory("/workspace/a")).toBe(false);

    await tick();
    expect((client.subscribeToEvents as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    ac.abort();
    a.end();
    await runPromise;
  });

  it("ensureDirectory ignores empty/blank input", async () => {
    const client = makeClientWithStreamMap(new Map());
    const router = new EventRouter(client);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, []);

    expect(router.ensureDirectory("")).toBe(false);
    expect(router.ensureDirectory(undefined as unknown as string)).toBe(false);

    expect((client.subscribeToEvents as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    ac.abort();
    await runPromise;
  });

  it("events from one directory's stream don't reach handlers via the wrong subscription", async () => {
    // Both directories deliver a session-routed event; verify the handler
    // sees both events (since handler routing is by sessionID, not by dir).
    // The point of this test is that both subscriptions are active and
    // independent — neither blocks the other.
    const a = makePushable<unknown>();
    const b = makePushable<unknown>();
    const map = new Map<string, AsyncIterable<unknown>>([
      ["/workspace/a", a.iterable()],
      ["/workspace/b", b.iterable()],
    ]);
    const client = makeClientWithStreamMap(map);
    const router = new EventRouter(client);
    const handlerA = makeHandler();
    const handlerB = makeHandler();
    router.registerSession("ses_a", handlerA);
    router.registerSession("ses_b", handlerB);

    const ac = new AbortController();
    const runPromise = router.start(ac.signal, ["/workspace/a", "/workspace/b"]);

    a.push({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", sessionID: "ses_a", messageID: "m1", type: "text", text: "from-a" },
      },
    });
    b.push({
      type: "message.part.updated",
      properties: {
        part: { id: "p2", sessionID: "ses_b", messageID: "m2", type: "text", text: "from-b" },
      },
    });
    await tick();

    expect(handlerA.onPartUpdated).toHaveBeenCalledOnce();
    expect(handlerB.onPartUpdated).toHaveBeenCalledOnce();
    expect(handlerA.onPartUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ text: "from-a" }),
    );
    expect(handlerB.onPartUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ text: "from-b" }),
    );

    ac.abort();
    a.end();
    b.end();
    await runPromise;
  });

  it("ensureDirectory called after start() opens a new subscription on demand", async () => {
    const a = makePushable<unknown>();
    const map = new Map<string, AsyncIterable<unknown>>([
      ["/workspace/a", a.iterable()],
    ]);
    const client = makeClientWithStreamMap(map);
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_a", handler);

    const ac = new AbortController();
    const runPromise = router.start(ac.signal, []); // no initial dirs

    // No subscriptions opened yet
    await tick();
    expect((client.subscribeToEvents as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // Lazy add (e.g. /switch fired)
    expect(router.ensureDirectory("/workspace/a")).toBe(true);
    await tick();

    // Now an event flows
    a.push({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", sessionID: "ses_a", messageID: "m1", type: "text", text: "delivered" },
      },
    });
    await tick();
    expect(handler.onPartUpdated).toHaveBeenCalledOnce();

    ac.abort();
    a.end();
    await runPromise;
  });

  it("ensureDirectory is a no-op once the parent signal has aborted", async () => {
    const client = makeClientWithStreamMap(new Map());
    const router = new EventRouter(client);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal, []);
    ac.abort();
    await runPromise;

    expect(router.ensureDirectory("/workspace/late")).toBe(false);
    expect((client.subscribeToEvents as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
