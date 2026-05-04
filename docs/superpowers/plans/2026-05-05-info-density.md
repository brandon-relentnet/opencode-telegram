# Telegram Bot Info Density — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface model, agent mode, token usage, cost, branch, and session slug across three info surfaces (pinned, streaming header, `/info`) so the user can see what state the bot is in at a glance.

**Architecture:** Schema additions to `chat_state` for new state. New `branch-info.ts` shells to git (cached 5s). New `cost-tracker.ts` aggregates per-message tokens+cost via existing `message.created` events. Pinned message redesigned to 5 compact lines. Streaming view gains a header. New `/info` command for full detail.

**Tech Stack:** TypeScript strict, ESM `.js` imports, vitest, `mock.calls[0]!`, better-sqlite3, grammy. Builds on commit `e7c53fa`.

**Spec:** `docs/superpowers/specs/2026-05-05-info-density-design.md`

---

## Task 1: chat_state schema additions

**Files:**
- Modify: `tg-bridge/src/chat-state.ts`
- Modify: `tg-bridge/tests/chat-state.test.ts`

**Goal:** Add 12 new nullable columns to chat_state. Idempotent migration. New getter/setter methods.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/chat-state.test.ts`:

```typescript
describe("ChatStateRepo info-density fields", () => {
  it("session_slug roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getSessionSlug(1)).toBeNull();
    repo.setSessionSlug(1, "clever-meadow");
    expect(repo.getSessionSlug(1)).toBe("clever-meadow");
  });

  it("branch roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setBranch(1, "feature-x");
    expect(repo.getBranch(1)).toBe("feature-x");
  });

  it("agent_mode roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setAgentMode(1, "build");
    expect(repo.getAgentMode(1)).toBe("build");
  });

  it("incrementCumulativeStats accumulates", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.incrementCumulativeStats(1, {
      tokensInput: 100, tokensOutput: 50, tokensReasoning: 10,
      tokensCacheRead: 200, tokensCacheWrite: 0,
      costMicros: 4_200,
    });
    repo.incrementCumulativeStats(1, {
      tokensInput: 50, tokensOutput: 25, tokensReasoning: 0,
      tokensCacheRead: 0, tokensCacheWrite: 100,
      costMicros: 1_800,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(150);
    expect(stats.tokensOutput).toBe(75);
    expect(stats.tokensReasoning).toBe(10);
    expect(stats.tokensCacheRead).toBe(200);
    expect(stats.tokensCacheWrite).toBe(100);
    expect(stats.costMicros).toBe(6_000);
  });

  it("resetCumulativeStats clears counters but preserves project state", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setProject(1, "/workspace/x", "ses_1");
    repo.incrementCumulativeStats(1, {
      tokensInput: 100, tokensOutput: 50, tokensReasoning: 0,
      tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: 1000,
    });
    repo.resetCumulativeStats(1);
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(0);
    expect(stats.costMicros).toBe(0);
    // Project state survived
    expect(repo.get(1)?.projectPath).toBe("/workspace/x");
  });

  it("getCumulativeStats on unknown chat returns zeros", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    const stats = repo.getCumulativeStats(99);
    expect(stats.tokensInput).toBe(0);
    expect(stats.costMicros).toBe(0);
  });

  it("context_limit roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setContextLimit(1, 200_000);
    expect(repo.getContextLimit(1)).toBe(200_000);
  });

  it("session_started_at roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setSessionStartedAt(1, 1_000_000_000_000);
    expect(repo.getSessionStartedAt(1)).toBe(1_000_000_000_000);
  });

  it("last_deploy_at roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setLastDeployAt(1, 1_500_000_000_000);
    expect(repo.getLastDeployAt(1)).toBe(1_500_000_000_000);
  });

  it("idempotent migration on existing DB", () => {
    const db = new Database(":memory:");
    new ChatStateRepo(db);
    new ChatStateRepo(db); // second construction must not throw
    const cols = db.prepare("PRAGMA table_info(chat_state)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("session_slug")).toBe(true);
    expect(names.has("branch")).toBe(true);
    expect(names.has("agent_mode")).toBe(true);
    expect(names.has("cumulative_tokens_input")).toBe(true);
    expect(names.has("cumulative_cost_micros")).toBe(true);
    expect(names.has("context_limit")).toBe(true);
    expect(names.has("session_started_at")).toBe(true);
    expect(names.has("last_deploy_at")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify red**

Run: `cd tg-bridge && npx vitest run tests/chat-state.test.ts`

Expected: failures on new methods (e.g. `repo.getSessionSlug is not a function`).

- [ ] **Step 3: Update SCHEMA + migrateSchema in `chat-state.ts`**

Add the new columns to the SCHEMA constant (for fresh DBs) AND ensure migrateSchema's `PRAGMA table_info` check covers them all. The existing pattern in chat-state.ts already handles `pinned_message_id`/`pin_paused`/`last_user_message_id` via ALTER TABLE ADD COLUMN — extend the same pattern for these 12 new columns.

Add to SCHEMA constant:
```sql
CREATE TABLE IF NOT EXISTS chat_state (
  chat_id                       INTEGER PRIMARY KEY,
  project_path                  TEXT,
  session_id                    TEXT,
  model                         TEXT,
  updated_at                    INTEGER NOT NULL,
  pinned_message_id             INTEGER,
  pin_paused                    INTEGER NOT NULL DEFAULT 0,
  last_user_message_id          INTEGER,
  -- info-density additions:
  session_slug                  TEXT,
  branch                        TEXT,
  agent_mode                    TEXT,
  cumulative_tokens_input       INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_output      INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_reasoning   INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  cumulative_cost_micros        INTEGER NOT NULL DEFAULT 0,
  context_limit                 INTEGER,
  session_started_at            INTEGER,
  last_activity_at              INTEGER,
  last_deploy_at                INTEGER
);
```

In `migrateSchema(db)`, extend the `requiredCols` array (or wherever the existing migration pattern lives — find it via grep — to include each new column with its `ALTER TABLE chat_state ADD COLUMN <name> <type>` clause for old DBs). For columns with NOT NULL DEFAULT 0, the ALTER must include the default.

- [ ] **Step 4: Add prepared statements + methods**

Add to `ChatStateRepo` class:

```typescript
// In constructor:
this.getSessionSlugStmt = db.prepare("SELECT session_slug FROM chat_state WHERE chat_id = ?");
this.setSessionSlugStmt = db.prepare(
  "UPDATE chat_state SET session_slug = ?, updated_at = ? WHERE chat_id = ?",
);
this.getBranchStmt = db.prepare("SELECT branch FROM chat_state WHERE chat_id = ?");
this.setBranchStmt = db.prepare(
  "UPDATE chat_state SET branch = ?, updated_at = ? WHERE chat_id = ?",
);
this.getAgentModeStmt = db.prepare("SELECT agent_mode FROM chat_state WHERE chat_id = ?");
this.setAgentModeStmt = db.prepare(
  "UPDATE chat_state SET agent_mode = ?, updated_at = ? WHERE chat_id = ?",
);
this.getCumulativeStatsStmt = db.prepare(`
  SELECT cumulative_tokens_input, cumulative_tokens_output, cumulative_tokens_reasoning,
         cumulative_tokens_cache_read, cumulative_tokens_cache_write, cumulative_cost_micros
  FROM chat_state WHERE chat_id = ?
`);
this.incrementCumulativeStatsStmt = db.prepare(`
  UPDATE chat_state SET
    cumulative_tokens_input       = cumulative_tokens_input + @ti,
    cumulative_tokens_output      = cumulative_tokens_output + @to,
    cumulative_tokens_reasoning   = cumulative_tokens_reasoning + @tr,
    cumulative_tokens_cache_read  = cumulative_tokens_cache_read + @tcr,
    cumulative_tokens_cache_write = cumulative_tokens_cache_write + @tcw,
    cumulative_cost_micros        = cumulative_cost_micros + @cm,
    updated_at                    = @now
  WHERE chat_id = @chatId
`);
this.resetCumulativeStatsStmt = db.prepare(`
  UPDATE chat_state SET
    cumulative_tokens_input = 0, cumulative_tokens_output = 0,
    cumulative_tokens_reasoning = 0, cumulative_tokens_cache_read = 0,
    cumulative_tokens_cache_write = 0, cumulative_cost_micros = 0,
    updated_at = ?
  WHERE chat_id = ?
`);
this.getContextLimitStmt = db.prepare("SELECT context_limit FROM chat_state WHERE chat_id = ?");
this.setContextLimitStmt = db.prepare(
  "UPDATE chat_state SET context_limit = ?, updated_at = ? WHERE chat_id = ?",
);
this.getSessionStartedAtStmt = db.prepare("SELECT session_started_at FROM chat_state WHERE chat_id = ?");
this.setSessionStartedAtStmt = db.prepare(
  "UPDATE chat_state SET session_started_at = ?, updated_at = ? WHERE chat_id = ?",
);
this.getLastDeployAtStmt = db.prepare("SELECT last_deploy_at FROM chat_state WHERE chat_id = ?");
this.setLastDeployAtStmt = db.prepare(
  "UPDATE chat_state SET last_deploy_at = ?, updated_at = ? WHERE chat_id = ?",
);
```

Add the public methods. Each `set*` calls `ensureRow(chatId)` first (existing pattern). Each `get*` returns `null` for missing rows (use `?? null` after the row destructure). `getCumulativeStats` returns `{ tokensInput: 0, ... }` for missing rows.

```typescript
getSessionSlug(chatId: number): string | null {
  const row = this.getSessionSlugStmt.get(chatId) as { session_slug: string | null } | undefined;
  return row?.session_slug ?? null;
}
setSessionSlug(chatId: number, slug: string | null): void {
  this.ensureRow(chatId);
  this.setSessionSlugStmt.run(slug, Date.now(), chatId);
}
// ... similar for branch, agent_mode, context_limit, session_started_at, last_deploy_at

getCumulativeStats(chatId: number): {
  tokensInput: number; tokensOutput: number; tokensReasoning: number;
  tokensCacheRead: number; tokensCacheWrite: number; costMicros: number;
} {
  const row = this.getCumulativeStatsStmt.get(chatId) as
    | { cumulative_tokens_input: number; cumulative_tokens_output: number;
        cumulative_tokens_reasoning: number; cumulative_tokens_cache_read: number;
        cumulative_tokens_cache_write: number; cumulative_cost_micros: number } | undefined;
  if (!row) return { tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: 0 };
  return {
    tokensInput: row.cumulative_tokens_input,
    tokensOutput: row.cumulative_tokens_output,
    tokensReasoning: row.cumulative_tokens_reasoning,
    tokensCacheRead: row.cumulative_tokens_cache_read,
    tokensCacheWrite: row.cumulative_tokens_cache_write,
    costMicros: row.cumulative_cost_micros,
  };
}
incrementCumulativeStats(chatId: number, delta: {
  tokensInput: number; tokensOutput: number; tokensReasoning: number;
  tokensCacheRead: number; tokensCacheWrite: number; costMicros: number;
}): void {
  this.ensureRow(chatId);
  this.incrementCumulativeStatsStmt.run({
    ti: delta.tokensInput, to: delta.tokensOutput, tr: delta.tokensReasoning,
    tcr: delta.tokensCacheRead, tcw: delta.tokensCacheWrite, cm: delta.costMicros,
    now: Date.now(), chatId,
  });
}
resetCumulativeStats(chatId: number): void {
  this.ensureRow(chatId);
  this.resetCumulativeStatsStmt.run(Date.now(), chatId);
}
```

- [ ] **Step 5: Run tests to verify green**

Run: `cd tg-bridge && npx vitest run`

Expected: 411 + 9 = 420 passing.

- [ ] **Step 6: Run typecheck**

Run: `cd tg-bridge && npm run typecheck` — exit 0.

- [ ] **Step 7: Commit**

```bash
git add tg-bridge/src/chat-state.ts tg-bridge/tests/chat-state.test.ts
git commit -m "chat-state: add info-density columns + accumulator methods

Adds 12 new nullable columns: session_slug, branch, agent_mode, 5
cumulative-token columns, cumulative_cost_micros (1e-6 USD), context_limit,
session_started_at, last_activity_at, last_deploy_at. Idempotent migration
via existing migrateSchema pattern.

New methods: get/setSessionSlug, get/setBranch, get/setAgentMode,
getCumulativeStats, incrementCumulativeStats (atomic UPDATE),
resetCumulativeStats (called on /new and /switch), get/setContextLimit,
get/setSessionStartedAt, get/setLastDeployAt."
```

---

## Task 2: branch-info.ts (live git inspection with caching)

**Files:**
- Create: `tg-bridge/src/branch-info.ts`
- Create: `tg-bridge/tests/branch-info.test.ts`

**Goal:** Two functions — `getCurrentBranch(path)` (cheap, used on every pinned flush) and `getGitInfo(path)` (richer, used by `/info`). Both cached per-project for 5s.

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/branch-info.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
```

- [ ] **Step 2: Run tests to verify red**

Run: `cd tg-bridge && npx vitest run tests/branch-info.test.ts`

Expected: module-not-found.

- [ ] **Step 3: Implement `branch-info.ts`**

Create `tg-bridge/src/branch-info.ts`:

```typescript
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
    runGit("git rev-list --count @{u}..HEAD", projectPath),  // commits we have that origin doesn't
    runGit("git rev-list --count HEAD..@{u}", projectPath),  // commits origin has that we don't
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
```

- [ ] **Step 4: Run tests + typecheck**

`cd tg-bridge && npx vitest run` (420 + 5 = 425) and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/branch-info.ts tg-bridge/tests/branch-info.test.ts
git commit -m "branch-info: live git inspection with 5s per-project cache

Two public functions: getCurrentBranch (cheap, used on every pinned
flush) and getGitInfo (richer, used by /info). Both share a 5s cache
keyed by projectPath so rapid pinned-flushes don't hammer the FS.

Shells \`git branch --show-current\`, \`git status --porcelain\`,
\`git rev-list --count\` for ahead/behind, \`git log -1\` for last
commit, \`git remote get-url origin\` for repo identity. All wrapped
with 3s exec timeout + try/catch returning null on failure.

Non-git directories return an empty GitInfo (null branch, zero counts);
pinned status renders \"\u2014\" for those fields rather than blocking."
```

---

## Task 3: cost-tracker.ts (token + cost aggregation)

**Files:**
- Create: `tg-bridge/src/cost-tracker.ts`
- Create: `tg-bridge/tests/cost-tracker.test.ts`

**Goal:** Track per-message cost + tokens contributing to chat_state cumulative counters. De-duplicate by message ID so multiple `message.created` events for the same ID don't double-count. Reset on `/new` or `/switch`.

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/cost-tracker.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../src/chat-state.js";
import { CostTracker } from "../src/cost-tracker.js";

let repo: ChatStateRepo;
let tracker: CostTracker;

beforeEach(() => {
  const db = new Database(":memory:");
  repo = new ChatStateRepo(db);
  tracker = new CostTracker(repo);
});

describe("CostTracker", () => {
  it("records assistant message tokens + cost into chat_state", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 0 } },
      cost: 0.0042,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(100);
    expect(stats.tokensOutput).toBe(50);
    expect(stats.tokensReasoning).toBe(10);
    expect(stats.tokensCacheRead).toBe(200);
    expect(stats.tokensCacheWrite).toBe(0);
    expect(stats.costMicros).toBe(4_200);
  });

  it("ignores duplicate message IDs (idempotent)", () => {
    const msg = {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    };
    tracker.recordAssistantMessage(1, msg);
    tracker.recordAssistantMessage(1, msg); // duplicate
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
  });

  it("treats different message IDs as separate", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    });
    tracker.recordAssistantMessage(1, {
      id: "msg_2",
      tokens: { input: 200, output: 75, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.002,
    });
    const stats = repo.getCumulativeStats(1);
    expect(stats.tokensInput).toBe(300);
    expect(stats.costMicros).toBe(3_000);
  });

  it("handles missing/null cost as 0", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: null as unknown as number, // simulating Anthropic Pro/Max OAuth
    });
    expect(repo.getCumulativeStats(1).costMicros).toBe(0);
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
  });

  it("handles missing tokens gracefully", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: undefined as unknown as { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
      cost: 0.001,
    });
    expect(repo.getCumulativeStats(1).tokensInput).toBe(0);
    expect(repo.getCumulativeStats(1).costMicros).toBe(1_000);
  });

  it("reset clears the seen-IDs cache and chat_state cumulative", () => {
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    });
    tracker.reset(1);
    expect(repo.getCumulativeStats(1).tokensInput).toBe(0);
    // After reset, the same msg_1 ID should be countable again
    tracker.recordAssistantMessage(1, {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    });
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
  });

  it("isolates seen-IDs across chats", () => {
    const msg = {
      id: "msg_1",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    };
    tracker.recordAssistantMessage(1, msg);
    tracker.recordAssistantMessage(2, msg); // different chat, same msg ID
    expect(repo.getCumulativeStats(1).tokensInput).toBe(100);
    expect(repo.getCumulativeStats(2).tokensInput).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to verify red**

`cd tg-bridge && npx vitest run tests/cost-tracker.test.ts` — expect module-not-found.

- [ ] **Step 3: Implement `cost-tracker.ts`**

Create `tg-bridge/src/cost-tracker.ts`:

```typescript
import type { ChatStateRepo } from "./chat-state.js";

export interface AssistantMessageInfo {
  id: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
}

export class CostTracker {
  /**
   * Per-chat seen-message IDs. opencode emits multiple message.created /
   * message.part.updated events for the same message ID; we only count once.
   * Cleared by reset() on /new and /switch.
   */
  private seenByChat = new Map<number, Set<string>>();

  constructor(private state: ChatStateRepo) {}

  recordAssistantMessage(chatId: number, info: AssistantMessageInfo): void {
    if (typeof info.id !== "string" || info.id.length === 0) return;
    let seen = this.seenByChat.get(chatId);
    if (!seen) {
      seen = new Set();
      this.seenByChat.set(chatId, seen);
    }
    if (seen.has(info.id)) return;
    seen.add(info.id);

    const tokens = info.tokens ?? {};
    const cache = tokens.cache ?? {};
    this.state.incrementCumulativeStats(chatId, {
      tokensInput: tokens.input ?? 0,
      tokensOutput: tokens.output ?? 0,
      tokensReasoning: tokens.reasoning ?? 0,
      tokensCacheRead: cache.read ?? 0,
      tokensCacheWrite: cache.write ?? 0,
      costMicros: typeof info.cost === "number" ? Math.round(info.cost * 1_000_000) : 0,
    });
  }

  reset(chatId: number): void {
    this.seenByChat.delete(chatId);
    this.state.resetCumulativeStats(chatId);
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

`cd tg-bridge && npx vitest run` (425 + 7 = 432) and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/cost-tracker.ts tg-bridge/tests/cost-tracker.test.ts
git commit -m "cost-tracker: aggregate per-message tokens + cost with dedup

opencode emits multiple events per message; this module dedupes by
info.id so we count once per assistant message. Multiplies cost (USD
float) by 1_000_000 to store as integer micros (avoids float drift on
incremental sum). reset(chatId) is called on /new and /switch to
clear both the in-memory seen-IDs set and the chat_state cumulative
counters."
```

---

## Tasks 4–10 (overview)

The remaining tasks follow the same TDD pattern. Briefer outlines below; code samples will be provided to the implementer subagent in dispatch text.

**Task 4: opencode-client widening**
- Widen `Session` shape exposed by `BridgeOpencodeClient` to include `slug?: string` and `time?: { created: number; updated: number }`
- Add `getModelContextLimit(providerId, modelId): Promise<number | null>` — calls `/provider`, extracts `providers.<id>.models.<id>.limit.context`
- Update tests; existing tests provide mock clients that need their stubs widened (~6 fixture updates expected)

**Task 5: format.ts — pinned + streaming header**
- New `renderPinnedStatus(state, info)` produces 5-line HTML status; takes `{ projectName, branch, agentMode, model, tokensUsed, contextLimit, costMicros, coolifyFqdn, lastDeployAgo, ahead, behind }`
- New `renderStreamingHeader({ model, agentMode, tokensCumulative, costThisTurnMicros })` produces single-line MarkdownV2; returns `""` if no token info
- ~6 unit tests per renderer

**Task 6: pinned-status.ts — wire new render + buttons**
- Replace existing render call with new `renderPinnedStatus`
- New button row: `[Sessions] [Model] [Deploy] [Info]`
- Add `pin:info` callback route
- Existing 9 pinned-status tests need adjustment; ~3 new tests for new fields

**Task 7: Wire cost-tracker + slug + agent_mode + branch into handlers**
- `message-handler.ts`, `project-creator.ts`, `commands/deploy.ts`: each registers an `onMessageCreated` handler that:
  - When `info.role === "user"` → existing user-ID tracking (unchanged)
  - When `info.role === "assistant"` AND `info.tokens` present → `costTracker.recordAssistantMessage(chatId, info)` + `state.setAgentMode(chatId, info.agent ?? "build")` + `state.setLastActivityAt(chatId, Date.now())`
- `commands/switch.ts`, `new.ts`, `init.ts`, `init-remote.ts`, `clone.ts`: capture session slug + started_at on createSession + reset CostTracker
- `commands/deploy.ts`: bump `last_deploy_at` on success
- Pinned-flush triggers `getCurrentBranch` to refresh chat_state.branch
- index.ts wires `costTracker = new CostTracker(state)`; passes via deps
- ~5 new test cases across handler tests; existing tests stay green

**Task 8: /info command + tests**
- `commands/info.ts` aggregates everything: `chat_state.get*`, `branch-info.getGitInfo`, optional `client.getSession(sessionId)` for fresh session info, optional `client.getModelContextLimit` if cached value missing
- Renders HTML following the spec's mockup
- Sections gated on data presence
- Wired into `index.ts` + `setMyCommands` + help.ts
- ~5 unit tests covering: full-state render, missing-Coolify section, non-git directory, missing slug fallback, missing context limit

**Task 9: setMyCommands + help text**
- Add `/info` to the command list in `index.ts:registerCommands`
- Add `/info` line to `commands/help.ts` RAW
- Update `tests/commands/help.test.ts` for-loop
- No new files

**Task 10: Build + push + deploy + smoke verify**
- Local: `cd tg-bridge && npm run build && npx vitest run && npm run typecheck`
- Push to origin
- SSH deploy: `cd /opt/opencode-telegram/repo && git pull && cd tg-bridge && npm run build && systemctl restart tg-bridge`
- Verify systemctl active + journalctl clean
- USER smoke test (Telegram)

---

## Self-Review

### Spec coverage
- ✅ Pinned redesign (Task 5/6)
- ✅ Streaming header (Task 5/7)
- ✅ /info command (Task 8)
- ✅ Session slug everywhere (Task 4 + 6 + 7 + 8)
- ✅ Branch detection + display (Task 2 + 5 + 7 + 8)
- ✅ Token + cost cumulative tracking (Task 3 + 7)
- ✅ Schema migration (Task 1)
- ✅ No new git/PR commands (intentional)

### Placeholder scan
None. Each task has concrete code or concrete prose summarizing what code goes where.

### Type consistency
- `GitInfo` (Task 2) consumed by Task 5 + 8 — same shape
- `AssistantMessageInfo` (Task 3) consumed by Task 7 — same shape
- `CumulativeStats` returned by `getCumulativeStats` (Task 1) consumed by Tasks 5/8 — same shape
- `CostTracker` constructor signature stable across Tasks 3 + 7

### Estimated test count delta

| Task | Tests added | Cumulative |
|---|---|---|
| baseline | — | 411 |
| Task 1 | +9 | 420 |
| Task 2 | +5 | 425 |
| Task 3 | +7 | 432 |
| Task 4 | +3 | 435 |
| Task 5 | +12 (6 pinned + 6 streaming) | 447 |
| Task 6 | +3 | 450 |
| Task 7 | +5 | 455 |
| Task 8 | +5 | 460 |
| Task 9 | 0 | 460 |
| **Final** | | **~460** |
