/**
 * Project creation orchestration: shared logic for /clone and /init.
 *
 * Both commands send a deterministic prompt to a one-shot opencode session
 * anchored at /workspace. The LLM uses its bash tool to execute git clone
 * or mkdir + git init. On success, the bridge auto-switches the chat to
 * the newly-created project.
 *
 * This module exports pure helpers (prompt-builders, success-detection)
 * plus the orchestration function `createProject`.
 */

import { join } from "node:path";
import type { Logger } from "pino";
import type { OpencodeClient } from "./opencode-client.js";
import type { ChatStateRepo } from "./chat-state.js";
import type { SessionEventHandler } from "./event-router.js";
import type { TurnBot } from "./turn.js";
import type { PinnedStatusDeps } from "./pinned-status.js";
import type { CostTracker, AssistantMessageInfo } from "./cost-tracker.js";
import { Turn, type IncomingPart } from "./turn.js";
import { getCurrentBranch } from "./branch-info.js";
import { safeEdit } from "./safe-telegram.js";
import { buildSwitchConfirmation } from "./commands/switch.js";
import { describeError } from "./errors.js";
import { parseModelId } from "./config.js";

export type CreationKind = "clone" | "init" | "init-remote";

/**
 * Minimal shape detectSuccess needs from each part. Both real callers
 * (IncomingPart from turn.ts) and test object literals satisfy this
 * structurally — detectSuccess is generic over the concrete shape so no
 * cast is required at the call site.
 */
export interface MaybeTextPart {
  type: string;
  text?: string;
}

/** Build the deterministic prompt sent to opencode for a /clone command. */
export function buildClonePrompt(url: string, name: string): string {
  return [
    "Run exactly this single command and report only the result. Do not run any other commands. Do not summarize the output. Do not explore the cloned repository.",
    "",
    `git clone -o StrictHostKeyChecking=accept-new ${url} /workspace/${name}`,
    "",
    "If the command succeeds (exit code 0), reply with the single word: cloned",
    "",
    "If the command fails, reply with: failed: <one-sentence summary of the error>",
  ].join("\n");
}

/** Build the deterministic prompt sent to opencode for an /init command. */
export function buildInitPrompt(name: string): string {
  return [
    "Run exactly this single command and report only the result. Do not run any other commands. Do not create README files, .gitignore, or any other content.",
    "",
    `mkdir -p /workspace/${name} && git init /workspace/${name}`,
    "",
    "If the command succeeds (exit code 0), reply with the single word: initialized",
    "",
    "If the command fails, reply with: failed: <one-sentence summary of the error>",
  ].join("\n");
}

/**
 * Build the deterministic prompt sent to opencode for an /init-remote command.
 *
 * Runs the full create-local-+-create-remote-+-push sequence in a single bash
 * invocation so the agent can't fork into multiple commands.
 *
 * IMPORTANT: we do NOT use `gh repo create --push` because GitHub's API
 * returns success on the create endpoint before the repo's git endpoint is
 * fully propagated, so the immediate push hits a 404 race intermittently.
 * Instead we create the repo, then loop the push with backoff (3 attempts).
 */
export function buildInitRemotePrompt(name: string, owner: string): string {
  return [
    "Run exactly this single bash command and report only the result. Do not run any other commands. Do not summarize or explore the new repository.",
    "",
    "```bash",
    `set -e`,
    `mkdir -p /workspace/${name}`,
    `cd /workspace/${name}`,
    `git init`,
    `echo "# ${name}" > README.md`,
    `git add README.md && git commit -m "Initial commit"`,
    `# Create the GitHub repo + add the origin remote (no auto-push here).`,
    `# GitHub's create API returns before the git endpoint is propagated;`,
    `# an immediate push hits 'repository not found' intermittently.`,
    `gh repo create ${owner}/${name} --private --source=. --remote=origin`,
    `# Push with backoff to absorb the propagation lag (~1-3 seconds).`,
    `for attempt in 1 2 3 4 5; do`,
    `  if git push -u origin main 2>&1; then`,
    `    PUSHED=1`,
    `    break`,
    `  fi`,
    `  sleep $attempt`,
    `done`,
    `if [ -z "\${PUSHED:-}" ]; then`,
    `  echo "failed: git push to ${owner}/${name} failed after 5 attempts (15s of backoff)"`,
    `  exit 0`,
    `fi`,
    `echo "remote_initialized"`,
    "```",
    "",
    "If the script prints `remote_initialized`, reply with that single word.",
    "",
    "If the script prints `failed: ...`, reply with that exact line.",
    "",
    "If any command fails before the script reaches its end, reply with: failed: <one-sentence summary of the error>",
  ].join("\n");
}

