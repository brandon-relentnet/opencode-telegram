import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import {
  buildClonePrompt,
  buildInitPrompt,
  buildInitRemotePrompt,
  detectSuccess,
  createProject,
  type MaybeTextPart,
} from "../src/project-creator.js";
import { ChatStateRepo } from "../src/chat-state.js";
import type { OpencodeClient } from "../src/opencode-client.js";
import type { SessionEventHandler } from "../src/event-router.js";

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
  it("returns false for empty parts array", () => {
    expect(detectSuccess([], "init")).toBe(false);
    expect(detectSuccess([], "clone")).toBe(false);
  });

  it("returns false when no text parts are present", () => {
    expect(
      detectSuccess(
        [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } } as MaybeTextPart],
        "init",
      ),
    ).toBe(false);
  });

  it("matches a single 'initialized' text part for init", () => {
    expect(detectSuccess([{ type: "text", text: "initialized" }], "init")).toBe(true);
  });

  it("matches a single 'cloned' text part for clone", () => {
    expect(detectSuccess([{ type: "text", text: "cloned" }], "clone")).toBe(true);
  });

  it("matches the LAST text part when earlier text parts contain preamble (init)", () => {
    expect(
      detectSuccess(
        [
          { type: "text", text: "I need to run the exact command you specified." },
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } },
          { type: "text", text: "initialized" },
        ],
        "init",
      ),
    ).toBe(true);
  });

  it("matches the LAST text part when earlier text parts contain preamble (clone)", () => {
    expect(
      detectSuccess(
        [
          { type: "text", text: "I'll clone that for you now." },
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } },
          { type: "text", text: "cloned" },
        ],
        "clone",
      ),
    ).toBe(true);
  });

  it("matches a verbose final reply containing the marker as a word (init)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "Successfully initialized the project at /workspace/foo." }],
        "init",
      ),
    ).toBe(true);
  });

  it("matches a verbose final reply containing the marker as a word (clone)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "I have cloned the repository into /workspace/foo." }],
        "clone",
      ),
    ).toBe(true);
  });

  it("returns false when the last text part starts with 'failed:' even if it contains the marker", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "failed: was already initialized" }],
        "init",
      ),
    ).toBe(false);
    expect(
      detectSuccess(
        [{ type: "text", text: "failed: target was already cloned" }],
        "clone",
      ),
    ).toBe(false);
  });

  it("returns false when 'failed:' has trailing whitespace differences", () => {
    // Confirms /^failed:/i is case-insensitive but anchored at start
    expect(detectSuccess([{ type: "text", text: "Failed: foo" }], "init")).toBe(false);
    expect(detectSuccess([{ type: "text", text: "FAILED: bar" }], "clone")).toBe(false);
  });

  it("returns false when only 'initialize' (root word, missing 'd') appears (init)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "I will run init to initialize the directory." }],
        "init",
      ),
    ).toBe(false);
  });

  it("returns false when only 'clone' (verb, not past-tense) appears (clone)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "I'll clone the repo now." }],
        "clone",
      ),
    ).toBe(false);
  });

  it("ignores empty/whitespace-only text parts when finding the last", () => {
    expect(
      detectSuccess(
        [
          { type: "text", text: "preamble" },
          { type: "text", text: "initialized" },
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
        "init",
      ),
    ).toBe(true);
  });

  it("returns false when the wrong marker appears (cloned in an init request)", () => {
    expect(detectSuccess([{ type: "text", text: "cloned" }], "init")).toBe(false);
    expect(detectSuccess([{ type: "text", text: "initialized" }], "clone")).toBe(false);
  });
});

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
    editMessageText: vi.fn(
      async (_chatId: number, _messageId: number, _text: string, _opts: unknown) => undefined,
    ),
    sendMessage: vi.fn(
      async (_chatId: number, _text: string, _opts: unknown) => ({ message_id: 999 }),
    ),
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
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ id: "ses_x", directory: "/workspace" })),
    getModelContextLimit: vi.fn(async () => null),
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
    // MarkdownV2 escaping turns ses_2 → ses\_2 in the rendered text.
    expect(String(lastEdit[2])).toContain("ses\\_2");
  });

  it("on auto-switch success: persists session slug + started_at + resets CostTracker", async () => {
    const router = makeRouter();
    // The second createSession (the long-running session for the new
    // project) returns a slug + time. The first (one-shot) returns just
    // an id; performAutoSwitch should pull slug/time from the SECOND.
    let createCount = 0;
    const client = makeClient({
      createSession: vi.fn(async () => {
        createCount++;
        if (createCount === 1) {
          return { id: `ses_${createCount}` };
        }
        return {
          id: `ses_${createCount}`,
          slug: "winter-forest",
          time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        };
      }),
    });
    const bot = makeBot();
    const state = new ChatStateRepo(new Database(":memory:"));
    const costTracker = { recordAssistantMessage: vi.fn(), reset: vi.fn() };
    const deps = {
      ...makeDeps({ client, router, bot, state }),
      costTracker: costTracker as never,
    };

    await createProject(
      {
        chatId: 1,
        placeholderId: 555,
        name: "myrepo",
        kind: "init",
        workspaceRoot: WORKSPACE_ROOT,
      },
      deps,
    );

    const handler = router.registered!;
    handler.onPartUpdated({ id: "p1", type: "text", text: "initialized" });
    await Promise.resolve(handler.onIdle());
    await tick();

    // CostTracker reset because the chat now points at a brand-new
    // project + session.
    expect(costTracker.reset).toHaveBeenCalledWith(1);
    // Slug + started_at persisted from the long-running session, NOT the
    // one-shot orchestration session.
    expect(state.getSessionSlug(1)).toBe("winter-forest");
    expect(state.getSessionStartedAt(1)).toBe(1_700_000_000_000);
    // agent_mode cleared until first assistant message in new session.
    expect(state.getAgentMode(1)).toBeNull();
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
    // chat-state untouched (state.get returns null when key missing, not undefined)
    expect(state.get(1)).toBeNull();
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
    expect(state.get(1)).toBeNull();
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

    expect(state.get(1)).toBeNull();
    const editCalls = bot.editMessageText.mock.calls;
    const lastEditText = String(editCalls[editCalls.length - 1]![2]);
    expect(lastEditText).toContain("network down");
  });

  it("for /clone without url: throws (interface contract)", async () => {
    const deps = makeDeps();
    await expect(
      createProject(
        // url omitted on purpose — runtime guard should reject this even though
        // the interface marks `url?` as optional (the contract is "required iff
        // kind === 'clone'", which TS can't enforce without a discriminated union).
        { chatId: 1, placeholderId: 555, name: "myrepo", kind: "clone", workspaceRoot: WORKSPACE_ROOT },
        deps,
      ),
    ).rejects.toThrow();
  });
});

