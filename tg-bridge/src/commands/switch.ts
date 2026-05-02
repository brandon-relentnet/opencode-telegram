import type { Context } from "grammy";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface SwitchDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  workspaceRoot: string;
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

  const session = await deps.client.createSession(`tg:${arg}`);
  // Seed the session with a no-reply context message anchoring the agent
  // to this directory. opencode sessions don't have an intrinsic project
  // field, so we communicate the working directory in the conversation.
  await deps.client.prompt(
    session.id,
    `You are working on a project located at \`${projectPath}\`. ` +
      `Use this as the working directory for all file operations. ` +
      `Files outside this directory are out of scope.`,
  );
  deps.state.setProject(ctx.chat!.id, projectPath, session.id);

  await ctx.reply(
    [
      `*${escapeMarkdownV2(`Switched to ${arg}`)}*`,
      escapeMarkdownV2(`Project: ${projectPath}`),
      escapeMarkdownV2(`Session: ${session.id}`),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
