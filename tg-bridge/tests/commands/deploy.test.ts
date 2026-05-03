import { describe, it, expect, vi } from "vitest";
import {
  handleDeploy,
  parseDeployReply,
  buildFirstDeployPrompt,
  buildSubsequentDeployPrompt,
} from "../../src/commands/deploy.js";

interface FakeCtx {
  chat: { id: number };
  reply: ReturnType<typeof vi.fn>;
}

function makeFakeCtx(): FakeCtx {
  return {
    chat: { id: 100 },
    reply: vi.fn(async () => ({ message_id: 999 })),
  };
}

function makeStateWithProject(coolifyApp: { uuid: string; fqdn: string } | null = null) {
  return {
    get: vi.fn(() => ({
      chatId: 100,
      projectPath: "/workspace/site",
      sessionId: "ses_42",
      model: null,
      updatedAt: 0,
    })),
    getCoolifyApp: vi.fn(() => coolifyApp),
    setCoolifyApp: vi.fn(),
  };
}

function makeStateWithoutProject() {
  return {
    get: vi.fn(() => null),
    getCoolifyApp: vi.fn(),
    setCoolifyApp: vi.fn(),
  };
}

function makeRouter() {
  let captured:
    | { id: string; handler: import("../../src/event-router.js").SessionEventHandler }
    | undefined;
  return {
    captured: () => captured,
    registerSession: vi.fn((id, handler) => {
      captured = { id, handler };
      return () => undefined;
    }),
    ensureDirectory: vi.fn(),
  };
}

function makeClient() {
  return {
    createSession: vi.fn(async () => ({ id: "ses_oneshot" })),
    prompt: vi.fn(async () => undefined),
    abortSession: vi.fn(),
    getSession: vi.fn(async () => ({ id: "ses_oneshot", directory: "/workspace/site" })),
    listProjects: vi.fn(),
    subscribeToEvents: vi.fn(),
    respondToPermission: vi.fn(),
    respondToQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
  };
}

function makeBot() {
  const edits: Array<unknown[]> = [];
  const sends: Array<unknown[]> = [];
  return {
    edits,
    sends,
    editMessageText: vi.fn(async (...args: unknown[]) => {
      edits.push(args);
      return undefined;
    }),
    sendMessage: vi.fn(async (...args: unknown[]) => {
      sends.push(args);
      return { message_id: 1234 };
    }),
  };
}

const baseDeps = () => ({
  client: makeClient() as never,
  state: makeStateWithProject() as never,
  router: makeRouter() as never,
  bot: makeBot() as never,
  workspaceRoot: "/workspace",
  defaultModel: "anthropic/claude-sonnet-4-5",
  coolifyConfig: {
    url: "https://coolify.example.com",
    token: "ct",
    serverUuid: "srv-1",
    projectUuid: "prj-1",
    githubAppUuid: "gha-1",
  },
});

describe("parseDeployReply", () => {
  it("parses 'deployed:UUID:FQDN' for first deploy", () => {
    expect(parseDeployReply("deployed:abc-123:newsite.example.com", true)).toEqual({
      kind: "first",
      uuid: "abc-123",
      fqdn: "newsite.example.com",
    });
  });

  it("parses 'deployed' for subsequent deploy", () => {
    expect(parseDeployReply("deployed", false)).toEqual({ kind: "subsequent" });
  });

  it("parses 'failed: <reason>' for either path", () => {
    expect(parseDeployReply("failed: Coolify returned 503", true)).toEqual({
      kind: "failed",
      reason: "Coolify returned 503",
    });
    expect(parseDeployReply("failed: push rejected", false)).toEqual({
      kind: "failed",
      reason: "push rejected",
    });
  });

  it("returns null for unrecognized output", () => {
    expect(parseDeployReply("Hi there!", true)).toBeNull();
    expect(parseDeployReply("", false)).toBeNull();
  });

  it("trims whitespace and is case-insensitive on the prefix", () => {
    expect(parseDeployReply("  Deployed:abc:fqdn.com  ", true)).toEqual({
      kind: "first",
      uuid: "abc",
      fqdn: "fqdn.com",
    });
  });
});

