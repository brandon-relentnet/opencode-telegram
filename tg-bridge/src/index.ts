import { Bot, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import pino from "pino";
import { loadConfig } from "./config.js";
import { whitelistMiddleware } from "./auth.js";
import { ChatStateRepo, openChatStateDb } from "./chat-state.js";
import { makeOpencodeClient } from "./opencode-client.js";
import { EventRouter } from "./event-router.js";
import { PermissionService } from "./permissions.js";
import { QuestionService } from "./question-service.js";
import { handleHelp } from "./commands/help.js";
import { handleProjects, handleProjectCallback } from "./commands/projects.js";
import { handleSwitch } from "./commands/switch.js";
import { handleClone } from "./commands/clone.js";
import { handleInit } from "./commands/init.js";
import { handleInitRemote } from "./commands/init-remote.js";
import { handleDeploy } from "./commands/deploy.js";
import { handleNew } from "./commands/new.js";
import { handleAbort } from "./commands/abort.js";
import { handleStatus } from "./commands/status.js";
import { handleModel, handleModelCallback } from "./commands/model.js";
import { handlePin, handleUnpin } from "./commands/pin.js";
import { handleSessions, handleSessionCallback } from "./commands/sessions.js";
import { handleTextMessage } from "./message-handler.js";
import { PinnedStatusManager, type PinnedStatusBot } from "./pinned-status.js";
import { ActiveTurns } from "./active-turns.js";
import { CostTracker } from "./cost-tracker.js";
import { reactCancelled } from "./reactions.js";
import { describeError } from "./errors.js";

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

  // Adapter for Turn: TurnBot uses a small `parse_mode?: "MarkdownV2" | "HTML"`
  // shape (streaming view is MarkdownV2, final view is HTML); bot.api accepts
  // a wider Other<...> type, so a thin closure bridges them.
  const turnBot = {
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      opts: { parse_mode?: "MarkdownV2" | "HTML" },
    ) => bot.api.editMessageText(chatId, messageId, text, opts),
    sendMessage: (
      chatId: number,
      text: string,
      opts: { parse_mode?: "MarkdownV2" | "HTML" },
    ) => bot.api.sendMessage(chatId, text, opts),
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

  const questions = new QuestionService(permBot as never, client, { log });

  // PinnedStatusManager — the singleton-per-process owner of the chat's
  // pinned status message. Slash-command handlers and the message handler
  // notify it of state mutations and Turn lifecycle events; PSM debounces
  // edits internally so spammy notifyStateChange calls coalesce. Cast to
  // PinnedStatusBot because grammy's Bot api signatures use Other<...>
  // helper types that don't structurally match the simpler shape PSM
  // declares (parse_mode + reply_markup + disable_notification only).
  const pinnedStatus = new PinnedStatusManager(
    bot as unknown as PinnedStatusBot,
    state,
    { log },
  );

  // CostTracker — singleton-per-process aggregator. Forwards each
  // assistant message.created event into chat_state.cumulative_* and
  // dedupes by message id. Reset on /new and /switch.
  const costTracker = new CostTracker(state);

  // 1) Whitelist gate runs before everything else.
  bot.use(whitelistMiddleware(config.allowedUserIds));

  // 2) Slash commands.
  // Pre-build per-command deps objects so the callback_query router (below)
  // can dispatch pin:* button presses to the same handlers without
  // duplicating the wiring.
  const projectsDeps = { workspaceRoot: config.workspaceRoot };
  // Tap-to-switch on /projects and pin:switch needs the same wiring as
  // /switch — opencode client to mint a session anchored to the project,
  // chat-state to persist project+session, the SSE router so the new
  // project's directory subscription is open before the user's next
  // prompt, and PinnedStatusManager so the pin re-renders.
  const projectsCallbackDeps = {
    workspaceRoot: config.workspaceRoot,
    client,
    state,
    router,
    pinnedStatus,
  };
  const switchDeps = {
    client,
    state,
    workspaceRoot: config.workspaceRoot,
    router,
    pinnedStatus,
    costTracker,
  };
  const cloneDeps = {
    client,
    state,
    router,
    bot: turnBot,
    workspaceRoot: config.workspaceRoot,
    defaultModel: config.defaultModel,
    pinnedStatus,
    costTracker,
    log,
  };
  const initDeps = {
    client,
    state,
    router,
    bot: turnBot,
    workspaceRoot: config.workspaceRoot,
    defaultModel: config.defaultModel,
    pinnedStatus,
    costTracker,
    log,
  };
  const initRemoteDeps = {
    client,
    state,
    router,
    bot: turnBot,
    workspaceRoot: config.workspaceRoot,
    defaultModel: config.defaultModel,
    ghToken: config.ghToken,
    ghOwner: config.ghOwner,
    pinnedStatus,
    costTracker,
    log,
  };
  const deployDeps = {
    client,
    state,
    router,
    bot: turnBot,
    workspaceRoot: config.workspaceRoot,
    defaultModel: config.defaultModel,
    coolifyConfig: {
      url: config.coolifyUrl,
      token: config.coolifyToken,
      serverUuid: config.coolifyServerUuid,
      projectUuid: config.coolifyProjectUuid,
      githubAppUuid: config.coolifyGithubAppUuid,
    },
    pinnedStatus,
    costTracker,
    log,
  };
  const newDeps = { client, state, router, pinnedStatus, costTracker };
  const modelDeps = { client, state, pinnedStatus };
  const sessionsDeps = { client, state, router, pinnedStatus };

  bot.command("help", (ctx: Context) => handleHelp(ctx));
  bot.command("projects", (ctx) => handleProjects(ctx, projectsDeps));
  bot.command("switch", (ctx) => handleSwitch(ctx, switchDeps));
  bot.command("clone", (ctx) => handleClone(ctx, cloneDeps));
  bot.command("init", (ctx) => handleInit(ctx, initDeps));
  // NOTE: Telegram bot commands cannot contain hyphens (only [A-Za-z0-9_]),
  // so we register as "initremote" not "init-remote". /init-remote would be
  // parsed by Telegram as command="init" with arg="-remote ...", routing to
  // the /init handler instead.
  bot.command("initremote", (ctx) => handleInitRemote(ctx, initRemoteDeps));
  bot.command("deploy", (ctx) => handleDeploy(ctx, deployDeps));
  bot.command("new", (ctx) => handleNew(ctx, newDeps));
  bot.command("abort", (ctx) => handleAbort(ctx, { client, state }));
  bot.command("status", (ctx) => handleStatus(ctx, { state }));
  bot.command("model", (ctx) => handleModel(ctx, modelDeps));
  bot.command("pin", (ctx) => handlePin(ctx, { pinnedStatus }));
  bot.command("unpin", (ctx) => handleUnpin(ctx, { pinnedStatus }));
  bot.command("sessions", (ctx) => handleSessions(ctx, sessionsDeps));

  // 3) Permission + question button callbacks.
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
    const data = ctx.callbackQuery.data ?? "";
    // Build the callback object conditionally to satisfy
    // exactOptionalPropertyTypes (don't pass `message: undefined`).
    const msg = ctx.callbackQuery.message;
    const cb = {
      id: ctx.callbackQuery.id,
      data,
      ...(msg
        ? {
            message: {
              chat: { id: msg.chat.id },
              message_id: msg.message_id,
            },
          }
        : {}),
    };
    // Route by callback-data prefix. `pin:` belongs to the pinned-status
    // inline keyboard (its 5 buttons re-enter existing slash-command flows);
    // `qst:` belongs to QuestionService; anything else (notably `perm:`)
    // goes to PermissionService.
    if (data.startsWith("pin:")) {
      // Acknowledge the press so Telegram clears the spinner before we go
      // do work that may touch the network. answerCallbackQuery is
      // idempotent and best-effort.
      try {
        await ctx.answerCallbackQuery();
      } catch (err) {
        log.warn({ err }, "answerCallbackQuery for pin: failed");
      }
      const action = data.slice("pin:".length);
      // The compact 4-button row routes to existing slash-command handlers
      // using the already-built deps so the inline-keyboard path doesn't
      // duplicate any logic. `pin:info` is reserved for Task 8 (/info).
      if (action === "sessions") {
        await handleSessions(ctx as never, sessionsDeps);
        return;
      }
      if (action === "model") {
        await handleModel(ctx as never, modelDeps);
        return;
      }
      if (action === "deploy") {
        await handleDeploy(ctx as never, deployDeps);
        return;
      }
      if (action === "info") {
        // /info handler arrives in Task 8; for now log and bail so the
        // button doesn't silently crash anything.
        log.info({ chatId: ctx.chat?.id }, "pin:info pressed (handler pending)");
        return;
      }
      log.info({ action }, "unhandled pin: callback action");
      return;
    }
    if (data.startsWith("sess:")) {
      // Tap-to-switch from the /sessions inline keyboard. The handler
      // answers the callback query itself (clears the spinner) before
      // mutating chat_state.
      await handleSessionCallback(ctx as never, sessionsDeps);
      return;
    }
    if (data.startsWith("proj:")) {
      // Tap-to-switch from the /projects inline keyboard. Handler answers
      // the callback query itself; deps mirror /switch so the SSE
      // subscription is opened and pinned status is nudged.
      await handleProjectCallback(ctx as never, projectsCallbackDeps);
      return;
    }
    if (data.startsWith("model:")) {
      // Tap-to-set from the /model inline keyboard. Handler validates
      // the embedded provider/model ID, persists, and notifies pinned
      // status. answerCallbackQuery is handled inside the handler.
      await handleModelCallback(ctx as never, modelDeps);
      return;
    }
    if (data.startsWith("cancel:")) {
      // C2: [⏹ Cancel] button on streaming-view placeholder. Look up the
      // active Turn by sessionId, call Turn.cancel() to stop streaming
      // edits, then ask opencode to abort. Order matters: cancel() flips
      // `finalized` so any in-flight or queued edit becomes a no-op,
      // preventing the streaming view from re-stomping whatever opencode
      // emits on its way to the abort. The user's original message gets
      // ⏸ via reactCancelled so the chat history shows what happened.
      const sessionId = data.slice("cancel:".length);
      const entry = ActiveTurns.get(sessionId);
      if (!entry) {
        // Turn already finalized between when Telegram rendered the
        // button and when the user tapped it. Telegram caches the
        // keyboard for ~60s after the message edit, so this race is real.
        try {
          await ctx.answerCallbackQuery({ text: "Already done" });
        } catch (err) {
          log.warn({ err }, "answerCallbackQuery for stale cancel: failed");
        }
        return;
      }
      try {
        await ctx.answerCallbackQuery({ text: "Cancelling…" });
      } catch (err) {
        log.warn({ err }, "answerCallbackQuery for cancel: failed");
      }
      // cancel() is idempotent and safe to await — it clears the
      // streaming-edit timer and waits for any in-flight edit to settle.
      await entry.turn.cancel();
      try {
        await client.abortSession(sessionId);
      } catch (err) {
        log.warn({ err: describeError(err), sessionId }, "abortSession failed during cancel");
      }
      // ⏸ on the user's original message — distinct from ✅ (success) and
      // ❌ (failure). Best-effort; reactions are a UX nicety. Cast follows
      // the same `as never` pattern message-handler uses: grammy's strict
      // ReactionTypeEmoji union doesn't structurally match our narrow
      // ReactionBot interface, but the runtime shape is compatible.
      void reactCancelled(bot as never, entry.chatId, entry.userMessageId, log);
      // Clear from the registry so subsequent taps land in the
      // "Already done" branch above.
      ActiveTurns.delete(sessionId);
      return;
    }
    if (data.startsWith("qst:")) {
      await questions.handleCallback(cb);
      return;
    }
    await permissions.handleCallback(cb);
  });

  // 4) Default text handler.
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    // Intercept text intended as a custom-typed answer to a pending question.
    // Slash commands (`/...`) are NOT intercepted — those go to bot.command()
    // first; this handler only fires for non-command text. Without this gate
    // the user's typed answer would be re-sent to opencode as a brand new
    // prompt, which is exactly what the question flow tries to avoid.
    if (
      typeof chatId === "number" &&
      typeof text === "string" &&
      !text.startsWith("/") &&
      questions.isAwaitingCustomAnswer(chatId)
    ) {
      try {
        await questions.handleCustomAnswer(chatId, text);
      } catch (err) {
        log.error({ err, chatId }, "questions.handleCustomAnswer failed");
      }
      return;
    }
    await handleTextMessage(ctx, {
      state,
      client,
      router,
      permissions,
      questions,
      bot: turnBot,
      defaultModel: config.defaultModel,
      pinnedStatus,
      costTracker,
      log,
    });
  });

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

  // Register slash commands so Telegram's `/` autocomplete shows them on
  // every device. Failure is non-fatal — commands still work via typing.
  await registerCommands(bot, log);

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

async function registerCommands(bot: Bot, log: pino.Logger): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "help", description: "Show available commands" },
      { command: "projects", description: "List projects (tap to switch)" },
      { command: "switch", description: "Switch to a project" },
      { command: "init", description: "Create a local project" },
      { command: "initremote", description: "Create project + private GitHub repo" },
      { command: "clone", description: "Clone a git repo into workspace" },
      { command: "new", description: "Start a fresh session in current project" },
      { command: "abort", description: "Cancel the current operation" },
      { command: "status", description: "Show current chat state" },
      { command: "model", description: "List models (tap to set)" },
      { command: "sessions", description: "Recent sessions (tap to switch)" },
      { command: "deploy", description: "Push + deploy current project to Coolify" },
      { command: "pin", description: "Re-engage the pinned status message" },
      { command: "unpin", description: "Pause auto-updates of pinned status" },
    ]);
  } catch (err) {
    log.warn({ err }, "setMyCommands failed; commands still work via typing");
  }
}

main().catch((err) => {
  // Top-level errors crash the process so the container restart policy kicks in.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
