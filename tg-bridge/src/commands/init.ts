import type { Context } from "grammy";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import { isSafeProjectName } from "./switch.js";
import { createProject } from "../project-creator.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { SessionEventHandler } from "../event-router.js";
import type { TurnBot } from "../turn.js";
import type { Logger } from "pino";
import type { PinnedStatusDeps } from "../pinned-status.js";

export interface InitDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
    ensureDirectory(directory: string): boolean;
  };
  bot: TurnBot;
  workspaceRoot: string;
  defaultModel: string;
  pinnedStatus?: PinnedStatusDeps;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export async function handleInit(ctx: Context, deps: InitDeps): Promise<void> {
  try {
    const name = ((ctx.match as string | undefined) ?? "").trim();

    if (name.length === 0) {
      await ctx.reply(escapeMarkdownV2("Usage: /init <name>"), { parse_mode: "MarkdownV2" });
      return;
    }

    if (!isSafeProjectName(name)) {
      await ctx.reply(escapeMarkdownV2("Invalid project name."), { parse_mode: "MarkdownV2" });
      return;
    }

    const projectPath = join(deps.workspaceRoot, name);
    if (existsSync(projectPath)) {
      await ctx.reply(
        escapeMarkdownV2(`Project '${name}' already exists. Use /switch ${name} or pick a different name.`),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const placeholder = await ctx.reply(escapeMarkdownV2(`initializing ${name}…`), {
      parse_mode: "MarkdownV2",
    });
    const placeholderId =
      typeof (placeholder as { message_id?: number }).message_id === "number"
        ? (placeholder as { message_id: number }).message_id
        : 0;

    await createProject(
      {
        chatId: ctx.chat!.id,
        placeholderId,
        name,
        kind: "init",
        workspaceRoot: deps.workspaceRoot,
      },
      {
        client: deps.client,
        state: deps.state,
        router: deps.router,
        bot: deps.bot,
        defaultModel: deps.defaultModel,
        ...(deps.pinnedStatus ? { pinnedStatus: deps.pinnedStatus } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      },
    );
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ /init failed: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
  }
}
