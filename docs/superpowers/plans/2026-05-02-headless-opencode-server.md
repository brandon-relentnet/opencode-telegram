# Headless opencode server with Telegram bridge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a two-container Docker stack (opencode server + Telegram bot bridge) deployable on Unraid. Laptop reaches `opencode web` over Tailscale; phone talks to a Telegram bot that bridges into the opencode SDK.

**Architecture:** Container `opencode` runs `opencode serve` with persistent volumes for auth, sessions, config, and a `/workspace` mount of the user's repos. Container `tg-bridge` is a Node/TypeScript bot using `grammy` + `@opencode-ai/sdk` + `better-sqlite3`. Both join a Compose-defined bridge network. Bridge subscribes to opencode's SSE event stream once and routes events to per-chat turn handlers indexed by sessionID. Permission requests surface as Telegram inline keyboards.

**Tech Stack:** TypeScript 5.x, grammy ^1.x, @opencode-ai/sdk (latest), better-sqlite3 ^11.x, zod ^3.x, pino ^9.x, vitest ^2.x, Node 22, Debian Bookworm slim, Docker Compose v2.

**Spec reference:** `docs/superpowers/specs/2026-05-02-headless-opencode-server-design.md`

---

## File structure

```
test-opencode-headless/
├── README.md                              # quick-start & "what is this"
├── BOOTSTRAP.md                           # one-time setup walkthrough
├── Makefile                               # `make build`, `make up`, `make logs`, etc.
├── .gitignore                             # node_modules, .env, *.sqlite, dist/
├── deploy/
│   ├── compose.yaml                       # the two services + network + volumes
│   ├── .env.example                       # template for secrets
│   └── README.md                          # deploy notes (Unraid specifics)
├── opencode-image/
│   ├── Dockerfile                         # node:22-bookworm-slim + opencode + LSPs
│   └── opencode-config.json               # baseline opencode config (permissions)
├── tg-bridge/
│   ├── Dockerfile                         # node:22-bookworm-slim + bridge build
│   ├── package.json
│   ├── package-lock.json                  # committed
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── .gitignore                         # dist/, *.sqlite
│   ├── src/
│   │   ├── index.ts                       # entry: load config, init bot, start polling
│   │   ├── config.ts                      # zod env validation
│   │   ├── auth.ts                        # whitelist middleware
│   │   ├── chunker.ts                     # split long output, code-fence aware
│   │   ├── format.ts                      # opencode parts → Telegram MarkdownV2
│   │   ├── chat-state.ts                  # SQLite repo for chat→{project,session,model}
│   │   ├── opencode-client.ts             # auth-wrapped opencode SDK client
│   │   ├── event-router.ts                # subscribes to event stream, routes by sessionID
│   │   ├── turn.ts                        # per-message turn lifecycle (buffer + edits)
│   │   ├── permissions.ts                 # permission.updated → inline keyboard → response
│   │   ├── message-handler.ts             # default text handler (non-command)
│   │   └── commands/
│   │       ├── help.ts
│   │       ├── projects.ts
│   │       ├── switch.ts
│   │       ├── new.ts
│   │       ├── abort.ts
│   │       ├── status.ts
│   │       └── model.ts
│   └── tests/
│       ├── config.test.ts
│       ├── auth.test.ts
│       ├── chunker.test.ts
│       ├── format.test.ts
│       ├── chat-state.test.ts
│       ├── opencode-client.test.ts
│       ├── turn.test.ts
│       ├── permissions.test.ts
│       └── commands/
│           ├── help.test.ts
│           ├── projects.test.ts
│           ├── switch.test.ts
│           ├── new.test.ts
│           ├── abort.test.ts
│           ├── status.test.ts
│           └── model.test.ts
└── docs/
    └── superpowers/
        ├── specs/2026-05-02-headless-opencode-server-design.md
        └── plans/2026-05-02-headless-opencode-server.md   # this file
```

**File responsibility boundaries:**

- **Pure functions** (no I/O, no clock, no SDK): `chunker.ts`, `format.ts`, `auth.ts` — trivially unit-testable.
- **Effectful helpers** with mockable boundaries: `config.ts` (reads `process.env`), `chat-state.ts` (SQLite, use `:memory:` in tests), `opencode-client.ts` (HTTP via injected fetch).
- **Stateful coordinators**: `event-router.ts` (subscription lifecycle), `turn.ts` (per-turn state machine), `permissions.ts` (pending-prompt registry).
- **Command handlers** (`commands/*.ts`): each receives a context bag `{ ctx, deps }` and returns nothing useful; tested via grammy's `Bot.handleUpdate`.
- **Wire-up**: `index.ts` and `message-handler.ts` are integration glue. `index.ts` is barely tested (smoke); `message-handler.ts` is tested with mocked deps.

---

## Task 1: Repo scaffolding (root + tg-bridge package)

**Files:**
- Create: `.gitignore`
- Create: `Makefile`
- Create: `README.md`
- Create: `tg-bridge/.gitignore`
- Create: `tg-bridge/package.json`
- Create: `tg-bridge/tsconfig.json`
- Create: `tg-bridge/vitest.config.ts`
- Create: `tg-bridge/src/.gitkeep`
- Create: `tg-bridge/tests/.gitkeep`

- [ ] **Step 1: Write root `.gitignore`**

```gitignore
# dependencies
node_modules/

# build artifacts
dist/
*.tsbuildinfo

# secrets
.env
.env.local
deploy/.env

# local data
*.sqlite
*.sqlite-journal

# editor
.DS_Store
.vscode/
.idea/
```

- [ ] **Step 2: Write root `Makefile`**

```makefile
.PHONY: help build up down logs restart shell-bridge shell-opencode test typecheck lint

help:
	@echo "Targets:"
	@echo "  build         - docker compose build"
	@echo "  up            - docker compose up -d"
	@echo "  down          - docker compose down"
	@echo "  restart       - down then up"
	@echo "  logs          - tail compose logs"
	@echo "  shell-bridge  - exec sh in tg-bridge"
	@echo "  shell-opencode- exec sh in opencode"
	@echo "  test          - run tg-bridge unit tests"
	@echo "  typecheck     - tg-bridge tsc --noEmit"

build:
	docker compose -f deploy/compose.yaml build

up:
	docker compose -f deploy/compose.yaml --env-file deploy/.env up -d

down:
	docker compose -f deploy/compose.yaml down

restart: down up

logs:
	docker compose -f deploy/compose.yaml logs -f --tail=200

shell-bridge:
	docker compose -f deploy/compose.yaml exec tg-bridge sh

shell-opencode:
	docker compose -f deploy/compose.yaml exec opencode sh

test:
	cd tg-bridge && npm test

typecheck:
	cd tg-bridge && npx tsc --noEmit
```

- [ ] **Step 3: Write minimal `README.md`**

```markdown
# Headless opencode server with Telegram bridge

A two-container Docker stack that runs opencode as an always-on headless server,
accessible from a laptop via Tailscale (`opencode web`) and from a phone via a
Telegram bot.

See `docs/superpowers/specs/2026-05-02-headless-opencode-server-design.md` for the design.

See `BOOTSTRAP.md` for one-time setup.

## Quick commands

```sh
make build      # build images
make up         # start the stack
make logs       # tail logs
make test       # run bridge tests
```
```

- [ ] **Step 4: Write `tg-bridge/.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo
*.sqlite
*.sqlite-journal
coverage/
```

- [ ] **Step 5: Write `tg-bridge/package.json`**

```json
{
  "name": "tg-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@opencode-ai/sdk": "^0.5.0",
    "better-sqlite3": "^11.5.0",
    "grammy": "^1.30.0",
    "pino": "^9.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.9.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

> **Version note:** Pin to the latest minor available at install time. The above are sane floors; the engineer should `npm install` and let the lockfile pin exact versions. If `@opencode-ai/sdk` doesn't have a `^0.5.0` yet, use the latest published version.

- [ ] **Step 6: Write `tg-bridge/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 7: Write `tg-bridge/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
```

- [ ] **Step 8: Create empty source/test directories**

```sh
mkdir -p tg-bridge/src tg-bridge/tests/commands
touch tg-bridge/src/.gitkeep tg-bridge/tests/.gitkeep
```

- [ ] **Step 9: Install dependencies and verify build infrastructure**

```sh
cd tg-bridge && npm install
```
Expected: `node_modules/` populated; `package-lock.json` written. No errors.

```sh
cd tg-bridge && npx tsc --noEmit
```
Expected: exit 0 (no `.ts` files to compile yet, but tsc validates config).

```sh
cd tg-bridge && npx vitest run
```
Expected: "No test files found" — exit code 0 or 1 depending on vitest version. Either is acceptable for now (no tests yet).

- [ ] **Step 10: Commit**

```sh
git add -A
git commit -m "Scaffold repo + tg-bridge package

Add root .gitignore, Makefile, minimal README. Initialize tg-bridge
TypeScript package with grammy, opencode SDK, better-sqlite3, vitest."
```

---

## Task 2: Config — zod-validated env

Validates all environment variables on startup with zod. Failures crash the process with a clear message rather than producing weird runtime errors later.

**Files:**
- Create: `tg-bridge/src/config.ts`
- Create: `tg-bridge/tests/config.test.ts`

- [ ] **Step 1: Write the failing test `tests/config.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

describe("loadConfig", () => {
  const validEnv = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_ALLOWED_USER_IDS: "111,222",
    OPENCODE_PASSWORD: "secret",
  };

  it("parses a valid env with defaults", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.telegramBotToken).toBe("123:abc");
    expect(cfg.allowedUserIds).toEqual([111, 222]);
    expect(cfg.opencodeUrl).toBe("http://opencode:4096");
    expect(cfg.opencodeUsername).toBe("opencode");
    expect(cfg.opencodePassword).toBe("secret");
    expect(cfg.workspaceRoot).toBe("/workspace");
    expect(cfg.logLevel).toBe("info");
  });

  it("trims whitespace and ignores empty entries in user IDs", () => {
    const cfg = loadConfig({ ...validEnv, TELEGRAM_ALLOWED_USER_IDS: " 111 , , 222 " });
    expect(cfg.allowedUserIds).toEqual([111, 222]);
  });

  it("rejects non-numeric user IDs", () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWED_USER_IDS: "111,abc" })).toThrow(
      ConfigError,
    );
  });

  it("rejects empty allowlist", () => {
    expect(() => loadConfig({ ...validEnv, TELEGRAM_ALLOWED_USER_IDS: "" })).toThrow(ConfigError);
  });

  it("requires TELEGRAM_BOT_TOKEN", () => {
    const env = { ...validEnv } as Record<string, string>;
    delete env.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig(env)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("requires OPENCODE_PASSWORD", () => {
    const env = { ...validEnv } as Record<string, string>;
    delete env.OPENCODE_PASSWORD;
    expect(() => loadConfig(env)).toThrow(/OPENCODE_PASSWORD/);
  });

  it("rejects unknown log level", () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: "yelling" })).toThrow(ConfigError);
  });

  it("accepts custom OPENCODE_URL and WORKSPACE_ROOT", () => {
    const cfg = loadConfig({
      ...validEnv,
      OPENCODE_URL: "http://example.local:9000",
      WORKSPACE_ROOT: "/data/code",
    });
    expect(cfg.opencodeUrl).toBe("http://example.local:9000");
    expect(cfg.workspaceRoot).toBe("/data/code");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/config.test.ts
```
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Implement `src/config.ts`**