describe("buildFirstDeployPrompt", () => {
  it("references the project path and uses shell vars for secrets", () => {
    const prompt = buildFirstDeployPrompt("/workspace/site");
    expect(prompt).toContain("cd /workspace/site");
    expect(prompt).toContain('"$COOLIFY_URL/api/v1/applications/private-github-app"');
    expect(prompt).toContain("Bearer $COOLIFY_TOKEN");
    expect(prompt).toContain('"project_uuid": "$COOLIFY_PROJECT_UUID"');
    expect(prompt).toContain('"server_uuid": "$COOLIFY_SERVER_UUID"');
    expect(prompt).toContain('"github_app_uuid": "$COOLIFY_GITHUB_APP_UUID"');
    expect(prompt).toContain('"build_pack": "nixpacks"');
    expect(prompt).toContain('"ports_exposes": "3000"');
    expect(prompt).toContain('echo "deployed:$APP_UUID:$FQDN"');
    expect(prompt).toMatch(/failed:/);
  });

  it("captures HTTP status separately so 4xx errors surface clearly", () => {
    // Without the HTTP-status capture, `curl -sf` would silently fail on 4xx
    // and the agent would improvise a generic "curl command did not produce
    // valid JSON" reply. The prompt must echo the full body + status.
    const prompt = buildFirstDeployPrompt("/workspace/site");
    expect(prompt).toContain("___STATUS:%{http_code}");
    expect(prompt).toContain("failed: Coolify HTTP $STATUS");
  });

  it("parses the FQDN from Coolify's .domains field (not .fqdn)", () => {
    // Coolify's POST /api/v1/applications/private-github-app returns
    // {uuid, domains: "https://x.example.com,https://y.example.com"} —
    // not the {uuid, fqdn} shape the original prompt assumed. The script
    // must read .domains and strip the scheme.
    const prompt = buildFirstDeployPrompt("/workspace/site");
    expect(prompt).toContain(".domains");
    expect(prompt).not.toContain(".fqdn");
  });

  it("strips the .git suffix from the origin URL (Coolify rejects it)", () => {
    // `git remote get-url origin` returns an HTTPS URL ending in .git when
    // gh repo create configured the remote. Coolify's POST endpoint rejects
    // that with HTTP 404 'Repository not found' because it tries to look up
    // 'owner/repo.git' (with the suffix as part of the name) on GitHub.
    const prompt = buildFirstDeployPrompt("/workspace/site");
    expect(prompt).toContain("sed 's/\\.git$//'");
  });
});

describe("buildSubsequentDeployPrompt", () => {
  it("references the project path, embeds app uuid, uses shell vars for COOLIFY_URL/TOKEN", () => {
    const prompt = buildSubsequentDeployPrompt("/workspace/site", "abc-123");
    expect(prompt).toContain("cd /workspace/site");
    expect(prompt).toContain("git push origin main");
    expect(prompt).toContain('"$COOLIFY_URL/api/v1/deploy?uuid=abc-123"');
    expect(prompt).toContain("Bearer $COOLIFY_TOKEN");
    expect(prompt).toContain('echo "deployed"');
  });
});

describe("handleDeploy validation", () => {
  it("replies 'use /switch first' when no project in chat state", async () => {
    const ctx = makeFakeCtx();
    const deps = { ...baseDeps(), state: makeStateWithoutProject() as never };
    await handleDeploy(ctx as never, deps);
    expect(ctx.reply).toHaveBeenCalled();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/switch/i);
  });

  it("replies with friendly error when COOLIFY_URL is missing", async () => {
    const ctx = makeFakeCtx();
    const deps = {
      ...baseDeps(),
      coolifyConfig: { ...baseDeps().coolifyConfig, url: undefined as unknown as string },
    };
    await handleDeploy(ctx as never, deps);
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/COOLIFY\\?_URL/);
  });

  it("replies with friendly error when COOLIFY_TOKEN is missing", async () => {
    const ctx = makeFakeCtx();
    const deps = {
      ...baseDeps(),
      coolifyConfig: { ...baseDeps().coolifyConfig, token: undefined as unknown as string },
    };
    await handleDeploy(ctx as never, deps);
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/COOLIFY\\?_TOKEN/);
  });
});

