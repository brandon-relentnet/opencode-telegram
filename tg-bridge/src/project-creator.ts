/**
 * Project creation orchestration: shared logic for /clone and /init.
 *
 * Both commands send a deterministic prompt to a one-shot opencode session
 * anchored at /workspace. The LLM uses its bash tool to execute git clone
 * or mkdir + git init. On success, the bridge auto-switches the chat to
 * the newly-created project.
 *
 * This module exports pure helpers (prompt-builders, success-detection)
 * plus the orchestration function `createProject` (added in a later task).
 */

export type CreationKind = "clone" | "init";

interface MaybeTextPart {
  type: string;
  text?: string;
  // Real callers pass IncomingPart-shaped objects with id, tool, state, etc.
  // We only consume `type` and `text`; the index signature lets the structural
  // type accept those extra fields without requiring callers to narrow.
  [k: string]: unknown;
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
 * Concatenates all text parts in arrival order, trims, and checks the
 * resulting string starts with the expected word ("cloned" or "initialized")
 * followed by a word boundary. Case-insensitive.
 */
export function detectSuccess(parts: readonly MaybeTextPart[], kind: CreationKind): boolean {
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text ?? "").trim())
    .filter((t) => t.length > 0)
    .join("\n")
    .trim();
  if (text.length === 0) return false;
  const marker = kind === "clone" ? /^cloned\b/i : /^initialized\b/i;
  return marker.test(text);
}