```typescript
import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const userIdList = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Not a positive integer: ${JSON.stringify(s)}`,
          });
          return z.NEVER;
        }
        return n;
      });
    if (ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TELEGRAM_ALLOWED_USER_IDS must contain at least one ID",
      });
      return z.NEVER;
    }
    return ids;
  });

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: userIdList,
  OPENCODE_URL: z.string().url().default("http://opencode:4096"),
  OPENCODE_USERNAME: z.string().min(1).default("opencode"),
  OPENCODE_PASSWORD: z.string().min(1, "OPENCODE_PASSWORD is required"),
  WORKSPACE_ROOT: z.string().min(1).default("/workspace"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
  workspaceRoot: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = Schema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${messages}`);
  }
  const parsed = result.data;
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    allowedUserIds: parsed.TELEGRAM_ALLOWED_USER_IDS,
    opencodeUrl: parsed.OPENCODE_URL,
    opencodeUsername: parsed.OPENCODE_USERNAME,
    opencodePassword: parsed.OPENCODE_PASSWORD,
    workspaceRoot: parsed.WORKSPACE_ROOT,
    logLevel: parsed.LOG_LEVEL,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/config.test.ts
```
Expected: 8 tests pass.

```sh
cd tg-bridge && npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/config.ts tg-bridge/tests/config.test.ts
git commit -m "Add config module with zod env validation

Validates required env vars on startup; rejects malformed
TELEGRAM_ALLOWED_USER_IDS and unknown LOG_LEVEL values with
clear error messages."
```

---

## Task 3: Whitelist auth middleware

Drops Telegram updates whose `from.id` is not in the configured allowlist. Must run before any other handler. Logs a warning on rejection but does not reply (to avoid revealing the bot is gated).

**Files:**
- Create: `tg-bridge/src/auth.ts`
- Create: `tg-bridge/tests/auth.test.ts`

- [ ] **Step 1: Write the failing test `tests/auth.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { whitelistMiddleware } from "../src/auth.js";

function makeCtx(fromId: number | undefined): Context {
  return {
    from: fromId === undefined ? undefined : { id: fromId },
    update: { update_id: 1 },
  } as unknown as Context;
}

describe("whitelistMiddleware", () => {
  it("calls next when from.id is in the allowlist", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([111, 222]);
    await mw(makeCtx(222), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not call next when from.id is missing", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([111]);
    await mw(makeCtx(undefined), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next when from.id is not in the allowlist", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([111]);
    await mw(makeCtx(999), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("treats an empty allowlist as deny-all (defensive)", async () => {
    const next = vi.fn() as unknown as NextFunction;
    const mw = whitelistMiddleware([]);
    await mw(makeCtx(111), next);
    expect(next).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/auth.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth.ts`**

```typescript
import type { Context, MiddlewareFn } from "grammy";

export function whitelistMiddleware(allowedUserIds: number[]): MiddlewareFn<Context> {
  const allow = new Set(allowedUserIds);
  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (id !== undefined && allow.has(id)) {
      await next();
      return;
    }
    // Drop silently. The caller is expected to log via pino at info level.
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/auth.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/auth.ts tg-bridge/tests/auth.test.ts
git commit -m "Add whitelist auth middleware

Drops Telegram updates whose from.id is not in the allowlist.
Returns silently to avoid revealing the bot is gated."
```

---

## Task 4: Chunker — split long output preserving code fences

Telegram caps text messages at 4096 characters. The chunker splits long output into messages ≤ a safe maximum, never breaking inside a fenced code block. If a code block must be split, the open fence is closed at the chunk boundary and reopened with the same language hint on the next chunk.

**Files:**
- Create: `tg-bridge/src/chunker.ts`
- Create: `tg-bridge/tests/chunker.test.ts`

- [ ] **Step 1: Write the failing test `tests/chunker.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { chunkForTelegram, MAX_TELEGRAM_LENGTH } from "../src/chunker.js";

describe("chunkForTelegram", () => {
  it("returns a single chunk when input is short", () => {
    expect(chunkForTelegram("hello")).toEqual(["hello"]);
  });

  it("returns a single chunk when input is exactly at the safe max", () => {
    const text = "a".repeat(MAX_TELEGRAM_LENGTH);
    expect(chunkForTelegram(text)).toEqual([text]);
  });

  it("splits long text at paragraph boundaries", () => {
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const para3 = "c".repeat(2000);
    const input = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkForTelegram(input);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
    }
    expect(chunks.join("")).toContain(para1);
    expect(chunks.join("")).toContain(para2);
    expect(chunks.join("")).toContain(para3);
  });

  it("keeps a small code block intact in one chunk", () => {
    const input = "before\n\n```ts\nconst x = 1;\n```\n\nafter";
    expect(chunkForTelegram(input)).toEqual([input]);
  });

  it("splits a code block that exceeds the safe max, closing and reopening with the same language", () => {
    const codeLines = Array.from({ length: 600 }, (_, i) => `line ${i};`);
    const input = "intro\n\n```ts\n" + codeLines.join("\n") + "\n```\n\noutro";
    const chunks = chunkForTelegram(input);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
      // every chunk must have balanced fences
      const fenceCount = (c.match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
    // language hint is preserved on the re-opened fence
    const middleChunks = chunks.slice(1);
    expect(middleChunks.every((c) => c.startsWith("```ts"))).toBe(true);
  });

  it("hard-splits a single very long line as a last resort", () => {
    const input = "x".repeat(MAX_TELEGRAM_LENGTH * 2 + 500);
    const chunks = chunkForTelegram(input);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
    }
    expect(chunks.join("")).toBe(input);
  });

  it("handles empty input", () => {
    expect(chunkForTelegram("")).toEqual([]);
  });

  it("handles a code block with no language hint", () => {
    const codeLines = Array.from({ length: 600 }, (_, i) => `L${i}`);
    const input = "```\n" + codeLines.join("\n") + "\n```";
    const chunks = chunkForTelegram(input);
    for (const c of chunks) {
      const fenceCount = (c.match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/chunker.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/chunker.ts`**

```typescript
/**
 * Chunker for Telegram message text.
 *
 * Telegram allows up to 4096 characters per text message. We use a safe
 * maximum slightly below that to leave room for fence-balancing insertions
 * when splitting a long code block across chunks.
 */

export const MAX_TELEGRAM_LENGTH = 4000;

const FENCE_RE = /^```(\w*)\s*$/;

interface BufferState {
  text: string;
  inFence: boolean;
  fenceLang: string;
}

function emptyBuffer(): BufferState {
  return { text: "", inFence: false, fenceLang: "" };
}

function appendLine(buf: BufferState, line: string): BufferState {
  const text = buf.text.length === 0 ? line : `${buf.text}\n${line}`;
  const m = line.match(FENCE_RE);
  if (m) {
    if (buf.inFence) {
      return { text, inFence: false, fenceLang: "" };
    }
    return { text, inFence: true, fenceLang: m[1] ?? "" };
  }
  return { ...buf, text };
}

function closeIfNeeded(buf: BufferState): string {
  return buf.inFence ? `${buf.text}\n\`\`\`` : buf.text;
}

function projectLength(buf: BufferState, line: string): number {
  const join = buf.text.length === 0 ? 0 : 1; // newline
  const fenceClose = buf.inFence ? 4 : 0; // "\n```" if we'd flush now
  return buf.text.length + join + line.length + fenceClose;
}

function hardSplit(line: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += max) {
    out.push(line.slice(i, i + max));
  }
  return out;
}

export function chunkForTelegram(input: string, max: number = MAX_TELEGRAM_LENGTH): string[] {
  if (input.length === 0) return [];
  if (input.length <= max) return [input];

  const chunks: string[] = [];
  let buf = emptyBuffer();
  const rawLines = input.split("\n");

  // Pre-pass: hard-split any single line that on its own exceeds max.
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length > max) {
      lines.push(...hardSplit(line, max));
    } else {
      lines.push(line);
    }
  }

  for (const line of lines) {
    if (projectLength(buf, line) > max && buf.text.length > 0) {
      // Flush buffer (closing fence if needed)
      chunks.push(closeIfNeeded(buf));
      // If we were in a fence, start the next buffer with a reopened fence
      if (buf.inFence) {
        const reopen = buf.fenceLang ? `\`\`\`${buf.fenceLang}` : "```";
        buf = { text: reopen, inFence: true, fenceLang: buf.fenceLang };
      } else {
        buf = emptyBuffer();
      }
    }
    buf = appendLine(buf, line);
  }

  if (buf.text.length > 0) {
    chunks.push(closeIfNeeded(buf));
  }

  return chunks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/chunker.test.ts
```
Expected: 8 tests pass. If any fail, adjust the implementation; the tests are the spec.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/chunker.ts tg-bridge/tests/chunker.test.ts
git commit -m "Add chunker that splits long output preserving code fences

Splits at line boundaries, hard-splits any single line that exceeds
the safe max. When a chunk boundary falls inside a fenced code block,
closes the fence at the split and reopens with the same language."
```

---

## Task 5: Format — opencode parts → Telegram MarkdownV2

Translates the heterogeneous `Part[]` returned by the opencode SDK into a single Telegram MarkdownV2 string. Handles text parts, tool calls (rendered as a small italic note), and tool results (rendered as a code block, truncated past 50 lines).

**Reference for Telegram MarkdownV2:** https://core.telegram.org/bots/api#markdownv2-style — outside code blocks, escape `_*[]()~`>#+-=|{}.!`; inside `pre`/`code`, escape only `` ` `` and `\`.

**Note on Part types:** The opencode SDK's `Part` is a discriminated union. For Phase 1 we render `text` and `tool` parts; everything else (reasoning, step boundaries, etc.) is dropped. The renderer accepts a structural type so it doesn't fight SDK shape changes.

**Files:**
- Create: `tg-bridge/src/format.ts`
- Create: `tg-bridge/tests/format.test.ts`

- [ ] **Step 1: Write the failing test `tests/format.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { renderParts, escapeMarkdownV2, type RenderablePart } from "../src/format.js";

describe("escapeMarkdownV2", () => {
  it("escapes all reserved characters", () => {
    expect(escapeMarkdownV2("a_b*c[d](e)f~g`h>i#j+k-l=m|n{o}p.q!r")).toBe(
      "a\\_b\\*c\\[d\\]\\(e\\)f\\~g\\`h\\>i\\#j\\+k\\-l\\=m\\|n\\{o\\}p\\.q\\!r",
    );
  });

  it("leaves plain ASCII letters and digits untouched", () => {
    expect(escapeMarkdownV2("hello world 123")).toBe("hello world 123");
  });
});

describe("renderParts", () => {
  it("renders empty input as empty string", () => {
    expect(renderParts([])).toBe("");
  });

  it("escapes text parts", () => {
    const parts: RenderablePart[] = [{ type: "text", text: "hello (world)." }];
    expect(renderParts(parts)).toBe("hello \\(world\\)\\.");
  });

  it("concatenates multiple text parts with no extra separator", () => {
    const parts: RenderablePart[] = [
      { type: "text", text: "first " },
      { type: "text", text: "second" },
    ];
    expect(renderParts(parts)).toBe("first second");
  });

  it("renders a tool call as an italic note before its result", () => {
    const parts: RenderablePart[] = [
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "src/auth.ts" }, output: "file body" },
      },
    ];
    const out = renderParts(parts);
    expect(out).toContain("_called `read`");
    expect(out).toContain("src/auth\\.ts");
    expect(out).toContain("```");
    expect(out).toContain("file body");
  });

  it("truncates tool output past 50 lines and appends a notice", () => {
    const longOutput = Array.from({ length: 75 }, (_, i) => `L${i}`).join("\n");
    const parts: RenderablePart[] = [
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: longOutput },
      },
    ];
    const out = renderParts(parts);
    expect(out).toContain("L0");
    expect(out).toContain("L49");
    expect(out).not.toContain("L50");
    expect(out).toContain("truncated");
  });

  it("renders a pending tool call without a result block", () => {
    const parts: RenderablePart[] = [
      {
        type: "tool",
        tool: "edit",
        state: { status: "pending", input: { filePath: "x.ts" } },
      },
    ];
    const out = renderParts(parts);
    expect(out).toContain("_called `edit`");
    // no code-block result yet
    expect(out).not.toContain("```\n");
  });

  it("interleaves text and tool parts in order", () => {
    const parts: RenderablePart[] = [
      { type: "text", text: "first." },
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "a.ts" }, output: "x" },
      },
      { type: "text", text: "after." },
    ];
    const out = renderParts(parts);
    const idxFirst = out.indexOf("first");
    const idxTool = out.indexOf("called");
    const idxAfter = out.indexOf("after");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxTool).toBeGreaterThan(idxFirst);
    expect(idxAfter).toBeGreaterThan(idxTool);
  });

  it("ignores unknown part types", () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "reasoning", text: "internal monologue" },
    ] as RenderablePart[];
    const out = renderParts(parts);
    expect(out).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/format.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/format.ts`**

```typescript
/**
 * Render opencode message parts into a single Telegram MarkdownV2 string.
 *
 * Per Telegram docs (https://core.telegram.org/bots/api#markdownv2-style):
 *   Outside code blocks, escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
 *   Inside `pre` / `code`, escape only ` and \.
 */

const RESERVED_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const CODE_RESERVED_RE = /[\\`]/g;

const TOOL_RESULT_LINE_LIMIT = 50;
const TRUNCATION_NOTICE = "…truncated, full result on opencode web";

export function escapeMarkdownV2(text: string): string {
  return text.replace(RESERVED_RE, (c) => `\\${c}`);
}

function escapeCode(text: string): string {
  return text.replace(CODE_RESERVED_RE, (c) => `\\${c}`);
}

interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
}

export type RenderablePart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: ToolState }
  | { type: string; [k: string]: unknown }; // unknown variants ignored

function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Pick the most informative single field per known tool, else show first key=value.
  const preferredKey =
    {
      read: "filePath",
      write: "filePath",
      edit: "filePath",
      bash: "command",
      grep: "pattern",
      glob: "pattern",
      webfetch: "url",
    }[toolName] ?? Object.keys(obj)[0];
  if (!preferredKey) return "";
  const value = obj[preferredKey];
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function renderTextPart(text: string): string {
  return escapeMarkdownV2(text);
}

function renderToolPart(tool: string, state: ToolState): string {
  const summary = summarizeToolInput(tool, state.input);
  const escapedTool = escapeMarkdownV2(tool);
  const escapedSummary = summary ? ` on ${escapeMarkdownV2(summary)}` : "";
  // Italic via _ ... _; inline code via backticks (which don't need to be escaped
  // inside the surrounding italic since they delimit a code entity in MarkdownV2).
  const header = `_called \`${escapedTool}\`${escapedSummary}_`;

  const output = state.output ?? "";
  if (state.status !== "completed" || output.length === 0) {
    return header;
  }

  const lines = output.split("\n");
  const truncated = lines.length > TOOL_RESULT_LINE_LIMIT;
  const body = truncated
    ? `${lines.slice(0, TOOL_RESULT_LINE_LIMIT).join("\n")}\n${TRUNCATION_NOTICE}`
    : output;

  return `${header}\n\`\`\`\n${escapeCode(body)}\n\`\`\``;
}

export function renderParts(parts: readonly RenderablePart[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof (part as { text?: string }).text === "string") {
      segments.push(renderTextPart((part as { text: string }).text));
    } else if (
      part.type === "tool" &&
      typeof (part as { tool?: string }).tool === "string" &&
      (part as { state?: ToolState }).state
    ) {
      const tp = part as { tool: string; state: ToolState };
      segments.push(renderToolPart(tp.tool, tp.state));
    }
    // unknown types: skip
  }
  return segments.join("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/format.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/format.ts tg-bridge/tests/format.test.ts
git commit -m "Add MarkdownV2 renderer for opencode parts

Renders text and tool parts to Telegram MarkdownV2; tool results are
shown in code blocks and truncated past 50 lines."
```

---

## Task 6: chat-state — SQLite repository for per-chat state

Persists `{ project_path, session_id, model }` keyed by Telegram `chat_id`. Survives bridge restarts. Uses `better-sqlite3` (synchronous, embedded). Tests use an in-memory database.

**Files:**
- Create: `tg-bridge/src/chat-state.ts`
- Create: `tg-bridge/tests/chat-state.test.ts`

- [ ] **Step 1: Write the failing test `tests/chat-state.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo, type ChatState } from "../src/chat-state.js";

