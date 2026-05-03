import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import {
  buildClonePrompt,
  buildInitPrompt,
  detectSuccess,
  createProject,
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
