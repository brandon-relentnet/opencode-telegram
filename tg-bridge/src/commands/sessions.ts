import type { Context } from "grammy";
import { escapeHtml } from "../markdown-to-html.js";
import { describeError } from "../errors.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { PinnedStatusDeps } from "../pinned-status.js";

/**
 * Dependencies for the /sessions command and its callback handler.
 *
 * `client.listSessions({ directory })` is intentionally narrow: this
 * handler only needs id + title + time.updated and only ever scopes by
 * directory. Wider type unions (the SDK's full `Session` shape) would
 * over-constrain test fakes for no benefit.
 */
export interface SessionsDeps {
  state: Pick<ChatStateRepo, "get" | "setSession">;
  client: {
    listSessions(args: {
      directory: string;
    }): Promise<Array<{ id: string; title?: string; time?: { updated?: number } }>>;
  };
  /**
   * EventRouter handle. Tap-to-switch ensures the SSE subscription for
   * the project's directory exists before the user's next prompt — same
   * idempotent pattern as /switch.
   */
  router: { ensureDirectory(directory: string): boolean };
  /**
   * Pinned-status manager. Session changes invalidate the pinned message;
   * `notifyStateChange` debounces internally.
   */
  pinnedStatus: Pick<PinnedStatusDeps, "notifyStateChange">;
}

/**
 * Cap inline-keyboard buttons to keep the message Telegram-friendly. The
 * 64-byte callback_data limit is satisfied by `sess:<id>` since opencode
 * session IDs are short ULIDs (~30 chars). 8 rows fits comfortably on a
 * mobile screen and avoids overwhelming users with stale sessions.
 */
const MAX_BUTTONS = 8;

export async function handleSessions(ctx: Context, deps: SessionsDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  const stateRow = deps.state.get(chatId);
  if (!stateRow?.projectPath) {
    await ctx.reply("Use /switch first to pick a project.");
    return;
  }

  let sessions: Array<{ id: string; title?: string; time?: { updated?: number } }>;
  try {
    sessions = await deps.client.listSessions({ directory: stateRow.projectPath });
  } catch (err) {
    await ctx.reply(`Failed to list sessions: ${describeError(err)}`);
    return;
  }

  const sorted = sessions
    .slice()
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, MAX_BUTTONS);

  if (sorted.length === 0) {
    await ctx.reply("No sessions for this project yet.");
    return;
  }

  const keyboard = sorted.map((s) => {
    const ago = humanizeAgo(s.time?.updated ?? 0);
    // Telegram inline-button labels render best at ~30 chars; longer titles
    // get truncated visibly with `…`. callback_data stays short because
    // session IDs are <= ~30 chars (ULIDs), well under the 64-byte cap.
    const baseTitle = s.title ?? s.id.slice(0, 12);
    const trimmed = baseTitle.length > 30 ? `${baseTitle.slice(0, 29)}…` : baseTitle;
    return [{ text: `${trimmed} · ${ago}`, callback_data: `sess:${s.id}` }];
  });

  const projectName = stateRow.projectPath.split("/").pop() ?? "";
  await ctx.reply(`<b>Sessions in ${escapeHtml(projectName)}</b>`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function handleSessionCallback(ctx: Context, deps: SessionsDeps): Promise<void> {
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  const chatId = ctx.chat?.id;
  if (!data || typeof chatId !== "number") return;
  if (!data.startsWith("sess:")) return;
  const sessionId = data.slice("sess:".length);
  if (sessionId.length === 0) return;

  // Acknowledge the press so Telegram clears the spinner before any
  // subsequent state work or replies. answerCallbackQuery is best-effort.
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // Already answered or query expired — proceed regardless.
  }

  // Persist the new session, then notify pinned status. We don't call
  // ensureDirectory here because the project hasn't changed; if the user
  // has been chatting in this project, the SSE subscription is already
  // open from /switch (or from the boot-seed pass).
  const stateRow = deps.state.get(chatId);
  deps.state.setSession(chatId, sessionId);
  if (stateRow?.projectPath) {
    deps.router.ensureDirectory(stateRow.projectPath);
  }
  deps.pinnedStatus.notifyStateChange(chatId);

  await ctx.reply(`Switched to session <code>${escapeHtml(sessionId)}</code>`, {
    parse_mode: "HTML",
  });
}

/**
 * Format a unix-ms timestamp as a coarse "n minutes ago" / "n hours ago"
 * string. Returns "?" for missing timestamps so the keyboard never shows
 * a blank suffix. Coarse-grained because the inline-button label has
 * ~30 chars total; "5 min ago" is more useful than "4m 32s ago".
 */
function humanizeAgo(updatedAt: number): string {
  if (updatedAt === 0) return "?";
  const min = Math.floor((Date.now() - updatedAt) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
