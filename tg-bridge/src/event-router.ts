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

type EventLogger = Pick<Logger, "warn">;

export class EventRouter {
  private handlers = new Map<string, SessionEventHandler>();

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

  async start(signal: AbortSignal): Promise<void> {
    let backoffMs = 500;
    while (!signal.aborted) {
      try {
        for await (const evt of this.client.subscribeToEvents(signal)) {
          backoffMs = 500; // reset on any successful event
          this.dispatch(evt as RawEvent);
        }
        // Stream ended cleanly. If we're not aborted, reconnect.
        if (signal.aborted) return;
      } catch (err) {
        if (signal.aborted) return;
        // fall through to backoff
      }
      await this.sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  private dispatch(evt: RawEvent): void {
    // Per the SDK, only some event types carry a top-level `properties.sessionID`.
    // For `message.part.updated`, the sessionID lives on `properties.part.sessionID`.
    const sessionId = this.extractSessionId(evt);
    if (!sessionId) {
      // Known event type with no routable sessionID — surface it so we don't lose
      // infrastructure-level errors (e.g. session.error without a sessionID) silently.
      if (this.isKnownType(evt.type)) {
        this.log?.warn({ eventType: evt.type }, "unrouted opencode event");
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
