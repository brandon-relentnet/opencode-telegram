import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleProjects } from "../../src/commands/projects.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

describe("handleProjects", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "ws-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("lists subdirectories alphabetically", async () => {
    mkdirSync(join(workspaceRoot, "myapp"));
    mkdirSync(join(workspaceRoot, "blog"));
    mkdirSync(join(workspaceRoot, "scripts"));
    writeFileSync(join(workspaceRoot, "README.md"), "ignore me");

    const ctx = makeFakeCtx();
    await handleProjects(ctx as never, { workspaceRoot });

    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).toMatch(/blog/);
    expect(text).toMatch(/myapp/);
    expect(text).toMatch(/scripts/);
    expect(text).not.toMatch(/README/);
    // Alphabetical
    expect(text.indexOf("blog")).toBeLessThan(text.indexOf("myapp"));
    expect(text.indexOf("myapp")).toBeLessThan(text.indexOf("scripts"));
  });

  it("ignores hidden directories", async () => {
    mkdirSync(join(workspaceRoot, ".git"));
    mkdirSync(join(workspaceRoot, "myapp"));
    const ctx = makeFakeCtx();
    await handleProjects(ctx as never, { workspaceRoot });
    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).not.toMatch(/\.git/);
    expect(text).toMatch(/myapp/);
  });

  it("reports when no projects are present", async () => {
    const ctx = makeFakeCtx();
    await handleProjects(ctx as never, { workspaceRoot });
    const [text] = ctx.reply.mock.calls[0]!;
    expect(text).toMatch(/no projects/i);
  });
});
