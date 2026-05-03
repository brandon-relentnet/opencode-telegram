# Telegram Project Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/clone <git-url> [name]` and `/init <name>` Telegram commands. Both create projects under `/workspace` by dispatching a constrained prompt to a one-shot opencode session whose bash tool does the actual work. On success, the chat auto-switches to the new project.

**Architecture:** Bridge validates input pre-LLM (name safety, target collision, URL format), then sends a deterministic prompt to a session anchored at `/workspace`. Custom event handler intercepts `session.idle`, detects success marker (`cloned`/`initialized`), and auto-switches by creating a new session in the new subdirectory + replacing the placeholder with the standard switch confirmation. On failure, the LLM's error response stays visible and chat-state is unchanged.

**Tech Stack:** TypeScript (Node 22, ESM, strict), grammy, vitest, pino. Project uses `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Test mocks use `mock.calls[0]!` non-null assertions per existing convention.

**Spec:** `docs/superpowers/specs/2026-05-02-telegram-project-creation-design.md`

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `tg-bridge/src/commands/switch.ts` | Modify (extract helpers) | Export `isSafeProjectName` and `buildSwitchConfirmation` so project-creator can reuse them. Existing handler behavior unchanged. |
| `tg-bridge/src/project-creator.ts` | Create | Pure helpers (`buildClonePrompt`, `buildInitPrompt`, `detectSuccess`) + orchestration (`createProject`) that drives a one-shot opencode session and handles the auto-switch. |
| `tg-bridge/src/commands/clone.ts` | Create | Parse `/clone <url> [name]`, derive default name from URL, validate, dispatch to `createProject`. |
| `tg-bridge/src/commands/init.ts` | Create | Parse `/init <name>`, validate, dispatch to `createProject`. |
| `tg-bridge/src/commands/help.ts` | Modify (add 2 lines) | Add `/clone` and `/init` to the help text. |
| `tg-bridge/src/index.ts` | Modify (register handlers) | Wire up the two new commands. |
| `tg-bridge/tests/commands/switch.test.ts` | Modify (verify exports) | Confirm refactored helpers are exported and behavior unchanged. |
| `tg-bridge/tests/project-creator.test.ts` | Create | Unit tests for pure helpers + createProject orchestration. |
| `tg-bridge/tests/commands/clone.test.ts` | Create | Unit tests for clone handler validation + dispatch. |
| `tg-bridge/tests/commands/init.test.ts` | Create | Unit tests for init handler validation + dispatch. |

**Total:** 4 new source files, 3 new test files, 4 modified files (3 src + 1 test).

---

## Task 1: Refactor `switch.ts` — extract reusable helpers

**Files:**
- Modify: `tg-bridge/src/commands/switch.ts`
- Modify: `tg-bridge/tests/commands/switch.test.ts`

**Goal:** Promote the local `isSafeProjectName` function and the inline switch-confirmation message-builder to exported helpers. Behavior of `handleSwitch` unchanged.

- [ ] **Step 1: Read the current switch.ts and switch.test.ts**

```bash
cd /Users/doni/code/test-opencode-headless
cat tg-bridge/src/commands/switch.ts
cat tg-bridge/tests/commands/switch.test.ts
```

Note the current shape: `isSafeProjectName` is a private file-local function (line 22-28 of switch.ts at HEAD `7fe1c86`). The switch confirmation message is built inline at lines 68-74.

- [ ] **Step 2: Update switch.ts**

Replace the entire file with:

```typescript
import type { Context } from "grammy";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface SwitchDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  workspaceRoot: string;
  /**
   * EventRouter handle so /switch can ensure an SSE subscription exists
   * for the newly-activated project's directory. Without this, sessions in
   * a directory the bridge has never subscribed to would emit events into
   * a scope nothing reads, and the placeholder would hang at "thinking…".
   */
  router: { ensureDirectory(directory: string): boolean };
}

/**
 * Validate a project-name argument as safe to use as a subdirectory of
 * the workspace root. Rejects empty, absolute paths, path separators,
 * and names starting with `.` (which would clash with `.git` etc. and
 * be hidden from the default `/projects` listing anyway).
 */
export function isSafeProjectName(name: string): boolean {
  if (name.length === 0) return false;
  if (isAbsolute(name)) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.startsWith(".")) return false;
  return true;
}

/**
 * Build the standard "switched to <name>" reply used by /switch and (after
 * auto-switch) by /clone and /init. Returns a MarkdownV2-escaped string
 * ready to send via ctx.reply or safeEdit.
 */
export function buildSwitchConfirmation(name: string, projectPath: string, sessionId: string): string {
  return [
    `*${escapeMarkdownV2(`Switched to ${name}`)}*`,
    escapeMarkdownV2(`Project: ${projectPath}`),
    escapeMarkdownV2(`Session: ${sessionId}`),
  ].join("\n");
}