describe("ChatStateRepo", () => {
  let repo: ChatStateRepo;

  beforeEach(() => {
    const db = new Database(":memory:");
    repo = new ChatStateRepo(db);
  });

  it("get returns null for unknown chat", () => {
    expect(repo.get(999)).toBeNull();
  });

  it("setProject creates a row with project and session, no model", () => {
    repo.setProject(1, "/workspace/myapp", "ses_1");
    const state = repo.get(1);
    expect(state).toMatchObject<Partial<ChatState>>({
      chatId: 1,
      projectPath: "/workspace/myapp",
      sessionId: "ses_1",
      model: null,
    });
    expect(state!.updatedAt).toBeGreaterThan(0);
  });

  it("setProject updates existing row and bumps updated_at", async () => {
    repo.setProject(1, "/workspace/a", "ses_a");
    const first = repo.get(1)!;
    await new Promise((r) => setTimeout(r, 5));
    repo.setProject(1, "/workspace/b", "ses_b");
    const second = repo.get(1)!;
    expect(second.projectPath).toBe("/workspace/b");
    expect(second.sessionId).toBe("ses_b");
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("setSession updates only the session id, leaving project and model intact", () => {
    repo.setProject(1, "/workspace/a", "ses_old");
    repo.setModel(1, "anthropic/claude-sonnet-4-5");
    repo.setSession(1, "ses_new");
    const s = repo.get(1)!;
    expect(s.projectPath).toBe("/workspace/a");
    expect(s.sessionId).toBe("ses_new");
    expect(s.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("setSession on a missing row creates the row with null project", () => {
    repo.setSession(7, "ses_only");
    const s = repo.get(7)!;
    expect(s.projectPath).toBeNull();
    expect(s.sessionId).toBe("ses_only");
  });

  it("setModel updates only the model", () => {
    repo.setProject(1, "/workspace/a", "ses_a");
    repo.setModel(1, "openai/gpt-5");
    const s = repo.get(1)!;
    expect(s.model).toBe("openai/gpt-5");
    expect(s.sessionId).toBe("ses_a");
  });

  it("clear deletes the row", () => {
    repo.setProject(1, "/workspace/a", "ses_a");
    repo.clear(1);
    expect(repo.get(1)).toBeNull();
  });

  it("findByChatId is independent across chat ids", () => {
    repo.setProject(1, "/workspace/a", "ses_1");
    repo.setProject(2, "/workspace/b", "ses_2");
    expect(repo.get(1)!.projectPath).toBe("/workspace/a");
    expect(repo.get(2)!.projectPath).toBe("/workspace/b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/chat-state.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/chat-state.ts`**

```typescript
import type Database from "better-sqlite3";

export interface ChatState {
  chatId: number;
  projectPath: string | null;
  sessionId: string | null;
  model: string | null;
  updatedAt: number;
}

interface Row {
  chat_id: number;
  project_path: string | null;
  session_id: string | null;
  model: string | null;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_state (
    chat_id      INTEGER PRIMARY KEY,
    project_path TEXT,
    session_id   TEXT,
    model        TEXT,
    updated_at   INTEGER NOT NULL
  );
`;

function rowToState(row: Row): ChatState {
  return {
    chatId: row.chat_id,
    projectPath: row.project_path,
    sessionId: row.session_id,
    model: row.model,
    updatedAt: row.updated_at,
  };
}

export class ChatStateRepo {
  private getStmt: Database.Statement<[number]>;
  private upsertProjectStmt: Database.Statement;
  private upsertSessionStmt: Database.Statement;
  private upsertModelStmt: Database.Statement;
  private deleteStmt: Database.Statement<[number]>;

  constructor(private db: Database.Database) {
    db.exec(SCHEMA);
    this.getStmt = db.prepare("SELECT * FROM chat_state WHERE chat_id = ?");
    this.upsertProjectStmt = db.prepare(`
      INSERT INTO chat_state (chat_id, project_path, session_id, updated_at)
      VALUES (@chatId, @projectPath, @sessionId, @now)
      ON CONFLICT(chat_id) DO UPDATE SET
        project_path = excluded.project_path,
        session_id   = excluded.session_id,
        updated_at   = excluded.updated_at
    `);
    this.upsertSessionStmt = db.prepare(`
      INSERT INTO chat_state (chat_id, session_id, updated_at)
      VALUES (@chatId, @sessionId, @now)
      ON CONFLICT(chat_id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `);
    this.upsertModelStmt = db.prepare(`
      INSERT INTO chat_state (chat_id, model, updated_at)
      VALUES (@chatId, @model, @now)
      ON CONFLICT(chat_id) DO UPDATE SET
        model      = excluded.model,
        updated_at = excluded.updated_at
    `);
    this.deleteStmt = db.prepare("DELETE FROM chat_state WHERE chat_id = ?");
  }

  get(chatId: number): ChatState | null {
    const row = this.getStmt.get(chatId) as Row | undefined;
    return row ? rowToState(row) : null;
  }

  setProject(chatId: number, projectPath: string, sessionId: string): void {
    this.upsertProjectStmt.run({ chatId, projectPath, sessionId, now: Date.now() });
  }

  setSession(chatId: number, sessionId: string): void {
    this.upsertSessionStmt.run({ chatId, sessionId, now: Date.now() });
  }

  setModel(chatId: number, model: string): void {
    this.upsertModelStmt.run({ chatId, model, now: Date.now() });
  }

  clear(chatId: number): void {
    this.deleteStmt.run(chatId);
  }
}

export function openChatStateDb(filename: string): Database.Database {
  // Lazy import so tests can pass an existing in-memory db directly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
```

> **Note:** The `openChatStateDb` helper is a convenience for `index.ts`. Tests construct the repo directly with a `:memory:` db. The `require` inside is to avoid pulling the native module at module-load time during tests; the engineer may freely replace it with a top-level `import` if it works in the project's Node setup.

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/chat-state.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/chat-state.ts tg-bridge/tests/chat-state.test.ts
git commit -m "Add SQLite-backed chat state repository

Persists per-chat project/session/model with upsert semantics. Schema
is created on construction; tests use :memory: for isolation."
```

---

## Task 7: opencode-client — SDK wrapper with basic-auth fetch

Wraps `@opencode-ai/sdk`'s `createOpencodeClient` so that:
1. All HTTP requests carry HTTP Basic auth (username:password from env).
2. The rest of the bridge depends on a small interface (`OpencodeClient`) rather than the SDK directly, making consumers easy to test with fakes.

**Reference docs:** https://opencode.ai/docs/sdk/ (especially the "Client only" section). The `createOpencodeClient` factory accepts a `fetch` option — that's where the auth header is added.

**Implementation note:** The exact SDK method names (e.g. `client.session.prompt`) are stable per the docs; if a method's signature differs at the time of implementation, prefer matching the SDK's actual current shape and updating this wrapper rather than holding to this task's exact code.

**Files:**
- Create: `tg-bridge/src/opencode-client.ts`
- Create: `tg-bridge/tests/opencode-client.test.ts`

- [ ] **Step 1: Write the failing test `tests/opencode-client.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildAuthFetch } from "../src/opencode-client.js";

describe("buildAuthFetch", () => {
  it("adds an Authorization: Basic header with base64-encoded user:pass", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "opencode", "secret");

    await wrapped("http://opencode:4096/global/health");

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = (call[1] ?? {}) as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(
      "Basic " + Buffer.from("opencode:secret").toString("base64"),
    );
  });

  it("preserves existing headers and body", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    await wrapped("http://opencode:4096/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });

    const call = (inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = (call[1] ?? {}) as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toMatch(/^Basic /);
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("works when init is undefined", async () => {
    const inner = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const wrapped = buildAuthFetch(inner, "u", "p");

    await wrapped("http://opencode:4096/x");

    expect(inner).toHaveBeenCalledOnce();
    const init = ((inner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] ?? {}) as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toMatch(/^Basic /);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/opencode-client.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/opencode-client.ts`**

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";

/**
 * Wraps a fetch implementation so every request carries HTTP Basic
 * authentication using the configured credentials.
 */
export function buildAuthFetch(
  inner: typeof fetch,
  username: string,
  password: string,
): typeof fetch {
  const authHeader =
    "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", authHeader);
    return inner(input, { ...(init ?? {}), headers });
  };
}

export interface OpencodeClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
}

/**
 * The minimal interface the rest of the bridge depends on. Implemented by
 * the SDK-backed client below; can also be implemented by test fakes.
 *
 * The shapes of `Session`, `Part`, `Project`, etc. mirror what the SDK
 * returns; consumers should treat them as opaque or import the SDK types
 * directly from "@opencode-ai/sdk".
 */
export interface OpencodeClient {
  createSession(title?: string): Promise<{ id: string }>;
  abortSession(sessionId: string): Promise<boolean>;
  listSessions(): Promise<Array<{ id: string; title: string; time: { updated: number } }>>;

  /**
   * Send a prompt. Returns a promise that resolves when the assistant
   * message is complete. The caller will typically *not* await this
   * promise inline; instead it will subscribe to the event stream for
   * incremental updates and await at the end.
   */
  prompt(
    sessionId: string,
    text: string,
    options?: { model?: { providerID: string; modelID: string } },
  ): Promise<unknown>;

  listProjects(): Promise<Array<{ id?: string; path?: string; [k: string]: unknown }>>;
  listProviders(): Promise<{ providers: unknown[]; default: Record<string, string> }>;

  respondToPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember?: boolean,
  ): Promise<boolean>;

  /**
   * Subscribe to the global event stream. Returns an async iterable of
   * raw event objects (the SDK's typed union). Consumer must call
   * `controller.abort()` on `signal` to stop the stream.
   */
  subscribeToEvents(signal: AbortSignal): AsyncIterable<unknown>;
}

export function makeOpencodeClient(opts: OpencodeClientOptions): OpencodeClient {
  const innerFetch = opts.fetch ?? fetch;
  const client = createOpencodeClient({
    baseUrl: opts.baseUrl,
    fetch: buildAuthFetch(innerFetch, opts.username, opts.password),
  });

  return {
    async createSession(title) {
      const res = await client.session.create({ body: title ? { title } : {} });
      // SDK returns either `data` field or top-level depending on responseStyle.
      // Default is "fields" => { data, response, request }. Use `.data`.
      const data = (res as { data?: { id: string } }).data ?? (res as { id?: string });
      if (!data || typeof (data as { id?: unknown }).id !== "string") {
        throw new Error("createSession: unexpected response shape");
      }
      return { id: (data as { id: string }).id };
    },

    async abortSession(sessionId) {
      const res = await client.session.abort({ path: { id: sessionId } });
      const data = (res as { data?: boolean }).data ?? (res as unknown);
      return Boolean(data);
    },

    async listSessions() {
      const res = await client.session.list();
      const data = (res as { data?: unknown }).data ?? (res as unknown);
      return data as Array<{ id: string; title: string; time: { updated: number } }>;
    },

    async prompt(sessionId, text, options) {
      return client.session.prompt({
        path: { id: sessionId },
        body: {
          ...(options?.model ? { model: options.model } : {}),
          parts: [{ type: "text", text }],
        },
      });
    },

    async listProjects() {
      const res = await client.project.list();
      const data = (res as { data?: unknown }).data ?? (res as unknown);
      return data as Array<{ id?: string; path?: string }>;
    },

    async listProviders() {
      const res = await client.config.providers();
      const data = (res as { data?: unknown }).data ?? (res as unknown);
      return data as { providers: unknown[]; default: Record<string, string> };
    },

    async respondToPermission(sessionId, permissionId, response, remember) {
      // The SDK exposes this as either a flat function or nested; we use the
      // raw HTTP path as a fallback if the SDK shape differs from docs.
      // Try both; throw on neither.
      const sdkAny = client as unknown as Record<string, unknown>;
      const flat = sdkAny.postSessionByIdPermissionsByPermissionId as
        | ((args: unknown) => Promise<unknown>)
        | undefined;
      const args = {
        path: { id: sessionId, permissionID: permissionId },
        body: { response, ...(remember === undefined ? {} : { remember }) },
      };
      let res: unknown;
      if (typeof flat === "function") {
        res = await flat(args);
      } else {
        // Fallback: direct fetch via the wrapped fetch on the inner client.
        const url = `${opts.baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`;
        const wrapped = buildAuthFetch(innerFetch, opts.username, opts.password);
        const r = await wrapped(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args.body),
        });
        if (!r.ok) throw new Error(`respondToPermission failed: ${r.status}`);
        res = await r.json();
      }
      const data = (res as { data?: boolean }).data ?? (res as unknown);
      return Boolean(data);
    },

    async *subscribeToEvents(signal) {
      const sub = await client.event.subscribe({ signal });
      // The SDK exposes either { stream } or a direct async iterable.
      const stream =
        (sub as { stream?: AsyncIterable<unknown> }).stream ?? (sub as AsyncIterable<unknown>);
      for await (const evt of stream) {
        if (signal.aborted) return;
        yield evt;
      }
    },
  };
}
```

> **Implementation note:** Several `as unknown` casts are intentional — the SDK has multiple response styles (`data` vs `fields`) and method-naming conventions that may shift. The wrapper isolates that volatility. If a particular call's shape doesn't match what's coded here when the engineer runs it, prefer fixing the wrapper to match the actual SDK over fighting the types.

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/opencode-client.test.ts
```
Expected: 3 tests pass.

```sh
cd tg-bridge && npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/opencode-client.ts tg-bridge/tests/opencode-client.test.ts
git commit -m "Add opencode SDK client wrapper with basic-auth fetch

Wraps @opencode-ai/sdk so every request carries HTTP Basic auth.
Exposes a minimal OpencodeClient interface that consumers depend on,
making them easy to fake in tests."
```

---

## Common test helper for commands

All command tasks below use the same fake-context helper. Establish it once in this task and reuse:

**Files:**
- Create: `tg-bridge/tests/helpers/fake-ctx.ts`

- [ ] **Step 1: Write the helper**

```typescript
import { vi } from "vitest";

export interface FakeCtxInit {
  chatId?: number;
  fromId?: number;
  text?: string;
  match?: string; // grammy populates ctx.match for /command <args>
}

export interface FakeCtx {
  chat: { id: number; type: "private" };
  from: { id: number; is_bot: false; first_name: string };
  message: { text: string };
  match: string;
  reply: ReturnType<typeof vi.fn>;
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
  };
}

export function makeFakeCtx(init: FakeCtxInit = {}): FakeCtx {
  const reply = vi.fn(async () => ({ message_id: 1 }));
  return {
    chat: { id: init.chatId ?? 1, type: "private" },
    from: { id: init.fromId ?? 111, is_bot: false, first_name: "test" },
    message: { text: init.text ?? "" },
    match: init.match ?? "",
    reply,
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 2 })),
      editMessageText: vi.fn(async () => true),
    },
  };
}
```

- [ ] **Step 2: Commit (no tests yet — this is shared infrastructure)**

```sh
git add tg-bridge/tests/helpers/fake-ctx.ts
git commit -m "Add fake context helper for command tests"
```

---

## Task 8: /help command

Replies with a static list of available commands. No deps needed.

**Files:**
- Create: `tg-bridge/src/commands/help.ts`
- Create: `tg-bridge/tests/commands/help.test.ts`

- [ ] **Step 1: Write the failing test `tests/commands/help.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { handleHelp, HELP_TEXT } from "../../src/commands/help.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

describe("handleHelp", () => {
  it("replies with the help text in MarkdownV2", async () => {
    const ctx = makeFakeCtx();
    await handleHelp(ctx as never);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text, opts] = ctx.reply.mock.calls[0];
    expect(text).toBe(HELP_TEXT);
    expect(opts).toEqual({ parse_mode: "MarkdownV2" });
  });

  it("HELP_TEXT lists all the commands the bridge supports", () => {
    for (const cmd of ["/new", "/projects", "/switch", "/abort", "/status", "/model", "/help"]) {
      expect(HELP_TEXT).toContain(cmd);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/commands/help.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/commands/help.ts`**

```typescript
import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";

const RAW = [
  "*opencode bridge*",
  "",
  "/new — start a new session in the current project",
  "/projects — list available projects under /workspace",
  "/switch <name> — switch to a project (creates a new session)",
  "/abort — abort the current running task",
  "/status — show current project, session, and model",
  "/model [providerID/modelID] — show or set the model",
  "/help — show this message",
  "",
  "Send any other text to talk to the agent.",
].join("\n");

// Pre-escape since this is a static string. *bold* markers are kept raw;
// everything else is escaped per MarkdownV2 rules.
function buildHelpText(): string {
  // The header line uses MarkdownV2 *bold*, so escape only the inner text.
  const lines = RAW.split("\n");
  const head = lines[0]!;
  const headInner = head.slice(1, -1); // strip *...*
  const headEscaped = `*${escapeMarkdownV2(headInner)}*`;
  const rest = lines.slice(1).map(escapeMarkdownV2);
  return [headEscaped, ...rest].join("\n");
}

export const HELP_TEXT = buildHelpText();

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: "MarkdownV2" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/commands/help.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/commands/help.ts tg-bridge/tests/commands/help.test.ts
git commit -m "Add /help command with static command list"
```

---

## Task 9: /projects command

Lists subdirectories of `WORKSPACE_ROOT`. Reads via `fs.readdir`. Tests inject a temp directory.

**Files:**
- Create: `tg-bridge/src/commands/projects.ts`
- Create: `tg-bridge/tests/commands/projects.test.ts`

- [ ] **Step 1: Write the failing test `tests/commands/projects.test.ts`**

```typescript
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
    const [text] = ctx.reply.mock.calls[0];
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
    const [text] = ctx.reply.mock.calls[0];
    expect(text).not.toMatch(/\.git/);
    expect(text).toMatch(/myapp/);
  });

  it("reports when no projects are present", async () => {
    const ctx = makeFakeCtx();
    await handleProjects(ctx as never, { workspaceRoot });
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toMatch(/no projects/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/commands/projects.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/projects.ts`**

```typescript
import type { Context } from "grammy";
import { readdirSync } from "node:fs";
import { escapeMarkdownV2 } from "../format.js";

export interface ProjectsDeps {
  workspaceRoot: string;
}

export function listProjects(workspaceRoot: string): string[] {
  const entries = readdirSync(workspaceRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export async function handleProjects(ctx: Context, deps: ProjectsDeps): Promise<void> {
  const projects = listProjects(deps.workspaceRoot);
  if (projects.length === 0) {
    await ctx.reply(
      escapeMarkdownV2(`No projects found in ${deps.workspaceRoot}.`),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }
  const lines = ["*Projects:*", ...projects.map((p, i) => `${i + 1}. ${escapeMarkdownV2(p)}`)];
  // The header uses real *bold*, the rest is plain escaped text. Header text
  // ("Projects:") has no MarkdownV2 special chars except ":" so escape it.
  lines[0] = `*${escapeMarkdownV2("Projects:")}*`;
  await ctx.reply(
    [
      `*${escapeMarkdownV2("Projects")}*`,
      ...projects.map((p, i) => `${i + 1}\\. \`${p.replace(/`/g, "\\`")}\``),
      "",
      escapeMarkdownV2("Use /switch <name> to select one."),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/commands/projects.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/commands/projects.ts tg-bridge/tests/commands/projects.test.ts
git commit -m "Add /projects command listing workspace subdirectories"
```

---

## Task 10: /switch command

Switches the chat to a different project under `/workspace`. Validates the directory exists, creates a fresh opencode session, and seeds it with a `noReply: true` prompt establishing the working directory context (since opencode sessions are server-global without an intrinsic project field).

**Files:**
- Create: `tg-bridge/src/commands/switch.ts`
- Create: `tg-bridge/tests/commands/switch.test.ts`

- [ ] **Step 1: Write the failing test `tests/commands/switch.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleSwitch } from "../../src/commands/switch.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(overrides: Partial<OpencodeClient> = {}): OpencodeClient {
  return {
    createSession: vi.fn(async () => ({ id: "ses_new" })),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(async () => ({ data: { info: {}, parts: [] } })),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn((_signal) => (async function* () {})()),
    ...overrides,
  } as OpencodeClient;
}

