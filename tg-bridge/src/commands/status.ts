import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface StatusDeps {
  state: ChatStateRepo;
}

export async function handleStatus(ctx: Context, deps: StatusDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const current = deps.state.get(chatId);
  if (!current?.projectPath) {
    await ctx.reply(escapeMarkdownV2("No project selected. Use /projects then /switch."), {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  const lastUpdated = new Date(current.updatedAt).toISOString();
  const lines = [
    `*${escapeMarkdownV2("Status")}*`,
    escapeMarkdownV2(`Project: ${current.projectPath}`),
    escapeMarkdownV2(`Session: ${current.sessionId ?? "(none)"}`),
    escapeMarkdownV2(`Model:   ${current.model ?? "(default)"}`),
    escapeMarkdownV2(`Updated: ${lastUpdated}`),
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
}
