import { createOpencodeClient } from "@opencode-ai/sdk";
import type {
  Session as SdkSession,
  Project as SdkProject,
} from "@opencode-ai/sdk";

/**
 * Wraps a `fetch` implementation so every request carries HTTP Basic
 * authentication using the configured credentials.
 *
 * The returned function has the standard `(input, init?)` shape so it can
 * be consumed by general fetch users; an SDK-shaped adapter (`Request` →
 * `Response`) is built on top of it inside `makeOpencodeClient`.
 *
 * Important behaviour with `Request` inputs: when the SDK calls us with a
 * fully-built `Request`, we MUST preserve the request's existing headers
 * (notably `Content-Type: application/json`). Naively passing
 * `{ headers: <only Auth> }` as the second arg replaces the original
 * headers entirely (verified in Node 22's undici), producing a JSON body
 * sent without the JSON content-type → opencode can't parse it → it
 * rejects with `expected array, received undefined at parts`. So when
 * `input` is already a `Request`, we construct a new `Request` that
 * merges its existing headers with our Authorization header.
 */
export function buildAuthFetch(
  inner: typeof fetch,
  username: string,
  password: string,
): typeof fetch {
  const authHeader =
    "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return async (input, init) => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      if (!headers.has("Authorization")) headers.set("Authorization", authHeader);
      // Spreading any caller-supplied init lets URL-targeted callers
      // continue to work, but realistically the SDK only passes a Request
      // and no init.
      return inner(new Request(input, { ...(init ?? {}), headers }));
    }
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", authHeader);
    return inner(input, { ...(init ?? {}), headers });
  };
}

export interface OpencodeClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
}

/**
 * Minimal interface the rest of the bridge depends on. Implemented by the
 * SDK-backed client below; can also be implemented by test fakes.
 *
 * Named with a `Bridge` prefix to avoid colliding with the SDK's exported
 * `OpencodeClient` class.
 */
export interface BridgeOpencodeClient {
  /**
   * Create a session. When `options.directory` is provided, opencode anchors
   * the session to that worktree (auto-creating a Project entry if one
   * doesn't already exist). Without it, the session falls back to the
   * server's CWD ("/workspace" in our container) and ends up under the
   * "global" project.
   */
  createSession(
    title?: string,
    options?: { directory?: string },
  ): Promise<{ id: string }>;
  abortSession(sessionId: string): Promise<boolean>;
  listSessions(): Promise<SdkSession[]>;
  /**
   * Send a prompt. `options.model` selects the model (otherwise opencode
   * picks its default, which may not match the provider account the bridge
   * has authenticated against). `options.directory` re-anchors the turn to
   * a specific worktree.
   */
  prompt(
    sessionId: string,
    text: string,
    options?: {
      model?: { providerID: string; modelID: string };
      directory?: string;
    },
  ): Promise<unknown>;
  listProjects(): Promise<SdkProject[]>;
  listProviders(): Promise<{ providers: unknown[]; default: Record<string, string> }>;
  /**
   * Fetch session metadata (id + directory). Used by Question / Permission
   * services to learn the worktree the session was anchored at, so subsequent
   * reply / reject / respond POSTs can carry the correct `?directory=` query
   * (see comment on `respondToQuestion` for the routing-by-directory bug).
   *
   * The route returns the session regardless of the request's `?directory=`
   * (sessions are persisted globally), so we can call this from anywhere.
   */
  getSession(sessionId: string): Promise<{ id: string; directory: string }>;
  /**
   * Respond to a permission request.
   *
   * `response` is the bridge-level intent: `"allow"` or `"deny"`. The SDK
   * exposes `"once" | "always" | "reject"`; we map `(allow, remember=true)`
   * to `"always"`, `(allow, !remember)` to `"once"`, and `deny` to `"reject"`.
   *
   * `directory` MUST match the session's worktree. opencode's permission
   * registry is per-instance (keyed by directory); a respond without the
   * matching `?directory=` lands in opencode's CWD instance, fails to find
   * the pending request, and silently no-ops while still returning 200.
   */
  respondToPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember?: boolean,
    directory?: string,
  ): Promise<boolean>;
  /**
   * Submit answers for a question request.
   *
   * `answers` has one entry per question in the original request, in the
   * same order. Each entry is the array of selected option labels;
   * single-select wraps a single label in an array; multi-select includes
   * all selected; custom-typed answers are appended as raw strings.
   *
   * `directory` MUST match the session's worktree. opencode's question
   * registry is per-instance (keyed by directory); without the matching
   * `?directory=` query, `Question.reply` finds no pending entry, returns
   * 200/`true` while logging `WARN reply for unknown request`, and the
   * agent's `question` tool stays blocked indefinitely. The bug is
   * silent: callers get success but the answer never reaches the model.
   *
   * Returns the SDK's success flag (typically true for 2xx).
   */
  respondToQuestion(
    requestId: string,
    answers: Array<Array<string>>,
    directory?: string,
  ): Promise<boolean>;
  /**
   * Reject a pending question request. Used by the bridge when it can no
   * longer collect answers (e.g. internal timeout, persistent submit
   * failure). opencode treats this as the question being cancelled; the
   * agent's `question` tool returns rejected.
   *
   * `directory` MUST match the session's worktree (same caveat as
   * `respondToQuestion`).
   */
  rejectQuestion(requestId: string, directory?: string): Promise<boolean>;
  /**
   * Subscribe to opencode's SSE event stream. The stream is
   * directory-scoped server-side: pass `directory` to receive events for
   * sessions in that worktree. Without a directory, opencode delivers
   * only events for its container CWD (`/workspace`), missing events
   * for project-anchored sessions like `/workspace/cbg-invoices`.
   */
  subscribeToEvents(signal: AbortSignal, directory?: string): AsyncIterable<unknown>;
}

