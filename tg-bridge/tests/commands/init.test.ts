import { describe, it, expect, vi, beforeEach } from "vitest";

const WORKSPACE_ROOT = "/workspace";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock("../../src/project-creator.js", () => ({
  createProject: vi.fn(async () => undefined),
}));

import { existsSync } from "node:fs";
import { createProject } from "../../src/project-creator.js";
import { handleInit } from "../../src/commands/init.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

function makeDeps() {
  return {
    client: {} as never,
    state: { get: vi.fn(() => null) } as never,
    router: {} as never,
    bot: {} as never,
    workspaceRoot: WORKSPACE_ROOT,
    defaultModel: "anthropic/claude-sonnet-4-5",
  };
}

describe("handleInit", () => {
  beforeEach(() => {
    vi.mocked(createProject).mockClear();
    vi.mocked(existsSync).mockReturnValue(false);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
