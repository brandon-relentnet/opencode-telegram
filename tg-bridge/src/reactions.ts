import type { Logger } from "pino";

/**
 * Minimal bot surface needed to set message reactions. We narrow this down
 * from grammy's full Bot type so callers can pass a stub in tests and so the
 * dependency is explicit at call sites.
 */
export interface ReactionBot {
  api: {
    setMessageReaction(
      chatId: number,
      messageId: number,
      reactions: Array<{ type: "emoji"; emoji: string }>,
    ): Promise<unknown>;
  };
}

type ReactionLogger = Partial<Pick<Logger, "warn">>;

/**
 * Reactions are best-effort UX. We swallow errors so a transient Telegram
 * API failure (rate limit, message deleted, lost permission) never blocks
 * the main flow that the user actually cares about.
 */
async function react(
  bot: ReactionBot,
  chatId: number,
  messageId: number,
  emoji: string,
  log?: ReactionLogger,
): Promise<void> {
  try {
    await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
  } catch (err) {
    log?.warn?.({ err, chatId, messageId, emoji }, "setMessageReaction failed");
  }
}

export const reactProcessing = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) =>
  react(b, c, m, "👍", l);
export const reactDone = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) =>
  react(b, c, m, "✅", l);
export const reactFailed = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) =>
  react(b, c, m, "❌", l);
export const reactCancelled = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) =>
  react(b, c, m, "⏸", l);
