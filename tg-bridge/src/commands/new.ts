import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { PinnedStatusDeps } from "../pinned-status.js";
import type { CostTracker } from "../cost-tracker.js";

export interface NewDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  /**
   * EventRouter handle so /new can defensively re-ensure the SSE
   * subscription for the project's directory. Almost always already open
   * (because /switch opens it), but ensure is idempotent and cheap.
   */
  router: { ensureDirectory(directory: string): boolean };
  /**
   * Pinned-status manager. /new calls notifyStateChange after rotating to
   * the freshly-created session so the pinned message reflects the change.
   */
  pinnedStatus?: PinnedStatusDeps;
  /**
   * Cumulative-cost tracker. /new resets cumulative counters since the
   * new session starts a clean slate. Optional so tests can omit it.
   */
  costTracker?: CostTracker;
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

  let session: Awaited<ReturnType<typeof deps.client.createSession>>;
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
  // Same metadata as /switch — fresh slug + started_at, reset cumulative
  // counters, clear agent_mode. Branch is unchanged (project didn't move).
  deps.state.setSessionSlug(chatId, session.slug ?? null);
  deps.state.setSessionStartedAt(chatId, session.time?.created ?? Date.now());
  deps.costTracker?.reset(chatId);
  deps.state.setAgentMode(chatId, null);
  deps.router.ensureDirectory(current.projectPath);
  deps.pinnedStatus?.notifyStateChange(chatId);

  await ctx.reply(
    [
      `*${escapeMarkdownV2("New session")}*`,
      escapeMarkdownV2(`Project: ${current.projectPath}`),
      escapeMarkdownV2(`Session: ${session.id}`),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
