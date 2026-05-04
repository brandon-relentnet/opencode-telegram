import { describe, it, expect, vi, beforeEach } from "vitest";

const WORKSPACE_ROOT = "/workspace";

// Mock node:fs partially so vi.mocked(existsSync) works (vi.spyOn fails on
// ESM-imported fs because the property descriptor is non-configurable).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock("../../src/project-creator.js", () => ({
  createProject: vi.fn(async () => undefined),
}));

import { existsSync } from "node:fs";
import { createProject } from "../../src/project-creator.js";
import { handleClone, deriveProjectName, parseCloneArgs } from "../../src/commands/clone.js";
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
    // Default: no project exists at the target. Reset between tests so a
    // collision-test setting `true` doesn't leak into the next test.
    vi.mocked(existsSync).mockReturnValue(false);
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
    // URL whose basename starts with `.` → fails isSafeProjectName's dot-prefix check
    const ctx = makeFakeCtx({ chatId: 1, text: "/clone https://github.com/.hidden" });
    ctx.match = "https://github.com/.hidden";
    await handleClone(ctx as never, makeDeps());
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/Invalid project name/i);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
