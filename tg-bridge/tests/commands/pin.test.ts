import { describe, it, expect, vi } from "vitest";
import { handlePin, handleUnpin } from "../../src/commands/pin.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

function makeDeps() {
  return {
    pinnedStatus: {
      enablePin: vi.fn(async () => undefined),
      pausePin: vi.fn(async () => undefined),
    },
  };
}

describe("/pin", () => {
  it("calls enablePin with the chat id and replies confirming", async () => {
    const ctx = makeFakeCtx({ chatId: 42 });
    const deps = makeDeps();
    await handlePin(ctx as never, deps);
    expect(deps.pinnedStatus.enablePin).toHaveBeenCalledWith(42);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text, opts] = ctx.reply.mock.calls[0]!;
    expect(String(text)).toMatch(/pin/i);
    expect((opts as { parse_mode?: string }).parse_mode).toBe("MarkdownV2");
  });

  it("does nothing when ctx.chat is missing", async () => {
    const deps = makeDeps();
    const reply = vi.fn(async () => undefined);
    const ctx = { reply } as unknown;
    await handlePin(ctx as never, deps);
    expect(deps.pinnedStatus.enablePin).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("reports failure if enablePin throws (does not propagate)", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    const deps = makeDeps();
    deps.pinnedStatus.enablePin.mockRejectedValueOnce(new Error("boom"));
    await handlePin(ctx as never, deps);
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/failed|boom/i);
  });
});

describe("/unpin", () => {
  it("calls pausePin with the chat id and replies confirming", async () => {
    const ctx = makeFakeCtx({ chatId: 42 });
    const deps = makeDeps();
    await handleUnpin(ctx as never, deps);
    expect(deps.pinnedStatus.pausePin).toHaveBeenCalledWith(42);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text, opts] = ctx.reply.mock.calls[0]!;
    expect(String(text)).toMatch(/paus|unpin/i);
    expect((opts as { parse_mode?: string }).parse_mode).toBe("MarkdownV2");
  });

  it("does nothing when ctx.chat is missing", async () => {
    const deps = makeDeps();
    const reply = vi.fn(async () => undefined);
    const ctx = { reply } as unknown;
    await handleUnpin(ctx as never, deps);
    expect(deps.pinnedStatus.pausePin).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
