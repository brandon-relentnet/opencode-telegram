import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import pino from "pino";
import { loadConfig } from "./config.js";
import { whitelistMiddleware } from "./auth.js";
import { ChatStateRepo, openChatStateDb } from "./chat-state.js";
import { makeOpencodeClient } from "./opencode-client.js";
import { EventRouter } from "./event-router.js";
import { PermissionService } from "./permissions.js";
import { handleHelp } from "./commands/help.js";
import { handleProjects } from "./commands/projects.js";
import { handleSwitch } from "./commands/switch.js";
import { handleClone } from "./commands/clone.js";
import { handleInit } from "./commands/init.js";
import { handleNew } from "./commands/new.js";
import { handleAbort } from "./commands/abort.js";
import { handleStatus } from "./commands/status.js";
import { handleModel } from "./commands/model.js";
import { handleTextMessage } from "./message-handler.js";

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SQLITE_PATH = process.env["SQLITE_PATH"] ?? "/data/chat-state.sqlite";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });

  const db = openChatStateDb(SQLITE_PATH);
  const state = new ChatStateRepo(db);

  const client = makeOpencodeClient({
    baseUrl: config.opencodeUrl,
    username: config.opencodeUsername,
    password: config.opencodePassword,
  });

  const router = new EventRouter(client, log);

  const bot = new Bot(config.telegramBotToken);

  // Globally handle Telegram 429 (rate limit) responses by honouring the
  // server-provided retry_after, with sane bounds so we don't stall forever.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 5 }));

  // Adapter for Turn: TurnBot expects a strict { parse_mode: "MarkdownV2" }
  // options shape; bot.api accepts a wider Other<...> type, so a thin closure
  // bridges them.
  const turnBot = {
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      opts: { parse_mode: "MarkdownV2" },
    ) => bot.api.editMessageText(chatId, messageId, text, opts),
    sendMessage: (chatId: number, text: string, opts: { parse_mode: "MarkdownV2" }) =>
      bot.api.sendMessage(chatId, text, opts),
  };

  // Adapter for PermissionService. PermissionBot's signatures use plain object
  // shapes that overlap-but-don't-equal grammy's `Other<...>` helper types, so
  // a small `as never` cast at the construction site keeps the wiring honest
  // without trying to defeat grammy's overload machinery.
  const permBot = {
    sendMessage: (
      chatId: number,
      text: string,
      opts: Parameters<typeof bot.api.sendMessage>[2],
    ) => bot.api.sendMessage(chatId, text, opts),
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      opts: Parameters<typeof bot.api.editMessageText>[3],
    ) => bot.api.editMessageText(chatId, messageId, text, opts),
    answerCallbackQuery: (
      id: string,
      opts?: Parameters<typeof bot.api.answerCallbackQuery>[1],
    ) => bot.api.answerCallbackQuery(id, opts),
  };

  const permissions = new PermissionService(permBot as never, client, {
    timeoutMs: PERMISSION_TIMEOUT_MS,
    log,
  });

  // 1) Whitelist gate runs before everything else.
  bot.use(whitelistMiddleware(config.allowedUserIds));

  // 2) Slash commands.
  bot.command("help", (ctx: Context) => handleHelp(ctx));
  bot.command("projects", (ctx) => handleProjects(ctx, { workspaceRoot: config.workspaceRoot }));
  bot.command("switch", (ctx) =>
    handleSwitch(ctx, { client, state, workspaceRoot: config.workspaceRoot, router }),
  );
  bot.command("clone", (ctx) =>
    handleClone(ctx, {
      client,
      state,
      router,
      bot: turnBot,
      workspaceRoot: config.workspaceRoot,
      defaultModel: config.defaultModel,
      log,
    }),
  );
  bot.command("init", (ctx) =>
    handleInit(ctx, {
      client,
      state,
      router,
      bot: turnBot,
      workspaceRoot: config.workspaceRoot,
      defaultModel: config.defaultModel,
      log,
    }),
  );
  bot.command("new", (ctx) => handleNew(ctx, { client, state, router }));
  bot.command("abort", (ctx) => handleAbort(ctx, { client, state }));
  bot.command("status", (ctx) => handleStatus(ctx, { state }));
  bot.command("model", (ctx) => handleModel(ctx, { client, state }));

  // 3) Permission button callbacks.
  bot.on("callback_query:data", async (ctx) => {
    log.info(
      {
        callbackId: ctx.callbackQuery.id,
        data: ctx.callbackQuery.data,
        from: ctx.from?.id,
        chat: ctx.chat?.id,
      },
      "callback_query received",
    );
    // Build the callback object conditionally to satisfy
    // exactOptionalPropertyTypes (don't pass `message: undefined`).
    const msg = ctx.callbackQuery.message;
    await permissions.handleCallback({
      id: ctx.callbackQuery.id,
      data: ctx.callbackQuery.data,
      ...(msg
        ? {
            message: {
              chat: { id: msg.chat.id },
              message_id: msg.message_id,
            },
          }
        : {}),
    });
  });

  // 4) Default text handler.
  bot.on("message:text", (ctx) =>
    handleTextMessage(ctx, {
      state,
      client,
      router,
      permissions,
      bot: turnBot,
      defaultModel: config.defaultModel,
      log,
    }),
  );

  // 5) Catch any error thrown out of a handler so a single buggy turn doesn't
  // kill the bot loop. grammy's default behaviour on unhandled errors is to
  // print "No error handler was set!" then stop polling. We log instead so
  // the container keeps serving subsequent messages.
  bot.catch((err) => {
    log.error(
      {
        err: err.error,
        update_id: err.ctx.update.update_id,
        chat_id: err.ctx.chat?.id,
      },
      "unhandled bot error",
    );
  });

  // 6) Start the SSE consumer in the background. Seed it with directories
  // we know about from chat-state so resumed chats start receiving events
  // immediately on boot. Never await — start() resolves only on shutdown.
  const ac = new AbortController();
  const initialDirs = state.getDistinctProjectPaths();
  log.info({ initialDirs }, "seeding event subscriptions");
  void router
    .start(ac.signal, initialDirs)
    .catch((err) => log.error({ err }, "EventRouter exited"));

  // 6) Start polling.
  const stop = async () => {
    log.info("shutting down");
    ac.abort();
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log.info({ workspaceRoot: config.workspaceRoot, opencodeUrl: config.opencodeUrl }, "starting");
  // `allowed_updates` MUST include "callback_query" or Telegram won't send
  // button-press events. grammy claims to auto-detect from registered
  // handlers, but in practice the auto-detection didn't fire here (button
  // presses produced no `callback_query received` log even with the handler
  // registered). Explicit list, no magic.
  await bot.start({
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query"],
  });
}

main().catch((err) => {
  // Top-level errors crash the process so the container restart policy kicks in.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