/**
 * Alias for downstream consumers. The plan and downstream tasks reference
 * this name; the implementation is `BridgeOpencodeClient`. Both names refer
 * to the same shape; use either.
 */
export type OpencodeClient = BridgeOpencodeClient;

/**
 * Adapt a standard `(input, init)` fetch into the SDK's expected
 * `(request: Request) => ReturnType<typeof fetch>` shape. We re-issue the
 * request through `inner` so the auth wrapper still applies.
 */
function toSdkFetch(inner: typeof fetch): (request: Request) => ReturnType<typeof fetch> {
  return (request) => inner(request);
}

export function makeOpencodeClient(opts: OpencodeClientOptions): BridgeOpencodeClient {
  const innerFetch = opts.fetch ?? fetch;
  const authFetch = buildAuthFetch(innerFetch, opts.username, opts.password);
  const client = createOpencodeClient({
    baseUrl: opts.baseUrl,
    fetch: toSdkFetch(authFetch),
    // `throwOnError: true` makes the SDK throw on non-2xx; with the default
    // `responseStyle: "fields"`, successful results expose the parsed body
    // under `.data`. We extract `.data` at each call site.
    throwOnError: true,
  });

  return {
    async createSession(title, options) {
      const { data } = await client.session.create({
        body: title === undefined ? {} : { title },
        ...(options?.directory ? { query: { directory: options.directory } } : {}),
      });
      if (!data || typeof data.id !== "string") {
        throw new Error("createSession: unexpected response shape");
      }
      return { id: data.id };
    },

    async abortSession(sessionId) {
      const { data } = await client.session.abort({
        path: { id: sessionId },
      });
      return Boolean(data);
    },

    async listSessions() {
      const { data } = await client.session.list();
      return data ?? [];
    },

    async prompt(sessionId, text, options) {
      const body = {
        ...(options?.model ? { model: options.model } : {}),
        parts: [{ type: "text" as const, text }],
      };
      // promptAsync returns immediately (HTTP 204-ish) instead of holding
      // the connection open for the agent's full lifecycle. The bridge's
      // completion + streaming UX is purely SSE-driven via EventRouter, so
      // we don't need the sync /session/{id}/message endpoint's blocking
      // semantics. Using the sync endpoint caused "prompt failed: fetch
      // failed" on long-running tasks (Node 22 undici bodyTimeout +
      // intermediate idle timeouts kill the connection ~2-3 min in).
      const { data } = await client.session.promptAsync({
        path: { id: sessionId },
        body,
        ...(options?.directory ? { query: { directory: options.directory } } : {}),
      });
      return data;
    },

    async listProjects() {
      const { data } = await client.project.list();
      return data ?? [];
    },

    async listProviders() {
      const { data } = await client.config.providers();
      if (!data) {
        throw new Error("listProviders: empty response");
      }
      return data;
    },

    async getSession(sessionId) {
      const { data } = await client.session.get({
        path: { id: sessionId },
      });
      if (!data || typeof data.id !== "string" || typeof data.directory !== "string") {
        throw new Error("getSession: unexpected response shape");
      }
      return { id: data.id, directory: data.directory };
    },

    async respondToPermission(sessionId, permissionId, response, remember, directory) {
      // Map bridge-level (allow/deny + remember) onto SDK enum.
      const sdkResponse: "once" | "always" | "reject" =
        response === "deny" ? "reject" : remember ? "always" : "once";
      const { data } = await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response: sdkResponse },
        // Forward the session's directory so opencode routes to the right
        // instance — see the JSDoc on the interface method for why this is
        // load-bearing.
        ...(directory ? { query: { directory } } : {}),
      });
      return Boolean(data);
    },

    async respondToQuestion(requestId, answers, directory) {
      // The v1 SDK pinned in this project (@opencode-ai/sdk@1.14.32) has
      // no question API — `client.question.reply` only exists in v2. To
      // avoid a SDK migration in Task 2, call the HTTP endpoint directly
      // through authFetch (same pattern as `subscribeToEvents` for SSE).
      // The HTTP contract is stable across v1/v2.
      return await postQuestionEndpoint(
        opts.baseUrl,
        authFetch,
        requestId,
        "reply",
        { answers },
        directory,
      );
    },

    async rejectQuestion(requestId, directory) {
      return await postQuestionEndpoint(
        opts.baseUrl,
        authFetch,
        requestId,
        "reject",
        undefined,
        directory,
      );
    },

    async *subscribeToEvents(signal, directory) {
      // We deliberately bypass the SDK's `client.event.subscribe()` here.
      //
      // The SDK's SSE implementation
      // (node_modules/@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.js)
      // calls the GLOBAL `fetch` directly — it ignores the `fetch` option
      // we passed to `createOpencodeClient`. As a result, every SSE
      // subscription request goes out WITHOUT our Basic auth header,
      // opencode returns 401, the SDK retries with backoff (capped at
      // 30s), and the bridge never receives a single session event.
      //
      // Using our `authFetch` directly + a hand-rolled SSE parser solves
      // the auth problem and keeps the parser simple (we only consume
      // `data:` lines as JSON; opencode doesn't use `event:`/`id:`/`retry:`
      // for the events we care about).
      yield* sseStream(opts.baseUrl, authFetch, signal, directory);
    },
  };
}