describe("buildInitRemotePrompt", () => {
  it("references the project name and owner", () => {
    const out = buildInitRemotePrompt("new-site", "brandon");
    expect(out).toContain("/workspace/new-site");
    expect(out).toContain("gh repo create brandon/new-site");
  });

  it("creates the dir + git init + initial commit in a single bash block", () => {
    const out = buildInitRemotePrompt("x", "owner");
    expect(out).toContain("mkdir -p /workspace/x");
    expect(out).toContain("git init");
    expect(out).toContain("git add README.md && git commit -m");
    expect(out).toContain("--private --source=. --remote=origin");
  });

  it("creates the GitHub repo without --push to avoid the propagation race", () => {
    // GitHub returns success on the create API before the repo's git endpoint
    // is fully propagated. `gh repo create --push` does the push immediately
    // and intermittently hits "repository not found". We split create and push.
    const out = buildInitRemotePrompt("x", "owner");
    expect(out).not.toContain("--push");
  });

  it("retries `git push` with backoff to absorb the propagation lag", () => {
    const out = buildInitRemotePrompt("x", "owner");
    expect(out).toContain("for attempt in 1 2 3 4 5;");
    expect(out).toContain("git push -u origin main");
    expect(out).toContain("sleep $attempt");
    expect(out).toContain("after 5 attempts");
  });

  it("ends with the marker contract (remote_initialized or failed:)", () => {
    const out = buildInitRemotePrompt("x", "owner");
    expect(out).toContain("remote_initialized");
    expect(out).toMatch(/failed:/);
  });
});

describe("detectSuccess for init-remote", () => {
  it("matches \\bremote_initialized\\b in the last text part", () => {
    expect(
      detectSuccess(
        [
          { type: "text", text: "Running command..." },
          { type: "text", text: "remote_initialized" },
        ],
        "init-remote",
      ),
    ).toBe(true);
  });

  it("matches verbose markers like 'Successfully remote_initialized the repo'", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "Successfully remote_initialized the repo" }],
        "init-remote",
      ),
    ).toBe(true);
  });

  it("hard-fails on leading 'failed:' even if remote_initialized appears", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "failed: gh repo create returned exit 1; would have remote_initialized" }],
        "init-remote",
      ),
    ).toBe(false);
  });

  it("rejects 'initialized' alone (must be the full word)", () => {
    expect(
      detectSuccess([{ type: "text", text: "initialized" }], "init-remote"),
    ).toBe(false);
  });
});
