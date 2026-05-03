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
import { Turn, type IncomingPart } from "./turn.js";
import { safeEdit } from "./safe-telegram.js";
import { buildSwitchConfirmation } from "./commands/switch.js";
import { describeError } from "./errors.js";
import { parseModelId } from "./config.js";

export type CreationKind = "clone" | "init";

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
  const marker = kind === "clone" ? /\bcloned\b/i : /\binitialized\b/i;
  return marker.test(last);
}

export interface CreateProjectArgs {
  chatId: number;
  placeholderId: number;
  name: string;
  kind: CreationKind;
  /** Required when kind === "clone". */
  url?: string;
  workspaceRoot: string;
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

  // Ensure SSE subscription on the workspace root so the one-shot session's
  // events reach our handler. Idempotent.
  deps.router.ensureDirectory(args.workspaceRoot);

  // Open the one-shot session for the creation operation.
  const sessionTitle = `tg:${args.kind}:${args.name}`;
  const oneShotSession = await deps.client.createSession(sessionTitle, {
    directory: args.workspaceRoot,
  });

  // Build the prompt for this kind.
  const prompt =
    args.kind === "clone"
      ? buildClonePrompt(args.url!, args.name)
      : buildInitPrompt(args.name);

  // Set up the streaming Turn for the placeholder.
  const turn = new Turn(deps.bot, args.chatId, args.placeholderId);
  const collectedParts: IncomingPart[] = [];

  let unregistered = false;
  const unregister = deps.router.registerSession(oneShotSession.id, {
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
    async onIdle() {
      try {
        if (detectSuccess(collectedParts, args.kind)) {
          await performAutoSwitch(args, deps);
        } else {
          // Failure path: render the LLM's error response into the placeholder.
          await turn.finalize();
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
      try {
        await turn.showError(describeError(err));
      } catch (showErr) {
        deps.log?.error?.(
          { chatId: args.chatId, name: args.name, kind: args.kind, err: describeError(showErr) },
          "createProject onError handler threw",
        );
      }
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
  const model = parseModelId(deps.defaultModel);
  deps.client
    .prompt(oneShotSession.id, prompt, {
      ...(model ? { model } : {}),
      directory: args.workspaceRoot,
    })
    .catch(async (err) => {
      try {
        await turn.showError(`prompt failed: ${describeError(err)}`);
      } finally {
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
  await safeEdit(
    deps.bot,
    args.chatId,
    args.placeholderId,
    buildSwitchConfirmation(args.name, projectPath, session.id),
    deps.log,
  );
}
