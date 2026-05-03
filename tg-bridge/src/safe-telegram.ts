import type { Logger } from "pino";

type SafeLogger = Partial<Pick<Logger, "warn">>;

/** Bot surface used by safeEdit. Matches grammy's bot.api.editMessageText shape loosely. */
export interface SafeEditBot {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode?: "MarkdownV2" },
  ): Promise<unknown>;
}

/** Bot surface used by safeSend. */
export interface SafeSendBot {
  sendMessage(
    chatId: number,
    text: string,
    opts: { parse_mode?: "MarkdownV2" },
  ): Promise<{ message_id: number }>;
}

/**
 * Undo MarkdownV2 escaping by removing backslashes that precede ASCII
 * reserved characters. This is the round-trip inverse of escapeMarkdownV2
 * for content WE escaped. For arbitrary input it removes any "\\X" → "X"
 * substitution, which is fine for our fallback-to-plain-text use case
 * (we want readable text, not perfect inverse). The `u` flag ensures `.`
 * matches whole code points rather than surrogate halves.
 */
export function stripMarkdownV2Escapes(text: string): string {
  return text.replace(/\\(.)/gu, "$1");
}

/**
 * Edit a Telegram message with MarkdownV2; on parse failure, retry once
 * as plain text with escapes stripped. Never throws — on persistent
 * failure, logs a warning (if logger provided) and returns.
 */
export async function safeEdit(
  bot: SafeEditBot,
  chatId: number,
  messageId: number,
  text: string,
  log?: SafeLogger,
): Promise<void> {
  try {
    await bot.editMessageText(chatId, messageId, text, { parse_mode: "MarkdownV2" });
    return;
  } catch (markdownErr) {
    try {
      const plain = stripMarkdownV2Escapes(text);
      await bot.editMessageText(chatId, messageId, plain, {});
      return;
    } catch (plainErr) {
      log?.warn?.(
        {
          chatId,
          messageId,
          textLength: text.length,
          markdownErr,
          plainErr,
        },
        "safeEdit failed in both MarkdownV2 and plain-text mode",
      );
      return;
    }
  }
}

/**
 * Send a Telegram message with MarkdownV2; on parse failure, retry once
 * as plain text. Never throws — on persistent failure, logs a warning
 * and returns null.
 */
export async function safeSend(
  bot: SafeSendBot,
  chatId: number,
  text: string,
  log?: SafeLogger,
): Promise<{ message_id: number } | null> {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (markdownErr) {
    try {
      const plain = stripMarkdownV2Escapes(text);
      return await bot.sendMessage(chatId, plain, {});
    } catch (plainErr) {
      log?.warn?.(
        {
          chatId,
          textLength: text.length,
          markdownErr,
          plainErr,
        },
        "safeSend failed in both MarkdownV2 and plain-text mode",
      );
      return null;
    }
  }
}
