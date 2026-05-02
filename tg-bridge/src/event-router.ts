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

export class EventRouter {
  private handlers = new Map<string, SessionEventHandler>();

  constructor(private client: OpencodeClient) {}

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
    const sessionId =
      typeof evt.properties?.sessionID === "string" ? evt.properties.sessionID : undefined;
    if (!sessionId) return;
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