/**
 * POST to `/question/{requestID}/{action}` through the authenticated
 * fetch wrapper. Returns the parsed JSON body coerced to boolean — both
 * endpoints respond with a literal `true` on success.
 *
 * Throws on non-2xx so callers can distinguish "submitted, opencode said
 * no" (returns false) from "network/HTTP failure" (throws).
 */
async function postQuestionEndpoint(
  baseUrl: string,
  authFetch: typeof fetch,
  requestId: string,
  action: "reply" | "reject",
  body: Record<string, unknown> | undefined,
  directory: string | undefined,
): Promise<boolean> {
  const url = new URL(`/question/${encodeURIComponent(requestId)}/${action}`, baseUrl);
  // Without ?directory=, opencode's InstanceMiddleware falls back to the
  // server's CWD (`/workspace` in our container) and finds no pending
  // question — see JSDoc on `respondToQuestion`.
  if (directory) url.searchParams.set("directory", directory);
  const response = await authFetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    throw new Error(
      `question.${action} failed: ${response.status} ${response.statusText}`,
    );
  }
  const data: unknown = await response.json().catch(() => null);
  return Boolean(data);
}

/**
 * Authenticated SSE consumer for opencode's `/event` endpoint.
 *
 * Why hand-rolled instead of the SDK helper: see comment in
 * `subscribeToEvents` above — the SDK's SSE module bypasses our
 * authenticated fetch wrapper, producing 401 on every request.
 *
 * Yields the parsed JSON object from each `data:` line. Re-throws on
 * network/HTTP errors so the caller (EventRouter) can apply its own
 * reconnect/backoff policy.
 */
async function* sseStream(
  baseUrl: string,
  authFetch: typeof fetch,
  signal: AbortSignal,
  directory: string | undefined,
): AsyncGenerator<unknown, void, undefined> {
  const url = new URL("/event", baseUrl);
  if (directory) url.searchParams.set("directory", directory);

  const response = await authFetch(url.toString(), {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("SSE response had no body");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      // SSE event boundary is a blank line (\n\n). Anything left after
      // the last \n\n is a partial event for the next iteration.
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const data = parseSseChunk(chunk);
        if (data !== undefined) yield data;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // noop — already released or stream cancelled
    }
  }
}

/**
 * Parse a single SSE chunk (lines separated by \n) and return the parsed
 * JSON value of its `data:` payload, or `undefined` if the chunk has no
 * data line / is unparseable.
 *
 * Supports multi-line `data:` (concatenated with \n per the SSE spec).
 * Ignores `event:`, `id:`, `retry:`, and comment lines (`:`-prefixed).
 */
function parseSseChunk(chunk: string): unknown {
  const lines = chunk.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      // The space after `data:` is optional per the spec.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // Ignore other field types — opencode doesn't use them for the
    // events we consume.
  }
  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join("\n");
  try {
    return JSON.parse(raw);
  } catch {
    // Malformed JSON — drop. opencode's events should always be JSON
    // but a heartbeat or comment may slip through.
    return undefined;
  }
}
