import type { Context } from "grammy";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { PinnedStatusDeps } from "../pinned-status.js";

export interface SwitchDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  workspaceRoot: string;
  /**
   * EventRouter handle so /switch can ensure an SSE subscription exists
   * for the newly-activated project's directory. Without this, sessions in
   * a directory the bridge has never subscribed to would emit events into
   * a scope nothing reads, and the placeholder would hang at "thinking…".
   */
  router: { ensureDirectory(directory: string): boolean };
  /**
   * Pinned-status manager. /switch calls notifyStateChange after persisting
   * the new project + session so the pinned message reflects the change.
   * Optional so tests that don't care about pinned status can omit it.
   */
  pinnedStatus?: PinnedStatusDeps;
}

/**
 * Validate a project-name argument as safe to use as a subdirectory of
 * the workspace root. Rejects empty, absolute paths, path separators,
 * and names starting with `.` (which would clash with `.git` etc. and
 * be hidden from the default `/projects` listing anyway).
 */
export function isSafeProjectName(name: string): boolean {
  if (name.length === 0) return false;
  if (isAbsolute(name)) return false;
  // Only allow alphanumerics, dot, underscore, hyphen. Rejects whitespace,
  // path separators, shell metacharacters, command-arg lookalikes.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  // No leading dot (collides with .git, hidden from /projects listing).
  // No leading dash (parses like a CLI flag in shell commands; also protects
  // against Telegram bot-command quirks like "/init-remote" being routed to
  // /init handler with name="-remote").
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return true;
}

/**
 * Build the standard "switched to <name>" reply used by /switch and (after
 * auto-switch) by /clone and /init. Returns a MarkdownV2-escaped string
 * ready to send via ctx.reply or safeEdit.
 */
export function buildSwitchConfirmation(name: string, projectPath: string, sessionId: string): string {
  return [
    `*${escapeMarkdownV2(`Switched to ${name}`)}*`,
    escapeMarkdownV2(`Project: ${projectPath}`),
    escapeMarkdownV2(`Session: ${sessionId}`),
  ].join("\n");
}

export async function handleSwitch(ctx: Context, deps: SwitchDeps): Promise<void> {
  const arg = (ctx.match as string | undefined)?.trim() ?? "";
  if (arg.length === 0) {
    await ctx.reply(escapeMarkdownV2("Usage: /switch <project-name>"), {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  if (!isSafeProjectName(arg)) {
    await ctx.reply(escapeMarkdownV2("Invalid project name."), { parse_mode: "MarkdownV2" });
    return;
  }

  const projectPath = join(deps.workspaceRoot, arg);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    await ctx.reply(escapeMarkdownV2(`No such project: ${arg}`), { parse_mode: "MarkdownV2" });
    return;
  }

  let session: { id: string };
  try {
    // Pass `directory` so opencode anchors the session to this worktree
    // (auto-creating a Project record if one doesn't exist) and so subsequent
    // turns in `message-handler` can re-anchor against the same path.
    session = await deps.client.createSession(`tg:${arg}`, { directory: projectPath });
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ Failed to switch: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
    return;
  }
  deps.state.setProject(ctx.chat!.id, projectPath, session.id);
  // Ensure the SSE subscription for this project's directory is open before
  // the user sends their first prompt. Idempotent — no-op if we're already
  // subscribed (e.g. another chat is in this project, or we hit boot-seed).
  deps.router.ensureDirectory(projectPath);
  // Pinned message: project + session changed. PSM debounces internally.
  deps.pinnedStatus?.notifyStateChange(ctx.chat!.id);

  await ctx.reply(buildSwitchConfirmation(arg, projectPath, session.id), {
    parse_mode: "MarkdownV2",
  });
}
