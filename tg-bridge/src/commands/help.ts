import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";

const RAW = [
  "*opencode bridge*",
  "",
  "/new — start a new session in the current project",
  "/projects — list available projects (tap to switch)",
  "/switch <name> — switch to a project (creates a new session)",
  "/clone <git-url> [name] — clone a git repository into /workspace",
  "/init <name> — create an empty new project under /workspace (with git init)",
  "/initremote <name> — create new project + private GitHub repo + push",
  "/deploy — push pending changes + create-or-update Coolify app + deploy",
  "/abort — abort the current running task",
  "/status — show current project, session, and model",
  "/info — full project + git + session + model + deploy details",
  "/model [providerID/modelID] — list models (tap to set), or set directly",
  "/sessions — recent sessions in this project (tap to switch)",
  "/pin — re-engage the pinned status message",
  "/unpin — pause auto-updates of the pinned status",
  "/trace [N] — recent bridge events for this chat (debug)",
  "/help — show this message",
  "",
  "Send any other text to talk to the agent.",
].join("\n");

// Pre-escape since this is a static string. *bold* markers are kept raw;
// everything else is escaped per MarkdownV2 rules.
function buildHelpText(): string {
  // The header line uses MarkdownV2 *bold*, so escape only the inner text.
  const lines = RAW.split("\n");
  const head = lines[0]!;
  const headInner = head.slice(1, -1); // strip *...*
  const headEscaped = `*${escapeMarkdownV2(headInner)}*`;
  const rest = lines.slice(1).map(escapeMarkdownV2);
  return [headEscaped, ...rest].join("\n");
}

export const HELP_TEXT = buildHelpText();

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: "MarkdownV2" });
}