describe("handleSwitch", () => {
  let workspaceRoot: string;
  let state: ChatStateRepo;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(workspaceRoot, "myapp"));
    state = new ChatStateRepo(new Database(":memory:"));
  });

  afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  it("rejects when no argument is given", async () => {
    const ctx = makeFakeCtx({ match: "" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/usage/i);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown project", async () => {
    const ctx = makeFakeCtx({ match: "missing" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });
    expect(ctx.reply.mock.calls[0][0]).toMatch(/no such project/i);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("rejects path-traversal arguments", async () => {
    const ctx = makeFakeCtx({ match: "../etc" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });
    expect(ctx.reply.mock.calls[0][0]).toMatch(/invalid/i);
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("creates a new session, seeds it with project context, and stores state", async () => {
    const ctx = makeFakeCtx({ chatId: 42, match: "myapp" });
    const client = makeFakeClient();
    await handleSwitch(ctx as never, { client, state, workspaceRoot });

    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.prompt).toHaveBeenCalledOnce();
    const promptCall = (client.prompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(promptCall[0]).toBe("ses_new");
    expect(promptCall[1]).toMatch(new RegExp(join(workspaceRoot, "myapp")));

    const stored = state.get(42)!;
    expect(stored.projectPath).toBe(join(workspaceRoot, "myapp"));
    expect(stored.sessionId).toBe("ses_new");

    expect(ctx.reply.mock.calls[0][0]).toMatch(/myapp/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/commands/switch.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/switch.ts`**

```typescript
import type { Context } from "grammy";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { escapeMarkdownV2 } from "../format.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface SwitchDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  workspaceRoot: string;
}

function isSafeProjectName(name: string): boolean {
  if (name.length === 0) return false;
  if (isAbsolute(name)) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.startsWith(".")) return false;
  return true;
}

export async function handleSwitch(ctx: Context, deps: SwitchDeps): Promise<void> {
  const arg = (ctx.match as string | undefined)?.trim() ?? "";
  if (arg.length === 0) {
    await ctx.reply(escapeMarkdownV2("Usage: /switch <project-name>"), {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  if (!isSafeProjectName(arg)) {
    await ctx.reply(escapeMarkdownV2("Invalid project name."), { parse_mode: "MarkdownV2" });
    return;
  }

  const projectPath = join(deps.workspaceRoot, arg);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    await ctx.reply(escapeMarkdownV2(`No such project: ${arg}`), { parse_mode: "MarkdownV2" });
    return;
  }

  const session = await deps.client.createSession(`tg:${arg}`);
  // Seed the session with a no-reply context message anchoring the agent
  // to this directory. opencode sessions don't have an intrinsic project
  // field, so we communicate the working directory in the conversation.
  await deps.client.prompt(
    session.id,
    `You are working on a project located at \`${projectPath}\`. ` +
      `Use this as the working directory for all file operations. ` +
      `Files outside this directory are out of scope.`,
  );
  deps.state.setProject(ctx.chat!.id, projectPath, session.id);

  await ctx.reply(
    [
      `*${escapeMarkdownV2(`Switched to ${arg}`)}*`,
      escapeMarkdownV2(`Project: ${projectPath}`),
      escapeMarkdownV2(`Session: ${session.id}`),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
```

> **Note:** The seeding `prompt` call here uses the default (synchronous) `prompt` shape. Because we're awaiting it without any user-visible streaming, that's fine. If `noReply` support exists at implementation time, prefer adding `noReply: true` to suppress an LLM round-trip; otherwise the seeding turn produces a small ack response that the user won't see (the bot doesn't surface it).

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/commands/switch.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/commands/switch.ts tg-bridge/tests/commands/switch.test.ts
git commit -m "Add /switch command for selecting a project

Validates the project name (no path traversal), creates a fresh
opencode session, seeds it with the working directory as context,
and persists the new project+session to chat state."
```

---

## Task 11: /new command

Starts a fresh session in the current project. Reuses the seed-context approach from `/switch`.

**Files:**
- Create: `tg-bridge/src/commands/new.ts`
- Create: `tg-bridge/tests/commands/new.test.ts`

- [ ] **Step 1: Write the failing test `tests/commands/new.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleNew } from "../../src/commands/new.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(): OpencodeClient {
  return {
    createSession: vi.fn(async () => ({ id: "ses_new" })),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(async () => ({})),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("handleNew", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("prompts the user to /switch first when no project is set", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleNew(ctx as never, { client, state });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/\/switch/);
  });

  it("creates a new session in the current project and updates state", async () => {
    state.setProject(1, "/workspace/myapp", "ses_old");
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleNew(ctx as never, { client, state });

    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.prompt).toHaveBeenCalledOnce();
    const stored = state.get(1)!;
    expect(stored.projectPath).toBe("/workspace/myapp");
    expect(stored.sessionId).toBe("ses_new");
    expect(ctx.reply.mock.calls[0][0]).toMatch(/new session/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/commands/new.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/new.ts`**

```typescript
import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface NewDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
}

export async function handleNew(ctx: Context, deps: NewDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const current = deps.state.get(chatId);
  if (!current?.projectPath) {
    await ctx.reply(
      escapeMarkdownV2("No project selected. Use /projects then /switch <name>."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  const session = await deps.client.createSession(
    `tg:${current.projectPath.split("/").pop() ?? "session"}`,
  );
  await deps.client.prompt(
    session.id,
    `You are working on a project located at \`${current.projectPath}\`. ` +
      `Use this as the working directory for all file operations.`,
  );
  deps.state.setSession(chatId, session.id);

  await ctx.reply(
    [
      `*${escapeMarkdownV2("New session")}*`,
      escapeMarkdownV2(`Project: ${current.projectPath}`),
      escapeMarkdownV2(`Session: ${session.id}`),
    ].join("\n"),
    { parse_mode: "MarkdownV2" },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/commands/new.test.ts
```
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/commands/new.ts tg-bridge/tests/commands/new.test.ts
git commit -m "Add /new command for starting a fresh session in the current project"
```

---

## Task 12: /abort command

Calls `client.abortSession` on the current session.

**Files:**
- Create: `tg-bridge/src/commands/abort.ts`
- Create: `tg-bridge/tests/commands/abort.test.ts`

- [ ] **Step 1: Write the failing test `tests/commands/abort.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleAbort } from "../../src/commands/abort.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(abortImpl?: (id: string) => Promise<boolean>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(abortImpl ?? (async () => true)),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("handleAbort", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("replies with an instruction when no session is active", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleAbort(ctx as never, { client, state });
    expect(client.abortSession).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/no active session/i);
  });

  it("calls client.abortSession with the current session id", async () => {
    state.setProject(1, "/workspace/a", "ses_x");
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient();
    await handleAbort(ctx as never, { client, state });
    expect(client.abortSession).toHaveBeenCalledWith("ses_x");
    expect(ctx.reply.mock.calls[0][0]).toMatch(/aborted/i);
  });

  it("reports failure if abort returns false", async () => {
    state.setProject(1, "/workspace/a", "ses_x");
    const ctx = makeFakeCtx({ chatId: 1 });
    const client = makeFakeClient(async () => false);
    await handleAbort(ctx as never, { client, state });
    expect(ctx.reply.mock.calls[0][0]).toMatch(/could not abort|nothing to abort/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/commands/abort.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/abort.ts`**

```typescript
import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface AbortDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
}

export async function handleAbort(ctx: Context, deps: AbortDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const current = deps.state.get(chatId);
  if (!current?.sessionId) {
    await ctx.reply(escapeMarkdownV2("No active session to abort."), {
      parse_mode: "MarkdownV2",
    });
    return;
  }
  const ok = await deps.client.abortSession(current.sessionId);
  await ctx.reply(
    escapeMarkdownV2(ok ? "Aborted." : "Could not abort (nothing to abort, perhaps?)."),
    { parse_mode: "MarkdownV2" },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/commands/abort.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/commands/abort.ts tg-bridge/tests/commands/abort.test.ts
git commit -m "Add /abort command for halting the current session"
```

---

## Task 13: /status command

Reports current project, session ID, model, and last-update time.

**Files:**
- Create: `tg-bridge/src/commands/status.ts`
- Create: `tg-bridge/tests/commands/status.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleStatus } from "../../src/commands/status.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

describe("handleStatus", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("reports 'no project' when chat state is empty", async () => {
    const ctx = makeFakeCtx({ chatId: 1 });
    await handleStatus(ctx as never, { state });
    expect(ctx.reply.mock.calls[0][0]).toMatch(/no project/i);
  });

  it("includes project, session, and default-model marker when partially set", async () => {
    state.setProject(1, "/workspace/blog", "ses_42");
    const ctx = makeFakeCtx({ chatId: 1 });
    await handleStatus(ctx as never, { state });
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toMatch(/blog/);
    expect(text).toMatch(/ses_42/);
    expect(text).toMatch(/default/i);
  });

  it("includes the explicitly-set model", async () => {
    state.setProject(1, "/workspace/blog", "ses_42");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    const ctx = makeFakeCtx({ chatId: 1 });
    await handleStatus(ctx as never, { state });
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toMatch(/claude-sonnet-4-5/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/commands/status.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/status.ts`**

```typescript
import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface StatusDeps {
  state: ChatStateRepo;
}

export async function handleStatus(ctx: Context, deps: StatusDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const current = deps.state.get(chatId);
  if (!current?.projectPath) {
    await ctx.reply(escapeMarkdownV2("No project selected. Use /projects then /switch."), {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  const lastUpdated = new Date(current.updatedAt).toISOString();
  const lines = [
    `*${escapeMarkdownV2("Status")}*`,
    escapeMarkdownV2(`Project: ${current.projectPath}`),
    escapeMarkdownV2(`Session: ${current.sessionId ?? "(none)"}`),
    escapeMarkdownV2(`Model:   ${current.model ?? "(default)"}`),
    escapeMarkdownV2(`Updated: ${lastUpdated}`),
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/commands/status.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/commands/status.ts tg-bridge/tests/commands/status.test.ts
git commit -m "Add /status command showing current project/session/model"
```

---

## Task 14: /model command

With no argument: shows current model and lists available providers. With an argument `providerID/modelID`: stores the choice in chat state.

**Files:**
- Create: `tg-bridge/src/commands/model.ts`
- Create: `tg-bridge/tests/commands/model.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../../src/chat-state.js";
import { handleModel } from "../../src/commands/model.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import type { OpencodeClient } from "../../src/opencode-client.js";

function makeFakeClient(): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({
      providers: [
        { id: "anthropic", models: { "claude-sonnet-4-5": {} } },
        { id: "openai", models: { "gpt-5": {} } },
      ],
      default: { anthropic: "claude-sonnet-4-5", openai: "gpt-5" },
    })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("handleModel", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("with no arg, lists providers and shows current model", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    const ctx = makeFakeCtx({ chatId: 1, match: "" });
    const client = makeFakeClient();
    await handleModel(ctx as never, { client, state });
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toMatch(/claude-sonnet-4-5/);
    expect(text).toMatch(/anthropic/);
    expect(text).toMatch(/openai/);
  });

  it("rejects an arg without a slash", async () => {
    const ctx = makeFakeCtx({ chatId: 1, match: "anthropic" });
    const client = makeFakeClient();
    await handleModel(ctx as never, { client, state });
    expect(ctx.reply.mock.calls[0][0]).toMatch(/format/i);
  });

  it("stores a valid providerID/modelID and confirms", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, match: "openai/gpt-5" });
    const client = makeFakeClient();
    await handleModel(ctx as never, { client, state });
    expect(state.get(1)!.model).toBe("openai/gpt-5");
    expect(ctx.reply.mock.calls[0][0]).toMatch(/gpt-5/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/commands/model.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/model.ts`**

```typescript
import type { Context } from "grammy";
import { escapeMarkdownV2 } from "../format.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { ChatStateRepo } from "../chat-state.js";

export interface ModelDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
}

interface ProviderRecord {
  id?: string;
  models?: Record<string, unknown>;
  [k: string]: unknown;
}

function isValidModelId(s: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s);
}

export async function handleModel(ctx: Context, deps: ModelDeps): Promise<void> {
  const chatId = ctx.chat!.id;
  const arg = (ctx.match as string | undefined)?.trim() ?? "";

  if (arg.length === 0) {
    const current = deps.state.get(chatId);
    const { providers, default: defaults } = await deps.client.listProviders();
    const lines = [
      `*${escapeMarkdownV2("Model")}*`,
      escapeMarkdownV2(`Current: ${current?.model ?? "(default)"}`),
      "",
      `*${escapeMarkdownV2("Available providers:")}*`,
    ];
    for (const provider of providers as ProviderRecord[]) {
      if (!provider.id) continue;
      const def = defaults[provider.id];
      const models = provider.models ? Object.keys(provider.models) : [];
      lines.push(
        escapeMarkdownV2(
          `- ${provider.id}${def ? ` (default: ${def})` : ""}: ${models.join(", ") || "n/a"}`,
        ),
      );
    }
    lines.push("", escapeMarkdownV2("Set with /model <providerID>/<modelID>"));
    await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    return;
  }

  if (!isValidModelId(arg)) {
    await ctx.reply(
      escapeMarkdownV2("Invalid format. Use /model <providerID>/<modelID> (e.g. anthropic/claude-sonnet-4-5)."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  deps.state.setModel(chatId, arg);
  await ctx.reply(escapeMarkdownV2(`Model set to ${arg}.`), { parse_mode: "MarkdownV2" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/commands/model.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/commands/model.ts tg-bridge/tests/commands/model.test.ts
git commit -m "Add /model command for showing/setting the model"
```

---

## Task 15: EventRouter — global SSE subscription with per-session dispatch

Holds a single long-lived subscription to `client.subscribeToEvents`. Dispatches events to per-session handlers registered by other components (Turn, permission handler). Auto-reconnects with exponential backoff if the stream disconnects.

**Files:**
- Create: `tg-bridge/src/event-router.ts`
- Create: `tg-bridge/tests/event-router.test.ts`

- [ ] **Step 1: Write the failing test `tests/event-router.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { EventRouter, type SessionEventHandler } from "../src/event-router.js";
import type { OpencodeClient } from "../src/opencode-client.js";

interface Pushable<T> {
  push(value: T): void;
  end(): void;
  iterable(): AsyncIterable<T>;
}

function makePushable<T>(): Pushable<T> {
  const queue: T[] = [];
  let resolveNext: ((value: IteratorResult<T>) => void) | null = null;
  let ended = false;
  return {
    push(v) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: v, done: false });
      } else {
        queue.push(v);
      }
    },
    end() {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
    iterable() {
      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          return {
            next() {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false });
              }
              if (ended) {
                return Promise.resolve({ value: undefined as never, done: true });
              }
              return new Promise<IteratorResult<T>>((resolve) => {
                resolveNext = resolve;
              });
            },
          };
        },
      };
    },
  };
}

function makeClientWithStream(stream: AsyncIterable<unknown>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => stream),
  } as OpencodeClient;
}

function makeHandler(): SessionEventHandler {
  return {
    onPartUpdated: vi.fn(),
    onIdle: vi.fn(),
    onError: vi.fn(),
    onPermissionUpdated: vi.fn(),
  };
}

describe("EventRouter", () => {
  it("dispatches message.part.updated to the handler for that session", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal);

    pushable.push({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: { type: "text", text: "hi" } },
    });

    await new Promise((r) => setImmediate(r));
    expect(handler.onPartUpdated).toHaveBeenCalledWith({ type: "text", text: "hi" });

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("ignores events for unregistered sessions", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal);

    pushable.push({
      type: "message.part.updated",
      properties: { sessionID: "ses_unknown", part: { type: "text", text: "hi" } },
    });
    await new Promise((r) => setImmediate(r));
    // No throw, no crash.

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches session.idle and session.error", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal);

    pushable.push({ type: "session.idle", properties: { sessionID: "ses_1" } });
    pushable.push({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { name: "Boom", message: "x" } },
    });
    await new Promise((r) => setImmediate(r));

    expect(handler.onIdle).toHaveBeenCalledOnce();
    expect(handler.onError).toHaveBeenCalledOnce();

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("dispatches permission.updated to the handler for the matching sessionID", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal);

    const perm = {
      id: "perm_x",
      sessionID: "ses_1",
      title: "Allow bash?",
      type: "bash",
      input: { command: "ls" },
    };
    pushable.push({ type: "permission.updated", properties: perm });
    await new Promise((r) => setImmediate(r));

    expect(handler.onPermissionUpdated).toHaveBeenCalledWith(perm);

    ac.abort();
    pushable.end();
    await runPromise;
  });

  it("unregister stops further dispatch to the handler", async () => {
    const pushable = makePushable<unknown>();
    const client = makeClientWithStream(pushable.iterable());
    const router = new EventRouter(client);
    const handler = makeHandler();
    const unregister = router.registerSession("ses_1", handler);
    const ac = new AbortController();
    const runPromise = router.start(ac.signal);

    unregister();
    pushable.push({
      type: "message.part.updated",
      properties: { sessionID: "ses_1", part: { type: "text", text: "x" } },
    });
    await new Promise((r) => setImmediate(r));
    expect(handler.onPartUpdated).not.toHaveBeenCalled();

    ac.abort();
    pushable.end();
    await runPromise;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/event-router.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/event-router.ts`**

```typescript
import type { OpencodeClient } from "./opencode-client.js";

export interface SessionEventHandler {
  onPartUpdated(part: unknown): void;
  onIdle(): void;
  onError(err: unknown): void;
  onPermissionUpdated(perm: unknown): void;
}

interface RawEvent {
  type: string;
  properties?: Record<string, unknown> & { sessionID?: string };
}

export class EventRouter {
  private handlers = new Map<string, SessionEventHandler>();

  constructor(private client: OpencodeClient) {}

  registerSession(sessionId: string, handler: SessionEventHandler): () => void {
    this.handlers.set(sessionId, handler);
    return () => {
      const current = this.handlers.get(sessionId);
      if (current === handler) this.handlers.delete(sessionId);
    };
  }

  async start(signal: AbortSignal): Promise<void> {
    let backoffMs = 500;
    while (!signal.aborted) {
      try {
        for await (const evt of this.client.subscribeToEvents(signal)) {
          backoffMs = 500; // reset on any successful event
          this.dispatch(evt as RawEvent);
        }
        // Stream ended cleanly. If we're not aborted, reconnect.
        if (signal.aborted) return;
      } catch (err) {
        if (signal.aborted) return;
        // fall through to backoff
      }
      await this.sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  private dispatch(evt: RawEvent): void {
    const sessionId =
      typeof evt.properties?.sessionID === "string" ? evt.properties.sessionID : undefined;
    if (!sessionId) return;
    const handler = this.handlers.get(sessionId);
    if (!handler) return;

    switch (evt.type) {
      case "message.part.updated": {
        const part = (evt.properties as { part?: unknown }).part;
        if (part) handler.onPartUpdated(part);
        return;
      }
      case "session.idle":
        handler.onIdle();
        return;
      case "session.error": {
        const error = (evt.properties as { error?: unknown }).error ?? new Error("session error");
        handler.onError(error);
        return;
      }
      case "permission.updated":
        handler.onPermissionUpdated(evt.properties);
        return;
      default:
        return; // ignore other event types in Phase 1
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/event-router.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/event-router.ts tg-bridge/tests/event-router.test.ts
git commit -m "Add EventRouter for SSE dispatch with reconnect

Maintains a single long-lived subscription to opencode events, fans
out by sessionID to per-session handlers. Auto-reconnects with
exponential backoff (capped at 30s) on disconnect."
```

---

## Task 16: Turn — per-message lifecycle with throttled edits

A `Turn` represents one user-prompt → agent-response cycle. It owns the placeholder Telegram message ID, accumulates parts as they stream in, and edits the placeholder ≤ 1/sec with the current rendered state. On `finalize()`, it does a last-render and splits long output into multiple messages.

**Assumption:** part updates are *snapshots* keyed by `part.id` (each event carries the full current state of that part). If the engineer finds they're deltas at integration time, change `appendPart` to append `incoming.text` to the existing buffer instead of replacing.

**Files:**
- Create: `tg-bridge/src/turn.ts`
- Create: `tg-bridge/tests/turn.test.ts`

- [ ] **Step 1: Write the failing test `tests/turn.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Turn, type TurnBot } from "../src/turn.js";

function makeBot(): TurnBot & { calls: { edits: unknown[][]; sends: unknown[][] } } {
  const calls = { edits: [] as unknown[][], sends: [] as unknown[][] };
  return {
    calls,
    async editMessageText(chatId, messageId, text, opts) {
      calls.edits.push([chatId, messageId, text, opts]);
    },
    async sendMessage(chatId, text, opts) {
      calls.sends.push([chatId, text, opts]);
      return { message_id: 100 + calls.sends.length };
    },
  };
}

describe("Turn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not edit before any part arrives", () => {
    const bot = makeBot();
    new Turn(bot, 1, 50, { throttleMs: 1000 });
    vi.advanceTimersByTime(2000);
    expect(bot.calls.edits).toHaveLength(0);
  });

  it("edits the placeholder once after throttle window when a part arrives", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "hello" });
    expect(bot.calls.edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0][2]).toBe("hello");
  });

  it("absorbs rapid updates into a single edit per throttle window", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "h" });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({ id: "p1", type: "text", text: "he" });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({ id: "p1", type: "text", text: "hello" });
    await vi.advanceTimersByTimeAsync(800);
    // After throttle window completes, exactly one edit with latest state
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0][2]).toBe("hello");
  });

  it("finalize edits placeholder with the final render and clears any pending timer", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "first" });
    await turn.finalize();
    // The pending timer would have fired at +1000ms; finalize ran immediately.
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0][2]).toBe("first");
    // No follow-up edits after finalize
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.sends).toHaveLength(0);
  });

  it("finalize splits long output: edits placeholder with first chunk, sends remaining as new messages", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    const para1 = "a".repeat(2000);
    const para2 = "b".repeat(2000);
    const para3 = "c".repeat(2000);
    turn.appendPart({ id: "p1", type: "text", text: `${para1}\n\n${para2}\n\n${para3}` });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.sends.length).toBeGreaterThanOrEqual(1);
    const allText =
      (bot.calls.edits[0][2] as string) +
      bot.calls.sends.map((c) => c[1] as string).join("");
    expect(allText).toContain(para1);
    expect(allText).toContain(para2);
    expect(allText).toContain(para3);
  });

  it("finalize with no parts edits placeholder with a 'no response' marker", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0][2]).toMatch(/no response/i);
  });

  it("showError edits placeholder with the error text and prevents further edits", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "partial" });
    await turn.showError("boom");
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0][2]).toMatch(/boom/);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.calls.edits).toHaveLength(1);
  });

  it("ignores appendPart after finalize", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    await turn.finalize();
    turn.appendPart({ id: "p1", type: "text", text: "late" });
    await vi.advanceTimersByTimeAsync(2000);
    // Only the finalize edit
    expect(bot.calls.edits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/turn.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/turn.ts`**

```typescript
import { renderParts, escapeMarkdownV2, type RenderablePart } from "./format.js";
import { chunkForTelegram } from "./chunker.js";

export interface TurnBot {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode: "MarkdownV2" },
  ): Promise<unknown>;
  sendMessage(
    chatId: number,
    text: string,
    opts: { parse_mode: "MarkdownV2" },
  ): Promise<{ message_id: number }>;
}

export interface IncomingPart {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  state?: { status: string; input?: unknown; output?: string };
}

export interface TurnOptions {
  throttleMs?: number;
}

export class Turn {
  private parts: Map<string, IncomingPart> = new Map();
  private partOrder: string[] = [];
  private lastEditAt = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private inFlightEdit: Promise<void> | null = null;
  private throttleMs: number;

  constructor(
    private bot: TurnBot,
    private chatId: number,
    private placeholderMessageId: number,
    options: TurnOptions = {},
  ) {
    this.throttleMs = options.throttleMs ?? 1000;
  }

  appendPart(part: IncomingPart): void {
    if (this.finalized) return;
    if (!this.parts.has(part.id)) this.partOrder.push(part.id);
    this.parts.set(part.id, part);
    this.scheduleEdit();
  }

  async showError(error: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    await this.bot.editMessageText(
      this.chatId,
      this.placeholderMessageId,
      `❌ ${escapeMarkdownV2(error)}`,
      { parse_mode: "MarkdownV2" },
    );
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);

    const text = this.renderCurrent();
    if (text.length === 0) {
      await this.bot.editMessageText(
        this.chatId,
        this.placeholderMessageId,
        escapeMarkdownV2("(no response)"),
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const chunks = chunkForTelegram(text);
    await this.bot.editMessageText(this.chatId, this.placeholderMessageId, chunks[0]!, {
      parse_mode: "MarkdownV2",
    });
    for (const chunk of chunks.slice(1)) {
      await this.bot.sendMessage(this.chatId, chunk, { parse_mode: "MarkdownV2" });
    }
  }

  private scheduleEdit(): void {
    if (this.pendingTimer || this.finalized) return;
    const now = Date.now();
    const due = this.lastEditAt + this.throttleMs;
    const delay = Math.max(0, due - now);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.lastEditAt = Date.now();
      this.inFlightEdit = this.editNow();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private async editNow(): Promise<void> {
    if (this.finalized) return;
    const text = this.renderCurrent();
    if (text.length === 0) return;
    const [first] = chunkForTelegram(text);
    if (!first) return;
    try {
      await this.bot.editMessageText(this.chatId, this.placeholderMessageId, first, {
        parse_mode: "MarkdownV2",
      });
    } catch {
      // Swallow transient edit errors (Telegram 429, "message is not modified", etc.).
      // Finalize will produce the authoritative state.
    } finally {
      this.inFlightEdit = null;
    }
  }

  private renderCurrent(): string {
    const ordered: RenderablePart[] = this.partOrder
      .map((id) => this.parts.get(id))
      .filter((p): p is IncomingPart => Boolean(p))
      .map((p) => {
        if (p.type === "text" && typeof p.text === "string") {
          return { type: "text", text: p.text };
        }
        if (p.type === "tool" && typeof p.tool === "string" && p.state) {
          return {
            type: "tool",
            tool: p.tool,
            state: {
              status: p.state.status as "pending" | "running" | "completed" | "error",
              input: p.state.input,
              output: p.state.output,
            },
          };
        }
        return { type: p.type } as RenderablePart;
      });
    return renderParts(ordered);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/turn.test.ts
```
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/turn.ts tg-bridge/tests/turn.test.ts
git commit -m "Add Turn class for per-message streaming lifecycle

Accumulates parts by id, edits the placeholder Telegram message at
most once per throttle window with the current render. On finalize,
splits long output into multiple messages."
```

---

## Task 17: PermissionService — inline keyboard + callback handling

Surfaces opencode's `permission.updated` events as Telegram inline-keyboard messages and routes button presses back to opencode via `client.respondToPermission`. Auto-denies after a timeout.

**Files:**
- Create: `tg-bridge/src/permissions.ts`
- Create: `tg-bridge/tests/permissions.test.ts`

- [ ] **Step 1: Write the failing test `tests/permissions.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionService, type PermissionBot } from "../src/permissions.js";
import type { OpencodeClient } from "../src/opencode-client.js";

function makeBot(): PermissionBot & {
  calls: { sends: unknown[][]; edits: unknown[][]; answers: unknown[][] };
} {
  const calls = { sends: [] as unknown[][], edits: [] as unknown[][], answers: [] as unknown[][] };
  return {
    calls,
    async sendMessage(chatId, text, opts) {
      calls.sends.push([chatId, text, opts]);
      return { message_id: 700 + calls.sends.length };
    },
    async editMessageText(chatId, messageId, text, opts) {
      calls.edits.push([chatId, messageId, text, opts]);
    },
    async answerCallbackQuery(id, opts) {
      calls.answers.push([id, opts]);
    },
  };
}

function makeClient(): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("PermissionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sendRequest sends a Telegram message with three inline buttons", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_x",
      sessionID: "ses_1",
      title: "Allow bash command?",
      type: "bash",
      input: { command: "ls" },
    });
    expect(bot.calls.sends).toHaveLength(1);
    const [chatId, text, opts] = bot.calls.sends[0];
    expect(chatId).toBe(42);
    expect(text).toMatch(/Allow bash command/);
    const kb = (opts as { reply_markup?: { inline_keyboard?: unknown[][] } }).reply_markup;
    expect(kb?.inline_keyboard?.[0]).toHaveLength(3);
    const buttons = kb!.inline_keyboard![0]!.map(
      (b) => (b as { text: string; callback_data: string }).callback_data,
    );
    expect(buttons).toEqual(["perm:perm_x:once", "perm:perm_x:always", "perm:perm_x:deny"]);
  });

  it("handleCallback (once) calls respondToPermission(allow, false) and edits the message", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_x",
      sessionID: "ses_1",
      title: "Allow?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb1",
      data: "perm:perm_x:once",
      message: { chat: { id: 42 }, message_id: 701 },
    });
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_x", "allow", false);
    expect(bot.calls.answers).toHaveLength(1);
    expect(bot.calls.edits.length).toBeGreaterThan(0);
  });

  it("handleCallback (always) calls respondToPermission(allow, true)", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_y",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb2",
      data: "perm:perm_y:always",
      message: { chat: { id: 42 }, message_id: 702 },
    });
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_y", "allow", true);
  });

  it("handleCallback (deny) calls respondToPermission(deny, false)", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_z",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb3",
      data: "perm:perm_z:deny",
      message: { chat: { id: 42 }, message_id: 703 },
    });
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_z", "deny", false);
  });

  it("auto-denies after timeout if no button is pressed", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_t",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_t", "deny", false);
  });

  it("ignores callbacks whose data does not match the perm: prefix", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.handleCallback({
      id: "cb_other",
      data: "other:thing",
      message: { chat: { id: 42 }, message_id: 1 },
    });
    expect(client.respondToPermission).not.toHaveBeenCalled();
  });

  it("ignores duplicate callbacks for the same permission id", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_dup",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb1",
      data: "perm:perm_dup:once",
      message: { chat: { id: 42 }, message_id: 700 },
    });
    await svc.handleCallback({
      id: "cb2",
      data: "perm:perm_dup:deny",
      message: { chat: { id: 42 }, message_id: 700 },
    });
    expect(client.respondToPermission).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/permissions.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/permissions.ts`**

```typescript
import { escapeMarkdownV2 } from "./format.js";
import type { OpencodeClient } from "./opencode-client.js";

