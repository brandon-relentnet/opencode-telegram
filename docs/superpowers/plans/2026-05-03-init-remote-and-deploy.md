# `/init-remote` + `/deploy` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two Telegram commands that take a project from idea to deployed: `/init-remote <name>` creates a local project + private GitHub repo + initial push; `/deploy` creates-or-updates a Coolify application that auto-deploys on push.

**Architecture:** Agent-driven via the existing `createProject` orchestrator. Bridge sends deterministic shell prompts; agent runs `gh` + `git` + `curl` + `jq` in the opencode container. Secrets (GH_TOKEN, COOLIFY_TOKEN) live in opencode container env and are referenced as shell variables in prompts (never embedded as literals). Per-project Coolify app UUID stored in a new `coolify_app` table, keyed by `(chat_id, project_path)`.

**Tech Stack:** TypeScript (Node 22, ESM, strict), grammy, vitest, pino, better-sqlite3. Coolify v4 REST API. GitHub CLI (`gh`).

**Spec:** `docs/superpowers/specs/2026-05-03-init-remote-and-deploy-design.md`

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `tg-bridge/src/chat-state.ts` | Modify | Add `coolify_app(chat_id, project_path) → uuid, fqdn` table + `setCoolifyApp` / `getCoolifyApp` methods |
| `tg-bridge/src/config.ts` | Modify | Add optional env-var fields: `ghToken`, `ghOwner`, `coolifyUrl`, `coolifyToken`, `coolifyServerUuid`, `coolifyProjectUuid`, `coolifyGithubAppUuid` |
| `tg-bridge/src/project-creator.ts` | Modify | Extend `CreationKind` with `"init-remote"`, add `buildInitRemotePrompt`, extend `detectSuccess` marker map |
| `tg-bridge/src/commands/init-remote.ts` | Create | Validate name + dir + GH_TOKEN env → dispatch `createProject` with kind `"init-remote"` |
| `tg-bridge/src/commands/deploy.ts` | Create | Validate project + COOLIFY_* env → branch first-vs-subsequent → dispatch agent → parse marker → persist |
| `tg-bridge/src/commands/help.ts` | Modify | Add `/init-remote` + `/deploy` lines |
| `tg-bridge/src/index.ts` | Modify | Register both new commands; pass coolifyConfig + ghOwner |
| `tg-bridge/tests/chat-state.test.ts` | Modify | Tests for new methods + table migration |
| `tg-bridge/tests/config.test.ts` | Modify | Tests for new optional env-var fields |
| `tg-bridge/tests/project-creator.test.ts` | Modify | Tests for `buildInitRemotePrompt` + `detectSuccess(init-remote)` |
| `tg-bridge/tests/commands/init-remote.test.ts` | Create | Validation + dispatch tests |
| `tg-bridge/tests/commands/deploy.test.ts` | Create | Validation + first-deploy + subsequent-deploy + parse helper tests |
| `tg-bridge/tests/commands/help.test.ts` | Modify | Add `/init-remote` + `/deploy` to for-loop |
| `opencode-image/Dockerfile` | Modify | Add `gh` + `jq` apt install |
| `deploy/.env.example` | Modify | Document GH_TOKEN, GH_OWNER, COOLIFY_* env vars |
| `deploy/compose.yaml` | Modify | Pass new env vars through to BOTH bridge AND opencode containers |
| `BOOTSTRAP.md` | Modify | One-time Coolify GitHub App + tokens setup section |

**Total:** 6 new files + 11 modified.

---

## Task 1: chat-state — `coolify_app` table + repo methods

**Files:**
- Modify: `tg-bridge/src/chat-state.ts`
- Modify: `tg-bridge/tests/chat-state.test.ts`

