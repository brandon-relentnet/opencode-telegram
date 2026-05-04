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

export interface CloneDeps {
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

/**
 * Permissive git-URL recognizer. Matches:
 *   - SSH: git@host:path
 *   - SSH long form: ssh://user@host/path
 *   - HTTP/HTTPS: http(s)://host/path
 * Does NOT validate that the URL points at a reachable repo — that's the
 * LLM bash call's job.
 */
const GIT_URL_RE = /^(git@[\w.-]+:|ssh:\/\/|https?:\/\/)/;

/**
 * Derive a sensible default project name from a git URL. Examples:
 *   git@github.com:foo/bar.git    → bar
 *   https://github.com/foo/bar    → bar
 *   https://example.com/team/x.git → x
 * Returns "" if no usable name can be extracted (caller should reject).
 */
export function deriveProjectName(url: string): string {
  if (!url) return "";
  // Strip trailing slash(es)
  const trimmed = url.replace(/\/+$/, "");
  // Take the part after the last "/" or ":"
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
  const tail = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
  // Strip trailing ".git"
  return tail.replace(/\.git$/, "");
}

/**
 * Parse the args portion of /clone (i.e. ctx.match). Returns the URL and an
 * optional explicit-name override.
 */
export function parseCloneArgs(raw: string): { url: string | undefined; explicitName: string | undefined } {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  return {
    url: tokens[0],
    explicitName: tokens[1],
  };
}

export async function handleClone(ctx: Context, deps: CloneDeps): Promise<void> {
  try {
    const raw = (ctx.match as string | undefined) ?? "";
    const { url, explicitName } = parseCloneArgs(raw);

    if (!url) {
      await ctx.reply(escapeMarkdownV2("Usage: /clone <git-url> [name]"), {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    if (!GIT_URL_RE.test(url)) {
      await ctx.reply(escapeMarkdownV2(`Doesn't look like a git URL: ${url}`), {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    const name = explicitName ?? deriveProjectName(url);

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

    // Send placeholder; remember its message_id for createProject to update.
    const placeholder = await ctx.reply(escapeMarkdownV2(`cloning ${name}…`), {
      parse_mode: "MarkdownV2",
    });
    const placeholderId =
      typeof (placeholder as { message_id?: number }).message_id === "number"
        ? (placeholder as { message_id: number }).message_id
        : 0;

    // Inherit chat's model — see init.ts comment.
    const stateRow = deps.state.get(ctx.chat!.id);
    const modelId = stateRow?.model ?? deps.defaultModel;

    await createProject(
      {
        chatId: ctx.chat!.id,
        placeholderId,
        name,
        kind: "clone",
        url,
        workspaceRoot: deps.workspaceRoot,
        modelId,
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
    await ctx.reply(escapeMarkdownV2(`❌ /clone failed: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
  }
}
