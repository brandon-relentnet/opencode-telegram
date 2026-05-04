import type { Context } from "grammy";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import { escapeHtml } from "../markdown-to-html.js";
import { describeError } from "../errors.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { PinnedStatusDeps } from "../pinned-status.js";
import { isSafeProjectName, buildSwitchConfirmation } from "./switch.js";

export interface ProjectsDeps {
  workspaceRoot: string;
}

/**
 * Extended deps for the inline-keyboard callback handler. Tap-to-switch
 * mirrors the real /switch flow: create a session anchored to the picked
 * project's directory, persist project + session, ensure the SSE
 * subscription, and nudge the pinned-status manager. Optional
 * pinnedStatus matches /switch so tests that don't care can omit it.
 */
export interface ProjectsCallbackDeps extends ProjectsDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  router: { ensureDirectory(directory: string): boolean };
  pinnedStatus?: PinnedStatusDeps;
}

/**
 * Cap inline-keyboard rows to keep the message Telegram-friendly. 50 is
 * a soft ceiling — way above what most workspaces will hold but well
 * inside Telegram's per-message button limits, and the directory listing
 * is already alphabetical so the first 50 are the most predictable subset.
 */
const MAX_BUTTONS = 50;

export function listProjects(workspaceRoot: string): string[] {
  const entries = readdirSync(workspaceRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export async function handleProjects(ctx: Context, deps: ProjectsDeps): Promise<void> {
  let projects: string[];
  try {
    projects = listProjects(deps.workspaceRoot);
  } catch (err) {
    // Most likely ENOENT (workspaceRoot doesn't exist) or EACCES (no read
    // access to the bind-mount). Both are operator-misconfig issues, but we
    // still want a useful chat reply rather than a silent crash.
    await ctx.reply(
      escapeMarkdownV2(`❌ Failed to list projects: ${describeError(err)}`),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }
  if (projects.length === 0) {
    await ctx.reply(`No projects found in ${escapeHtml(deps.workspaceRoot)}.`, {
      parse_mode: "HTML",
    });
    return;
  }

  const trimmed = projects.slice(0, MAX_BUTTONS);
  // One row per project so long names stay readable on mobile. callback_data
  // is `proj:<name>` — the names are already validated as safe via
  // isSafeProjectName before any side effect, so the prefix + name fits well
  // under Telegram's 64-byte callback_data cap.
  const keyboard = trimmed.map((name) => [{ text: name, callback_data: `proj:${name}` }]);
  await ctx.reply("<b>Projects</b>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * Tap-to-switch handler for `proj:<name>` callbacks emitted by /projects.
 *
 * Mirrors the real /switch flow rather than recreating it: validate the
 * name, anchor a new opencode session to the project's directory, persist
 * project+session, ensure the SSE subscription is open, and notify the
 * pinned-status manager. Errors surface as user-visible replies (HTML, since
 * MarkdownV2 escapes paths poorly).
 */
export async function handleProjectCallback(
  ctx: Context,
  deps: ProjectsCallbackDeps,
): Promise<void> {
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  const chatId = ctx.chat?.id;
  if (!data || typeof chatId !== "number") return;
  if (!data.startsWith("proj:")) return;
  const name = data.slice("proj:".length);
  if (name.length === 0) return;

  // answerCallbackQuery clears the spinner. Best-effort — Telegram returns
  // an error if the press already expired, which is fine: we proceed.
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // Already answered or query expired — proceed regardless.
  }

  if (!isSafeProjectName(name)) {
    await ctx.reply(`Invalid project name: ${escapeHtml(name)}`, { parse_mode: "HTML" });
    return;
  }

  const projectPath = join(deps.workspaceRoot, name);

  let session: { id: string };
  try {
    session = await deps.client.createSession(`tg:${name}`, { directory: projectPath });
  } catch (err) {
    await ctx.reply(`Failed to switch: ${escapeHtml(describeError(err))}`, {
      parse_mode: "HTML",
    });
    return;
  }

  deps.state.setProject(chatId, projectPath, session.id);
  // Open the SSE subscription before the user's next prompt — same
  // idempotent ensureDirectory contract as /switch.
  deps.router.ensureDirectory(projectPath);
  deps.pinnedStatus?.notifyStateChange(chatId);

  await ctx.reply(buildSwitchConfirmation(name, projectPath, session.id), {
    parse_mode: "MarkdownV2",
  });
}
