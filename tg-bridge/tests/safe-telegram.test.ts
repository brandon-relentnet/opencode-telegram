import { describe, it, expect, vi } from "vitest";
import { safeEdit, safeSend, stripMarkdownV2Escapes, stripHtml } from "../src/safe-telegram.js";

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

describe("stripHtml", () => {
  it("removes simple tags", () => {
    expect(stripHtml("<b>hi</b>")).toBe("hi");
  });

  it("decodes &amp; &lt; &gt; &quot; &#39;", () => {
    expect(stripHtml("a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;")).toBe(
      "a & b < c > d \"e\" 'f'",
    );
  });

  it("strips link tags but keeps label", () => {
    expect(stripHtml('See <a href="https://example.com">docs</a>.')).toBe("See docs.");
  });

  it("decodes &amp; last so encoded entities round-trip", () => {
    // If &amp; were decoded first, "&amp;lt;" would become "&lt;" then "<".
    // We want it to become "&lt;" (treated literally).
    expect(stripHtml("&amp;lt;")).toBe("&lt;");
  });
});

describe("safeEdit", () => {
  it("calls editMessageText once with HTML by default", async () => {
    const bot = makeBot();
    await safeEdit(bot, 1, 50, "<b>hi</b>");
    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    expect(bot.editMessageText.mock.calls[0]).toEqual([
      1,
      50,
      "<b>hi</b>",
      { parse_mode: "HTML" },
    ]);
  });

  it("uses MarkdownV2 when caller opts in", async () => {
    const bot = makeBot();
    await safeEdit(bot, 1, 50, "hello \\(world\\)", undefined, "MarkdownV2");
    expect(bot.editMessageText.mock.calls[0]).toEqual([
      1,
      50,
      "hello \\(world\\)",
      { parse_mode: "MarkdownV2" },
    ]);
  });

  it("retries with plain text (HTML stripped) when HTML fails", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce(undefined);
    await safeEdit(bot, 1, 50, "<b>broken</b>");
    expect(bot.editMessageText).toHaveBeenCalledTimes(2);
    expect(bot.editMessageText.mock.calls[1]).toEqual([1, 50, "broken", {}]);
  });

  it("retries with markdown stripped when MarkdownV2 fails", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce(undefined);
    await safeEdit(bot, 1, 50, "broken \\(markdown", undefined, "MarkdownV2");
    expect(bot.editMessageText.mock.calls[1]).toEqual([1, 50, "broken (markdown", {}]);
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
      parseMode: "HTML",
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
  it("calls sendMessage once with HTML by default", async () => {
    const bot = makeBot();
    const result = await safeSend(bot, 1, "<b>hi</b>");
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage.mock.calls[0]).toEqual([1, "<b>hi</b>", { parse_mode: "HTML" }]);
    expect(result).toEqual({ message_id: 999 });
  });

  it("uses MarkdownV2 when caller opts in", async () => {
    const bot = makeBot();
    await safeSend(bot, 1, "hello", undefined, "MarkdownV2");
    expect(bot.sendMessage.mock.calls[0]).toEqual([1, "hello", { parse_mode: "MarkdownV2" }]);
  });

  it("retries with HTML stripped when HTML fails", async () => {
    const bot = makeBot();
    bot.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce({ message_id: 1234 });
    const result = await safeSend(bot, 1, "<b>broken</b>");
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.sendMessage.mock.calls[1]).toEqual([1, "broken", {}]);
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