export async function handleSwitch(ctx: Context, deps: SwitchDeps): Promise<void> {
  const arg = (ctx.match as string | undefined)?.trim() ?? "";
  if (arg.length === 0) {
    await ctx.reply(escapeMarkdownV2("Usage: /switch <project-name>"), {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  if (!isSafeProjectName(arg)) {
    await ctx.reply(escapeMarkdownV2("Invalid project name."), { parse_mode: "MarkdownV2" });
    return;
  }

  const projectPath = join(deps.workspaceRoot, arg);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    await ctx.reply(escapeMarkdownV2(`No such project: ${arg}`), { parse_mode: "MarkdownV2" });
    return;
  }

  let session: { id: string };
  try {
    // Pass `directory` so opencode anchors the session to this worktree
    // (auto-creating a Project record if one doesn't exist) and so subsequent
    // turns in `message-handler` can re-anchor against the same path.
    session = await deps.client.createSession(`tg:${arg}`, { directory: projectPath });
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ Failed to switch: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
    return;
  }
  deps.state.setProject(ctx.chat!.id, projectPath, session.id);
  // Ensure the SSE subscription for this project's directory is open before
  // the user sends their first prompt. Idempotent — no-op if we're already
  // subscribed (e.g. another chat is in this project, or we hit boot-seed).
  deps.router.ensureDirectory(projectPath);

  await ctx.reply(buildSwitchConfirmation(arg, projectPath, session.id), {
    parse_mode: "MarkdownV2",
  });
}
```

The two changes from the prior version:
- `isSafeProjectName` is `export function` instead of `function`
- The inline reply array is replaced by `buildSwitchConfirmation(arg, projectPath, session.id)` and the returned string is sent

- [ ] **Step 3: Add a small test in switch.test.ts to lock in the exports**

Append to the existing `describe("handleSwitch", ...)` block (or add a new `describe` block for the helpers):

```typescript
import { isSafeProjectName, buildSwitchConfirmation } from "../../src/commands/switch.js";

describe("isSafeProjectName", () => {
  it("accepts standard project names", () => {
    expect(isSafeProjectName("my-project")).toBe(true);
    expect(isSafeProjectName("foo_bar")).toBe(true);
    expect(isSafeProjectName("a")).toBe(true);
  });

  it("rejects empty, dot-prefixed, separator-containing, or absolute names", () => {
    expect(isSafeProjectName("")).toBe(false);
    expect(isSafeProjectName(".hidden")).toBe(false);
    expect(isSafeProjectName("foo/bar")).toBe(false);
    expect(isSafeProjectName("foo\\bar")).toBe(false);
    expect(isSafeProjectName("/abs/path")).toBe(false);
  });
});

describe("buildSwitchConfirmation", () => {
  it("formats the standard switch reply with escaped fields", () => {
    expect(buildSwitchConfirmation("my-proj", "/workspace/my-proj", "ses_abc")).toBe(
      "*Switched to my\\-proj*\nProject: /workspace/my\\-proj\nSession: ses\\_abc",
    );
  });
});
```

(If switch.test.ts uses a different import-style, follow the existing convention — but the imports above match the codebase's pattern.)

- [ ] **Step 4: Run tests**

Run: `cd tg-bridge && npx vitest run`

Expected: existing switch tests still pass; 3 new tests pass (2 for isSafeProjectName + 1 for buildSwitchConfirmation). Total: 171 + 3 = 174.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/doni/code/test-opencode-headless
git add tg-bridge/src/commands/switch.ts tg-bridge/tests/commands/switch.test.ts
git commit -m "Extract isSafeProjectName + buildSwitchConfirmation from switch.ts

Both helpers will be reused by the upcoming /clone and /init commands
(via project-creator.ts). Behavior of handleSwitch is unchanged \u2014
the inline reply array is replaced by a call to buildSwitchConfirmation
that returns the same string.

Tests added to lock in both exports."
```

---

## Task 2: Create `project-creator.ts` pure helpers

**Files:**
- Create: `tg-bridge/src/project-creator.ts` (pure helpers only — `createProject` orchestration is Task 3)
- Create: `tg-bridge/tests/project-creator.test.ts`

**Goal:** Stand up the file with the prompt-builders and the success-detection helper. These are pure functions and trivially testable.

- [ ] **Step 1: Write the failing test**

Create `tg-bridge/tests/project-creator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildClonePrompt, buildInitPrompt, detectSuccess } from "../src/project-creator.js";

describe("buildClonePrompt", () => {
  it("substitutes URL and NAME into the template with StrictHostKeyChecking=accept-new", () => {
    const out = buildClonePrompt("git@github.com:foo/bar.git", "bar");
    expect(out).toContain("git clone -o StrictHostKeyChecking=accept-new git@github.com:foo/bar.git /workspace/bar");
    expect(out).toContain("reply with the single word: cloned");
    expect(out).toContain("failed:");
    expect(out).toContain("Do not run any other commands");
  });

  it("works with HTTPS URLs", () => {
    const out = buildClonePrompt("https://github.com/foo/bar.git", "myproject");
    expect(out).toContain("git clone -o StrictHostKeyChecking=accept-new https://github.com/foo/bar.git /workspace/myproject");
  });
});

describe("buildInitPrompt", () => {
  it("substitutes NAME into the mkdir + git init template", () => {
    const out = buildInitPrompt("myproject");
    expect(out).toContain("mkdir -p /workspace/myproject && git init /workspace/myproject");
    expect(out).toContain("reply with the single word: initialized");
    expect(out).toContain("failed:");
    expect(out).toContain("Do not create README files");
  });
});

describe("detectSuccess", () => {
  it("returns true for clone success when text starts with 'cloned'", () => {
    const parts = [{ id: "p1", type: "text", text: "cloned" }];
    expect(detectSuccess(parts, "clone")).toBe(true);
  });

  it("returns true for init success when text starts with 'initialized'", () => {
    const parts = [{ id: "p1", type: "text", text: "initialized" }];
    expect(detectSuccess(parts, "init")).toBe(true);
  });

  it("is case-insensitive on the success marker", () => {
    expect(detectSuccess([{ id: "p1", type: "text", text: "Cloned" }], "clone")).toBe(true);
    expect(detectSuccess([{ id: "p1", type: "text", text: "INITIALIZED" }], "init")).toBe(true);
  });

  it("matches when success marker is followed by extra text", () => {
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "cloned successfully" }], "clone"),
    ).toBe(true);
  });

  it("does not match partial-prefix words (uses word boundary)", () => {
    // "clonedown" should NOT match "cloned\b"
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "clonedown" }], "clone"),
    ).toBe(false);
  });

  it("does not match the wrong-kind marker", () => {
    expect(detectSuccess([{ id: "p1", type: "text", text: "initialized" }], "clone")).toBe(false);
    expect(detectSuccess([{ id: "p1", type: "text", text: "cloned" }], "init")).toBe(false);
  });

  it("returns false for an explicit failure response", () => {
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "failed: auth error" }], "clone"),
    ).toBe(false);
  });

  it("returns false for empty parts", () => {
    expect(detectSuccess([], "clone")).toBe(false);
  });

  it("ignores tool parts and concatenates only text parts in order", () => {
    const parts = [
      { id: "t1", type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } },
      { id: "p1", type: "text", text: "cloned" },
    ];
    expect(detectSuccess(parts, "clone")).toBe(true);
  });

  it("uses the first text part for marker detection (so trailing chatter is OK)", () => {
    // Concatenated text starts with 'cloned' → matches
    const parts = [
      { id: "p1", type: "text", text: "cloned" },
      { id: "p2", type: "text", text: "and the directory now exists" },
    ];
    expect(detectSuccess(parts, "clone")).toBe(true);
  });

  it("returns false when text does not start with the marker", () => {
    expect(
      detectSuccess([{ id: "p1", type: "text", text: "I cloned the repo" }], "clone"),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/project-creator.test.ts`

Expected: FAIL with "Failed to load url ../src/project-creator.js. Does the file exist?"

- [ ] **Step 3: Create `project-creator.ts` (pure helpers only)**

Create `tg-bridge/src/project-creator.ts`:

```typescript
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
```

- [ ] **Step 4: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all previous tests pass; new tests pass. Count check: 11 new tests (2 buildClonePrompt + 1 buildInitPrompt + 8 detectSuccess). Total: 174 + 11 = 185.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/doni/code/test-opencode-headless
git add tg-bridge/src/project-creator.ts tg-bridge/tests/project-creator.test.ts
git commit -m "Add project-creator pure helpers: prompt builders + success detection

Foundational layer for /clone and /init. The deterministic prompts
constrain the LLM to a single shell command with a clear success/failure
reply contract. detectSuccess scans the assistant text parts for the
expected marker word at the start (case-insensitive, word-boundary).

Orchestration (createProject) added in the next task."
```

---

## Task 3: Add `createProject` orchestration to `project-creator.ts`

**Files:**
- Modify: `tg-bridge/src/project-creator.ts` (add orchestration on top of pure helpers)
- Modify: `tg-bridge/tests/project-creator.test.ts` (add orchestration tests)

**Goal:** Implement the function that drives the LLM session, intercepts `session.idle`, and performs auto-switch on success.

- [ ] **Step 1: Write the failing tests**

Append to `tg-bridge/tests/project-creator.test.ts`:

```typescript
import { vi } from "vitest";
import Database from "better-sqlite3";
import { createProject } from "../src/project-creator.js";
import { ChatStateRepo } from "../src/chat-state.js";
import type { OpencodeClient } from "../src/opencode-client.js";
import type { SessionEventHandler } from "../src/event-router.js";

interface FakeRouter {
  registerSession: ReturnType<typeof vi.fn>;
  ensureDirectory: ReturnType<typeof vi.fn>;
  registered: SessionEventHandler | null;
  unregister: ReturnType<typeof vi.fn>;
}

function makeRouter(): FakeRouter {
  const router: FakeRouter = {
    registered: null,
    unregister: vi.fn(),
    registerSession: vi.fn(),
    ensureDirectory: vi.fn(() => true),
  };
  router.registerSession.mockImplementation((_id: string, handler: SessionEventHandler) => {
    router.registered = handler;
    return router.unregister;
  });
  return router;
}

function makeBot() {
  return {
    editMessageText: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ message_id: 999 })),
  };
}

