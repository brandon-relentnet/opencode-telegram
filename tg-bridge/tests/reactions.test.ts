import { describe, it, expect, vi } from "vitest";
import { reactProcessing, reactDone, reactFailed, reactCancelled } from "../src/reactions.js";

function makeBot() {
  return {
    api: { setMessageReaction: vi.fn(async () => true) },
  };
}

describe("reactions module", () => {
  it("reactProcessing sets 👍", async () => {
    const bot = makeBot();
    await reactProcessing(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "👍" },
    ]);
  });
  it("reactDone sets ✅", async () => {
    const bot = makeBot();
    await reactDone(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "✅" },
    ]);
  });
  it("reactFailed sets ❌", async () => {
    const bot = makeBot();
    await reactFailed(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "❌" },
    ]);
  });
  it("reactCancelled sets ⏸", async () => {
    const bot = makeBot();
    await reactCancelled(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "⏸" },
    ]);
  });
  it("swallows API errors silently", async () => {
    const bot = { api: { setMessageReaction: vi.fn(async () => { throw new Error("rate limit"); }) } };
    const log = { warn: vi.fn() };
    await expect(reactProcessing(bot as never, 1, 50, log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
