import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface ModelDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
}

interface ProviderRecord {
  id?: string;
  models?: Record<string, unknown>;
  [k: string]: unknown;
}

function isValidModelId(s: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s);
}

export async function handleModel(ctx: Context, deps: ModelDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const arg = (ctx.match as string | undefined)?.trim() ?? "";

  if (arg.length === 0) {
    const current = deps.state.get(chatId);
    const { providers, default: defaults } = await deps.client.listProviders();
    const lines = [
      `*${escapeMarkdownV2("Model")}*`,
      escapeMarkdownV2(`Current: ${current?.model ?? "(default)"}`),
      "",
      `*${escapeMarkdownV2("Available providers:")}*`,
    ];
    for (const provider of providers as ProviderRecord[]) {
      if (!provider.id) continue;
      const def = defaults[provider.id];
      const models = provider.models ? Object.keys(provider.models) : [];
      lines.push(
        escapeMarkdownV2(
          `- ${provider.id}${def ? ` (default: ${def})` : ""}: ${models.join(", ") || "n/a"}`,
        ),
      );
    }
    lines.push("", escapeMarkdownV2("Set with /model <providerID>/<modelID>"));
    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    return;
  }

  if (!isValidModelId(arg)) {
    await ctx.reply(
      escapeMarkdownV2("Invalid format. Use /model <providerID>/<modelID> (e.g. anthropic/claude-sonnet-4-5)."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  deps.state.setModel(chatId, arg);
  await ctx.reply(escapeMarkdownV2(`Model set to ${arg}.`), { parse_mode: "MarkdownV2" });
}