**Goal:** Add a separate `coolify_app(chat_id, project_path) → uuid, fqdn` table so multiple projects per chat track their own Coolify app UUIDs independently.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/chat-state.test.ts`:

```typescript
describe("ChatStateRepo coolify_app", () => {
  it("returns null when no coolify app set for (chat, project)", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getCoolifyApp(1, "/workspace/x")).toBeNull();
  });

  it("setCoolifyApp + getCoolifyApp roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setCoolifyApp(1, "/workspace/site", "abc-123", "site.example.com");
    expect(repo.getCoolifyApp(1, "/workspace/site")).toEqual({
      uuid: "abc-123",
      fqdn: "site.example.com",
    });
  });

  it("setCoolifyApp upserts on duplicate (chat, project)", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setCoolifyApp(1, "/workspace/site", "old-uuid", "old.example.com");
    repo.setCoolifyApp(1, "/workspace/site", "new-uuid", "new.example.com");
    expect(repo.getCoolifyApp(1, "/workspace/site")).toEqual({
      uuid: "new-uuid",
      fqdn: "new.example.com",
    });
  });

  it("isolates state across (chat, project) tuples", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setCoolifyApp(1, "/workspace/a", "uuid-a", "a.example.com");
    repo.setCoolifyApp(1, "/workspace/b", "uuid-b", "b.example.com");
    repo.setCoolifyApp(2, "/workspace/a", "uuid-c", "c.example.com");
    expect(repo.getCoolifyApp(1, "/workspace/a")).toEqual({ uuid: "uuid-a", fqdn: "a.example.com" });
    expect(repo.getCoolifyApp(1, "/workspace/b")).toEqual({ uuid: "uuid-b", fqdn: "b.example.com" });
    expect(repo.getCoolifyApp(2, "/workspace/a")).toEqual({ uuid: "uuid-c", fqdn: "c.example.com" });
  });

  it("creates the coolify_app table on construction (idempotent)", () => {
    const db = new Database(":memory:");
    new ChatStateRepo(db);
    new ChatStateRepo(db); // second construction must not throw
    const cols = db.prepare("PRAGMA table_info(coolify_app)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("chat_id")).toBe(true);
    expect(names.has("project_path")).toBe(true);
    expect(names.has("app_uuid")).toBe(true);
    expect(names.has("fqdn")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/chat-state.test.ts`

Expected: 5 new tests fail with "getCoolifyApp is not a function" / "setCoolifyApp is not a function".

- [ ] **Step 3: Implement the table + methods**

Edit `tg-bridge/src/chat-state.ts`. Update the `SCHEMA` constant to include the new table:

```typescript
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_state (
    chat_id      INTEGER PRIMARY KEY,
    project_path TEXT,
    session_id   TEXT,
    model        TEXT,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS coolify_app (
    chat_id      INTEGER NOT NULL,
    project_path TEXT NOT NULL,
    app_uuid     TEXT NOT NULL,
    fqdn         TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (chat_id, project_path)
  );
`;
```

Add two prepared statements to the `ChatStateRepo` constructor (after the existing ones):

```typescript
  private getCoolifyAppStmt: Database.Statement<[number, string]>;
  private upsertCoolifyAppStmt: Database.Statement;
```

In the constructor body (after `this.deleteStmt = ...`):

```typescript
    this.getCoolifyAppStmt = db.prepare(
      "SELECT app_uuid, fqdn FROM coolify_app WHERE chat_id = ? AND project_path = ?",
    );
    this.upsertCoolifyAppStmt = db.prepare(`
      INSERT INTO coolify_app (chat_id, project_path, app_uuid, fqdn, updated_at)
      VALUES (@chatId, @projectPath, @appUuid, @fqdn, @now)
      ON CONFLICT(chat_id, project_path) DO UPDATE SET
        app_uuid   = excluded.app_uuid,
        fqdn       = excluded.fqdn,
        updated_at = excluded.updated_at
    `);
```

Add two public methods (after `clear`):

```typescript
  /**
   * Look up the Coolify application UUID + FQDN previously set for this
   * (chat, project) pair. Returns null if /deploy has never been run for
   * this combination.
   */
  getCoolifyApp(chatId: number, projectPath: string): { uuid: string; fqdn: string } | null {
    const row = this.getCoolifyAppStmt.get(chatId, projectPath) as
      | { app_uuid: string; fqdn: string }
      | undefined;
    return row ? { uuid: row.app_uuid, fqdn: row.fqdn } : null;
  }

  /**
   * Persist the Coolify app UUID + FQDN for this (chat, project) pair.
   * Used by /deploy after first-deploy succeeds. Idempotent on re-run
   * via UPSERT.
   */
  setCoolifyApp(chatId: number, projectPath: string, appUuid: string, fqdn: string): void {
    this.upsertCoolifyAppStmt.run({
      chatId,
      projectPath,
      appUuid,
      fqdn,
      now: Date.now(),
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tg-bridge && npx vitest run`

Expected: 5 new tests pass; all 262 prior tests still pass.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/chat-state.ts tg-bridge/tests/chat-state.test.ts
git commit -m "chat-state: add coolify_app table + setCoolifyApp/getCoolifyApp

A new table keyed by (chat_id, project_path) tracks Coolify app UUIDs
per (chat, project) so multiple projects in the same chat each remember
their own deploy target. /deploy will write here on first deploy and
read here to decide first-vs-subsequent flow."
```

---

## Task 2: config — add optional GH + Coolify env vars

**Files:**
- Modify: `tg-bridge/src/config.ts`
- Modify: `tg-bridge/tests/config.test.ts`

**Goal:** Bridge knows whether each integration is configured. Required validation lives in commands (so users without Coolify can still use /init etc.); config just makes presence reachable.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/config.test.ts`:

```typescript
describe("loadConfig optional integration env vars", () => {
  const minEnv = {
    TELEGRAM_BOT_TOKEN: "tok",
    TELEGRAM_ALLOWED_USER_IDS: "1",
    OPENCODE_PASSWORD: "pw",
  };

  it("ghToken/ghOwner/coolify* default to undefined when not set", () => {
    const cfg = loadConfig(minEnv);
    expect(cfg.ghToken).toBeUndefined();
    expect(cfg.ghOwner).toBeUndefined();
    expect(cfg.coolifyUrl).toBeUndefined();
    expect(cfg.coolifyToken).toBeUndefined();
    expect(cfg.coolifyServerUuid).toBeUndefined();
    expect(cfg.coolifyProjectUuid).toBeUndefined();
    expect(cfg.coolifyGithubAppUuid).toBeUndefined();
  });

  it("populates ghToken / ghOwner when set", () => {
    const cfg = loadConfig({ ...minEnv, GH_TOKEN: "ghp_abc", GH_OWNER: "brandon" });
    expect(cfg.ghToken).toBe("ghp_abc");
    expect(cfg.ghOwner).toBe("brandon");
  });

  it("populates all coolify fields when set", () => {
    const cfg = loadConfig({
      ...minEnv,
      COOLIFY_URL: "https://coolify.example.com",
      COOLIFY_TOKEN: "ct_abc",
      COOLIFY_SERVER_UUID: "srv-1",
      COOLIFY_PROJECT_UUID: "prj-1",
      COOLIFY_GITHUB_APP_UUID: "gha-1",
    });
    expect(cfg.coolifyUrl).toBe("https://coolify.example.com");
    expect(cfg.coolifyToken).toBe("ct_abc");
    expect(cfg.coolifyServerUuid).toBe("srv-1");
    expect(cfg.coolifyProjectUuid).toBe("prj-1");
    expect(cfg.coolifyGithubAppUuid).toBe("gha-1");
  });

  it("rejects invalid COOLIFY_URL", () => {
    expect(() =>
      loadConfig({ ...minEnv, COOLIFY_URL: "not a url" }),
    ).toThrow(/COOLIFY_URL/);
  });

  it("trims whitespace on the new scalars", () => {
    const cfg = loadConfig({
      ...minEnv,
      GH_TOKEN: "  ghp_abc  ",
      COOLIFY_TOKEN: "  ct  ",
    });
    expect(cfg.ghToken).toBe("ghp_abc");
    expect(cfg.coolifyToken).toBe("ct");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/config.test.ts`

Expected: 5 new tests fail (`cfg.ghToken` is undefined because the field doesn't exist on the Config interface yet — TS will compile but the assertions for the populated cases will fail).

- [ ] **Step 3: Implement schema + interface additions**

Edit `tg-bridge/src/config.ts`. Extend the `Schema`:

```typescript
const optionalTrimmed = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1))
  .optional();

const Schema = z.object({
  // ... existing fields unchanged ...
  TELEGRAM_BOT_TOKEN: trimmedNonEmpty("TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: userIdList,
  OPENCODE_URL: z.string().url().default("http://opencode:4096"),
  OPENCODE_USERNAME: trimmedNonEmpty("OPENCODE_USERNAME is required").default("opencode"),
  OPENCODE_PASSWORD: trimmedNonEmpty("OPENCODE_PASSWORD is required"),
  WORKSPACE_ROOT: z.string().min(1).default("/workspace"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DEFAULT_MODEL: modelId.default("anthropic/claude-sonnet-4-5"),
  // GitHub integration (used by /init-remote)
  GH_TOKEN: optionalTrimmed,
  GH_OWNER: optionalTrimmed,
  // Coolify integration (used by /deploy)
  COOLIFY_URL: z.string().url().optional(),
  COOLIFY_TOKEN: optionalTrimmed,
  COOLIFY_SERVER_UUID: optionalTrimmed,
  COOLIFY_PROJECT_UUID: optionalTrimmed,
  COOLIFY_GITHUB_APP_UUID: optionalTrimmed,
});
```

Extend the `Config` interface:

```typescript
export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
  workspaceRoot: string;
  logLevel: LogLevel;
  defaultModel: string;
  // Optional integration fields. Commands gate on presence at invocation time.
  ghToken: string | undefined;
  ghOwner: string | undefined;
  coolifyUrl: string | undefined;
  coolifyToken: string | undefined;
  coolifyServerUuid: string | undefined;
  coolifyProjectUuid: string | undefined;
  coolifyGithubAppUuid: string | undefined;
}
```

Update the return mapping in `loadConfig`:

```typescript
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedUserIds: parsed.TELEGRAM_ALLOWED_USER_IDS,
    opencodeUrl: parsed.OPENCODE_URL,
    opencodeUsername: parsed.OPENCODE_USERNAME,
    opencodePassword: parsed.OPENCODE_PASSWORD,
    workspaceRoot: parsed.WORKSPACE_ROOT,
    logLevel: parsed.LOG_LEVEL,
    defaultModel: parsed.DEFAULT_MODEL,
    ghToken: parsed.GH_TOKEN,
    ghOwner: parsed.GH_OWNER,
    coolifyUrl: parsed.COOLIFY_URL,
    coolifyToken: parsed.COOLIFY_TOKEN,
    coolifyServerUuid: parsed.COOLIFY_SERVER_UUID,
    coolifyProjectUuid: parsed.COOLIFY_PROJECT_UUID,
    coolifyGithubAppUuid: parsed.COOLIFY_GITHUB_APP_UUID,
  };
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: 267 + 5 = 272 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/config.ts tg-bridge/tests/config.test.ts
git commit -m "config: add optional GH_TOKEN/GH_OWNER + COOLIFY_* env vars

Bridge surfaces these as optional Config fields so /init-remote and
/deploy can validate at invocation time. Users without Coolify keep
using /init etc. without errors. COOLIFY_URL is URL-validated; the
others are trimmed strings."
```

---

## Task 3: project-creator — extend for `init-remote` kind

**Files:**
- Modify: `tg-bridge/src/project-creator.ts`
- Modify: `tg-bridge/tests/project-creator.test.ts`

**Goal:** `createProject({ kind: "init-remote", ... })` works exactly like `init` and `clone`, dispatching a deterministic shell prompt that ends with `remote_initialized` or `failed:`.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/project-creator.test.ts`:

```typescript
describe("buildInitRemotePrompt", () => {
  it("references the project name and owner", () => {
    const out = buildInitRemotePrompt("new-site", "brandon");
    expect(out).toContain("/workspace/new-site");
    expect(out).toContain("gh repo create brandon/new-site");
  });

  it("creates the dir + git init + initial commit + gh push in a single bash block", () => {
    const out = buildInitRemotePrompt("x", "owner");
    expect(out).toContain("mkdir -p /workspace/x");
    expect(out).toContain("git init");
    expect(out).toContain("git add README.md && git commit -m");
    expect(out).toContain("--private --source=. --remote=origin --push");
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
```

Add `buildInitRemotePrompt` to the existing import line at the top of the file:

```typescript
import {
  buildClonePrompt,
  buildInitPrompt,
  buildInitRemotePrompt,
  detectSuccess,
  type CreationKind,
  type MaybeTextPart,
} from "../src/project-creator.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/project-creator.test.ts`

Expected: 7 new tests fail (`buildInitRemotePrompt is not a function`).

- [ ] **Step 3: Implement the changes**

Edit `tg-bridge/src/project-creator.ts`. Update `CreationKind`:

```typescript
export type CreationKind = "clone" | "init" | "init-remote";
```

Add `buildInitRemotePrompt` after `buildInitPrompt` (around line 62):

```typescript
/**
 * Build the deterministic prompt sent to opencode for an /init-remote command.
 *
 * Runs the full create-local-+-create-remote-+-push sequence in a single bash
 * invocation so the agent can't fork into multiple commands. `gh` reads
 * GH_TOKEN from its environment automatically — no embedded token needed.
 */
export function buildInitRemotePrompt(name: string, owner: string): string {
  return [
    "Run exactly this single bash command and report only the result. Do not run any other commands. Do not summarize or explore the new repository.",
    "",
    "```bash",
    `set -e`,
    `mkdir -p /workspace/${name}`,
    `cd /workspace/${name}`,
    `git init`,
    `echo "# ${name}" > README.md`,
    `git add README.md && git commit -m "Initial commit"`,
    `gh repo create ${owner}/${name} --private --source=. --remote=origin --push`,
    "```",
    "",
    "If every command succeeds, reply with the single word: remote_initialized",
    "",
    "If any command fails, reply with: failed: <one-sentence summary of the error>",
  ].join("\n");
}
```

Update `createProject`'s prompt selection (around line 149-152):

```typescript
  // Build the prompt for this kind.
  const prompt =
    args.kind === "clone"
      ? buildClonePrompt(args.url!, args.name)
      : args.kind === "init-remote"
      ? buildInitRemotePrompt(args.name, args.owner ?? "")
      : buildInitPrompt(args.name);
```

Update `CreateProjectArgs` (around line 95-103):

```typescript
export interface CreateProjectArgs {
  chatId: number;
  placeholderId: number;
  name: string;
  kind: CreationKind;
  /** Required when kind === "clone". */
  url?: string;
  /** Required when kind === "init-remote". GitHub owner namespace. */
  owner?: string;
  workspaceRoot: string;
}
```

Update the early-validation block in `createProject` (around line 134-136):

```typescript
  if (args.kind === "clone" && !args.url) {
    throw new Error("createProject: kind=clone requires a url argument");
  }
  if (args.kind === "init-remote" && !args.owner) {
    throw new Error("createProject: kind=init-remote requires an owner argument");
  }
```

Update `detectSuccess`'s marker selection (around line 90-92):

```typescript
  // Match the marker as a contained word, so verbose replies like
  // "Successfully initialized the directory" also match.
  const marker =
    kind === "clone"
      ? /\bcloned\b/i
      : kind === "init-remote"
      ? /\bremote_initialized\b/i
      : /\binitialized\b/i;
  return marker.test(last);
```

Note: the order matters — `init-remote` MUST match before `init` since `\binitialized\b` would also fire on "remote_initialized" because of the underscore (which is a `\w` character, so `\b` is between `_` and `i`, NOT inside the underscore). Actually `\binitialized\b` would NOT match "remote_initialized" because `_` is a word char (so `\b` is at the START of "remote", not at "initialized"). But just to be safe, we test `init-remote` first.

Update the session title generation in `createProject` (around line 143):

```typescript
  const sessionTitle = `tg:${args.kind}:${args.name}`;
```

(Already uses `args.kind` — no change needed; just confirming `tg:init-remote:<name>` will be the title.)

- [ ] **Step 4: Run tests + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: 272 + 7 = 279 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/project-creator.ts tg-bridge/tests/project-creator.test.ts
git commit -m "project-creator: support kind='init-remote' for /init-remote command

Adds buildInitRemotePrompt (single bash block: mkdir + git init +
README + commit + gh repo create --push) and the marker
\\\\bremote_initialized\\\\b in detectSuccess. CreateProjectArgs gains
optional 'owner' field, validated when kind='init-remote'."
```

---

## Task 4: `/init-remote` command

**Files:**
- Create: `tg-bridge/src/commands/init-remote.ts`
- Create: `tg-bridge/tests/commands/init-remote.test.ts`

**Goal:** Validate args + env, dispatch `createProject({ kind: "init-remote", ... })`. Mirrors `commands/init.ts` precisely.

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/commands/init-remote.test.ts`:

```typescript
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
    state: {} as never,
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

  it("replies with friendly error when ghToken is undefined", async () => {
    const ctx = makeFakeCtx("ok");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps({ ghToken: undefined }));
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/GH_TOKEN/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("replies with friendly error when ghOwner is undefined", async () => {
    const ctx = makeFakeCtx("ok");
    const createSpy = vi.spyOn(projectCreator, "createProject").mockResolvedValue();
    await handleInitRemote(ctx as never, makeDeps({ ghOwner: undefined }));
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/GH_OWNER/);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/commands/init-remote.test.ts`

Expected: tests fail with "Failed to load url ../../src/commands/init-remote.js".

- [ ] **Step 3: Create the command handler**

Create `tg-bridge/src/commands/init-remote.ts`:

```typescript
import type { Context } from "grammy";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import { isSafeProjectName } from "./switch.js";
import { createProject } from "../project-creator.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { SessionEventHandler } from "../event-router.js";
import type { TurnBot } from "../turn.js";
import type { Logger } from "pino";

export interface InitRemoteDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
    ensureDirectory(directory: string): boolean;
  };
  bot: TurnBot;
  workspaceRoot: string;
  defaultModel: string;
  ghToken: string | undefined;
  ghOwner: string | undefined;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export async function handleInitRemote(ctx: Context, deps: InitRemoteDeps): Promise<void> {
  try {
    const name = ((ctx.match as string | undefined) ?? "").trim();

    if (name.length === 0) {
      await ctx.reply(escapeMarkdownV2("Usage: /init-remote <name>"), {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    if (!isSafeProjectName(name)) {
      await ctx.reply(escapeMarkdownV2("Invalid project name."), {
        parse_mode: "MarkdownV2",
      });
      return;
    }

    if (!deps.ghToken) {
      await ctx.reply(
        escapeMarkdownV2(
          "GH_TOKEN is not set on the bridge. Set it in deploy/.env so /init-remote can create GitHub repos.",
        ),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    if (!deps.ghOwner) {
      await ctx.reply(
        escapeMarkdownV2(
          "GH_OWNER is not set on the bridge. Set it to your GitHub username (or org) in deploy/.env.",
        ),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const projectPath = join(deps.workspaceRoot, name);
    if (existsSync(projectPath)) {
      await ctx.reply(
        escapeMarkdownV2(
          `Project '${name}' already exists. Use /switch ${name} or pick a different name.`,
        ),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const placeholder = await ctx.reply(
      escapeMarkdownV2(`creating ${name} + remote repo…`),
      { parse_mode: "MarkdownV2" },
    );
    const placeholderId =
      typeof (placeholder as { message_id?: number }).message_id === "number"
        ? (placeholder as { message_id: number }).message_id
        : 0;

    await createProject(
      {
        chatId: ctx.chat!.id,
        placeholderId,
        name,
        kind: "init-remote",
        owner: deps.ghOwner,
        workspaceRoot: deps.workspaceRoot,
      },
      {
        client: deps.client,
        state: deps.state,
        router: deps.router,
        bot: deps.bot,
        defaultModel: deps.defaultModel,
        ...(deps.log ? { log: deps.log } : {}),
      },
    );
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ /init-remote failed: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: 279 + 6 = 285 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/commands/init-remote.ts tg-bridge/tests/commands/init-remote.test.ts
git commit -m "Add /init-remote command (project + private GitHub repo + push)

Mirrors /init's validation pipeline (safe name + dir doesn't exist) +
adds GH_TOKEN and GH_OWNER presence checks. Dispatches createProject
with kind='init-remote' so the agent runs the deterministic shell
sequence: mkdir + git init + commit + gh repo create --push. On
success createProject auto-switches the chat to the new project."
```

---

## Task 5: `/deploy` command (first + subsequent paths)

**Files:**
- Create: `tg-bridge/src/commands/deploy.ts`
- Create: `tg-bridge/tests/commands/deploy.test.ts`

**Goal:** Read chat state, branch on coolify_app presence, dispatch the right prompt, parse `deployed:UUID:FQDN` or `deployed`, persist UUID on first deploy, render final message with the deploy URL.

The deploy command does NOT use `createProject` because:
- It needs to anchor the agent session at the project directory (not workspace root)
- Its success-marker shapes are different (two distinct success markers)
- It needs to PARSE the marker (extract UUID + FQDN from first-deploy reply)
- It needs to PERSIST the parsed values

So we build a parallel orchestrator inline. It reuses `Turn`, `safeEdit`, `EventRouter`, but with a custom `SessionEventHandler` and reply parser.

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/commands/deploy.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDeploy, parseDeployReply, buildFirstDeployPrompt, buildSubsequentDeployPrompt } from "../../src/commands/deploy.js";

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
  let captured: { id: string; handler: import("../../src/event-router.js").SessionEventHandler } | undefined;
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
    expect(prompt).toContain('Bearer $COOLIFY_TOKEN');
    expect(prompt).toContain('"project_uuid": "$COOLIFY_PROJECT_UUID"');
    expect(prompt).toContain('"server_uuid": "$COOLIFY_SERVER_UUID"');
    expect(prompt).toContain('"github_app_uuid": "$COOLIFY_GITHUB_APP_UUID"');
    expect(prompt).toContain('"build_pack": "nixpacks"');
    expect(prompt).toContain('"ports_exposes": "3000"');
    expect(prompt).toContain('echo "deployed:$APP_UUID:$FQDN"');
    expect(prompt).toMatch(/failed:/);
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
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/COOLIFY_URL/);
  });

  it("replies with friendly error when COOLIFY_TOKEN is missing", async () => {
    const ctx = makeFakeCtx();
    const deps = {
      ...baseDeps(),
      coolifyConfig: { ...baseDeps().coolifyConfig, token: undefined as unknown as string },
    };
    await handleDeploy(ctx as never, deps);
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/COOLIFY_TOKEN/);
  });
});

describe("handleDeploy first-deploy path", () => {
  it("dispatches buildFirstDeployPrompt when no coolify_app saved", async () => {
    const ctx = makeFakeCtx();
    const deps = baseDeps();
    deps.state = makeStateWithProject(null) as never;
    await handleDeploy(ctx as never, deps);
    const promptCalls = (deps.client as ReturnType<typeof makeClient>).prompt.mock.calls;
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
    // Simulate the agent's reply: register the parts, then fire onIdle.
    const handler = router.captured()?.handler;
    expect(handler).toBeDefined();
    handler?.onPartUpdated({ id: "p1", type: "text", text: "deployed:abc-123:site.example.com" });
    await handler?.onIdle();
    // Bridge should persist UUID + FQDN
    const setSpy = (deps.state as ReturnType<typeof makeStateWithProject>).setCoolifyApp;
    expect(setSpy).toHaveBeenCalledWith(100, "/workspace/site", "abc-123", "site.example.com");
    // Bridge should edit placeholder with the deploy URL
    const bot = deps.bot as ReturnType<typeof makeBot>;
    const lastEdit = bot.edits[bot.edits.length - 1];
    expect(String(lastEdit?.[2])).toMatch(/site\\?\.example\\?\.com/);
  });
});

describe("handleDeploy subsequent-deploy path", () => {
  it("dispatches buildSubsequentDeployPrompt when coolify_app already saved", async () => {
    const ctx = makeFakeCtx();
    const deps = baseDeps();
    deps.state = makeStateWithProject({ uuid: "existing-uuid", fqdn: "existing.example.com" }) as never;
    await handleDeploy(ctx as never, deps);
    const promptCalls = (deps.client as ReturnType<typeof makeClient>).prompt.mock.calls;
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/commands/deploy.test.ts`

Expected: tests fail with "Failed to load url ../../src/commands/deploy.js".

- [ ] **Step 3: Create the command handler**

Create `tg-bridge/src/commands/deploy.ts`:

```typescript
import type { Context } from "grammy";
import type { Logger } from "pino";
import { escapeMarkdownV2 } from "../format.js";
import { describeError } from "../errors.js";
import { safeEdit } from "../safe-telegram.js";
import { Turn, type IncomingPart, type TurnBot } from "../turn.js";
import { parseModelId } from "../config.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { SessionEventHandler } from "../event-router.js";

export interface CoolifyConfig {
  url: string | undefined;
  token: string | undefined;
  serverUuid: string | undefined;
  projectUuid: string | undefined;
  githubAppUuid: string | undefined;
}

export interface DeployDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
    ensureDirectory(directory: string): boolean;
  };
  bot: TurnBot;
  workspaceRoot: string;
  defaultModel: string;
  coolifyConfig: CoolifyConfig;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

/** Build the deterministic prompt for first-time deploy of a project. */
export function buildFirstDeployPrompt(projectPath: string): string {
  return [
    "Run exactly this single bash command and report only the result. Do not run other commands. Do not retry on failure.",
    "",
    "```bash",
    `set -e`,
    `cd ${projectPath}`,
    `REPO_URL=$(git remote get-url origin)`,
    `git add -A`,
    `git diff --cached --quiet || git commit -m "Updates from Telegram session"`,
    `git push origin main`,
    `RESP=$(curl -sf -X POST "$COOLIFY_URL/api/v1/applications/private-github-app" \\`,
    `  -H "Authorization: Bearer $COOLIFY_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "{`,
    `    \\"project_uuid\\": \\"$COOLIFY_PROJECT_UUID\\",`,
    `    \\"server_uuid\\": \\"$COOLIFY_SERVER_UUID\\",`,
    `    \\"environment_name\\": \\"production\\",`,
    `    \\"github_app_uuid\\": \\"$COOLIFY_GITHUB_APP_UUID\\",`,
    `    \\"git_repository\\": \\"$REPO_URL\\",`,
    `    \\"git_branch\\": \\"main\\",`,
    `    \\"build_pack\\": \\"nixpacks\\",`,
    `    \\"ports_exposes\\": \\"3000\\",`,
    `    \\"instant_deploy\\": true`,
    `  }")`,
    `APP_UUID=$(echo "$RESP" | jq -r '.uuid // empty')`,
    `FQDN=$(echo "$RESP" | jq -r '.fqdn // empty')`,
    `if [ -z "$APP_UUID" ] || [ -z "$FQDN" ]; then`,
    `  echo "Coolify response missing uuid or fqdn: $RESP" >&2`,
    `  exit 1`,
    `fi`,
    `echo "deployed:$APP_UUID:$FQDN"`,
    "```",
    "",
    "On success, reply with the line printed by the script (deployed:UUID:FQDN).",
    "",
    "On failure, reply with: failed: <one-line summary of the failing command>",
  ].join("\n");
}

/** Build the deterministic prompt for subsequent deploy (app already exists). */
export function buildSubsequentDeployPrompt(projectPath: string, appUuid: string): string {
  return [
    "Run exactly this single bash command and report only the result. Do not run other commands. Do not retry on failure.",
    "",
    "```bash",
    `set -e`,
    `cd ${projectPath}`,
    `git add -A`,
    `git diff --cached --quiet || git commit -m "Updates from Telegram session"`,
    `git push origin main`,
    `# Coolify auto-deploys on push via webhook; this guarantees a build even with no commits.`,
    `curl -sf -X GET "$COOLIFY_URL/api/v1/deploy?uuid=${appUuid}" -H "Authorization: Bearer $COOLIFY_TOKEN"`,
    `echo "deployed"`,
    "```",
    "",
    "On success, reply with the single word: deployed",
    "",
    "On failure, reply with: failed: <one-line summary of the failing command>",
  ].join("\n");
}

export type DeployReply =
  | { kind: "first"; uuid: string; fqdn: string }
  | { kind: "subsequent" }
  | { kind: "failed"; reason: string };

/** Parse the agent's final text part into a structured deploy result, or null if unrecognized. */
export function parseDeployReply(text: string, isFirstDeploy: boolean): DeployReply | null {
  const t = text.trim();
  if (t.length === 0) return null;
  const failedMatch = t.match(/^failed:\s*(.+)$/i);
  if (failedMatch) return { kind: "failed", reason: failedMatch[1]!.trim() };
  if (isFirstDeploy) {
    const m = t.match(/^deployed:([^:]+):(.+)$/i);
    if (m) return { kind: "first", uuid: m[1]!.trim(), fqdn: m[2]!.trim() };
    return null;
  }
  if (/^deployed\s*$/i.test(t)) return { kind: "subsequent" };
  return null;
}

export async function handleDeploy(ctx: Context, deps: DeployDeps): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") return;

    const stateRow = deps.state.get(chatId);
    if (!stateRow?.projectPath) {
      await ctx.reply(
        escapeMarkdownV2("Use /switch <project> first, then /deploy."),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const cfg = deps.coolifyConfig;
    const missing: string[] = [];
    if (!cfg.url) missing.push("COOLIFY_URL");
    if (!cfg.token) missing.push("COOLIFY_TOKEN");
    if (!cfg.serverUuid) missing.push("COOLIFY_SERVER_UUID");
    if (!cfg.projectUuid) missing.push("COOLIFY_PROJECT_UUID");
    if (!cfg.githubAppUuid) missing.push("COOLIFY_GITHUB_APP_UUID");
    if (missing.length > 0) {
      await ctx.reply(
        escapeMarkdownV2(
          `Coolify env vars not set on the bridge: ${missing.join(", ")}. See BOOTSTRAP.md.`,
        ),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const projectPath = stateRow.projectPath;
    const existing = deps.state.getCoolifyApp(chatId, projectPath);
    const isFirst = existing == null;

    const placeholder = await ctx.reply(
      escapeMarkdownV2(isFirst ? "creating Coolify app + deploying…" : "deploying…"),
      { parse_mode: "MarkdownV2" },
    );
    const placeholderId =
      typeof (placeholder as { message_id?: number }).message_id === "number"
        ? (placeholder as { message_id: number }).message_id
        : 0;

    const prompt = isFirst
      ? buildFirstDeployPrompt(projectPath)
      : buildSubsequentDeployPrompt(projectPath, existing.uuid);

    deps.router.ensureDirectory(projectPath);
    const session = await deps.client.createSession(`tg:deploy:${projectPath}`, {
      directory: projectPath,
    });

    const turn = new Turn(deps.bot, chatId, placeholderId);
    const collected: IncomingPart[] = [];
    let unregistered = false;
    const unregister = deps.router.registerSession(session.id, {
      onPartUpdated(part) {
        const p = part as IncomingPart;
        if (typeof p.id !== "string") return;
        const idx = collected.findIndex((cp) => cp.id === p.id);
        if (idx >= 0) collected[idx] = p;
        else collected.push(p);
        turn.appendPart(p);
      },
      async onIdle() {
        try {
          const lastText = collected
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => (p.text ?? "").trim())
            .filter((t) => t.length > 0)
            .at(-1) ?? "";
          const result = parseDeployReply(lastText, isFirst);
          if (result?.kind === "first") {
            deps.state.setCoolifyApp(chatId, projectPath, result.uuid, result.fqdn);
            await safeEdit(
              deps.bot,
              chatId,
              placeholderId,
              escapeMarkdownV2(`✅ Deployed: https://${result.fqdn}`),
              deps.log,
            );
          } else if (result?.kind === "subsequent" && existing) {
            await safeEdit(
              deps.bot,
              chatId,
              placeholderId,
              escapeMarkdownV2(`✅ Redeployed: https://${existing.fqdn}`),
              deps.log,
            );
          } else if (result?.kind === "failed") {
            await turn.showError(result.reason);
          } else {
            // Unparseable reply — let Turn render whatever the agent returned.
            await turn.finalize();
          }
        } catch (err) {
          deps.log?.error?.(
            { chatId, projectPath, isFirst, err: describeError(err) },
            "deploy onIdle handler threw",
          );
        }
        if (!unregistered) {
          unregistered = true;
          unregister();
        }
      },
      async onError(err) {
        try {
          await turn.showError(describeError(err));
        } catch (showErr) {
          deps.log?.error?.(
            { chatId, projectPath, isFirst, err: describeError(showErr) },
            "deploy onError handler threw",
          );
        }
        if (!unregistered) {
          unregistered = true;
          unregister();
        }
      },
      onPermissionUpdated() {
        // Server policy is `allow` for everything in this bridge.
      },
    });

    const model = parseModelId(deps.defaultModel);
    deps.client
      .prompt(session.id, prompt, {
        ...(model ? { model } : {}),
        directory: projectPath,
      })
      .catch(async (err) => {
        try {
          await turn.showError(`prompt failed: ${describeError(err)}`);
        } finally {
          if (!unregistered) {
            unregistered = true;
            unregister();
          }
        }
      });
  } catch (err) {
    await ctx.reply(escapeMarkdownV2(`❌ /deploy failed: ${describeError(err)}`), {
      parse_mode: "MarkdownV2",
    });
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: 285 + ~14 = ~299 tests pass (recount the `it()` blocks in deploy.test.ts); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/commands/deploy.ts tg-bridge/tests/commands/deploy.test.ts
git commit -m "Add /deploy command (first-deploy + subsequent-deploy paths)

First deploy: creates a Coolify application via API, parses
deployed:UUID:FQDN from agent reply, persists in chat_state, replies
with 'Deployed: https://<fqdn>'. Subsequent deploys: pushes pending
commits + triggers Coolify rebuild via API, replies with 'Redeployed:
https://<stored-fqdn>'. Coolify secrets stay in opencode container env;
prompts reference \$COOLIFY_URL/\$COOLIFY_TOKEN as shell vars."
```

---

## Task 6: Wire into `index.ts` + `help.ts`

**Files:**
- Modify: `tg-bridge/src/index.ts`
- Modify: `tg-bridge/src/commands/help.ts`
- Modify: `tg-bridge/tests/commands/help.test.ts`

**Goal:** Register the two new commands; ensure `/help` lists them; existing tests stay green.

- [ ] **Step 1: Update help.ts**

Edit `tg-bridge/src/commands/help.ts`. Add `/init-remote` and `/deploy` to the RAW string between `/init` and `/abort`:

(Look at the file to find the exact place — open it and add the two lines.)

- [ ] **Step 2: Update help test**

Edit `tg-bridge/tests/commands/help.test.ts`. The existing for-loop probably iterates a list of expected commands. Add `/init-remote` and `/deploy` to that list.

- [ ] **Step 3: Update index.ts**

Edit `tg-bridge/src/index.ts`. Add imports near the existing command imports:

```typescript
import { handleInitRemote } from "./commands/init-remote.js";
import { handleDeploy } from "./commands/deploy.js";
```

After the existing `bot.command("init", ...)` block, add:

```typescript
  bot.command("init-remote", (ctx) =>
    handleInitRemote(ctx, {
      client,
      state,
      router,
      bot: turnBot,
      workspaceRoot: config.workspaceRoot,
      defaultModel: config.defaultModel,
      ghToken: config.ghToken,
      ghOwner: config.ghOwner,
      log,
    }),
  );

  bot.command("deploy", (ctx) =>
    handleDeploy(ctx, {
      client,
      state,
      router,
      bot: turnBot,
      workspaceRoot: config.workspaceRoot,
      defaultModel: config.defaultModel,
      coolifyConfig: {
        url: config.coolifyUrl,
        token: config.coolifyToken,
        serverUuid: config.coolifyServerUuid,
        projectUuid: config.coolifyProjectUuid,
        githubAppUuid: config.coolifyGithubAppUuid,
      },
      log,
    }),
  );
```

- [ ] **Step 4: Run full suite + build + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
cd tg-bridge && npm run build
```

Expected: all tests pass (help.test.ts now iterates the two new commands); typecheck clean; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/index.ts tg-bridge/src/commands/help.ts tg-bridge/tests/commands/help.test.ts
git commit -m "Wire /init-remote + /deploy into bot + help

Both commands registered after /init. /init-remote takes ghToken+ghOwner
from config; /deploy takes the full coolifyConfig from config. Help
text lists both new commands."
```

---

## Task 7: opencode-image — install `gh` + `jq`

**Files:**
- Modify: `opencode-image/Dockerfile`

**Goal:** Agent has `gh` (for /init-remote) and `jq` (for /deploy).

- [ ] **Step 1: Edit the Dockerfile**

Open `opencode-image/Dockerfile`. Find the existing `apt-get install` block. Add a step (or extend the existing one) to install `gh` and `jq`:

```dockerfile
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y gh jq \
  && rm -rf /var/lib/apt/lists/*
```

If `curl` and `gpg` aren't already in the base image, add them to the apt install list.

- [ ] **Step 2: Local build smoke test**

```bash
cd /Users/doni/code/test-opencode-headless
docker build -t opencode-image-local -f opencode-image/Dockerfile opencode-image/
docker run --rm opencode-image-local gh --version
docker run --rm opencode-image-local jq --version
```

Expected: both commands print version strings.

- [ ] **Step 3: Commit**

```bash
git add opencode-image/Dockerfile
git commit -m "opencode-image: install gh CLI + jq for /init-remote and /deploy

gh CLI reads GH_TOKEN automatically — no auth login at container start.
jq parses Coolify API responses in the /deploy first-time bash flow."
```

---

## Task 8: Config docs — `.env.example` + `compose.yaml` + `BOOTSTRAP.md`

**Files:**
- Modify: `deploy/.env.example`
- Modify: `deploy/compose.yaml`
- Modify: `BOOTSTRAP.md`

**Goal:** Document the new env vars. Pass them through compose to BOTH containers (bridge for validation; opencode for agent's bash). Walk the user through the one-time Coolify setup.

- [ ] **Step 1: Edit `deploy/.env.example`**

Append to the end of the file:

```
# /init-remote (set GH_TOKEN to a GitHub PAT with 'repo' + 'workflow' scopes;
# set GH_OWNER to your GitHub username or org)
GH_TOKEN=
GH_OWNER=

# /deploy — Coolify v4 instance details. See BOOTSTRAP.md for one-time setup.
COOLIFY_URL=
COOLIFY_TOKEN=
COOLIFY_SERVER_UUID=
COOLIFY_PROJECT_UUID=
COOLIFY_GITHUB_APP_UUID=
```

- [ ] **Step 2: Edit `deploy/compose.yaml`**

Find the `tg-bridge` service. In its `environment:` block, add:

```yaml
      GH_TOKEN: ${GH_TOKEN:-}
      GH_OWNER: ${GH_OWNER:-}
      COOLIFY_URL: ${COOLIFY_URL:-}
      COOLIFY_TOKEN: ${COOLIFY_TOKEN:-}
      COOLIFY_SERVER_UUID: ${COOLIFY_SERVER_UUID:-}
      COOLIFY_PROJECT_UUID: ${COOLIFY_PROJECT_UUID:-}
      COOLIFY_GITHUB_APP_UUID: ${COOLIFY_GITHUB_APP_UUID:-}
```

Find the `opencode` service. In its `environment:` block, add the SAME six entries (so the agent's bash can read them via shell expansion):

```yaml
      GH_TOKEN: ${GH_TOKEN:-}
      COOLIFY_URL: ${COOLIFY_URL:-}
      COOLIFY_TOKEN: ${COOLIFY_TOKEN:-}
      COOLIFY_SERVER_UUID: ${COOLIFY_SERVER_UUID:-}
      COOLIFY_PROJECT_UUID: ${COOLIFY_PROJECT_UUID:-}
      COOLIFY_GITHUB_APP_UUID: ${COOLIFY_GITHUB_APP_UUID:-}
```

(Opencode container does NOT need GH_OWNER — that's bridge-side validation only.)

- [ ] **Step 3: Edit `BOOTSTRAP.md`**

Append a new section before the smoke-test section:

```markdown
## 11. (Optional) Configure /init-remote + /deploy

If you want to use `/init-remote` (auto-create GitHub repos) and `/deploy` (push to Coolify), do this one-time setup:

### A. GitHub PAT

1. Visit https://github.com/settings/tokens/new
2. Note name: "tg-bridge-coolify"
3. Expiration: pick a value (90 days recommended)
4. Scopes: check `repo` (Full control of private repositories) and `workflow` (Update GitHub Action workflows)
5. Generate token; copy the `ghp_...` value
6. Add to `.env`:
   ```
   GH_TOKEN=ghp_...
   GH_OWNER=your-github-username
   ```

### B. Coolify GitHub App (one-time per Coolify instance)

1. In Coolify dashboard → Sources → New → GitHub App
2. Walk through the GitHub OAuth flow to install the Coolify GitHub App into your account
3. After installation, note the GitHub App's UUID from the Coolify Sources page

### C. Coolify API token

1. Coolify dashboard → Settings → API Tokens → Create New Token
2. Scope: `write` (deploy + create apps)
3. Copy the token

### D. Note your Coolify Server + Project UUIDs

1. Server UUID: Coolify dashboard → Servers → click your server → URL contains `/server/<uuid>`
2. Project UUID: Coolify dashboard → Projects → click your project (or create one named "telegram-deploys") → URL contains `/project/<uuid>`

### E. Add to `.env`

```
COOLIFY_URL=https://coolify.your-domain.com
COOLIFY_TOKEN=...
COOLIFY_SERVER_UUID=...
COOLIFY_PROJECT_UUID=...
COOLIFY_GITHUB_APP_UUID=...
```

### F. Restart the stack

```bash
cd /mnt/user/appdata/opencode/repo
docker compose -f deploy/compose.yaml up -d
```

### G. Smoke test

In Telegram:

1. `/init-remote test-deploy-1` → see streaming view → final auto-switch confirmation
2. Visit https://github.com/your-username/test-deploy-1 → confirm private repo with one commit
3. Chat: "build me a simple hello-world Astro site"
4. `/deploy` → see streaming view → final "✅ Deployed: https://..." message
5. Open the deploy URL → confirm site loads
6. Chat: "change heading to 'Hello, World 2'"
7. `/deploy` again → confirm rebuild after a minute

If anything fails, `docker logs tg-bridge --tail=200` and `docker logs opencode --tail=200` show what went wrong.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/.env.example deploy/compose.yaml BOOTSTRAP.md
git commit -m "Configure /init-remote + /deploy env vars + bootstrap docs

.env.example documents the 7 new env vars (GH_TOKEN, GH_OWNER,
COOLIFY_URL/TOKEN/SERVER_UUID/PROJECT_UUID/GITHUB_APP_UUID).
compose.yaml passes the relevant subset through to bridge (validation)
and opencode (agent bash). BOOTSTRAP.md gains a new section walking
through the one-time GitHub PAT + Coolify GitHub App + tokens setup."
```

---

## Task 9: Build, push, deploy, smoke-verify

**Files:** None modified. Final integration check.

- [ ] **Step 1: Final clean build + tests + typecheck**

```bash
cd /Users/doni/code/test-opencode-headless/tg-bridge
npm run build
npx vitest run
npm run typecheck
```

Expected: all pass. Capture test count.

- [ ] **Step 2: Inspect git log**

```bash
git log --oneline origin/main..HEAD
```

Expected: 8 new commits (Tasks 1-8).

- [ ] **Step 3: Push to origin**

```bash
git push origin main
```

- [ ] **Step 4: Deploy to Unraid**

```bash
ssh root@192.168.86.81 'cd /mnt/user/appdata/opencode/repo \
  && git pull --ff-only \
  && docker compose -f deploy/compose.yaml build opencode tg-bridge \
  && docker compose -f deploy/compose.yaml up -d'
```

Expected: both images build successfully; both containers recreated.

- [ ] **Step 5: Verify container health + clean startup**

```bash
ssh root@192.168.86.81 'docker ps --filter name=tg-bridge --format "Status: {{.Status}}"'
ssh root@192.168.86.81 'docker logs tg-bridge --tail=20'
ssh root@192.168.86.81 'docker logs opencode --tail=20'
```

Expected: both containers `Up X seconds`; bridge logs show standard startup; opencode logs show standard startup; NO errors.

- [ ] **Step 6: Verify gh + jq inside opencode container**

```bash
ssh root@192.168.86.81 'docker exec opencode gh --version'
ssh root@192.168.86.81 'docker exec opencode jq --version'
ssh root@192.168.86.81 'docker exec opencode gh auth status'
```

Expected: gh prints version; jq prints version; `gh auth status` confirms authenticated as GH_OWNER (uses GH_TOKEN).

- [ ] **Step 7: USER smoke test — see BOOTSTRAP.md section 11.G**

This step is performed by the user via Telegram. Follow the 7-step smoke test in BOOTSTRAP.md section G.

- [ ] **Step 8: If smoke test surfaces issues**

Capture logs:

```bash
ssh root@192.168.86.81 'docker logs tg-bridge --tail=200' > /tmp/tg-bridge.log
ssh root@192.168.86.81 'docker logs opencode --tail=200' > /tmp/opencode.log
```

Diagnose; fix as a new commit; redeploy; re-test.

---

## Self-Review

### Spec coverage

- ✅ `/init-remote` command — Tasks 3 + 4
- ✅ `/deploy` command (first + subsequent) — Task 5
- ✅ chat_state coolify_app table — Task 1
- ✅ project-creator extension for init-remote kind — Task 3
- ✅ Config gains optional GH_* + COOLIFY_* — Task 2
- ✅ opencode-image gh + jq — Task 7
- ✅ compose env passthrough — Task 8
- ✅ .env.example + BOOTSTRAP.md updates — Task 8
- ✅ index.ts + help.ts wiring — Task 6
- ✅ Pre-LLM validation in commands — Tasks 4 + 5
- ✅ MarkdownV2 escaping (via escapeMarkdownV2 + safeEdit) — Tasks 4 + 5
- ✅ Per-directory SSE routing reuse — handled by createProject + Task 5's deploy.ts (calls ensureDirectory + createSession with directory)
- ✅ Failure paths surface via showError — Tasks 4 + 5

### Placeholder scan

No "TODO", "TBD", "implement later", "fill in details", or "Similar to Task N" left in tasks. Every code block is concrete.

### Type consistency

- `CreationKind` extended consistently across project-creator + tests
- `CreateProjectArgs.owner` added; commands/init-remote.ts passes it
- `CoolifyConfig` shape consistent between deploy.ts and index.ts
- `DeployDeps.coolifyConfig` passed via compose env vars in index.ts → exposed via config.ts
- `parseDeployReply` return type aligned across tests + production
- `setCoolifyApp` / `getCoolifyApp` signatures match across chat-state.ts + deploy.ts callers

### Test count tracking

| Task | Tests added | Cumulative |
|---|---|---|
| baseline | — | 262 |
| Task 1 (chat-state coolify_app) | +5 | 267 |
| Task 2 (config new env vars) | +5 | 272 |
| Task 3 (project-creator init-remote) | +7 | 279 |
| Task 4 (/init-remote) | +6 | 285 |
| Task 5 (/deploy) | +14 | 299 |
| Task 6 (help wiring) | +0 (existing for-loop covers) | 299 |
| Task 7 (Dockerfile) | +0 | 299 |
| Task 8 (config docs) | +0 | 299 |
| **Final** | | **~299** |

If actual count diverges by ≤3, recount `it()` blocks per task and adjust.
