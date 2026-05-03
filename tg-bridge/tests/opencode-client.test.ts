import { describe, it, expect, vi } from "vitest";
import { buildAuthFetch, makeOpencodeClient } from "../src/opencode-client.js";

describe("buildAuthFetch", () => {
  it("adds an Authorization: Basic header with base64-encoded user:pass", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "opencode", "secret");

    await wrapped("http://opencode:4096/global/health");

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const init = (call[1] ?? {}) as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(
      "Basic " + Buffer.from("opencode:secret").toString("base64"),
    );
  });

  it("preserves existing headers and body", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    await wrapped("http://opencode:4096/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const init = (call[1] ?? {}) as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toMatch(/^Basic /);
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("works when init is undefined", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    await wrapped("http://opencode:4096/x");

    expect(inner).toHaveBeenCalledOnce();
    const init = ((inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] ?? {}) as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toMatch(/^Basic /);
  });

  it("preserves Content-Type and body when input is a fully-built Request (the SDK case)", async () => {
    // Regression: Node 22's fetch, when given (request, init={headers}),
    // REPLACES the request's headers with init.headers — so a naive impl
    // would drop Content-Type: application/json on requests built by the
    // SDK and opencode would then reject the body as "expected array,
    // received undefined at parts".
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    const original = new Request("http://opencode:4096/session/abc/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "preserved" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
    await wrapped(original);

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sentRequest = call[0] as Request;
    expect(sentRequest).toBeInstanceOf(Request);
    expect(sentRequest.headers.get("Content-Type")).toBe("application/json");
    expect(sentRequest.headers.get("X-Custom")).toBe("preserved");
    expect(sentRequest.headers.get("Authorization")).toMatch(/^Basic /);
    expect(sentRequest.method).toBe("POST");
    expect(await sentRequest.text()).toBe(
      JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    );
  });
});

/**
 * Build an SSE response body from an array of event objects.
 * Each event becomes one `data: <json>\n\n` block.
 */
function makeSseResponseBody(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      }
      controller.close();
    },
  });
}

describe("subscribeToEvents (custom SSE)", () => {
  it("uses the authenticated fetch wrapper (Authorization header is set on the SSE GET)", async () => {
    // Regression: the SDK's bundled SSE module bypasses our custom fetch
    // and uses bare global fetch — producing 401 on every request and
    // silently breaking event delivery to the bridge. This test asserts
    // that our hand-rolled SSE consumer goes through authFetch.
    const events = [{ type: "server.connected", properties: {} }];
    const innerFetch = vi.fn(
      async (_input, _init) =>
        new Response(makeSseResponseBody(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const ac = new AbortController();
    const collected: unknown[] = [];
    for await (const evt of client.subscribeToEvents(ac.signal)) {
      collected.push(evt);
    }
    ac.abort();

    expect(collected).toEqual(events);
    // Confirm the GET went through our auth wrapper.
    const call = (innerFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const init = (call[1] ?? {}) as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toMatch(/^Basic /);
    expect(new Headers(init.headers).get("Accept")).toBe("text/event-stream");
  });

  it("appends ?directory=... to the SSE URL when directory is provided", async () => {
    const events: unknown[] = [];
    const innerFetch = vi.fn(
      async (_input, _init) =>
        new Response(makeSseResponseBody(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const ac = new AbortController();
    for await (const _evt of client.subscribeToEvents(ac.signal, "/workspace/myapp")) {
      // drain
    }
    ac.abort();

    const call = (innerFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = new URL(call[0] as string);
    expect(url.pathname).toBe("/event");
    expect(url.searchParams.get("directory")).toBe("/workspace/myapp");
  });

  it("yields each parsed JSON event in order", async () => {
    const events = [
      { type: "server.connected", properties: {} },
      {
        type: "message.part.updated",
        properties: { part: { sessionID: "s1", id: "p1", type: "text", text: "hello" } },
      },
      { type: "session.idle", properties: { sessionID: "s1" } },
    ];
    const innerFetch = vi.fn(
      async () =>
        new Response(makeSseResponseBody(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const ac = new AbortController();
    const collected: unknown[] = [];
    for await (const evt of client.subscribeToEvents(ac.signal)) {
      collected.push(evt);
    }
    ac.abort();

    expect(collected).toEqual(events);
  });

  it("throws on non-2xx response so the EventRouter can apply backoff", async () => {
    const innerFetch = vi.fn(
      async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const ac = new AbortController();
    await expect(async () => {
      for await (const _ of client.subscribeToEvents(ac.signal)) {
        // nothing
      }
    }).rejects.toThrow(/SSE failed: 401/);
  });

  it("handles a chunk split across multiple reads (partial event buffering)", async () => {
    // Build a body that emits the JSON in multiple chunks split mid-event.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"a"'));
        controller.enqueue(encoder.encode(',"properties":{}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"b","properties":{}}\n'));
        controller.enqueue(encoder.encode("\n"));
        controller.close();
      },
    });
    const innerFetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const ac = new AbortController();
    const collected: unknown[] = [];
    for await (const evt of client.subscribeToEvents(ac.signal)) {
      collected.push(evt);
    }
    expect(collected).toEqual([
      { type: "a", properties: {} },
      { type: "b", properties: {} },
    ]);
  });
});

/**
 * The bridge currently imports `@opencode-ai/sdk` v1 (1.14.32), which has
 * no question API at all (only added in `@opencode-ai/sdk/v2`). To stay
 * within Task 2's scope (no SDK migration), `respondToQuestion` and
 * `rejectQuestion` are implemented by calling opencode's HTTP endpoints
 * directly through the project's existing `authFetch` wrapper, mirroring
 * the same approach used for SSE in `subscribeToEvents`.
 *
 * Tests therefore inject a fake `fetch` (existing project convention) and
 * assert URL, method, headers, and body. The HTTP contract is stable
 * across v1 and v2 of the SDK.
 */
describe("respondToQuestion", () => {
  it("POSTs answers to /question/{requestID}/reply with the auth header and JSON body", async () => {
    const innerFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(true), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const result = await client.respondToQuestion("qst_abc", [["A", "B"], ["C"]]);

    expect(result).toBe(true);
    const call = (innerFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = new URL(call[0] as string);
    expect(url.pathname).toBe("/question/qst_abc/reply");
    const init = (call[1] ?? {}) as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toMatch(/^Basic /);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      answers: [["A", "B"], ["C"]],
    });
  });

  it("returns false when opencode responds with falsy data", async () => {
    const innerFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(false), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const result = await client.respondToQuestion("qst_x", []);
    expect(result).toBe(false);
  });
});

describe("rejectQuestion", () => {
  it("POSTs to /question/{requestID}/reject with the auth header", async () => {
    const innerFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(true), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const client = makeOpencodeClient({
      baseUrl: "http://opencode.test:4096",
      username: "u",
      password: "p",
      fetch: innerFetch,
    });

    const result = await client.rejectQuestion("qst_xyz");

    expect(result).toBe(true);
    const call = (innerFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = new URL(call[0] as string);
    expect(url.pathname).toBe("/question/qst_xyz/reject");
    const init = (call[1] ?? {}) as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toMatch(/^Basic /);
  });
});