export interface PermissionBot {
  sendMessage(
    chatId: number,
    text: string,
    opts: {
      parse_mode: "MarkdownV2";
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    },
  ): Promise<{ message_id: number }>;

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode: "MarkdownV2" },
  ): Promise<unknown>;

  answerCallbackQuery(id: string, opts?: { text?: string }): Promise<unknown>;
}

export interface PermissionRequest {
  id: string;
  sessionID?: string;
  title?: string;
  type?: string;
  input?: unknown;
}

export interface CallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

export interface PermissionServiceOptions {
  timeoutMs: number;
}

interface Pending {
  sessionId: string;
  chatId: number;
  messageId: number;
  timer: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

export class PermissionService {
  private pending = new Map<string, Pending>();

  constructor(
    private bot: PermissionBot,
    private client: OpencodeClient,
    private options: PermissionServiceOptions,
  ) {}

  async sendRequest(chatId: number, sessionId: string, perm: PermissionRequest): Promise<void> {
    const title = perm.title ?? `Permission requested${perm.type ? ` (${perm.type})` : ""}`;
    const text = `🔐 ${escapeMarkdownV2(title)}`;
    const sent = await this.bot.sendMessage(chatId, text, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Once", callback_data: `perm:${perm.id}:once` },
            { text: "✓ Always", callback_data: `perm:${perm.id}:always` },
            { text: "❌ Deny", callback_data: `perm:${perm.id}:deny` },
          ],
        ],
      },
    });

    const timer = setTimeout(() => {
      void this.autoDeny(perm.id);
    }, this.options.timeoutMs);

    this.pending.set(perm.id, {
      sessionId,
      chatId,
      messageId: sent.message_id,
      timer,
      resolved: false,
    });
  }

  async handleCallback(cb: CallbackQuery): Promise<void> {
    const data = cb.data ?? "";
    if (!data.startsWith("perm:")) return;
    const parts = data.split(":");
    if (parts.length !== 3) return;
    const [, permId, action] = parts as [string, string, string];

    const entry = this.pending.get(permId);
    if (!entry || entry.resolved) {
      await this.bot.answerCallbackQuery(cb.id, { text: "Already responded" }).catch(() => {});
      return;
    }
    entry.resolved = true;
    clearTimeout(entry.timer);

    let response: "allow" | "deny";
    let remember = false;
    if (action === "once") {
      response = "allow";
    } else if (action === "always") {
      response = "allow";
      remember = true;
    } else if (action === "deny") {
      response = "deny";
    } else {
      return;
    }

    try {
      await this.client.respondToPermission(entry.sessionId, permId, response, remember);
    } finally {
      const status =
        response === "allow" ? (remember ? "✓ Allowed (always)" : "✅ Allowed once") : "❌ Denied";
      await this.bot
        .editMessageText(entry.chatId, entry.messageId, escapeMarkdownV2(status), {
          parse_mode: "MarkdownV2",
        })
        .catch(() => undefined);
      await this.bot.answerCallbackQuery(cb.id).catch(() => undefined);
      this.pending.delete(permId);
    }
  }

  private async autoDeny(permId: string): Promise<void> {
    const entry = this.pending.get(permId);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    try {
      await this.client.respondToPermission(entry.sessionId, permId, "deny", false);
    } finally {
      await this.bot
        .editMessageText(
          entry.chatId,
          entry.messageId,
          escapeMarkdownV2("⏱ Timed out — denied"),
          { parse_mode: "MarkdownV2" },
        )
        .catch(() => undefined);
      this.pending.delete(permId);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/permissions.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/permissions.ts tg-bridge/tests/permissions.test.ts
git commit -m "Add PermissionService for inline-keyboard permission prompts

Surfaces opencode permission.updated events as Telegram messages with
[Once]/[Always]/[Deny] buttons. Routes callback queries back to
opencode via respondToPermission. Auto-denies after timeout."
```

---

## Task 18: message-handler — default text handler orchestrating Turn + EventRouter

Handles user text messages that aren't slash commands. Looks up chat state, sends a placeholder, creates a `Turn`, registers a per-session handler with the `EventRouter`, and calls `client.prompt`.

**Files:**
- Create: `tg-bridge/src/message-handler.ts`
- Create: `tg-bridge/tests/message-handler.test.ts`

- [ ] **Step 1: Write the failing test `tests/message-handler.test.ts`**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo } from "../src/chat-state.js";
import { handleTextMessage } from "../src/message-handler.js";
import { makeFakeCtx } from "./helpers/fake-ctx.js";
import type { OpencodeClient } from "../src/opencode-client.js";
import type { SessionEventHandler } from "../src/event-router.js";

interface FakeRouter {
  registerSession: ReturnType<typeof vi.fn>;
  registered: SessionEventHandler | null;
  unregister: ReturnType<typeof vi.fn>;
}

function makeRouter(): FakeRouter {
  const router: FakeRouter = {
    registered: null,
    unregister: vi.fn(),
    registerSession: vi.fn(),
  };
  router.registerSession.mockImplementation((_id: string, handler: SessionEventHandler) => {
    router.registered = handler;
    return router.unregister;
  });
  return router;
}

function makeClient(promptImpl?: (...a: unknown[]) => Promise<unknown>): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(promptImpl ?? (async () => ({}))),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

function makeBot() {
  return {
    editMessageText: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ message_id: 999 })),
  };
}

describe("handleTextMessage", () => {
  let state: ChatStateRepo;

  beforeEach(() => {
    state = new ChatStateRepo(new Database(":memory:"));
  });

  it("prompts the user to /switch when no project is set", async () => {
    const ctx = makeFakeCtx({ chatId: 1, text: "hi" });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/\/switch/);
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("with project+session: sends placeholder, registers handler, calls client.prompt", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "do the thing" });
    // Emulate placeholder send via ctx.reply (returning the placeholder message id)
    ctx.reply.mockResolvedValue({ message_id: 555 });

    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(router.registerSession).toHaveBeenCalledWith("ses_a", expect.any(Object));
    expect(client.prompt).toHaveBeenCalledWith("ses_a", "do the thing", undefined);
  });

  it("passes the configured model to client.prompt", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    state.setModel(1, "anthropic/claude-sonnet-4-5");
    const ctx = makeFakeCtx({ chatId: 1, text: "hello" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(client.prompt).toHaveBeenCalledWith("ses_a", "hello", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    });
  });

  it("on prompt rejection: shows error via the placeholder message and unregisters", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "x" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();
    const client = makeClient(async () => {
      throw new Error("boom");
    });
    const bot = makeBot();
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: { sendRequest: vi.fn() } as never,
    });
    expect(bot.editMessageText).toHaveBeenCalled();
    const args = bot.editMessageText.mock.calls[0];
    expect(String(args[2])).toMatch(/boom/);
    expect(router.unregister).toHaveBeenCalled();
  });

  it("permission events route to PermissionService.sendRequest", async () => {
    state.setProject(1, "/workspace/a", "ses_a");
    const ctx = makeFakeCtx({ chatId: 1, text: "x" });
    ctx.reply.mockResolvedValue({ message_id: 555 });
    const router = makeRouter();
    const client = makeClient();
    const bot = makeBot();
    const permissions = { sendRequest: vi.fn(async () => undefined) };
    await handleTextMessage(ctx as never, {
      state,
      client,
      router,
      bot,
      permissions: permissions as never,
    });
    const handler = router.registered!;
    handler.onPermissionUpdated({ id: "p1", sessionID: "ses_a", title: "ok?", type: "bash" });
    expect(permissions.sendRequest).toHaveBeenCalledWith(1, "ses_a", expect.objectContaining({ id: "p1" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd tg-bridge && npx vitest run tests/message-handler.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/message-handler.ts`**

```typescript
import type { Context } from "grammy";
import { escapeMarkdownV2 } from "./format.js";
import { Turn, type TurnBot } from "./turn.js";
import type { OpencodeClient } from "./opencode-client.js";
import type { ChatStateRepo } from "./chat-state.js";
import type { SessionEventHandler } from "./event-router.js";
import type { PermissionService } from "./permissions.js";

export interface MessageHandlerDeps {
  state: ChatStateRepo;
  client: OpencodeClient;
  router: {
    registerSession(sessionId: string, handler: SessionEventHandler): () => void;
  };
  permissions: Pick<PermissionService, "sendRequest">;
  bot: TurnBot;
}

interface IncomingTextPart {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  state?: { status: string; input?: unknown; output?: string };
}

function parseModel(modelId: string): { providerID: string; modelID: string } | undefined {
  const idx = modelId.indexOf("/");
  if (idx <= 0 || idx === modelId.length - 1) return undefined;
  return { providerID: modelId.slice(0, idx), modelID: modelId.slice(idx + 1) };
}

export async function handleTextMessage(ctx: Context, deps: MessageHandlerDeps): Promise<void> {
  const text = ctx.message?.text;
  if (typeof text !== "string" || text.startsWith("/")) return;

  const chatId = ctx.chat!.id;
  const stateRow = deps.state.get(chatId);
  if (!stateRow?.projectPath || !stateRow.sessionId) {
    await ctx.reply(
      escapeMarkdownV2("No active session. Use /projects then /switch <name>."),
      { parse_mode: "MarkdownV2" },
    );
    return;
  }

  const placeholder = await ctx.reply(escapeMarkdownV2("thinking…"), {
    parse_mode: "MarkdownV2",
  });
  const placeholderId =
    typeof (placeholder as { message_id?: number }).message_id === "number"
      ? (placeholder as { message_id: number }).message_id
      : 0;

  const turn = new Turn(deps.bot, chatId, placeholderId);
  const sessionId = stateRow.sessionId;
  let unregistered = false;

  const handler: SessionEventHandler = {
    onPartUpdated(part) {
      const p = part as IncomingTextPart;
      if (typeof p.id === "string") turn.appendPart(p);
    },
    async onIdle() {
      await turn.finalize();
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    async onError(err) {
      const msg = err instanceof Error ? err.message : String(err);
      await turn.showError(msg);
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
    onPermissionUpdated(perm) {
      void deps.permissions.sendRequest(chatId, sessionId, perm as never);
    },
  };

  const unregister = deps.router.registerSession(sessionId, handler);

  const model = stateRow.model ? parseModel(stateRow.model) : undefined;
  try {
    await deps.client.prompt(sessionId, text, model ? { model } : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await turn.showError(`prompt failed: ${msg}`);
    if (!unregistered) {
      unregistered = true;
      unregister();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```sh
cd tg-bridge && npx vitest run tests/message-handler.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/message-handler.ts tg-bridge/tests/message-handler.test.ts
git commit -m "Add default text-message handler

Looks up chat state, sends placeholder, wires a Turn through the
EventRouter for the current session, and calls client.prompt. On
HTTP failure, surfaces the error via the placeholder message."
```

---

## Task 19: index.ts — entry point wiring everything together

Composition root. Loads config, initializes dependencies, registers grammy handlers, starts the EventRouter and the bot. No business logic; the wiring itself is the only thing it owns.

**Files:**
- Create: `tg-bridge/src/index.ts`

> **Note:** No unit tests for `index.ts` — it's pure composition. Validation is via `tsc --noEmit` plus the smoke test in BOOTSTRAP after deployment.

- [ ] **Step 1: Implement `src/index.ts`**

```typescript
import { Bot, type Context } from "grammy";
import pino from "pino";
import { loadConfig } from "./config.js";
import { whitelistMiddleware } from "./auth.js";
import { ChatStateRepo, openChatStateDb } from "./chat-state.js";
import { makeOpencodeClient } from "./opencode-client.js";
import { EventRouter } from "./event-router.js";
import { PermissionService } from "./permissions.js";
import { handleHelp } from "./commands/help.js";
import { handleProjects } from "./commands/projects.js";
import { handleSwitch } from "./commands/switch.js";
import { handleNew } from "./commands/new.js";
import { handleAbort } from "./commands/abort.js";
import { handleStatus } from "./commands/status.js";
import { handleModel } from "./commands/model.js";
import { handleTextMessage } from "./message-handler.js";

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SQLITE_PATH = process.env.SQLITE_PATH ?? "/data/chat-state.sqlite";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });

  const db = openChatStateDb(SQLITE_PATH);
  const state = new ChatStateRepo(db);

  const client = makeOpencodeClient({
    baseUrl: config.opencodeUrl,
    username: config.opencodeUsername,
    password: config.opencodePassword,
  });

  const router = new EventRouter(client);

  const bot = new Bot(config.telegramBotToken);

  // The TurnBot/PermissionBot interfaces are satisfied by grammy's bot.api.
  const turnBot = {
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      opts: { parse_mode: "MarkdownV2" },
    ) => bot.api.editMessageText(chatId, messageId, text, opts),
    sendMessage: (chatId: number, text: string, opts: { parse_mode: "MarkdownV2" }) =>
      bot.api.sendMessage(chatId, text, opts),
  };

  const permBot = {
    sendMessage: (
      chatId: number,
      text: string,
      opts: Parameters<typeof bot.api.sendMessage>[2],
    ) => bot.api.sendMessage(chatId, text, opts),
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      opts: Parameters<typeof bot.api.editMessageText>[3],
    ) => bot.api.editMessageText(chatId, messageId, text, opts),
    answerCallbackQuery: (id: string, opts?: Parameters<typeof bot.api.answerCallbackQuery>[1]) =>
      bot.api.answerCallbackQuery(id, opts),
  };

  const permissions = new PermissionService(permBot as never, client, {
    timeoutMs: PERMISSION_TIMEOUT_MS,
  });

  // 1) Whitelist gate runs before everything else.
  bot.use(whitelistMiddleware(config.allowedUserIds));

  // 2) Slash commands.
  bot.command("help", (ctx: Context) => handleHelp(ctx));
  bot.command("projects", (ctx) => handleProjects(ctx, { workspaceRoot: config.workspaceRoot }));
  bot.command("switch", (ctx) =>
    handleSwitch(ctx, { client, state, workspaceRoot: config.workspaceRoot }),
  );
  bot.command("new", (ctx) => handleNew(ctx, { client, state }));
  bot.command("abort", (ctx) => handleAbort(ctx, { client, state }));
  bot.command("status", (ctx) => handleStatus(ctx, { state }));
  bot.command("model", (ctx) => handleModel(ctx, { client, state }));

  // 3) Permission button callbacks.
  bot.on("callback_query:data", async (ctx) => {
    await permissions.handleCallback({
      id: ctx.callbackQuery.id,
      data: ctx.callbackQuery.data,
      message: ctx.callbackQuery.message
        ? {
            chat: { id: ctx.callbackQuery.message.chat.id },
            message_id: ctx.callbackQuery.message.message_id,
          }
        : undefined,
    });
  });

  // 4) Default text handler.
  bot.on("message:text", (ctx) =>
    handleTextMessage(ctx, { state, client, router, permissions, bot: turnBot }),
  );

  // 5) Start the SSE consumer in the background; never await it.
  const ac = new AbortController();
  void router.start(ac.signal).catch((err) => log.error({ err }, "EventRouter exited"));

  // 6) Start polling.
  const stop = async () => {
    log.info("shutting down");
    ac.abort();
    await bot.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  log.info({ workspaceRoot: config.workspaceRoot, opencodeUrl: config.opencodeUrl }, "starting");
  await bot.start({ drop_pending_updates: true });
}

