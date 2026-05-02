import { describe, it, expect, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { whitelistMiddleware } from "../src/auth.js";

function makeCtx(fromId: number | undefined): Context {
  return {
    from: fromId === undefined ? undefined : { id: fromId },
    update: { update_id: 1 },
  } as unknown as Context;
}

describe("whitelistMiddleware", () => {
  it("calls next when from.id is in the allowlist", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([111, 222]);
    await mw(makeCtx(222), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not call next when from.id is missing", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([111]);
    await mw(makeCtx(undefined), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next when from.id is not in the allowlist", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([111]);
    await mw(makeCtx(999), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("treats an empty allowlist as deny-all (defensive)", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([]);
    await mw(makeCtx(111), next);
    expect(next).not.toHaveBeenCalled();
  });
});