/**
 * Inspect the assistant message parts for a creation-success marker.
 *
 * Uses the LAST non-empty text part — the agent's final reply per our
 * prompt contract. Earlier text parts may be preamble narration like
 * "I need to run the exact command...". The marker is matched as a
 * contained word (\binitialized\b / \bcloned\b) so verbose replies like
 * "Successfully initialized the directory" also match. A leading
 * /^failed:/i in the last part is a hard-fail signal and short-circuits
 * to false, even if the marker word also appears.
 */
export function detectSuccess<P extends MaybeTextPart>(
  parts: readonly P[],
  kind: CreationKind,
): boolean {
  // Use the LAST non-empty text part — the agent's final reply per our
  // prompt contract. Earlier text parts may be preamble narration like
  // "I need to run the exact command...".
  const textParts = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text ?? "").trim())
    .filter((t) => t.length > 0);
  const last = textParts.at(-1) ?? "";
  // Hard fail signal: agent followed our "failed: ..." contract.
  if (/^failed:/i.test(last)) return false;
  // Match the marker as a contained word, so verbose replies like
  // "Successfully initialized the directory" also match.
  // Order matters: test init-remote before init. \binitialized\b would NOT
  // match "remote_initialized" anyway because `_` is a word char (so \b sits
  // at the start of "remote", not at "initialized"), but explicit ordering
  // makes the intent obvious.
  const marker =
    kind === "clone"
      ? /\bcloned\b/i
      : kind === "init-remote"
      ? /\bremote_initialized\b/i
      : /\binitialized\b/i;
  return marker.test(last);
}

export interface CreateProjectArgs {
  chatId: number;
  placeholderId: number;
  name: string;
  kind: CreationKind;
  /** Required when kind === "clone". */
  url?: string;
  /** Required when kind === "init-remote". GitHub owner namespace. */
  owner?: string;
  workspaceRoot: string;
  /**
   * Optional override for the model used by the one-shot orchestration
   * session. When omitted, falls back to `deps.defaultModel`. Pass the
   * chat's currently-selected model from chat_state so /init/clone/initremote
   * don't silently switch providers behind the user's back.
   */
  modelId?: string;
}

export interface CreateProjectDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
    ensureDirectory(directory: string): boolean;
  };
  bot: TurnBot;
  defaultModel: string;
  /**
   * Pinned-status manager. createProject sets the pinned message to
   * Working at session start, Idle on success (after auto-switch persists
   * the new project), Failed on error. Optional so legacy/test call sites
   * can omit it.
   */
  pinnedStatus?: PinnedStatusDeps;
  /**
   * Optional cumulative-cost tracker. Tokens spent by the one-shot
   * orchestration session DO count toward the chat (real spend), but
   * after a successful auto-switch we reset() since the chat now points
   * at a brand new project + session. Optional so tests can omit it.
   */
  costTracker?: CostTracker;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Drive the create-a-project flow:
 *  1. Open a one-shot opencode session at the workspace root
 *  2. Send the deterministic clone-or-init prompt
 *  3. Stream tool calls into the placeholder via Turn (reuses render overhaul UX)
 *  4. On session.idle, detect success marker:
 *     - success → create a fresh session in /workspace/<name>, update chat-state,
 *       ensure SSE subscription, replace placeholder with switch confirmation
 *     - failure → let Turn.finalize render the LLM's error response, leave chat-state alone
 *
 * Returns immediately after dispatching the prompt (does NOT await it). The
 * actual completion is handled asynchronously by the SessionEventHandler.
 */
