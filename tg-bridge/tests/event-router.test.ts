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

function makeClientWithStream(stream: AsyncIterable<unknown>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => stream),
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

describe("EventRouter", () => {
  it("dispatches message.part.updated to the handler for that session", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal);

    pushable.push({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" },
        delta: "hi",
      },
    });

    await new Promise((r) => setImmediate(r));
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
    const runPromise = router.start(ac.signal);

    pushable.push({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_x", sessionID: "ses_unknown", messageID: "msg_x", type: "text", text: "hi" },
        delta: "hi",
      },
    });
    await new Promise((r) => setImmediate(r));
    // No throw, no crash.

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
    const runPromise = router.start(ac.signal);

    pushable.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
    pushable.push({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "Boom", message: "x" } },
    });
    await new Promise((r) => setImmediate(r));

    expect(handler.onIdle).toHaveBeenCalledOnce();
    expect(handler.onError).toHaveBeenCalledOnce();

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
    const runPromise = router.start(ac.signal);

    const perm = {
      id: "perm_x",
      sessionID: "ses_1",
      title: "Allow bash?",
      type: "bash",
      input: { command: "ls" },
    };
    pushable.push({ type: "permission.updated", properties: perm });
    await new Promise((r) => setImmediate(r));

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
    const runPromise = router.start(ac.signal);

    // session.error with no sessionID — must not be silently dropped.
    pushable.push({
      type: "session.error",
      properties: { error: { name: "ApiError", message: "infra failure" } },
    });
    await new Promise((r) => setImmediate(r));

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
    const runPromise = router.start(ac.signal);

    pushable.push({ type: "server.connected", properties: {} });
    await new Promise((r) => setImmediate(r));

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
    const runPromise = router.start(ac.signal);

    unregister();
    pushable.push({
      type: "message.part.updated",
      properties: {
        part: { id: "prt_y", sessionID: "ses_1", messageID: "msg_y", type: "text", text: "x" },
        delta: "x",
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(handler.onPartUpdated).not.toHaveBeenCalled();

    ac.abort();
    pushable.end();
    await runPromise;
  });
});
