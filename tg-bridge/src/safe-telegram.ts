import type { Logger } from "pino";

type SafeLogger = Partial<Pick<Logger, "warn">>;

export type ParseMode = "MarkdownV2" | "HTML";

/** Bot surface used by safeEdit. Matches grammy's bot.api.editMessageText shape loosely. */
export interface SafeEditBot {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode?: ParseMode },
  ): Promise<unknown>;
}

/** Bot surface used by safeSend. */
export interface SafeSendBot {
  sendMessage(
    chatId: number,
    text: string,
    opts: { parse_mode?: ParseMode },
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
 * Strip HTML tags and decode the entities Telegram HTML mode produces, so
 * a parse-failed HTML message can be re-sent as plain text. Lossy but
 * readable — `<a href="...">label</a>` becomes just `label`.
 */
export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripForMode(text: string, mode: ParseMode): string {
  return mode === "HTML" ? stripHtml(text) : stripMarkdownV2Escapes(text);
}

/**
 * Edit a Telegram message with the supplied parse mode (defaults to HTML
 * since the final view now renders HTML); on parse failure, retry once as
 * plain text with markup stripped. Never throws — on persistent failure,
 * logs a warning (if logger provided) and returns.
 *
 * Callers passing MarkdownV2-escaped text MUST opt in via `parseMode:
 * "MarkdownV2"` or the HTML parser will mangle their backslashes.
 */
export async function safeEdit(
  bot: SafeEditBot,
  chatId: number,
  messageId: number,
  text: string,
  log?: SafeLogger,
  parseMode: ParseMode = "HTML",
): Promise<void> {
  try {
    await bot.editMessageText(chatId, messageId, text, { parse_mode: parseMode });
    return;
  } catch (markupErr) {
    try {
      const plain = stripForMode(text, parseMode);
      await bot.editMessageText(chatId, messageId, plain, {});
      return;
    } catch (plainErr) {
      log?.warn?.(
        {
          chatId,
          messageId,
          textLength: text.length,
          parseMode,
          markupErr,
          plainErr,
        },
        "safeEdit failed in both markup and plain-text mode",
      );
      return;
    }
  }
}

/**
 * Send a Telegram message with the supplied parse mode (defaults to HTML);
 * on parse failure, retry once as plain text. Never throws — on persistent
 * failure, logs a warning and returns null.
 */
export async function safeSend(
  bot: SafeSendBot,
  chatId: number,
  text: string,
  log?: SafeLogger,
  parseMode: ParseMode = "HTML",
): Promise<{ message_id: number } | null> {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: parseMode });
  } catch (markupErr) {
    try {
      const plain = stripForMode(text, parseMode);
      return await bot.sendMessage(chatId, plain, {});
    } catch (plainErr) {
      log?.warn?.(
        {
          chatId,
          textLength: text.length,
          parseMode,
          markupErr,
          plainErr,
        },
        "safeSend failed in both markup and plain-text mode",
      );
      return null;
    }
  }
}
