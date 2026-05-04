import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInitRemote } from "../../src/commands/init-remote.js";

vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  existsSync: vi.fn(() => false),
}));

import { existsSync } from "node:fs";
import * as projectCreator from "../../src/project-creator.js";

interface FakeCtx {
  match: string;
  chat: { id: number };
  reply: ReturnType<typeof vi.fn>;
}

function makeFakeCtx(match: string): FakeCtx {
  return {
    match,
    chat: { id: 100 },
    reply: vi.fn(async () => ({ message_id: 999 })),
  };
}

function makeDeps(overrides: Partial<Parameters<typeof handleInitRemote>[1]> = {}) {
  return {
    client: {} as never,
    state: { get: vi.fn(() => null) } as never,
    router: { registerSession: vi.fn(), ensureDirectory: vi.fn() } as never,
    bot: {} as never,
    workspaceRoot: "/workspace",
    defaultModel: "anthropic/claude-sonnet-4-5",
    ghToken: "ghp_abc",
    ghOwner: "brandon",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
});

describe("handleInitRemote validation", () => {
  it("replies with usage when name is missing", async () => {
    const ctx = makeFakeCtx("");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalled();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/Usage/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("replies with 'invalid project name' on path-traversal attempts", async () => {
    const ctx = makeFakeCtx("../bad");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps());
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/[Ii]nvalid project name/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("replies with 'already exists' if /workspace/<name> exists locally", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const ctx = makeFakeCtx("taken");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps());
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/already exists/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("dispatches successfully when ghToken is undefined (gh CLI auth fallback)", async () => {
    // gh CLI authenticates via either GH_TOKEN env var OR `gh auth login`
    // credentials stored in ~/.config/gh/hosts.yml. The bridge no longer
    // requires GH_TOKEN to be set; the agent's `gh repo create` will surface
    // a clear error if neither auth method works.
    vi.mocked(existsSync).mockReturnValue(false);
    const ctx = makeFakeCtx("ok");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps({ ghToken: undefined }));
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("replies with friendly error when ghOwner is undefined", async () => {
    const ctx = makeFakeCtx("ok");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps({ ghOwner: undefined }));
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/GH\\?_OWNER/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("dispatches createProject with kind='init-remote' on valid input", async () => {
    const ctx = makeFakeCtx("good-name");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const args = createSpy.mock.calls[0]![0];
    expect(args).toMatchObject({
      chatId: 100,
      placeholderId: 999,
      name: "good-name",
      kind: "init-remote",
      owner: "brandon",
      workspaceRoot: "/workspace",
    });
  });
});
