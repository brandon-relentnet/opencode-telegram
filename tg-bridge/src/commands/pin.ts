import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import type { PinnedStatusManager } from "../pinned-status.js";

/**
 * Narrow surface so test fixtures can stub PSM without instantiating the
 * full manager (with debounce timers + a Telegram bot stub).
 */
export interface PinDeps {
  pinnedStatus: Pick<PinnedStatusManager, "enablePin" | "pausePin">;
}

export async function handlePin(ctx: Context, deps: PinDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  try {
    await deps.pinnedStatus.enablePin(chatId);
  } catch (err) {
    await ctx.reply(
      escapeMarkdownV2(`❌ Failed to pin status: ${describeError(err)}`),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }
  await ctx.reply(
    escapeMarkdownV2("📌 Pinned status engaged. I'll keep it updated."),
    { parse_mode: "MarkdownV2" },
  );
}

export async function handleUnpin(ctx: Context, deps: PinDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  try {
    await deps.pinnedStatus.pausePin(chatId);
  } catch (err) {
    await ctx.reply(
      escapeMarkdownV2(`❌ Failed to unpin: ${describeError(err)}`),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }
  await ctx.reply(
    escapeMarkdownV2("📌 Pinned status paused. Run /pin to re-engage."),
    { parse_mode: "MarkdownV2" },
  );
}