main().catch((err) => {
  // Top-level errors crash the process so the container restart policy kicks in.
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the typecheck passes**

```sh
cd tg-bridge && npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Verify the build produces a runnable `dist/index.js`**

```sh
cd tg-bridge && npm run build
ls -la dist/index.js
```
Expected: file exists, no errors.

- [ ] **Step 4: Run the full test suite to confirm nothing regressed**

```sh
cd tg-bridge && npm test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/src/index.ts
git commit -m "Add bot entry point wiring config, deps, and handlers

Composition root: loads config, opens SQLite, instantiates the
opencode client + EventRouter + PermissionService, registers
whitelist middleware, slash commands, callback handler, and the
default text handler, then starts polling."
```

---

## Task 20: tg-bridge Dockerfile

Multi-stage build: builder compiles TypeScript and installs dev deps, runtime image carries only the compiled `dist/` and production deps. `better-sqlite3` is a native module so the builder needs `python3` and `build-essential`; the runtime image only needs `libstdc++`.

**Files:**
- Create: `tg-bridge/Dockerfile`
- Create: `tg-bridge/.dockerignore`

- [ ] **Step 1: Write `tg-bridge/.dockerignore`**

```
node_modules
dist
coverage
*.sqlite
*.sqlite-journal
.vscode
.idea
.git
tests
```

- [ ] **Step 2: Write `tg-bridge/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Native deps for better-sqlite3 build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build

# Strip dev deps for the runtime image
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# better-sqlite3's prebuilt binary needs libstdc++; bookworm-slim ships it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 bridge \
 && useradd  --system --uid 1001 --gid bridge --home /app --shell /sbin/nologin bridge \
 && mkdir -p /data \
 && chown -R bridge:bridge /app /data

COPY --from=builder --chown=bridge:bridge /app/node_modules ./node_modules
COPY --from=builder --chown=bridge:bridge /app/dist ./dist
COPY --from=builder --chown=bridge:bridge /app/package.json ./package.json

USER bridge
ENV NODE_ENV=production
ENV SQLITE_PATH=/data/chat-state.sqlite

CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Verify the image builds**

```sh
docker build -t tg-bridge:dev tg-bridge
```
Expected: image builds without errors. The build will take a minute the first time (better-sqlite3 compile).

- [ ] **Step 4: Verify the entrypoint runs and crashes cleanly without env**

```sh
docker run --rm tg-bridge:dev || true
```
Expected: process exits non-zero with a `ConfigError: Invalid configuration: TELEGRAM_BOT_TOKEN ...` style message. This confirms the image starts and the config validator runs.

- [ ] **Step 5: Commit**

```sh
git add tg-bridge/Dockerfile tg-bridge/.dockerignore
git commit -m "Add multi-stage Dockerfile for tg-bridge

Builder compiles TS and installs build-time native deps for
better-sqlite3; runtime image runs as non-root user with /data as a
mount point for the SQLite file."
```

---

## Task 21: opencode-image Dockerfile + baseline config

Custom opencode image with the LSPs and CLI tools the user works with. Bakes in a baseline `opencode-config.json` whose permission policy matches the spec (allow file ops, ask for bash/network).

**Files:**
- Create: `opencode-image/Dockerfile`
- Create: `opencode-image/opencode-config.json`

> **Implementation note:** Verify the exact `permission` schema against opencode's current docs (https://opencode.ai/docs/permissions/) at implementation time. The version below reflects what we expect based on the design phase. Adjust if opencode's schema has shifted.

- [ ] **Step 1: Write `opencode-image/opencode-config.json`**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow",
    "write": "allow",
    "edit": "allow",
    "bash": "ask",
    "webfetch": "ask"
  }
}
```

- [ ] **Step 2: Write `opencode-image/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

