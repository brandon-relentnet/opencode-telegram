import type { Logger } from "pino";
import type { OpencodeClient } from "./opencode-client.js";

export interface SessionEventHandler {
  onPartUpdated(part: unknown): void;
  onIdle(): void;
  onError(err: unknown): void;
  onPermissionUpdated(perm: unknown): void;
}

interface RawEvent {
  type: string;
  properties?: Record<string, unknown> & { sessionID?: string };
}

type EventLogger = Partial<Pick<Logger, "warn" | "info">>;

/**
 * EventRouter maintains one SSE subscription PER project directory.
 *
 * opencode's `/event` endpoint is directory-scoped: subscribing without a
 * `directory` query param only delivers events for opencode's CWD
 * (`/workspace`). Sessions in `/workspace/<project>` emit events to the
 * `/event?directory=/workspace/<project>` scope. Without a per-directory
 * subscription, the bridge sees `server.connected`/`server.heartbeat`
 * but never `message.part.updated` or `session.idle` for project
 * sessions — the placeholder hangs at "thinking…" forever.
 *
 * Subscriptions are keyed by directory path. `ensureDirectory(dir)` is
 * idempotent; `start()` opens an initial set seeded from chat-state.
 * Each per-directory loop runs its own backoff/reconnect, all gated on
 * the parent abort signal.
 */
export class EventRouter {
  private handlers = new Map<string, SessionEventHandler>();
  private subscriptions = new Map<string, AbortController>();
  private parentSignal: AbortSignal | undefined;

  constructor(
    private client: OpencodeClient,
    private log?: EventLogger,
  ) {}

  registerSession(sessionId: string, handler: SessionEventHandler): () => void {
    this.handlers.set(sessionId, handler);
    return () => {
      const current = this.handlers.get(sessionId);
      if (current === handler) this.handlers.delete(sessionId);
    };
  }

  /**
   * Open per-directory SSE subscriptions for the given initial set, and
   * keep them open until `signal` aborts. Returns when all subscriptions
   * have ended (i.e. when `signal` is aborted).
   */
  async start(signal: AbortSignal, initialDirectories: string[] = []): Promise<void> {
    this.parentSignal = signal;
    // De-dup the initial set; tolerate falsy entries from upstream.
    const dirs = Array.from(new Set(initialDirectories.filter((d) => typeof d === "string" && d.length > 0)));
    for (const dir of dirs) this.openSubscription(dir);

    // When the parent signal aborts, abort all sub-subscriptions.
    const onAbort = () => {
      for (const ac of this.subscriptions.values()) ac.abort();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    // Wait for shutdown.
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /**
   * Idempotently ensure a SSE subscription exists for `directory`.
   * Safe to call multiple times for the same directory; only the first
   * call opens a connection. Returns true if a new subscription was
   * opened, false if one already existed.
   */
  ensureDirectory(directory: string): boolean {
    if (typeof directory !== "string" || directory.length === 0) return false;
    if (this.subscriptions.has(directory)) return false;
    if (this.parentSignal?.aborted) return false;
    this.openSubscription(directory);
    return true;
  }

  private openSubscription(directory: string): void {
    const ac = new AbortController();
    this.subscriptions.set(directory, ac);
    // Cascade the parent shutdown.
    if (this.parentSignal) {
      const onParentAbort = () => ac.abort();
      this.parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    // Fire-and-forget; the loop manages its own backoff and exits when ac aborts.
    void this.subscriptionLoop(directory, ac.signal);
  }

  private async subscriptionLoop(directory: string, signal: AbortSignal): Promise<void> {
    let backoffMs = 500;
    this.log?.info?.({ directory }, "opencode event subscription opening");
    while (!signal.aborted) {
      try {
        for await (const evt of this.client.subscribeToEvents(signal, directory)) {
          backoffMs = 500; // reset on any successful event
          this.dispatch(evt as RawEvent);
        }
        if (signal.aborted) break;
        // Stream ended cleanly; reconnect after a short pause.
      } catch (err) {
        if (signal.aborted) break;
        this.log?.warn?.({ directory, err }, "opencode event subscription errored, will reconnect");
      }
      await this.sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
    this.subscriptions.delete(directory);
    this.log?.info?.({ directory }, "opencode event subscription closed");
  }

  private dispatch(evt: RawEvent): void {
    // Per the SDK, only some event types carry a top-level `properties.sessionID`.
    // For `message.part.updated`, the sessionID lives on `properties.part.sessionID`.
    const sessionId = this.extractSessionId(evt);
    if (!sessionId) {
      // Known event type with no routable sessionID — surface it so we don't lose
      // infrastructure-level errors (e.g. session.error without a sessionID) silently.
      if (this.isKnownType(evt.type)) {
        this.log?.warn?.({ eventType: evt.type }, "unrouted opencode event");
      }
      return;
    }
    const handler = this.handlers.get(sessionId);
    if (!handler) return;

    switch (evt.type) {
      case "message.part.updated": {
        const part = (evt.properties as { part?: unknown }).part;
        if (part) handler.onPartUpdated(part);
        return;
      }
      case "session.idle":
        handler.onIdle();
        return;
      case "session.error": {
        const error = (evt.properties as { error?: unknown }).error ?? new Error("session error");
        handler.onError(error);
        return;
      }
      // opencode 1.14.32 publishes `permission.asked` when the agent first
      // requests a permission (the SDK types still claim `permission.updated`,
      // but the server emits `.asked`). We accept both for forward compat.
      case "permission.asked":
      case "permission.updated":
        handler.onPermissionUpdated(evt.properties);
        return;
      default:
        return; // ignore other event types in Phase 1
    }
  }

  private extractSessionId(evt: RawEvent): string | undefined {
    if (evt.type === "message.part.updated") {
      const part = (evt.properties as { part?: { sessionID?: string } } | undefined)?.part;
      return typeof part?.sessionID === "string" ? part.sessionID : undefined;
    }
    const direct = evt.properties?.sessionID;
    return typeof direct === "string" ? direct : undefined;
  }

  private isKnownType(type: string): boolean {
    return (
      type === "message.part.updated" ||
      type === "session.idle" ||
      type === "session.error" ||
      type === "permission.asked" ||
      type === "permission.updated"
    );
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
