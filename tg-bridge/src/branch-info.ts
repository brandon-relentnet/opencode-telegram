import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface GitInfo {
  branch: string | null;
  status: { modified: number; untracked: number };
  ahead: number;
  behind: number;
  lastCommit: { sha: string; message: string; ageMs: number } | null;
  remote: string | null;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { data: GitInfo; expiresAt: number }>();

/** Test-only: clear cache. */
export function _clearCache(): void {
  cache.clear();
}

async function runGit(cmd: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(cmd, { cwd, timeout: 3_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function getCurrentBranch(projectPath: string): Promise<string | null> {
  const info = await getGitInfo(projectPath);
  return info.branch;
}

export async function getGitInfo(projectPath: string): Promise<GitInfo> {
  const cached = cache.get(projectPath);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const branch = await runGit("git branch --show-current", projectPath);
  if (branch === null) {
    // Not a git repo OR git failed
    const empty: GitInfo = {
      branch: null,
      status: { modified: 0, untracked: 0 },
      ahead: 0,
      behind: 0,
      lastCommit: null,
      remote: null,
    };
    cache.set(projectPath, { data: empty, expiresAt: Date.now() + CACHE_TTL_MS });
    return empty;
  }

  // Run remaining inspections in parallel.
  const [statusOut, aheadOut, behindOut, lastOut, remoteOut] = await Promise.all([
    runGit("git status --porcelain", projectPath),
    runGit("git rev-list --count @{u}..HEAD", projectPath), // commits we have that origin doesn't
    runGit("git rev-list --count HEAD..@{u}", projectPath), // commits origin has that we don't
    runGit("git log -1 --format=%h%x09%s%x09%ct", projectPath),
    runGit("git remote get-url origin", projectPath),
  ]);

  let modified = 0;
  let untracked = 0;
  if (statusOut) {
    for (const line of statusOut.split("\n")) {
      if (line.length < 2) continue;
      const code = line.slice(0, 2);
      if (code === "??") untracked++;
      else modified++;
    }
  }

  let lastCommit: GitInfo["lastCommit"] = null;
  if (lastOut) {
    const [sha, message, ctSec] = lastOut.split("\t");
    if (sha && message && ctSec) {
      lastCommit = {
        sha,
        message,
        ageMs: Date.now() - Number(ctSec) * 1000,
      };
    }
  }

  // Normalize remote URL: extract owner/repo from common formats.
  let remote: string | null = null;
  if (remoteOut) {
    // git@github.com:owner/repo.git OR https://github.com/owner/repo(.git)?
    const sshMatch = remoteOut.match(/^git@[^:]+:([^/]+\/[^.]+)/);
    const httpsMatch = remoteOut.match(/github\.com\/([^/]+\/[^/.]+)/);
    remote = (sshMatch?.[1] ?? httpsMatch?.[1] ?? remoteOut).replace(/\.git$/, "");
  }

  const data: GitInfo = {
    branch,
    status: { modified, untracked },
    ahead: Number(aheadOut ?? 0),
    behind: Number(behindOut ?? 0),
    lastCommit,
    remote,
  };
  cache.set(projectPath, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}