# CLI tools opencode benefits from + LSP runtimes for the languages
# typescript-language-server runs on Node (already present)
# pyright runs on Node (installed via npm)
# gopls and rust-analyzer are language-specific; install only if needed
ARG INSTALL_GO_LSP=false
ARG INSTALL_RUST_LSP=false

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      openssh-client \
      ripgrep \
      fd-find \
      jq \
      build-essential \
      python3 \
      python3-pip \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# opencode CLI + Node-based LSPs
RUN npm install -g \
      opencode-ai \
      typescript \
      typescript-language-server \
      pyright

# Optional: Go LSP
RUN if [ "$INSTALL_GO_LSP" = "true" ]; then \
      apt-get update \
        && apt-get install -y --no-install-recommends golang-go \
        && rm -rf /var/lib/apt/lists/* \
        && go install golang.org/x/tools/gopls@latest \
        && cp /root/go/bin/gopls /usr/local/bin/gopls; \
    fi

# Optional: Rust LSP (large; ~250MB)
RUN if [ "$INSTALL_RUST_LSP" = "true" ]; then \
      apt-get update \
        && apt-get install -y --no-install-recommends rust-analyzer cargo rustc \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# Persist auth and session history at /root/.local/share/opencode (volume)
# Persist config at /root/.config/opencode (volume)
RUN mkdir -p /root/.local/share/opencode /root/.config/opencode /workspace
COPY opencode-config.json /root/.config/opencode/config.json

WORKDIR /workspace

EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

- [ ] **Step 3: Verify the image builds (default LSP set)**

```sh
docker build -t opencode-server:dev opencode-image
```
Expected: image builds. `npm install -g opencode-ai` is the slowest step.

- [ ] **Step 4: Smoke-test that opencode runs**

```sh
docker run --rm opencode-server:dev opencode --version
```
Expected: prints a version string and exits 0.

- [ ] **Step 5: Commit**

```sh
git add opencode-image/Dockerfile opencode-image/opencode-config.json
git commit -m "Add opencode server image with LSPs and baseline config

Bookworm-slim + Node 22 + opencode-ai + TypeScript/Python LSPs.
Optional build args for Go and Rust LSPs. Baseline config sets
permissions: allow file ops, ask for bash and webfetch."
```

---

## Task 22: Compose stack + .env.example

The Docker Compose file ties the two images together with a private bridge network and the volumes from the spec.

**Files:**
- Create: `deploy/compose.yaml`
- Create: `deploy/.env.example`
- Create: `deploy/README.md`

- [ ] **Step 1: Write `deploy/.env.example`**

```dotenv
# Copy this file to /mnt/user/appdata/opencode/.env (mode 0600) and fill in.

# Telegram
TELEGRAM_BOT_TOKEN=PUT_YOUR_BOTFATHER_TOKEN_HERE
# Comma-separated list of allowed Telegram numeric user IDs.
# Get yours by DMing @userinfobot.
TELEGRAM_ALLOWED_USER_IDS=000000000

# opencode server (basic auth shared between server and bridge)
OPENCODE_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=PUT_RANDOM_32_BYTE_HEX_HERE

# Optional: opencode image build flags
INSTALL_GO_LSP=false
INSTALL_RUST_LSP=false

# Logging
LOG_LEVEL=info

# Filesystem paths on the Unraid host (override if you store things elsewhere)
WORKSPACE_HOST_PATH=/mnt/user/code
APPDATA_HOST_PATH=/mnt/user/appdata/opencode
```

- [ ] **Step 2: Write `deploy/compose.yaml`**

```yaml
name: opencode-server

x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"

networks:
  opencode-net:
    driver: bridge

services:
  opencode:
    build:
      context: ../opencode-image
      args:
        INSTALL_GO_LSP: ${INSTALL_GO_LSP:-false}
        INSTALL_RUST_LSP: ${INSTALL_RUST_LSP:-false}
    image: opencode-server:local
    container_name: opencode
    restart: unless-stopped
    networks: [opencode-net]
    ports:
      # Host-published so the Tailscale plugin can serve it on the tailnet.
      # Keep bound to all interfaces; firewall the host appropriately.
      - "4096:4096"
    environment:
      OPENCODE_SERVER_USERNAME: ${OPENCODE_USERNAME:-opencode}
      OPENCODE_SERVER_PASSWORD: ${OPENCODE_SERVER_PASSWORD:?required}
    volumes:
      - ${WORKSPACE_HOST_PATH:?required}:/workspace
      - ${APPDATA_HOST_PATH:?required}/data:/root/.local/share/opencode
      - ${APPDATA_HOST_PATH:?required}/config:/root/.config/opencode
      - ${APPDATA_HOST_PATH:?required}/ssh:/root/.ssh:ro
    deploy:
      resources:
        limits:
          memory: 4g
          cpus: "2.0"
    logging: *default-logging

  tg-bridge:
    build:
      context: ../tg-bridge
    image: tg-bridge:local
    container_name: tg-bridge
    restart: unless-stopped
    depends_on: [opencode]
    networks: [opencode-net]
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:?required}
      TELEGRAM_ALLOWED_USER_IDS: ${TELEGRAM_ALLOWED_USER_IDS:?required}
      OPENCODE_URL: http://opencode:4096
      OPENCODE_USERNAME: ${OPENCODE_USERNAME:-opencode}
      OPENCODE_PASSWORD: ${OPENCODE_SERVER_PASSWORD:?required}
      WORKSPACE_ROOT: /workspace
      LOG_LEVEL: ${LOG_LEVEL:-info}
    volumes:
      # The bridge needs to see the same workspace mount to validate /switch.
      - ${WORKSPACE_HOST_PATH:?required}:/workspace:ro
      - ${APPDATA_HOST_PATH:?required}/bridge:/data
    deploy:
      resources:
        limits:
          memory: 256m
          cpus: "0.5"
    logging: *default-logging
```

- [ ] **Step 3: Write `deploy/README.md`**

```markdown
# Deploy

This directory holds the Compose file for running both containers. See
the project root's `BOOTSTRAP.md` for one-time setup steps.

## Files

- `compose.yaml` — service definitions
- `.env.example` — copy to `/mnt/user/appdata/opencode/.env` and fill in

## Common commands

Run from the repo root:

```sh
make build      # build both images
make up         # start the stack (reads /mnt/user/appdata/opencode/.env)
make down       # stop and remove containers
make logs       # tail compose logs
make restart    # down + up
```

## Volume layout (Unraid defaults)

| Container path                       | Unraid path                                    |
|--------------------------------------|------------------------------------------------|
| `/workspace` (opencode rw, bridge ro)| `/mnt/user/code`                               |
| `/root/.local/share/opencode`        | `/mnt/user/appdata/opencode/data`              |
| `/root/.config/opencode`             | `/mnt/user/appdata/opencode/config`            |
| `/root/.ssh` (ro)                    | `/mnt/user/appdata/opencode/ssh`               |
| `/data` (bridge)                     | `/mnt/user/appdata/opencode/bridge`            |

Pin all of the above to the cache pool via Unraid Mover settings.
```

- [ ] **Step 4: Validate the compose file**

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env.example config > /dev/null
```
Expected: exit 0 (compose parses; the `${...:?required}` expansions resolve because we pass example values).

- [ ] **Step 5: Update root `Makefile` to use the env file path on Unraid**

The `up` target already reads `deploy/.env`, but on Unraid the env lives at `/mnt/user/appdata/opencode/.env`. Add a deploy-specific target.

```makefile
# Append to existing Makefile (add after the existing `up:` target):

up-unraid:
	docker compose -f deploy/compose.yaml --env-file /mnt/user/appdata/opencode/.env up -d
```

Apply the edit by reading the existing Makefile and adding the `up-unraid` target after the existing targets.

- [ ] **Step 6: Commit**

```sh
git add deploy/compose.yaml deploy/.env.example deploy/README.md Makefile
git commit -m "Add Docker Compose stack with .env template

Two services on a private bridge network: opencode (publishes :4096
to the host for Tailscale) and tg-bridge (no published ports).
Resource limits, log rotation, and the volume layout match the spec."
```

---

## Task 23: BOOTSTRAP.md and README polish

The one-time setup walkthrough plus a readable top-level README.

**Files:**
- Create: `BOOTSTRAP.md`
- Modify: `README.md`

- [ ] **Step 1: Write `BOOTSTRAP.md`**

```markdown
# Bootstrap

One-time setup for the headless opencode server. All paths are Unraid
defaults; adjust if you store things elsewhere.

## Prerequisites

- Unraid with the Docker engine running
- The Tailscale Community Apps plugin installed and logged in
- A reasonable amount of disk on the cache pool (~5 GB working room)
- A Telegram account on your phone

## 1. Tailscale

1. Open the Tailscale plugin's web UI on Unraid.
2. Confirm the host's tailnet IP (e.g. `100.x.y.z`).
3. From any other tailnet device, `ping <unraid-tailnet-ip>` should succeed.

## 2. Create the Telegram bot

1. In Telegram, DM `@BotFather`.
2. Send `/newbot`. Pick a name and a unique username ending in `_bot`.
3. Save the token BotFather gives you. Treat it like a password.

## 3. Find your Telegram numeric user ID

1. DM `@userinfobot`. Save the `Id` value.
2. (Optional) Repeat for any additional users you want to allow.

## 4. Generate an SSH deploy key for git

```sh
ssh-keygen -t ed25519 -N "" -f /mnt/user/appdata/opencode/ssh/id_ed25519 \
  -C "opencode-server@$(hostname)"
chmod 600 /mnt/user/appdata/opencode/ssh/id_ed25519
```

Add the contents of `/mnt/user/appdata/opencode/ssh/id_ed25519.pub` to GitHub:
- Per-repo: Settings → Deploy keys → Add deploy key (write access if you'll push)
- Or as a personal SSH key: Settings → SSH and GPG keys → New SSH key

## 5. Generate the `.env` file

```sh
mkdir -p /mnt/user/appdata/opencode
PASSWORD="$(openssl rand -hex 32)"
cat > /mnt/user/appdata/opencode/.env <<EOF
TELEGRAM_BOT_TOKEN=PASTE_YOUR_BOTFATHER_TOKEN_HERE
TELEGRAM_ALLOWED_USER_IDS=PASTE_YOUR_NUMERIC_USER_ID_HERE
OPENCODE_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$PASSWORD
INSTALL_GO_LSP=false
INSTALL_RUST_LSP=false
LOG_LEVEL=info
WORKSPACE_HOST_PATH=/mnt/user/code
APPDATA_HOST_PATH=/mnt/user/appdata/opencode
EOF
chmod 600 /mnt/user/appdata/opencode/.env
```

Edit the file and paste the bot token and user ID where indicated.

## 6. Prepare the workspace

```sh
mkdir -p /mnt/user/code
# Clone whatever repos you'll work on into /mnt/user/code/<repo-name>
cd /mnt/user/code
git clone git@github.com:you/myapp.git
git clone git@github.com:you/blog.git
```

## 7. Clone this project somewhere on Unraid and build

```sh
git clone <this-repo-url> /mnt/user/appdata/opencode/repo
cd /mnt/user/appdata/opencode/repo
make build
```

## 8. Start the stack

```sh
make up-unraid
make logs
```

You should see opencode logging that it's listening on `:4096` and
tg-bridge logging "starting" with no errors.

## 9. Connect Anthropic (one-time, from a tailnet device)

1. From your laptop (on the tailnet), open `http://<unraid-tailnet-ip>:4096`.
2. Sign in with username `opencode` and the `OPENCODE_SERVER_PASSWORD` value.
3. Click "Connect Anthropic" (or whichever provider).
4. Complete the OAuth flow. The token is saved into the `data` volume.

## 10. Smoke test from your phone

1. In Telegram, search for your bot (the BotFather username) and start a chat.
2. Send `/help` — you should get a reply listing commands.
3. Send `/projects` — you should see your repos listed.
4. Send `/switch myapp` — bot confirms the switch and creates a session.
5. Send `what is 2+2` — bot replies "4" (or thereabouts).
6. Send `list the files in this project` — agent will use a tool. You'll see a "thinking…" message that updates as it works.
7. Send `run the tests` — agent will request bash permission. Tap `✅ Once`. The bash output appears.

If any step fails, check `make logs` and the troubleshooting notes in the design spec.

## Routine maintenance

- **Update opencode:** `make build` then `make restart`. Auth and sessions persist via the volumes.
- **Backups:** the CA Backup/Restore Unraid plugin captures `/mnt/user/appdata/opencode/*` automatically. Repos are backed by `git push`.
- **Rotate the bot token:** ask @BotFather to revoke the old one, set the new value in `/mnt/user/appdata/opencode/.env`, `make restart`.
```

- [ ] **Step 2: Replace the placeholder `README.md` with a real one**

```markdown
# Headless opencode server with Telegram bridge

An always-on, self-hosted opencode AI coding agent that you can drive
from any device:

- **Laptop:** open `opencode web` in a browser over Tailscale.
- **Phone:** chat with a Telegram bot that bridges into the opencode SDK.

## What's in here

- `opencode-image/` — Docker image for the headless opencode server (LSPs + tools)
- `tg-bridge/` — TypeScript Telegram bot using `grammy` + `@opencode-ai/sdk`
- `deploy/` — Docker Compose stack
- `docs/superpowers/specs/` — design document
- `docs/superpowers/plans/` — implementation plan

## Architecture in one diagram

```
[Phone]   ──Telegram──▶  [tg-bridge]  ──HTTP/SSE──▶  [opencode]
[Laptop]  ──Tailscale──▶                opencode web (port 4096)
                          (both containers run on Unraid)
```

## Quick start

See `BOOTSTRAP.md` for the one-time setup. After that:

```sh
make up-unraid    # start the stack
make logs         # tail logs
make down         # stop
```

## Slash commands (Telegram)

- `/help` — list commands
- `/projects` — list available projects under `/workspace`
- `/switch <name>` — pick a project (creates a fresh session)
- `/new` — start a new session in the current project
- `/abort` — stop the current task
- `/status` — show project, session, model
- `/model [providerID/modelID]` — show or set the model
- Any other text — talk to the agent

## Development

```sh
cd tg-bridge
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run dev       # tsx watch
```

## Design

The full design rationale and trade-offs are in
`docs/superpowers/specs/2026-05-02-headless-opencode-server-design.md`.
```

- [ ] **Step 3: Commit**

```sh
git add BOOTSTRAP.md README.md
git commit -m "Add BOOTSTRAP walkthrough and polish README"
```

---

## Task 24: End-to-end smoke verification

A final task to confirm the deployed stack works. This is documented as a manual checklist in `BOOTSTRAP.md` § 10, but the engineer should walk through it after deploying.

**Files:** none (verification only)

- [ ] **Step 1: Build and start the stack on a real Unraid host**

```sh
make build && make up-unraid && make logs
```
Expected: both containers come up healthy. opencode logs show `listening on 0.0.0.0:4096`. tg-bridge logs show `starting`.

- [ ] **Step 2: Connect Anthropic via opencode web**

From a tailnet device, open `http://<unraid-tailnet-ip>:4096`, log in with the basic-auth password, and complete the OAuth flow.

- [ ] **Step 3: Smoke test from Telegram**

DM the bot and run through the checklist in `BOOTSTRAP.md` § 10 (steps 2–7). Each step should produce the expected output described there.

- [ ] **Step 4: Verify session persistence across restart**

```sh
make restart
make logs
```
DM the bot `/status`. The current project and session should still be set (chat-state survives the bridge restart; opencode sessions survive via the `data` volume).

- [ ] **Step 5: Verify whitelist enforcement**

Have someone whose Telegram ID is *not* in `TELEGRAM_ALLOWED_USER_IDS` DM the bot. They should get no response. Bridge logs should show no error.

- [ ] **Step 6: Tag a release**

Once everything works:

```sh
git tag -a v0.1.0 -m "Phase 1 complete: opencode + Telegram bridge"
```

---
