import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface AbortDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
}

export async function handleAbort(ctx: Context, deps: AbortDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const current = deps.state.get(chatId);
  if (!current?.sessionId) {
    await ctx.reply(escapeMarkdownV2("No active session to abort."), {
      parse_mode: "MarkdownV2",
    });
    return;
  }
  const ok = await deps.client.abortSession(current.sessionId);
  await ctx.reply(
    escapeMarkdownV2(ok ? "Aborted." : "Could not abort (nothing to abort, perhaps?)."),
    { parse_mode: "MarkdownV2" },
  );
}
