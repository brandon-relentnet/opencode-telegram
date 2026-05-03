import { describe, it, expect, vi } from "vitest";
import { safeEdit, safeSend, stripMarkdownV2Escapes } from "../src/safe-telegram.js";

interface FakeBot {
  editMessageText: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function makeBot(): FakeBot {
  return {
    editMessageText: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ message_id: 999 })),
  };
}

describe("stripMarkdownV2Escapes", () => {
  it("removes backslash before reserved chars", () => {
    expect(stripMarkdownV2Escapes("hello \\(world\\)\\.")).toBe("hello (world).");
  });

  it("preserves a literal backslash that was double-escaped", () => {
    // Original "x\y" escapes to "x\\\\y"; stripping should yield "x\\y".
    expect(stripMarkdownV2Escapes("x\\\\y")).toBe("x\\y");
  });

  it("leaves plain text untouched", () => {
    expect(stripMarkdownV2Escapes("hello world")).toBe("hello world");
  });

  it("handles a trailing single backslash gracefully", () => {
    expect(stripMarkdownV2Escapes("foo\\")).toBe("foo\\");
  });
});

describe("safeEdit", () => {
  it("calls editMessageText once with MarkdownV2 on success", async () => {
    const bot = makeBot();
    await safeEdit(bot, 1, 50, "hello \\(world\\)");
    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    expect(bot.editMessageText.mock.calls[0]).toEqual([
      1,
      50,
      "hello \\(world\\)",
      { parse_mode: "MarkdownV2" },
    ]);
  });

  it("retries with plain text when MarkdownV2 fails", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce(undefined);
    await safeEdit(bot, 1, 50, "broken \\(markdown");
    expect(bot.editMessageText).toHaveBeenCalledTimes(2);
    // Second call uses plain text (no parse_mode) and stripped content.
    expect(bot.editMessageText.mock.calls[1]).toEqual([
      1,
      50,
      "broken (markdown",
      {},
    ]);
  });

  it("does not throw when both attempts fail; logs warning", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));
    const log = { warn: vi.fn() };
    await expect(safeEdit(bot, 1, 50, "anything", log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const warnCall = log.warn.mock.calls[0]!;
    expect(warnCall[0]).toMatchObject({
      chatId: 1,
      messageId: 50,
      textLength: "anything".length,
    });
  });

  it("works without a logger (silent failure)", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"));
    await expect(safeEdit(bot, 1, 50, "anything")).resolves.toBeUndefined();
  });
});

describe("safeSend", () => {
  it("calls sendMessage once with MarkdownV2 on success", async () => {
    const bot = makeBot();
    const result = await safeSend(bot, 1, "hello");
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage.mock.calls[0]).toEqual([1, "hello", { parse_mode: "MarkdownV2" }]);
    expect(result).toEqual({ message_id: 999 });
  });

  it("retries with plain text when MarkdownV2 fails", async () => {
    const bot = makeBot();
    bot.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce({ message_id: 1234 });
    const result = await safeSend(bot, 1, "broken \\(markdown");
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.sendMessage.mock.calls[1]).toEqual([1, "broken (markdown", {}]);
    expect(result).toEqual({ message_id: 1234 });
  });

  it("returns null and logs warning when both attempts fail", async () => {
    const bot = makeBot();
    bot.sendMessage
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"));
    const log = { warn: vi.fn() };
    const result = await safeSend(bot, 1, "anything", log);
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("returns null silently when both attempts fail without a logger", async () => {
    const bot = makeBot();
    bot.sendMessage
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"));
    const result = await safeSend(bot, 1, "anything");
    expect(result).toBeNull();
  });
});
