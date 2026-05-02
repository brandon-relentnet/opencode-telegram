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
 */
export function buildAuthFetch(
  inner: typeof fetch,
  username: string,
  password: string,
): typeof fetch {
  const authHeader =
    "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return async (input, init) => {
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
  createSession(title?: string): Promise<{ id: string }>;
  abortSession(sessionId: string): Promise<boolean>;
  listSessions(): Promise<SdkSession[]>;
  prompt(
    sessionId: string,
    text: string,
    options?: { model?: { providerID: string; modelID: string } },
  ): Promise<unknown>;
  listProjects(): Promise<SdkProject[]>;
  listProviders(): Promise<{ providers: unknown[]; default: Record<string, string> }>;
  /**
   * Respond to a permission request.
   *
   * `response` is the bridge-level intent: `"allow"` or `"deny"`. The SDK
   * exposes `"once" | "always" | "reject"`; we map `(allow, remember=true)`
   * to `"always"`, `(allow, !remember)` to `"once"`, and `deny` to `"reject"`.
   */
  respondToPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember?: boolean,
  ): Promise<boolean>;
  subscribeToEvents(signal: AbortSignal): AsyncIterable<unknown>;
}

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
    async createSession(title) {
      const { data } = await client.session.create({
        body: title === undefined ? {} : { title },
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
      const { data } = await client.session.prompt({
        path: { id: sessionId },
        body,
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

    async respondToPermission(sessionId, permissionId, response, remember) {
      // Map bridge-level (allow/deny + remember) onto SDK enum.
      const sdkResponse: "once" | "always" | "reject" =
        response === "deny" ? "reject" : remember ? "always" : "once";
      const { data } = await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response: sdkResponse },
      });
      return Boolean(data);
    },

    async *subscribeToEvents(signal) {
      const sub = await client.event.subscribe({ signal });
      for await (const evt of sub.stream) {
        if (signal.aborted) return;
        yield evt;
      }
    },
  };
}