describe("handleDeploy first-deploy path", () => {
  it("dispatches buildFirstDeployPrompt when no coolify_app saved", async () => {
    const ctx = makeFakeCtx();
    const deps = baseDeps();
    deps.state = makeStateWithProject(null) as never;
    await handleDeploy(ctx as never, deps);
    const promptCalls = (deps.client as ReturnType<typeof makeClient>).prompt.mock
      .calls as unknown as unknown[][];
    expect(promptCalls).toHaveLength(1);
    expect(String(promptCalls[0]![1])).toContain("/api/v1/applications/private-github-app");
  });

  it("on 'deployed:UUID:FQDN' marker, persists app and edits placeholder with FQDN", async () => {
    const ctx = makeFakeCtx();
    const deps = baseDeps();
    const router = makeRouter();
    deps.router = router as never;
    deps.state = makeStateWithProject(null) as never;
    await handleDeploy(ctx as never, deps);
    const handler = router.captured()?.handler;
    expect(handler).toBeDefined();
    handler?.onPartUpdated({ id: "p1", type: "text", text: "deployed:abc-123:site.example.com" });
    await handler?.onIdle();
    const setSpy = (deps.state as ReturnType<typeof makeStateWithProject>).setCoolifyApp;
    expect(setSpy).toHaveBeenCalledWith(100, "/workspace/site", "abc-123", "site.example.com");
    const bot = deps.bot as ReturnType<typeof makeBot>;
    const lastEdit = bot.edits[bot.edits.length - 1];
    expect(String(lastEdit?.[2])).toMatch(/site\\?\.example\\?\.com/);
    // Dashboard URL must be included so user can navigate to manage the app.
    expect(String(lastEdit?.[2])).toMatch(/coolify\\?\.example\\?\.com\/applications\/abc\\?-123/);
  });
});

describe("handleDeploy subsequent-deploy path", () => {
  it("dispatches buildSubsequentDeployPrompt when coolify_app already saved", async () => {
    const ctx = makeFakeCtx();
    const deps = baseDeps();
    deps.state = makeStateWithProject({ uuid: "existing-uuid", fqdn: "existing.example.com" }) as never;
    await handleDeploy(ctx as never, deps);
    const promptCalls = (deps.client as ReturnType<typeof makeClient>).prompt.mock
      .calls as unknown as unknown[][];
    expect(promptCalls).toHaveLength(1);
    expect(String(promptCalls[0]![1])).toContain("uuid=existing-uuid");
    expect(String(promptCalls[0]![1])).not.toContain("/api/v1/applications/private-github-app");
  });

  it("on 'deployed' marker, edits placeholder with stored FQDN", async () => {
    const ctx = makeFakeCtx();
    const deps = baseDeps();
    const router = makeRouter();
    deps.router = router as never;
    deps.state = makeStateWithProject({ uuid: "u", fqdn: "stored.example.com" }) as never;
    await handleDeploy(ctx as never, deps);
    const handler = router.captured()?.handler;
    handler?.onPartUpdated({ id: "p1", type: "text", text: "deployed" });
    await handler?.onIdle();
    const bot = deps.bot as ReturnType<typeof makeBot>;
    const lastEdit = bot.edits[bot.edits.length - 1];
    expect(String(lastEdit?.[2])).toMatch(/stored\\?\.example\\?\.com/);
  });
});

describe("handleDeploy failure path", () => {
  it("on 'failed: <reason>' marker, surfaces the reason via showError", async () => {
    const ctx = makeFakeCtx();
    const deps = baseDeps();
    const router = makeRouter();
    deps.router = router as never;
    deps.state = makeStateWithProject(null) as never;
    await handleDeploy(ctx as never, deps);
    const handler = router.captured()?.handler;
    handler?.onPartUpdated({ id: "p1", type: "text", text: "failed: Coolify 503" });
    await handler?.onIdle();
    const setSpy = (deps.state as ReturnType<typeof makeStateWithProject>).setCoolifyApp;
    expect(setSpy).not.toHaveBeenCalled();
    const bot = deps.bot as ReturnType<typeof makeBot>;
    const lastEdit = bot.edits[bot.edits.length - 1];
    expect(String(lastEdit?.[2])).toMatch(/Coolify 503/);
  });
});