export async function createProject(
  args: CreateProjectArgs,
  deps: CreateProjectDeps,
): Promise<void> {
  if (args.kind === "clone" && !args.url) {
    throw new Error("createProject: kind=clone requires a url argument");
  }
  if (args.kind === "init-remote" && !args.owner) {
    throw new Error("createProject: kind=init-remote requires an owner argument");
  }

  // Ensure SSE subscription on the workspace root so the one-shot session's
  // events reach our handler. Idempotent.
  deps.router.ensureDirectory(args.workspaceRoot);

  // Reflect the in-flight create operation on the pinned status header so
  // the user sees what's happening at a glance even when the placeholder
  // scrolls off-screen.
  deps.pinnedStatus?.setWorking(
    args.chatId,
    args.kind === "clone"
      ? `cloning ${args.name}`
      : args.kind === "init-remote"
      ? `initializing ${args.name} (+ remote)`
      : `initializing ${args.name}`,
  );

  // Open the one-shot session for the creation operation.
  const sessionTitle = `tg:${args.kind}:${args.name}`;
  const oneShotSession = await deps.client.createSession(sessionTitle, {
    directory: args.workspaceRoot,
  });

  // Build the prompt for this kind.
  const prompt =
    args.kind === "clone"
      ? buildClonePrompt(args.url!, args.name)
      : args.kind === "init-remote"
      ? buildInitRemotePrompt(args.name, args.owner ?? "")
      : buildInitPrompt(args.name);

  // Set up the streaming Turn for the placeholder.
  const turn = new Turn(deps.bot, args.chatId, args.placeholderId);
  const collectedParts: IncomingPart[] = [];
  // Track user-role message IDs so the failure-path final view doesn't echo
  // the deterministic prompt back at the user (see message-handler.ts).
  const userMessageIds = new Set<string>();

  let unregistered = false;
  const unregister = deps.router.registerSession(oneShotSession.id, {
    onMessageUpdated(msg) {
      const m = msg as {
        info?: {
          id?: string;
          role?: string;
          agent?: string;
          tokens?: AssistantMessageInfo["tokens"];
          cost?: number;
        };
      };
      if (m.info?.role === "user" && typeof m.info.id === "string") {
        userMessageIds.add(m.info.id);
      }
      if (m.info?.role === "assistant" && typeof m.info.id === "string") {
        deps.costTracker?.recordAssistantMessage(args.chatId, {
          id: m.info.id,
          ...(m.info.tokens ? { tokens: m.info.tokens } : {}),
          ...(typeof m.info.cost === "number" ? { cost: m.info.cost } : {}),
        });
        deps.state.setAgentMode(args.chatId, m.info.agent ?? "build");
      }
      if (typeof m.info?.id === "string") {
        deps.state.setLastActivityAt(args.chatId, Date.now());
      }
    },
    onPartUpdated(part) {
      const p = part as IncomingPart;
      if (typeof p.id !== "string") return;
      // Track in our own list for success detection (Turn keeps its own copy
      // for rendering; we maintain this one for end-of-session inspection).
      const idx = collectedParts.findIndex((cp) => cp.id === p.id);
      if (idx >= 0) collectedParts[idx] = p;
      else collectedParts.push(p);
      turn.appendPart(p);
    },
    onSessionStatus(properties) {
      const status = (properties as { status?: unknown }).status;
      if (status) turn.setSessionStatus(status);
    },
    async onIdle() {
      try {
        if (detectSuccess(collectedParts, args.kind)) {
          // Stop streaming view BEFORE performAutoSwitch overwrites the
          // placeholder. Without this, a queued setTimeout could fire after
          // the switch confirmation lands and revert the placeholder back
          // to "⚡ bash mkdir... / thinking…".
          await turn.cancel();
          await performAutoSwitch(args, deps);
          // performAutoSwitch wrote new project + session into chat-state;
          // notify PSM so the pinned message shows the new project name on
          // its next flush. setIdle clears the "Working" detail.
          deps.pinnedStatus?.setIdle(args.chatId);
          deps.pinnedStatus?.notifyStateChange(args.chatId);
        } else {
          // Failure path: render the LLM's error response into the placeholder.
          await turn.finalize({ userMessageIds });
          deps.pinnedStatus?.setFailed(
            args.chatId,
            `${args.kind} ${args.name} failed`,
          );
          // Re-flush pinned so any partial git state (init may have created
          // /workspace/<name>/.git even on subsequent failure) shows up.
          deps.pinnedStatus?.notifyStateChange(args.chatId);
        }
      } catch (err) {
        deps.log?.error?.(
          { chatId: args.chatId, name: args.name, kind: args.kind, err: describeError(err) },
          "createProject onIdle handler threw",
        );
      }
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    async onError(err) {
      const msg = describeError(err);
      try {
        await turn.showError(msg);
      } catch (showErr) {
        deps.log?.error?.(
          { chatId: args.chatId, name: args.name, kind: args.kind, err: describeError(showErr) },
          "createProject onError handler threw",
        );
      }
      deps.pinnedStatus?.setFailed(args.chatId, msg.slice(0, 80));
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    onPermissionUpdated() {
      // Permission events for the one-shot creation session are not surfaced
      // to the user via keyboard. The server-side policy is `allow` for
      // everything, so this branch is unreachable in practice. If a future
      // policy tightens, add keyboard rendering here.
    },
  });

  // Fire-and-forget the prompt. Same pattern as message-handler: we MUST NOT
  // await, or grammy's update queue blocks until the prompt resolves.
  const model = parseModelId(args.modelId ?? deps.defaultModel);
  deps.client
    .prompt(oneShotSession.id, prompt, {
      ...(model ? { model } : {}),
      directory: args.workspaceRoot,
    })
    .catch(async (err) => {
      const msg = describeError(err);
      try {
        await turn.showError(`prompt failed: ${msg}`);
      } finally {
        deps.pinnedStatus?.setFailed(args.chatId, msg.slice(0, 80));
        if (!unregistered) {
          unregistered = true;
          unregister();
        }
      }
    });
}

/**
 * Auto-switch the chat to the newly-created project: open a fresh session
 * anchored to the new subdirectory, store it in chat-state, ensure SSE
 * subscription, and replace the placeholder with the standard switch
 * confirmation. Mirrors the tail half of switch.ts's handleSwitch.
 */
async function performAutoSwitch(
  args: CreateProjectArgs,
  deps: CreateProjectDeps,
): Promise<void> {
  const projectPath = join(args.workspaceRoot, args.name);
  const session = await deps.client.createSession(`tg:${args.name}`, {
    directory: projectPath,
  });
  deps.state.setProject(args.chatId, projectPath, session.id);
  deps.router.ensureDirectory(projectPath);
  // Persist the new (long-running) session's slug + started_at for /info
  // and the pinned-status header. The one-shot orchestration session's
  // slug is irrelevant — that session is throwaway.
  deps.state.setSessionSlug(args.chatId, session.slug ?? null);
  deps.state.setSessionStartedAt(
    args.chatId,
    session.time?.created ?? Date.now(),
  );
  // New chat session = fresh cumulative counters. CostTracker.reset clears
  // both the in-memory seen-IDs cache and chat_state cumulative.
  deps.costTracker?.reset(args.chatId);
  // Refresh the cached branch since we just landed in a new project.
  // getCurrentBranch is cheap (single git ref read, 5s cache) and falls
  // through to null for non-git directories.
  try {
    const branch = await getCurrentBranch(projectPath);
    deps.state.setBranch(args.chatId, branch);
  } catch (err) {
    deps.log?.warn?.(
      { err, projectPath },
      "performAutoSwitch: getCurrentBranch threw",
    );
  }
  // Clear agent_mode until the first assistant message in the new session
  // reveals it. Avoids stale "build" carrying over from prior session.
  deps.state.setAgentMode(args.chatId, null);
  // buildSwitchConfirmation returns MarkdownV2-escaped text — opt in here
  // so the HTML default in safeEdit doesn't mangle the backslashes.
  await safeEdit(
    deps.bot,
    args.chatId,
    args.placeholderId,
    buildSwitchConfirmation(args.name, projectPath, session.id),
    deps.log,
    "MarkdownV2",
  );
}
