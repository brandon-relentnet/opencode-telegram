import type { Context } from "grammy";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

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
}

function isSafeProjectName(name: string): boolean {
  if (name.length === 0) return false;
  if (isAbsolute(name)) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.startsWith(".")) return false;
  return true;
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

  await ctx.reply(
    [
      `*${escapeMarkdownV2(`Switched to ${arg}`)}*`,
      escapeMarkdownV2(`Project: ${projectPath}`),
      escapeMarkdownV2(`Session: ${session.id}`),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
