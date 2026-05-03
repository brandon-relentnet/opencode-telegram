import type { Context } from "grammy";
import { readdirSync } from "node:fs";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";

export interface ProjectsDeps {
  workspaceRoot: string;
}

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
    await ctx.reply(
      escapeMarkdownV2(`No projects found in ${deps.workspaceRoot}.`),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }
  await ctx.reply(
    [
      `*${escapeMarkdownV2("Projects")}*`,
      ...projects.map((p, i) => `${i + 1}\\. \`${p.replace(/`/g, "\\`")}\``),
      "",
      escapeMarkdownV2("Use /switch <name> to select one."),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
