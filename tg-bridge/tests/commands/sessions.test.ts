import { describe, it, expect, vi } from "vitest";
import { handleSessions, handleSessionCallback } from "../../src/commands/sessions.js";

function makeCtx(opts: { chatId?: number; data?: string } = {}) {
  // Reply / answerCallbackQuery are typed with explicit parameter shapes
  // so `mock.calls[0]` is `[text, options?]` not `[]` under tsc strict
  // mode (vi.fn() with a zero-arg implementation infers a zero-tuple).
  const reply = vi.fn(
    async (_text: string, _opts?: Record<string, unknown>) => ({ message_id: 999 }),
  );
  const answerCallbackQuery = vi.fn(async (_text?: string) => undefined);
  return {
    chat: { id: opts.chatId ?? 1 },
    reply,
    answerCallbackQuery,
    callbackQuery: opts.data ? { data: opts.data } : undefined,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof handleSessions>[1]> = {}) {
  return {
    state: {
      get: vi.fn(() => ({
        chatId: 1,
        projectPath: "/workspace/site",
        sessionId: "ses_old",
        model: null,
        updatedAt: 0,
      })),
      setSession: vi.fn(),
    },
    client: {
      listSessions: vi.fn(async () => [
        { id: "ses_a", title: "fix navbar", time: { updated: Date.now() - 5 * 60_000 } },
        { id: "ses_b", title: "add dark mode", time: { updated: Date.now() - 60 * 60_000 } },
      ]),
    },
    router: { ensureDirectory: vi.fn() },
    pinnedStatus: { notifyStateChange: vi.fn() },
    ...overrides,
  };
}

describe("/sessions", () => {
  it("replies with no project message when state has no projectPath", async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ state: { get: vi.fn(() => null), setSession: vi.fn() } });
    await handleSessions(ctx as never, deps as never);
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/switch/i);
  });

  it("lists sessions with inline keyboard", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessions(ctx as never, deps as never);
    expect(deps.client.listSessions).toHaveBeenCalledWith({ directory: "/workspace/site" });
    const opts = ctx.reply.mock.calls[0]![1] as { reply_markup?: { inline_keyboard?: unknown[][] } };
    expect(opts?.reply_markup?.inline_keyboard?.length).toBeGreaterThanOrEqual(2);
    const firstButton = (opts.reply_markup!.inline_keyboard![0] as Array<{ callback_data: string }>)[0]!;
    expect(firstButton.callback_data).toBe("sess:ses_a");
  });
});

describe("session callback", () => {
  it("switches session on tap", async () => {
    const ctx = makeCtx({ data: "sess:ses_a" });
    const deps = makeDeps();
    await handleSessionCallback(ctx as never, deps as never);
    expect(deps.state.setSession).toHaveBeenCalledWith(1, "ses_a");
    expect(deps.pinnedStatus.notifyStateChange).toHaveBeenCalledWith(1);
  });
});