function makeClient(opts: {
  createSession?: (...a: unknown[]) => Promise<{ id: string }>;
  prompt?: (...a: unknown[]) => Promise<unknown>;
} = {}): OpencodeClient {
  let createCount = 0;
  return {
    createSession:
      opts.createSession ??
      vi.fn(async () => {
        createCount++;
        return { id: `ses_${createCount}` };
      }),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(opts.prompt ?? (async () => ({}))),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

const tick = () => new Promise((r) => setImmediate(r));

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const WORKSPACE_ROOT = "/workspace";

function makeDeps(opts: { client?: OpencodeClient; router?: FakeRouter; bot?: ReturnType<typeof makeBot>; state?: ChatStateRepo } = {}) {
  return {
    client: opts.client ?? makeClient(),
    state: opts.state ?? new ChatStateRepo(new Database(":memory:")),
    router: opts.router ?? makeRouter(),
    bot: opts.bot ?? makeBot(),
    defaultModel: DEFAULT_MODEL,
  };
}

describe("createProject", () => {
  it("for /clone: creates a session at workspaceRoot, registers handler, fires prompt with directory=workspaceRoot", async () => {
    const router = makeRouter();
    const client = makeClient();
    const deps = makeDeps({ client, router });

    await createProject(
      {
        chatId: 1,
        placeholderId: 555,
        name: "myrepo",
        kind: "clone",
        url: "git@github.com:foo/myrepo.git",
        workspaceRoot: WORKSPACE_ROOT,
      },
      deps,
    );

    expect(router.ensureDirectory).toHaveBeenCalledWith(WORKSPACE_ROOT);
    expect(client.createSession).toHaveBeenCalledWith("tg:clone:myrepo", { directory: WORKSPACE_ROOT });
    expect(router.registerSession).toHaveBeenCalledWith("ses_1", expect.any(Object));
    expect(client.prompt).toHaveBeenCalledWith(
      "ses_1",
      expect.stringContaining("git clone -o StrictHostKeyChecking=accept-new git@github.com:foo/myrepo.git /workspace/myrepo"),
      expect.objectContaining({
        directory: WORKSPACE_ROOT,
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      }),
    );
  });

  it("for /init: same flow but with the init prompt", async () => {
    const router = makeRouter();
    const client = makeClient();
    const deps = makeDeps({ client, router });

    await createProject(
      { chatId: 1, placeholderId: 555, name: "newproj", kind: "init", workspaceRoot: WORKSPACE_ROOT },
      deps,
    );

    expect(client.createSession).toHaveBeenCalledWith("tg:init:newproj", { directory: WORKSPACE_ROOT });
    expect(client.prompt).toHaveBeenCalledWith(
      "ses_1",
      expect.stringContaining("mkdir -p /workspace/newproj && git init /workspace/newproj"),
      expect.objectContaining({ directory: WORKSPACE_ROOT }),
    );
  });

  it("on success marker: auto-switches by creating new session in subdir + state.setProject + ensureDirectory + replaces placeholder with switch confirmation", async () => {
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    const state = new ChatStateRepo(new Database(":memory:"));
    const deps = makeDeps({ client, router, bot, state });

    await createProject(
      { chatId: 1, placeholderId: 555, name: "myrepo", kind: "clone", url: "git@github.com:foo/myrepo.git", workspaceRoot: WORKSPACE_ROOT },
      deps,
    );

    // Simulate the LLM session producing parts then going idle with success marker.
    const handler = router.registered!;
    handler.onPartUpdated({ id: "p1", type: "text", text: "cloned" });
    await Promise.resolve(handler.onIdle());
    await tick();

    // Auto-switch: a SECOND createSession call for the subdir
    expect(client.createSession).toHaveBeenNthCalledWith(2, "tg:myrepo", {
      directory: "/workspace/myrepo",
    });
    // chat-state updated to point at the new project + new session
    const stored = state.get(1);
    expect(stored?.projectPath).toBe("/workspace/myrepo");
    expect(stored?.sessionId).toBe("ses_2");
    // SSE subscription opened for the new directory
    expect(router.ensureDirectory).toHaveBeenCalledWith("/workspace/myrepo");
    // Placeholder edited to the standard switch confirmation
    const editCalls = bot.editMessageText.mock.calls;
    const lastEdit = editCalls[editCalls.length - 1]!;
    expect(lastEdit[0]).toBe(1); // chatId
    expect(lastEdit[1]).toBe(555); // placeholderId
    expect(String(lastEdit[2])).toContain("Switched to myrepo");
    expect(String(lastEdit[2])).toContain("/workspace/myrepo");
    expect(String(lastEdit[2])).toContain("ses_2");
  });

  it("on failure marker: does NOT auto-switch, lets Turn.finalize render the LLM's error", async () => {
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    const state = new ChatStateRepo(new Database(":memory:"));
    const deps = makeDeps({ client, router, bot, state });

    await createProject(
      { chatId: 1, placeholderId: 555, name: "myrepo", kind: "clone", url: "git@github.com:foo/myrepo.git", workspaceRoot: WORKSPACE_ROOT },
      deps,
    );

    const handler = router.registered!;
    handler.onPartUpdated({ id: "p1", type: "text", text: "failed: authentication denied" });
    await Promise.resolve(handler.onIdle());
    await tick();

    // Only ONE createSession call (the one-shot session, no auto-switch second one)
    expect(client.createSession).toHaveBeenCalledTimes(1);
    // chat-state untouched
    expect(state.get(1)).toBeUndefined();
    // Placeholder shows the error text (Turn.finalize routes through safeEdit)
    const editCalls = bot.editMessageText.mock.calls;
    const lastEditText = String(editCalls[editCalls.length - 1]![2]);
    expect(lastEditText).toContain("failed: authentication denied");
    expect(lastEditText).not.toContain("Switched to");
  });

  it("on session.error: shows error via Turn.showError, no auto-switch", async () => {
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    const state = new ChatStateRepo(new Database(":memory:"));
    const deps = makeDeps({ client, router, bot, state });

    await createProject(
      { chatId: 1, placeholderId: 555, name: "myrepo", kind: "init", workspaceRoot: WORKSPACE_ROOT },
      deps,
    );

    const handler = router.registered!;
    handler.onError(new Error("opencode died"));
    await tick();

    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(state.get(1)).toBeUndefined();
    const editCalls = bot.editMessageText.mock.calls;
    const lastEditText = String(editCalls[editCalls.length - 1]![2]);
    expect(lastEditText).toContain("opencode died");
  });

  it("survives client.prompt rejection: shows error via Turn.showError", async () => {
    const router = makeRouter();
    const client = makeClient({
      prompt: async () => {
        throw new Error("network down");
      },
    });
    const bot = makeBot();
    const state = new ChatStateRepo(new Database(":memory:"));
    const deps = makeDeps({ client, router, bot, state });

    await createProject(
      { chatId: 1, placeholderId: 555, name: "myrepo", kind: "init", workspaceRoot: WORKSPACE_ROOT },
      deps,
    );

    await tick();
    await tick();

    expect(state.get(1)).toBeUndefined();
    const editCalls = bot.editMessageText.mock.calls;
    const lastEditText = String(editCalls[editCalls.length - 1]![2]);
    expect(lastEditText).toContain("network down");
  });

  it("for /clone without url: throws (interface contract)", async () => {
    const deps = makeDeps();
    await expect(
      createProject(
        // @ts-expect-error: testing runtime contract — TS would catch this in real consumers
        { chatId: 1, placeholderId: 555, name: "myrepo", kind: "clone", workspaceRoot: WORKSPACE_ROOT },
        deps,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/project-creator.test.ts`

Expected: FAIL with `createProject is not a function` or similar import-missing error.

- [ ] **Step 3: Add `createProject` to `project-creator.ts`**

Append to `tg-bridge/src/project-creator.ts`:

```typescript
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
import { join } from "node:path";

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
```

- [ ] **Step 4: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all tests pass. Count: 185 (after Task 2) + 7 new orchestration tests = 192.

If any tests fail, the most likely cause is a mismatch between what the tests expect (e.g. exact string matching on the auto-switch confirmation) and what `buildSwitchConfirmation` produces. Cross-reference with Task 1's `buildSwitchConfirmation` helper.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/doni/code/test-opencode-headless
git add tg-bridge/src/project-creator.ts tg-bridge/tests/project-creator.test.ts
git commit -m "Add createProject orchestration + auto-switch on success

Drives a one-shot opencode session at /workspace, streams the bash tool
call into the placeholder via Turn (reusing the render overhaul UX),
and on session.idle: if the assistant text starts with the success
marker, opens a fresh session in the new subdirectory + auto-switches
the chat (replaces placeholder with the standard switch confirmation,
suppressing the marker word). On failure, lets Turn.finalize render
the LLM's error response and leaves chat-state untouched.

All Telegram I/O routes through safeEdit/safeSend; both onIdle and
onError handlers wrapped in try/catch to defend against the
fire-and-forget event dispatch crashing the process."
```

---

## Task 4: Add `commands/clone.ts` handler

**Files:**
- Create: `tg-bridge/src/commands/clone.ts`
- Create: `tg-bridge/tests/commands/clone.test.ts`

**Goal:** Bridge-side validation and dispatch to `createProject`.

- [ ] **Step 1: Write the failing test**

Create `tg-bridge/tests/commands/clone.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleClone, deriveProjectName, parseCloneArgs } from "../../src/commands/clone.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import * as fs from "node:fs";

const WORKSPACE_ROOT = "/workspace";

vi.mock("../../src/project-creator.js", () => ({
  createProject: vi.fn(async () => undefined),
}));

import { createProject } from "../../src/project-creator.js";

function makeDeps() {
  return {
    client: {} as never,
    state: {} as never,
    router: {} as never,
    bot: {} as never,
    workspaceRoot: WORKSPACE_ROOT,
    defaultModel: "anthropic/claude-sonnet-4-5",
  };
}

describe("deriveProjectName", () => {
  it("strips .git suffix and takes the basename of an SSH URL", () => {
    expect(deriveProjectName("git@github.com:foo/bar.git")).toBe("bar");
  });
  it("works without .git suffix", () => {
    expect(deriveProjectName("git@github.com:foo/bar")).toBe("bar");
  });
  it("works with HTTPS URLs", () => {
    expect(deriveProjectName("https://github.com/foo/bar.git")).toBe("bar");
    expect(deriveProjectName("https://gitlab.com/team/project")).toBe("project");
  });
  it("handles trailing slash", () => {
    expect(deriveProjectName("https://github.com/foo/bar/")).toBe("bar");
  });
  it("returns empty string for unparseable input", () => {
    expect(deriveProjectName("")).toBe("");
    expect(deriveProjectName("/")).toBe("");
  });
});

describe("parseCloneArgs", () => {
  it("returns just url when one token", () => {
    expect(parseCloneArgs("git@github.com:foo/bar.git")).toEqual({
      url: "git@github.com:foo/bar.git",
      explicitName: undefined,
    });
  });
  it("returns url + name when two tokens", () => {
    expect(parseCloneArgs("git@github.com:foo/bar.git my-renamed")).toEqual({
      url: "git@github.com:foo/bar.git",
      explicitName: "my-renamed",
    });
  });
  it("collapses extra whitespace", () => {
    expect(parseCloneArgs("  git@github.com:foo/bar.git    my-renamed  ")).toEqual({
      url: "git@github.com:foo/bar.git",
      explicitName: "my-renamed",
    });
  });
  it("returns empty when no tokens", () => {
    expect(parseCloneArgs("")).toEqual({ url: undefined, explicitName: undefined });
    expect(parseCloneArgs("   ")).toEqual({ url: undefined, explicitName: undefined });
  });
});

describe("handleClone", () => {
  beforeEach(() => {
    vi.mocked(createProject).mockClear();
    // Default: no project exists at the target.
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with no args: replies with usage hint, no createProject call", async () => {
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone" });
    ctx.match = "";
    await handleClone(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/Usage:.*\/clone/);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("with invalid URL: replies with format error, no createProject call", async () => {
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone not-a-url" });
    ctx.match = "not-a-url";
    await handleClone(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/git URL/i);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("with derived-name that's invalid: replies with name validator error", async () => {
    // URL whose basename collapses to "" → invalid name
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone https://example.com/" });
    ctx.match = "https://example.com/";
    await handleClone(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/Invalid project name|Could not derive/i);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("with explicit invalid name: replies with validator error", async () => {
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone git@github.com:foo/bar.git ../escape" });
    ctx.match = "git@github.com:foo/bar.git ../escape";
    await handleClone(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/Invalid project name/i);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("when target name already exists on disk: replies with collision error", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone git@github.com:foo/bar.git" });
    ctx.match = "git@github.com:foo/bar.git";
    await handleClone(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/already exists/i);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("happy path with derived name: sends placeholder, calls createProject with kind=clone + url + derived name", async () => {
    const placeholder = { message_id: 555 };
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone git@github.com:foo/bar.git" });
    ctx.match = "git@github.com:foo/bar.git";
    ctx.reply.mockResolvedValue(placeholder);

    await handleClone(ctx as never, makeDeps());

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/cloning bar/i);
    expect(createProject).toHaveBeenCalledOnce();
    const call = vi.mocked(createProject).mock.calls[0]!;
    expect(call[0]).toEqual(expect.objectContaining({
      chatId: 1,
      placeholderId: 555,
      name: "bar",
      kind: "clone",
      url: "git@github.com:foo/bar.git",
      workspaceRoot: WORKSPACE_ROOT,
    }));
  });

  it("happy path with explicit name: uses explicit name over derived", async () => {
    const placeholder = { message_id: 555 };
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone git@github.com:foo/bar.git my-rename" });
    ctx.match = "git@github.com:foo/bar.git my-rename";
    ctx.reply.mockResolvedValue(placeholder);

    await handleClone(ctx as never, makeDeps());

    const call = vi.mocked(createProject).mock.calls[0]!;
    expect(call[0]).toEqual(expect.objectContaining({ name: "my-rename" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/commands/clone.test.ts`

Expected: FAIL with module-missing error.

- [ ] **Step 3: Create `commands/clone.ts`**

```typescript
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

    await createProject(
      {
        chatId: ctx.chat!.id,
        placeholderId,
        name,
        kind: "clone",
        url,
        workspaceRoot: deps.workspaceRoot,
      },
      {
        client: deps.client,
        state: deps.state,
        router: deps.router,
        bot: deps.bot,
        defaultModel: deps.defaultModel,
        ...(deps.log ? { log: deps.log } : {}),
      },
    );
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ /clone failed: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all pass. Count: 192 + 13 new = 205 (5 deriveProjectName + 4 parseCloneArgs + 7 handleClone, recount the `it(...)` blocks).

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/doni/code/test-opencode-headless
git add tg-bridge/src/commands/clone.ts tg-bridge/tests/commands/clone.test.ts
git commit -m "Add /clone command: parse URL + name, validate, dispatch to createProject

Bridge-side validation: URL format (permissive regex matching git/ssh/http URLs),
name safety (reuses isSafeProjectName), target collision (existsSync on the
read-only workspace mount). On all-clear, sends placeholder and dispatches
to createProject with kind=clone.

deriveProjectName handles the standard URL formats: SSH, HTTPS, with or
without trailing .git. Explicit name override via second arg."
```

---

## Task 5: Add `commands/init.ts` handler

**Files:**
- Create: `tg-bridge/src/commands/init.ts`
- Create: `tg-bridge/tests/commands/init.test.ts`

**Goal:** Same shape as `/clone` but simpler (no URL parsing).

- [ ] **Step 1: Write the failing test**

Create `tg-bridge/tests/commands/init.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleInit } from "../../src/commands/init.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import * as fs from "node:fs";

const WORKSPACE_ROOT = "/workspace";

vi.mock("../../src/project-creator.js", () => ({
  createProject: vi.fn(async () => undefined),
}));

import { createProject } from "../../src/project-creator.js";

function makeDeps() {
  return {
    client: {} as never,
    state: {} as never,
    router: {} as never,
    bot: {} as never,
    workspaceRoot: WORKSPACE_ROOT,
    defaultModel: "anthropic/claude-sonnet-4-5",
  };
}

describe("handleInit", () => {
  beforeEach(() => {
    vi.mocked(createProject).mockClear();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with no args: replies with usage hint, no createProject", async () => {
    const ctx = makeFakeCtx({ chatId: 1, text: "/init" });
    ctx.match = "";
    await handleInit(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/Usage:.*\/init/);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("with invalid name: replies with validator error", async () => {
    const ctx = makeFakeCtx({ chatId: 1, text: "/init ../escape" });
    ctx.match = "../escape";
    await handleInit(ctx as never, makeDeps());
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/Invalid project name/i);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("with name that already exists: replies with collision error", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const ctx = makeFakeCtx({ chatId: 1, text: "/init existing" });
    ctx.match = "existing";
    await handleInit(ctx as never, makeDeps());
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/already exists/i);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("happy path: sends placeholder, calls createProject with kind=init", async () => {
    const placeholder = { message_id: 555 };
    const ctx = makeFakeCtx({ chatId: 1, text: "/init newproj" });
    ctx.match = "newproj";
    ctx.reply.mockResolvedValue(placeholder);

    await handleInit(ctx as never, makeDeps());

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/initializing newproj/i);
    expect(createProject).toHaveBeenCalledOnce();
    const call = vi.mocked(createProject).mock.calls[0]!;
    expect(call[0]).toEqual(expect.objectContaining({
      chatId: 1,
      placeholderId: 555,
      name: "newproj",
      kind: "init",
      workspaceRoot: WORKSPACE_ROOT,
    }));
    // No url key for init
    expect(call[0]).not.toHaveProperty("url");
  });

  it("trims surrounding whitespace from the name arg", async () => {
    const placeholder = { message_id: 555 };
    const ctx = makeFakeCtx({ chatId: 1, text: "/init   spaced   " });
    ctx.match = "  spaced  ";
    ctx.reply.mockResolvedValue(placeholder);

    await handleInit(ctx as never, makeDeps());
    const call = vi.mocked(createProject).mock.calls[0]!;
    expect(call[0]).toEqual(expect.objectContaining({ name: "spaced" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/commands/init.test.ts`

Expected: FAIL with module-missing error.

- [ ] **Step 3: Create `commands/init.ts`**

```typescript
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
        ...(deps.log ? { log: deps.log } : {}),
      },
    );
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ /init failed: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all pass. Count: 205 + 5 new = 210.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/doni/code/test-opencode-headless
git add tg-bridge/src/commands/init.ts tg-bridge/tests/commands/init.test.ts
git commit -m "Add /init command: validate name, dispatch to createProject

Single-arg variant of /clone. Same validation pipeline (name safety,
target collision), then dispatches to createProject with kind=init.
The shared project-creator runs the deterministic mkdir + git init
prompt and auto-switches on success."
```

---

## Task 6: Wire commands into `index.ts` + add to `help.ts`

**Files:**
- Modify: `tg-bridge/src/index.ts`
- Modify: `tg-bridge/src/commands/help.ts`
- Modify: `tg-bridge/tests/commands/help.test.ts` (assertion update)

**Goal:** Make the new commands reachable from Telegram and discoverable via `/help`.

- [ ] **Step 1: Read the current index.ts to find the right insertion point**

Run: `cd /Users/doni/code/test-opencode-headless && grep -n "bot.command" tg-bridge/src/index.ts`

You should see lines registering existing commands. Insert `/clone` and `/init` next to `/switch` for grouping.

- [ ] **Step 2: Modify `tg-bridge/src/index.ts`**

Add imports near the other command imports:

```typescript
import { handleClone } from "./commands/clone.js";
import { handleInit } from "./commands/init.js";
```

Add two new `bot.command` registrations right after the existing `/switch` registration:

```typescript
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
```

The exact variable names (`client`, `state`, `router`, `turnBot`, `config`, `log`) match what's already in scope at the point where `/switch` is registered. If they differ, follow the in-scope pattern.

- [ ] **Step 3: Modify `tg-bridge/src/commands/help.ts`**

Update the `RAW` array to add the two new commands. Insert between `/switch` and `/abort`:

```typescript
const RAW = [
  "*opencode bridge*",
  "",
  "/new — start a new session in the current project",
  "/projects — list available projects under /workspace",
  "/switch <name> — switch to a project (creates a new session)",
  "/clone <git-url> [name] — clone a git repository into /workspace",
  "/init <name> — create an empty new project under /workspace (with git init)",
  "/abort — abort the current running task",
  "/status — show current project, session, and model",
  "/model [providerID/modelID] — show or set the model",
  "/help — show this message",
  "",
  "Send any other text to talk to the agent.",
].join("\n");
```

- [ ] **Step 4: Update help test assertions if any pin the line count**

Read the existing help test:

```bash
cat tg-bridge/tests/commands/help.test.ts
```

If a test asserts the exact help text or a specific number of lines, update it to include the two new lines. Most likely the existing test just checks key substrings (`/new`, `/projects`, etc.). If so, add assertions for `/clone` and `/init`:

```typescript
expect(HELP_TEXT).toContain("/clone");
expect(HELP_TEXT).toContain("/init");
```

If the test does an exact string equality, update the expected string to include the two new lines (matching the order in RAW).

- [ ] **Step 5: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all pass. Help test count may shift slightly depending on assertion style; otherwise count unchanged at 210.

- [ ] **Step 6: Run typecheck + build**

```bash
cd tg-bridge
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/doni/code/test-opencode-headless
git add tg-bridge/src/index.ts tg-bridge/src/commands/help.ts tg-bridge/tests/commands/help.test.ts
git commit -m "Wire /clone and /init into bot + help text

Registers the new commands at the same scope as /switch. Help text
groups the project-creation commands together: list \u2192 switch \u2192 clone
\u2192 init \u2192 abort \u2192 status \u2192 model."
```

---

## Task 7: Build, deploy, smoke verify

**Files:** None modified. Final integration check.

- [ ] **Step 1: Final clean build**

```bash
cd /Users/doni/code/test-opencode-headless/tg-bridge
npm run build
```

Expected: exit 0; produces `dist/` output.

- [ ] **Step 2: Full test suite**

```bash
cd /Users/doni/code/test-opencode-headless/tg-bridge
npx vitest run
```

Expected: all tests pass. Total approximately 210.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/doni/code/test-opencode-headless/tg-bridge
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Push to origin**

```bash
cd /Users/doni/code/test-opencode-headless
git log --oneline -10
git push origin main
```

Expected: 6 new commits pushed.

- [ ] **Step 5: Deploy to Unraid**

```bash
ssh root@192.168.86.81 'cd /mnt/user/appdata/opencode/repo && git pull --ff-only && docker compose -f deploy/compose.yaml build tg-bridge && docker compose -f deploy/compose.yaml up -d tg-bridge'
```

- [ ] **Step 6: Verify container health**

```bash
ssh root@192.168.86.81 'docker ps --filter name=tg-bridge --format "{{.Status}}"'
```

Expected: `Up X seconds`. NOT `Restarting`.

- [ ] **Step 7: Tail logs for clean startup**

```bash
ssh root@192.168.86.81 'docker logs tg-bridge --tail=20'
```

Expected: standard `seeding event subscriptions` / `opencode event subscription opening` / `starting` log lines. No errors.

- [ ] **Step 8: USER manual smoke test (perform via Telegram)**

1. **`/help`** — confirm `/clone` and `/init` appear in the list.
2. **`/init smoke-test`** — expected: `initializing smoke-test…` placeholder, then streaming view with bash call, then "Switched to smoke-test" with project + session info.
3. **`/projects`** — confirm `smoke-test` is listed.
4. **`/status`** — confirm current project is `smoke-test`.
5. **Send a follow-up message** like `What's in this directory?` — confirm the agent responds in the new project context.
6. **`/init smoke-test`** again — expected: rejected with "already exists" (no LLM dispatch).
7. **`/clone https://github.com/octocat/Hello-World.git`** — small public repo, should clone in seconds. Expected: streaming view with bash, then "Switched to Hello-World".
8. **`/clone not-a-url`** — expected: rejected with "Doesn't look like a git URL".
9. **`/clone`** (no args) — expected: usage hint.

- [ ] **Step 9: Final verification**

```bash
ssh root@192.168.86.81 'docker logs tg-bridge --since=10m | grep -iE "error|crash" | head -10'
```

Expected: no lines, OR only benign warnings (`safeEdit failed in ...` would indicate a render bug worth investigating).

---

## Self-Review

### Spec coverage

- ✅ `/clone <url> [name]` (Task 4)
- ✅ `/init <name>` (Task 5)
- ✅ Auto-switch on success (Task 3 — performAutoSwitch)
- ✅ Suppress success marker, replace placeholder with switch confirmation (Task 3)
- ✅ Pre-LLM validation: name safety (Task 1 export, Tasks 4 + 5 use)
- ✅ Pre-LLM validation: target doesn't exist (Tasks 4 + 5)
- ✅ Pre-LLM validation: URL format (Task 4)
- ✅ Deterministic prompts with `StrictHostKeyChecking=accept-new` (Task 2)
- ✅ Reuses Turn / safeEdit / safeSend / EventRouter (Task 3)
- ✅ Help text (Task 6)
- ✅ No infrastructure changes (verified across all tasks)
- ✅ Manual smoke test (Task 7)

### Placeholder scan

No "TBD", "TODO", "implement later", "fill in", or vague handlers. Every step has actual code or actual test code.

### Type consistency

- `CreationKind` defined in Task 2 (project-creator.ts), reused in Tasks 3-5
- `CreateProjectArgs` / `CreateProjectDeps` defined in Task 3
- `IncomingPart` reused from `turn.ts` (already exists)
- `SessionEventHandler` from `event-router.ts` (already exists)
- `TurnBot` from `turn.ts` (already exists)
- `OpencodeClient` from `opencode-client.ts` (already exists)
- `ChatStateRepo` from `chat-state.ts` (already exists)
- `parseModelId` reused from `config.ts` (already used in message-handler.ts)
- `isSafeProjectName` and `buildSwitchConfirmation` exported in Task 1, consumed in Tasks 3-5
- Function names: `handleClone`, `handleInit`, `createProject`, `buildClonePrompt`, `buildInitPrompt`, `detectSuccess`, `deriveProjectName`, `parseCloneArgs`, `performAutoSwitch` (private) — all consistent across tasks

### Test count tracking

| Task | Tests added | Cumulative |
|---|---|---|
| baseline (after render overhaul) | — | 171 |
| Task 1 (switch refactor) | +3 | 174 |
| Task 2 (project-creator pure helpers) | +11 | 185 |
| Task 3 (createProject orchestration) | +7 | 192 |
| Task 4 (clone command) | +13 | 205 |
| Task 5 (init command) | +5 | 210 |
| Task 6 (wiring + help) | +0 to +2 (depending on existing test style) | 210-212 |
| Task 7 (deploy) | 0 | 210-212 |

Recount the `it(...)` blocks in each task's Step 1 if the actual count diverges by ≤3.
