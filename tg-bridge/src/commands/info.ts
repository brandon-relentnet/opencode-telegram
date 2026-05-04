import type { Context } from "grammy";
import { basename } from "node:path";
import { escapeHtml } from "../markdown-to-html.js";
import { getGitInfo, type GitInfo } from "../branch-info.js";
import { describeError } from "../errors.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { OpencodeClient, BridgeSession } from "../opencode-client.js";

/**
 * Logger shape used by /info. Narrow to `info | warn` so any pino-compatible
 * logger satisfies it without forcing a full pino dep into the test fakes.
 */
interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface InfoDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  log?: Logger;
}

/**
 * /info — full state dump for the current chat. Aggregates chat_state,
 * `branch-info.getGitInfo`, the live opencode session record, and the
 * provider's context-window limit (cached on chat_state once retrieved).
 *
 * Sections are gated on data presence:
 *   - No project switched     → bail with hint.
 *   - Non-git project         → Git section says "not a git repository".
 *   - No Coolify app          → Deploy section omitted.
 *   - Session lookup throws   → fall back to cached chat_state values.
 */
export async function handleInfo(ctx: Context, deps: InfoDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;

  const row = deps.state.get(chatId);
  if (!row?.projectPath) {
    await ctx.reply("No project switched. Use /switch first.");
    return;
  }

  const projectPath = row.projectPath;

  // Run independent lookups in parallel so /info stays snappy even when the
  // project is huge or the opencode server is across the network.
  const [gitInfo, session] = await Promise.all([
    safeGetGitInfo(projectPath, deps.log),
    safeGetSession(deps.client, row.sessionId, deps.log),
  ]);

  // Refresh context_limit lazily — only when we have a model AND no cached
  // value yet, so /info doesn't pummel /provider on every invocation.
  let contextLimit = deps.state.getContextLimit(chatId);
  if (contextLimit == null && row.model) {
    const slashIdx = row.model.indexOf("/");
    if (slashIdx > 0) {
      const providerId = row.model.slice(0, slashIdx);
      const modelId = row.model.slice(slashIdx + 1);
      try {
        contextLimit = await deps.client.getModelContextLimit(providerId, modelId);
        if (contextLimit != null) {
          deps.state.setContextLimit(chatId, contextLimit);
        }
      } catch (err) {
        deps.log?.warn(
          { err: describeError(err), providerId, modelId },
          "info: getModelContextLimit failed",
        );
      }
    }
  }

  const lines: string[] = [];
  lines.push(...renderProjectSection(projectPath, gitInfo));
  lines.push("");
  lines.push(...renderGitSection(gitInfo));
  lines.push("");
  lines.push(...renderSessionSection(deps.state, chatId, row.sessionId, session));
  lines.push("");
  lines.push(
    ...renderModelSection(deps.state, chatId, row.model, contextLimit),
  );

  const coolifyApp = deps.state.getCoolifyApp(chatId, projectPath);
  if (coolifyApp) {
    lines.push("");
    lines.push(
      ...renderDeploySection(
        coolifyApp,
        deps.state.getLastDeployAt(chatId),
      ),
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function safeGetGitInfo(
  projectPath: string,
  log: Logger | undefined,
): Promise<GitInfo> {
  try {
    return await getGitInfo(projectPath);
  } catch (err) {
    log?.warn({ err: describeError(err), projectPath }, "info: getGitInfo failed");
    return {
      branch: null,
      status: { modified: 0, untracked: 0 },
      ahead: 0,
      behind: 0,
      lastCommit: null,
      remote: null,
    };
  }
}

async function safeGetSession(
  client: OpencodeClient,
  sessionId: string | null,
  log: Logger | undefined,
): Promise<BridgeSession | null> {
  if (!sessionId) return null;
  try {
    return await client.getSession(sessionId);
  } catch (err) {
    log?.warn({ err: describeError(err), sessionId }, "info: getSession failed");
    return null;
  }
}

function renderProjectSection(projectPath: string, gitInfo: GitInfo): string[] {
  const out: string[] = [];
  const name = basename(projectPath);
  out.push(`📁 <b>${escapeHtml(name)}</b>`);
  out.push(`   Path: <code>${escapeHtml(projectPath)}</code>`);
  if (gitInfo.remote) {
    // Render the remote as a clickable github link when it looks like owner/repo.
    if (/^[^\s]+\/[^\s]+$/.test(gitInfo.remote)) {
      const url = `https://github.com/${gitInfo.remote}`;
      out.push(
        `   GitHub: <a href="${escapeHtml(url)}">${escapeHtml(gitInfo.remote)}</a>`,
      );
    } else {
      out.push(`   GitHub: ${escapeHtml(gitInfo.remote)}`);
    }
  }
  return out;
}

function renderGitSection(gitInfo: GitInfo): string[] {
  const out: string[] = ["🌿 <b>Git</b>"];
  if (gitInfo.branch == null) {
    out.push("   not a git repository");
    return out;
  }
  out.push(`   Branch: <code>${escapeHtml(gitInfo.branch)}</code>`);
  const { modified, untracked } = gitInfo.status;
  if (modified === 0 && untracked === 0) {
    out.push("   Status: clean");
  } else {
    out.push(`   Status: ${modified} modified, ${untracked} untracked`);
  }
  out.push(`   Behind/ahead origin: ${gitInfo.behind}/${gitInfo.ahead}`);
  if (gitInfo.lastCommit) {
    const { sha, message, ageMs } = gitInfo.lastCommit;
    out.push(
      `   Last commit: <code>${escapeHtml(sha)}</code> ${escapeHtml(quote(message))} (${formatAgo(ageMs)})`,
    );
  }
  return out;
}

function renderSessionSection(
  state: ChatStateRepo,
  chatId: number,
  sessionId: string | null,
  liveSession: BridgeSession | null,
): string[] {
  const out: string[] = ["🎭 <b>Session</b>"];
  // Prefer live SDK values when available; otherwise fall back to chat_state.
  const slug = liveSession?.slug ?? state.getSessionSlug(chatId);
  if (slug) {
    out.push(`   Slug: <code>${escapeHtml(slug)}</code>`);
  }
  if (sessionId) {
    out.push(`   ID: <code>${escapeHtml(sessionId)}</code>`);
  }
  const startedAt = liveSession?.time?.created ?? state.getSessionStartedAt(chatId);
  if (startedAt != null) {
    const ageMs = Date.now() - startedAt;
    const time = new Date(startedAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    out.push(`   Started: ${escapeHtml(time)} (${formatAgo(ageMs)})`);
  }
  // If we have nothing at all, surface that explicitly so the section isn't
  // an empty header.
  if (out.length === 1) {
    out.push("   (no session)");
  }
  return out;
}

function renderModelSection(
  state: ChatStateRepo,
  chatId: number,
  model: string | null,
  contextLimit: number | null,
): string[] {
  const out: string[] = ["🤖 <b>Model</b>"];
  if (!model) {
    out.push("   (default)");
    return out;
  }
  const agentMode = state.getAgentMode(chatId);
  const modeLabel = agentMode ? `${escapeHtml(agentMode)} mode` : "default mode";
  out.push(`   <code>${escapeHtml(model)}</code> · ${modeLabel}`);

  const stats = state.getCumulativeStats(chatId);
  // Total context usage = input + output + reasoning + cache.read + cache.write
  // (cache reads still count against the model's context window).
  const used =
    stats.tokensInput +
    stats.tokensOutput +
    stats.tokensReasoning +
    stats.tokensCacheRead +
    stats.tokensCacheWrite;
  if (contextLimit != null && contextLimit > 0) {
    const pct = Math.round((used / contextLimit) * 100);
    out.push(
      `   Context: ${formatNumber(used)} / ${formatNumber(contextLimit)} tokens (${pct}%)`,
    );
  } else if (used > 0) {
    out.push(`   Context: ${formatNumber(used)} tokens`);
  }
  out.push(`   Cost so far: ${formatCostMicros(stats.costMicros)}`);
  return out;
}

function renderDeploySection(
  coolifyApp: { uuid: string; fqdn: string },
  lastDeployAt: number | null,
): string[] {
  const out: string[] = ["☁️ <b>Deploy</b>"];
  out.push(`   App uuid: <code>${escapeHtml(coolifyApp.uuid)}</code>`);
  const url = `https://${coolifyApp.fqdn}`;
  out.push(`   URL: <a href="${escapeHtml(url)}">${escapeHtml(coolifyApp.fqdn)}</a>`);
  if (lastDeployAt != null) {
    out.push(`   Last deployed: ${formatAgo(Date.now() - lastDeployAt)}`);
  }
  // Coolify dashboard URL is bridge-config-dependent (different self-hosters
  // use different domains); we can't guess it here. The deploy command logs
  // it; /info just shows the app uuid + FQDN, which are sufficient to find
  // it in any Coolify UI.
  return out;
}

/**
 * Render a "12m ago" / "2h ago" / "just now" relative timestamp from a
 * positive ms duration. Mirrors PinnedStatusManager.formatDeployAgo so the
 * pinned and /info surfaces speak the same dialect.
 */
function formatAgo(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const min = Math.floor(ageMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** Format a non-negative integer with thousand-separators (e.g. 23,481). */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format integer micros as "$0.42". Always two decimal places. */
function formatCostMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Wrap a string in straight double quotes for display. */
function quote(s: string): string {
  return `"${s}"`;
}
