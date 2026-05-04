import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import { escapeHtml } from "../markdown-to-html.js";
import { describeError } from "../errors.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { PinnedStatusDeps } from "../pinned-status.js";

export interface ModelDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  /**
   * Pinned-status manager. /model calls notifyStateChange after persisting
   * a new model selection so the pinned message reflects the change.
   */
  pinnedStatus?: PinnedStatusDeps;
}

interface ProviderRecord {
  id?: string;
  models?: Record<string, unknown>;
  [k: string]: unknown;
}

// Allow multi-segment model IDs like openrouter/anthropic/claude-sonnet-4-5.
function isValidModelId(s: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(s);
}

/**
 * Cap inline-keyboard rows to keep the message Telegram-friendly. 32 rows
 * still fits inside Telegram's per-message limits and covers a generous
 * provider+model fan-out (e.g. anthropic + openai + a few openrouter
 * mirrors). callback_data is `model:<provider>/<id>` which stays under
 * the 64-byte limit even for the longest openrouter triple-segment IDs.
 */
const MAX_BUTTONS = 32;

function flattenProviderModels(providers: ProviderRecord[]): string[] {
  const ids: string[] = [];
  for (const provider of providers) {
    if (!provider.id || !provider.models) continue;
    for (const modelId of Object.keys(provider.models)) {
      ids.push(`${provider.id}/${modelId}`);
    }
  }
  return ids;
}

export async function handleModel(ctx: Context, deps: ModelDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  const arg = (ctx.match as string | undefined)?.trim() ?? "";

  // No-arg path: render an inline keyboard. Tap = set.
  if (arg.length === 0) {
    let providersResp: { providers: unknown[]; default: Record<string, string> };
    try {
      providersResp = await deps.client.listProviders();
    } catch (err) {
      await ctx.reply(
        escapeMarkdownV2(`❌ Failed to list providers: ${describeError(err)}`),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }
    const ids = flattenProviderModels(providersResp.providers as ProviderRecord[]).slice(
      0,
      MAX_BUTTONS,
    );
    if (ids.length === 0) {
      await ctx.reply("No models available.");
      return;
    }
    const current = deps.state.get(chatId)?.model;
    const keyboard = ids.map((id) => {
      // Mark the currently-selected model so the user gets immediate
      // visual confirmation of where they are. The bullet leaves enough
      // budget under Telegram's ~30-char button label sweet spot.
      const text = id === current ? `• ${id}` : id;
      return [{ text, callback_data: `model:${id}` }];
    });
    await ctx.reply("<b>Models</b>", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (!isValidModelId(arg)) {
    await ctx.reply(
      escapeMarkdownV2("Invalid format. Use /model <providerID>/<modelID> (e.g. anthropic/claude-sonnet-4-5)."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  deps.state.setModel(chatId, arg);
  deps.pinnedStatus?.notifyStateChange(chatId);
  await ctx.reply(escapeMarkdownV2(`Model set to ${arg}.`), { parse_mode: "MarkdownV2" });
}

/**
 * Tap-to-set handler for `model:<id>` callbacks emitted by /model.
 *
 * Validates the embedded ID against the same regex /model uses for typed
 * input, persists it, and nudges PinnedStatusManager. Errors surface as
 * user-visible HTML replies (the model ID may contain slashes that
 * MarkdownV2 escapes awkwardly).
 */
export async function handleModelCallback(ctx: Context, deps: ModelDeps): Promise<void> {
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  const chatId = ctx.chat?.id;
  if (!data || typeof chatId !== "number") return;
  if (!data.startsWith("model:")) return;
  const id = data.slice("model:".length);
  if (id.length === 0) return;

  // Acknowledge the press so Telegram clears the spinner before any
  // further work. Best-effort — fine if Telegram already cleared it.
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // Already answered or query expired — proceed regardless.
  }

  if (!isValidModelId(id)) {
    await ctx.reply(`Invalid model ID: ${escapeHtml(id)}`, { parse_mode: "HTML" });
    return;
  }

  deps.state.setModel(chatId, id);
  deps.pinnedStatus?.notifyStateChange(chatId);
  await ctx.reply(`Model set to <code>${escapeHtml(id)}</code>`, { parse_mode: "HTML" });
}
