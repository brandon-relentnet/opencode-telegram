import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface NewDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
}

export async function handleNew(ctx: Context, deps: NewDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const current = deps.state.get(chatId);
  if (!current?.projectPath) {
    await ctx.reply(
      escapeMarkdownV2("No project selected. Use /projects then /switch <name>."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  let session: { id: string };
  try {
    session = await deps.client.createSession(
      `tg:${current.projectPath.split("/").pop() ?? "session"}`,
      { directory: current.projectPath },
    );
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ Failed to start new session: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
    return;
  }
  deps.state.setSession(chatId, session.id);

  await ctx.reply(
    [
      `*${escapeMarkdownV2("New session")}*`,
      escapeMarkdownV2(`Project: ${current.projectPath}`),
      escapeMarkdownV2(`Session: ${session.id}`),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
