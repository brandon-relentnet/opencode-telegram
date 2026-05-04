import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentBranch, getGitInfo, _clearCache } from "../src/branch-info.js";

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), "branch-info-"));
  execSync("git init -q", { cwd: repoPath });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoPath });
  execSync("git checkout -q -b main", { cwd: repoPath });
  writeFileSync(join(repoPath, "README.md"), "hi");
  execSync("git add . && git commit -q -m init", { cwd: repoPath });
  _clearCache();
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

describe("getCurrentBranch", () => {
  it("returns the current branch", async () => {
    expect(await getCurrentBranch(repoPath)).toBe("main");
  });

  it("returns null for a non-git directory", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "nonrepo-"));
    try {
      expect(await getCurrentBranch(nonRepo)).toBeNull();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("reflects branch changes after cache TTL", async () => {
    expect(await getCurrentBranch(repoPath)).toBe("main");
    execSync("git checkout -q -b feature-x", { cwd: repoPath });
    _clearCache(); // simulate TTL expiry
    expect(await getCurrentBranch(repoPath)).toBe("feature-x");
  });
});

describe("getGitInfo", () => {
  it("returns full info for a clean repo", async () => {
    const info = await getGitInfo(repoPath);
    expect(info.branch).toBe("main");
    expect(info.status.modified).toBe(0);
    expect(info.status.untracked).toBe(0);
    expect(info.lastCommit?.message).toBe("init");
    expect(info.remote).toBeNull();
  });

  it("counts modified + untracked files", async () => {
    writeFileSync(join(repoPath, "README.md"), "modified");
    writeFileSync(join(repoPath, "new.txt"), "new");
    _clearCache();
    const info = await getGitInfo(repoPath);
    expect(info.status.modified).toBe(1);
    expect(info.status.untracked).toBe(1);
  });

  it("returns null branch + zeroes for non-git", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "nonrepo-"));
    try {
      const info = await getGitInfo(nonRepo);
      expect(info.branch).toBeNull();
      expect(info.status.modified).toBe(0);
      expect(info.lastCommit).toBeNull();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("caches results for 5 seconds", async () => {
    const a = await getCurrentBranch(repoPath);
    execSync("git checkout -q -b feature-y", { cwd: repoPath });
    // Cache still hot — should return old value
    const b = await getCurrentBranch(repoPath);
    expect(a).toBe(b);
    expect(b).toBe("main");
  });
});
