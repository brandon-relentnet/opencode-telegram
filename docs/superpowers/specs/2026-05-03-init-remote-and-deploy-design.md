# `/init-remote` + `/deploy` — Design

**Date:** 2026-05-03
**Status:** Proposed
**Builds on:** `2026-05-02-telegram-project-creation-design.md` (introduced `/init` and `/clone` via `createProject` orchestrator)

## Problem

User wants to go from "idea in Telegram" to "site running on my Coolify server" without leaving the chat:

1. `/init-remote new-website` creates a local project, a private GitHub repo, and pushes the initial commit
2. Chat with the agent to write code
3. `/deploy` pushes pending changes, creates (on first run) or updates a Coolify application that watches the repo, and triggers a build
4. Subsequent code changes either auto-deploy via the Coolify webhook on push, or `/deploy` triggers an explicit rebuild

Today the bridge has `/init` (local-only project) and `/clone` (existing remote → local), but no path from local to a hosted GitHub repo, and no Coolify integration.

## Goals

1. Two new commands (`/init-remote`, `/deploy`) with the same UX shape as the existing `/init` and `/clone`: streaming agent view → final auto-switch confirmation
2. Per-project Coolify app UUID persisted in `chat_state` so `/deploy` knows whether to create or update
3. End-to-end flow: `/init-remote` → chat → `/deploy` → live URL, with no manual GitHub/Coolify UI work after one-time setup
4. Same safety guarantees as existing project commands: no path traversal, no overwrites, descriptive failures
5. Tests use the same TDD + dispatch-orchestration pattern as `/init` and `/clone`

## Non-goals

- Build pack customization (V1 always uses Nixpacks; Coolify auto-detects framework)
- Custom port (V1 always declares 3000 since most Node/Astro/Next templates use it; user can change in Coolify UI)
- Custom domain assignment (V1 uses Coolify's auto-generated `*.coolify.<your-domain>` subdomain)
- Environment variables / secrets management (Coolify supports this via API; deferred)
- Multi-environment per app (production only in V1)
- Build status polling (`/deploy-status` deferred)
- Rollback (`/rollback` deferred)
- Cleanup on partial failure (if `/init-remote` creates local repo but `gh repo create` fails, the local dir is left stranded; user must `rm -rf` and retry)
- Deploy-key fallback (we picked GitHub App method; deploy-key would be a separate spec)
- Coolify v3 (V1 targets v4 endpoints; v3 endpoints are different and out of scope)

## Architecture

### Pattern: agent-driven via `createProject` extension

Both new commands use the existing `createProject` orchestrator (same as `/init` and `/clone`):

1. Bridge validates inputs locally (no LLM cost on bad input)
2. Bridge dispatches a one-shot opencode session anchored at `/workspace`
3. Bridge sends a deterministic shell-command prompt that ends with "Reply with the single word: `<marker>` or `failed: <reason>`"
4. Bridge subscribes to the session's events; when `session.idle` fires, `detectSuccess` reads the LAST text part for the marker
5. On success, bridge takes follow-up action (auto-switch for `/init-remote`; persist UUID + send confirmation for `/deploy`)
6. On failure, bridge surfaces `failed: <reason>` to the user

This keeps the bridge code small and reuses every safety guarantee already validated for `/init` and `/clone` (per-directory SSE routing, directory-scoped permission/question reply, throttled streaming view, MarkdownV2 safety).

### Why agent-driven (recap from plan-mode brainstorm)

- Consistent with existing pattern → less novel surface area
- Agent has bash, git, gh, curl, jq in the container — no need to add a TypeScript HTTP client for Coolify
- LLM cost per command is small (deterministic shell sequence; agent runs ~3-5 tool calls)
- Failure modes from shell commands are clear and surface naturally as `failed: <reason>`
- If we ever need richer error handling (e.g. retry transient Coolify 5xx with backoff), we can promote that logic to the bridge later without breaking the user-facing contract

### Persistence

Two new nullable columns on `chat_state`:

```sql
ALTER TABLE chat_state ADD COLUMN coolify_app_uuid TEXT;
ALTER TABLE chat_state ADD COLUMN coolify_fqdn TEXT;
```

Migration runs idempotently in `openChatStateDb` (the existing `CREATE TABLE IF NOT EXISTS` schema lives there; we add the migration via `PRAGMA table_info` check).

New `ChatStateRepo` methods:
- `setCoolifyApp(chatId: number, projectPath: string, appUuid: string, fqdn: string): void`
- `getCoolifyApp(chatId: number, projectPath: string): { uuid: string; fqdn: string } | null`

Lookup is by `(chat_id, project_path)` because a single project may be deployed by multiple chats over time, and we want each chat's state isolated.

### Container changes

`opencode-image/Dockerfile` gains the GitHub CLI and `jq`:

```Dockerfile
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y gh jq \
  && rm -rf /var/lib/apt/lists/*
```

`gh` reads `GH_TOKEN` from the environment automatically — no `gh auth login` needed at container start.

### Env var additions

`deploy/.env.example` gets six new entries:

```
# /init-remote (gh CLI in opencode container reads GH_TOKEN automatically)
GH_TOKEN=ghp_...
GH_OWNER=brandon-relentnet     # optional; defaults to gh's authenticated user

# /deploy
COOLIFY_URL=https://coolify.relentnet.com
COOLIFY_TOKEN=...
COOLIFY_SERVER_UUID=...
COOLIFY_PROJECT_UUID=...
COOLIFY_GITHUB_APP_UUID=...
```

`deploy/compose.yaml` passes these through **to the opencode container** (where the agent runs). The bridge container does NOT need any of these — the bridge only orchestrates, the agent does the actual work.

The bridge ALSO reads `GH_OWNER` and `COOLIFY_URL` (purely for pre-LLM validation messages and for the final-confirmation message URL); these go in both env files. Treat them as informational.

## Components

### `tg-bridge/src/project-creator.ts` extension

Add `"init-remote"` to `CreationKind`:

```ts
export type CreationKind = "clone" | "init" | "init-remote";
```

Add `buildInitRemotePrompt(name, owner)`:

```ts
export function buildInitRemotePrompt(name: string, owner: string): string {
  return [
    "Run these commands in order, in a single bash invocation:",
    "",
    "```bash",
    `set -e`,
    `mkdir -p /workspace/${name}`,
    `cd /workspace/${name}`,
    `git init`,
    `echo "# ${name}" > README.md`,
    `git add README.md`,
    `git commit -m "Initial commit"`,
    `gh repo create ${owner}/${name} --private --source=. --remote=origin --push`,
    "```",
    "",
    "On success, reply with the single word: remote_initialized",
    "On failure, reply with: failed: <one-line reason from the failing command's output>",
    "",
    "Do not narrate. Do not run other commands. Do not retry on failure.",
  ].join("\n");
}
```

Extend `detectSuccess` marker map:

```ts
const SUCCESS_MARKER = {
  clone: /\bcloned\b/i,
  init: /\binitialized\b/i,
  "init-remote": /\bremote_initialized\b/i,
} as const;
```

This is a small change — the existing function structure (last text part + failed-prefix check + marker regex) handles `init-remote` with just the new marker entry.

### `tg-bridge/src/commands/init-remote.ts` (new)

Mirrors `commands/init.ts`:

- `handleInitRemote(ctx, deps)`: validation pipeline → dispatch
- `parseInitRemoteArgs(raw)`: returns `{ name }`
- Validation:
  - Name safety (reuse `isSafeProjectName` from `commands/switch.ts`)
  - `existsSync('/workspace/<name>')` → "failed: target /workspace/<name> already exists"
  - `process.env.GH_TOKEN` non-empty → "failed: GH_TOKEN not set; bridge cannot create remote repos"
- Dispatch: `await createProject({ kind: "init-remote", name, chatId, placeholderId, workspaceRoot, owner: deps.ghOwner }, deps)`

Wraps everything in try/catch + `describeError` (same pattern as init.ts).

### `tg-bridge/src/commands/deploy.ts` (new)

The most novel piece. Reads chat_state for the current project + Coolify app UUID, branches on first-deploy vs subsequent.

```ts
export async function handleDeploy(ctx, deps): Promise<void> {
  // 1. Pre-LLM validation
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  const stateRow = deps.state.get(chatId);
  if (!stateRow?.projectPath) {
    await ctx.reply("Use /switch <project> first, then /deploy.");
    return;
  }
  const placeholder = await ctx.reply("⏳ Deploying…");

  // 2. Look up existing Coolify app for this (chat, project)
  const existing = deps.state.getCoolifyApp(chatId, stateRow.projectPath);

  // 3. Build the appropriate prompt
  const prompt = existing
    ? buildSubsequentDeployPrompt(stateRow.projectPath, existing.uuid)
    : buildFirstDeployPrompt(stateRow.projectPath, deps.coolifyConfig);

  // 4. Dispatch — same orchestrator pattern as createProject, but with custom marker parser
  await runDeploy({
    chatId,
    placeholderId: placeholder.message_id,
    projectPath: stateRow.projectPath,
    isFirstDeploy: existing == null,
    prompt,
  }, deps);
}
```

`runDeploy` is a new function (or a generalization of `createProject`'s internals) that:
1. Calls `ensureDirectory(workspaceRoot)` for SSE coverage
2. Creates a session anchored at the project's directory (NOT workspace root — the agent needs to be IN the project to run `git push`)
3. Subscribes to events with a custom handler that:
   - Streams the agent's tool calls to a `Turn`
   - On `session.idle`: parses the LAST text part for either `deployed:<uuid>:<fqdn>` (first deploy) or `deployed` (subsequent), or `failed: ...`
4. On first-deploy success: `deps.state.setCoolifyApp(chatId, projectPath, uuid, fqdn)` + edit placeholder to "✅ Deployed: https://`<fqdn>`"
5. On subsequent-deploy success: edit placeholder to "✅ Redeployed: https://`<existing.fqdn>`"
6. On failure: `turn.showError(failureMsg)` (uses safeEdit)

### Prompt builders

**`buildFirstDeployPrompt(projectPath, config)`** — creates the Coolify app and triggers initial deploy:

```ts
export function buildFirstDeployPrompt(projectPath, config): string {
  return [
    `Run these commands in order, in a single bash invocation:`,
    ``,
    "```bash",
    `set -e`,
    `cd ${projectPath}`,
    `REPO_URL=$(git remote get-url origin)`,
    `git add -A`,
    `git diff --cached --quiet || git commit -m "Updates from Telegram session"`,
    `git push origin main`,
    `RESP=$(curl -sf -X POST "${config.url}/api/v1/applications/private-github-app" \\`,
    `  -H "Authorization: Bearer ${config.token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "project_uuid": "${config.projectUuid}",`,
    `    "server_uuid": "${config.serverUuid}",`,
    `    "environment_name": "production",`,
    `    "github_app_uuid": "${config.githubAppUuid}",`,
    `    "git_repository": "'$REPO_URL'",`,
    `    "git_branch": "main",`,
    `    "build_pack": "nixpacks",`,
    `    "ports_exposes": "3000",`,
    `    "instant_deploy": true`,
    `  }')`,
    `APP_UUID=$(echo "$RESP" | jq -r '.uuid // empty')`,
    `FQDN=$(echo "$RESP" | jq -r '.fqdn // empty')`,
    `if [ -z "$APP_UUID" ] || [ -z "$FQDN" ]; then`,
    `  echo "Coolify response missing uuid or fqdn: $RESP" >&2`,
    `  exit 1`,
    `fi`,
    `echo "deployed:$APP_UUID:$FQDN"`,
    "```",
    ``,
    `On success, reply with the line printed (deployed:UUID:FQDN).`,
    `On failure, reply with: failed: <one-line reason from the failing command>`,
    ``,
    `Do not narrate. Do not run other commands. Do not retry on failure.`,
  ].join("\n");
}
```

**`buildSubsequentDeployPrompt(projectPath, appUuid)`** — pushes + triggers rebuild on existing app:

```ts
export function buildSubsequentDeployPrompt(projectPath, appUuid): string {
  return [
    `Run these commands in order, in a single bash invocation:`,
    ``,
    "```bash",
    `set -e`,
    `cd ${projectPath}`,
    `git add -A`,
    `git diff --cached --quiet || git commit -m "Updates from Telegram session"`,
    `git push origin main`,
    `# Coolify auto-deploys on push via webhook; this guarantees a build even if there are no commits.`,
    `curl -sf -X GET "${config.url}/api/v1/deploy?uuid=${appUuid}" -H "Authorization: Bearer ${config.token}"`,
    `echo "deployed"`,
    "```",
    ``,
    `On success, reply with the single word: deployed`,
    `On failure, reply with: failed: <one-line reason>`,
    ``,
    `Do not narrate. Do not run other commands. Do not retry on failure.`,
  ].join("\n");
}
```

(Note: `config` is captured from closure in deploy.ts; the prompt builder is in commands/deploy.ts, not project-creator.ts, since these prompts include Coolify-specific config that's narrowly scoped to deploy.)

### Marker parsing

`detectSuccess` from project-creator handles the `init-remote` case naturally (just adds the marker). For deploy, we need TWO marker shapes:

- `/^deployed:([^:]+):(.+)$/` — first-deploy, captures uuid + fqdn
- `/^deployed\s*$/` — subsequent-deploy

Add a new helper `parseDeployReply(text, isFirstDeploy)` in commands/deploy.ts that returns `{ kind: "first"; uuid; fqdn } | { kind: "subsequent" } | { kind: "failed"; reason } | null`.

This lives in commands/deploy.ts (not project-creator.ts) because the parsing is deploy-specific and shouldn't pollute the generic detectSuccess.

### `tg-bridge/src/chat-state.ts` schema migration

In `openChatStateDb`, after the existing `CREATE TABLE IF NOT EXISTS chat_state ...`:

```ts
function migrateSchema(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(chat_state)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("coolify_app_uuid")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN coolify_app_uuid TEXT");
  }
  if (!colNames.has("coolify_fqdn")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN coolify_fqdn TEXT");
  }
}
```

Existing chat_state rows get `NULL` for the new columns — `getCoolifyApp` returns `null` for those rows, which correctly drives the first-deploy path.

`setCoolifyApp` and `getCoolifyApp` are simple prepared statements that respect the `(chat_id, project_path)` composite key.

### `tg-bridge/src/index.ts` wiring

After existing `/init` and `/clone` registration:

```ts
bot.command("init-remote", (ctx) =>
  handleInitRemote(ctx, {
    client,
    state,
    router,
    bot: turnBot,
    workspaceRoot,
    defaultModel,
    log,
    ghOwner: process.env.GH_OWNER,
  })
);

bot.command("deploy", (ctx) =>
  handleDeploy(ctx, {
    client,
    state,
    router,
    bot: turnBot,
    workspaceRoot,
    defaultModel,
    log,
    coolifyConfig: {
      url: process.env.COOLIFY_URL,
      token: process.env.COOLIFY_TOKEN,
      serverUuid: process.env.COOLIFY_SERVER_UUID,
      projectUuid: process.env.COOLIFY_PROJECT_UUID,
      githubAppUuid: process.env.COOLIFY_GITHUB_APP_UUID,
    },
  })
);
```

`commands/help.ts` adds two lines to RAW between `/clone` and `/abort`:

```
/init-remote <name> — create new project + private GitHub repo + push
/deploy — push pending changes + create-or-update Coolify app + deploy
```

## Data flow

### `/init-remote new-website`

```
1. User sends "/init-remote new-website" to Telegram
2. bridge: handleInitRemote validates name → /workspace/new-website doesn't exist → GH_TOKEN set
3. bridge: ctx.reply("⏳ Creating project + remote repo…") returns placeholder message_id
4. bridge: createProject({kind: "init-remote", name: "new-website", ...})
   - ensureDirectory("/workspace") for SSE coverage
   - createSession("tg:init-remote:new-website", {directory: "/workspace"})
   - registerSession with custom handler that tracks parts + on idle calls detectSuccess
   - prompt with buildInitRemotePrompt → "deployed marker is remote_initialized"
   - fire-and-forget client.prompt(sid, prompt, {model, directory: "/workspace"})
5. agent in opencode container:
   - bash: mkdir -p /workspace/new-website; cd; git init; README.md; commit;
           gh repo create brandon-relentnet/new-website --private --source=. --push
   - replies "remote_initialized"
6. bridge: detectSuccess matches \bremote_initialized\b in last text part → true
7. bridge: performAutoSwitch:
   - createSession("tg:new-website", {directory: "/workspace/new-website"}) — fresh session anchored at project
   - state.setProject(chatId, "/workspace/new-website", new_session_id)
   - router.ensureDirectory("/workspace/new-website")
   - safeEdit(placeholder) with buildSwitchConfirmation("new-website", "/workspace/new-website", new_session_id)
8. User sees: "✅ Switched to: new-website / Path: /workspace/new-website / Session: ses_xxx"
```

### `/deploy` — first time on a project

```
1. User sends "/deploy"
2. bridge: handleDeploy reads chat_state → has projectPath="/workspace/new-website", session_id="ses_xxx"
3. bridge: state.getCoolifyApp(chatId, projectPath) → null (first deploy)
4. bridge: ctx.reply("⏳ Deploying…") → placeholder message_id
5. bridge: runDeploy with isFirstDeploy=true, prompt=buildFirstDeployPrompt
   - ensureDirectory("/workspace/new-website")
   - createSession("tg:deploy:new-website", {directory: "/workspace/new-website"})
   - registerSession with handler that parses "deployed:UUID:FQDN" or "failed: ..."
   - fire-and-forget client.prompt(sid, prompt, {model, directory: "/workspace/new-website"})
6. agent in opencode container:
   - bash: cd to project, git push (no-op if no changes), POST to Coolify API,
           parse response, echo "deployed:abc-123:newwebsite-abc.coolify.relentnet.com"
   - replies with the echo'd line
7. bridge: parseDeployReply matches → {kind: "first", uuid: "abc-123", fqdn: "newwebsite-abc.coolify.relentnet.com"}
8. bridge: state.setCoolifyApp(chatId, projectPath, "abc-123", "newwebsite-abc.coolify.relentnet.com")
9. bridge: safeEdit(placeholder) with "✅ Deployed: https://newwebsite-abc.coolify.relentnet.com"
```

### `/deploy` — subsequent times

```
1-4. Same as above
5. bridge: state.getCoolifyApp returns {uuid: "abc-123", fqdn: "newwebsite-abc..."}
6. bridge: runDeploy with isFirstDeploy=false, prompt=buildSubsequentDeployPrompt(projectPath, "abc-123")
7. agent:
   - bash: cd, git push, GET /api/v1/deploy?uuid=abc-123, echo "deployed"
   - replies "deployed"
8. bridge: parseDeployReply → {kind: "subsequent"}
9. bridge: safeEdit(placeholder) with "✅ Redeployed: https://newwebsite-abc.coolify.relentnet.com"
```

## Edge cases

| Case | Behavior |
|---|---|
| `/init-remote` with name colliding with existing local dir | Pre-LLM validation: "failed: /workspace/X already exists" |
| `/init-remote` with name colliding with existing GitHub repo | Agent's `gh repo create` fails → bridge surfaces "failed: GraphQL: Name already exists on this account" or similar |
| `/init-remote` without GH_TOKEN env var | Pre-LLM validation: "failed: GH_TOKEN not set; bridge cannot create remote repos" |
| `/init-remote` with invalid name (path traversal, special chars) | Pre-LLM validation via `isSafeProjectName`: "failed: invalid project name" |
| `/deploy` with no project switched | "Use /switch <project> first, then /deploy." (no LLM dispatch) |
| `/deploy` with project that has no `git remote origin` | Agent's `git remote get-url origin` fails → "failed: no remote 'origin' found. Run /init-remote first or add a remote." |
| `/deploy` first time, Coolify GitHub App not installed | Agent's POST returns 4xx → "failed: Coolify rejected app creation: <error from response>" |
| `/deploy` first time, Coolify response missing uuid/fqdn | Agent script's check fails → "failed: Coolify response missing uuid or fqdn: `<resp>`" |
| `/deploy` subsequent, Coolify app deleted from UI | Agent's deploy API returns 404 → "failed: Coolify app `<uuid>` not found. Delete and redeploy?" — V1 surfaces error; user can manually clear chat_state in V2 |
| `/deploy` with no local changes | `git diff --cached --quiet` is true → no commit, no push needed → only the Coolify deploy API call runs → success |
| `/deploy` push fails (e.g. branch behind remote) | Agent's `git push` fails → "failed: push rejected (non-fast-forward)" — user resolves manually for V1 |
| `git push` succeeds but Coolify API call fails (network/5xx) | Agent's curl exits non-zero → "failed: Coolify API: 503 Service Unavailable" — user can re-run `/deploy` |
| `/init-remote` agent runs partially (local repo created, push fails) | Local dir + git history left in place; user must `rm -rf /workspace/<name>` and retry. Documented in V2 cleanup work. |
| `/deploy` mid-stream, user sends a different command | Existing pattern: `/deploy` is a one-shot session that runs to completion; other commands queue behind it (grammy serializes) |
| Concurrent `/deploy` from the same chat | First one wins; second one starts after first finishes (grammy serializes per-update). No deduplication needed in V1. |
| Coolify URL with trailing slash | Prompt builder strips trailing slash: `config.url.replace(/\/+$/, "")` |

## Testing strategy

### Unit tests (per task in plan)

**`tests/chat-state.test.ts`** new tests:
- `setCoolifyApp` writes uuid + fqdn for (chatId, projectPath)
- `getCoolifyApp` returns null when not set, returns `{uuid, fqdn}` when set
- Migration: opening an old DB (without the new columns) succeeds, columns added, existing rows have NULL

**`tests/project-creator.test.ts`** new tests:
- `detectSuccess` recognizes `\bremote_initialized\b` for kind=`init-remote`
- `buildInitRemotePrompt` includes name, owner, all required commands, and the marker contract
- `createProject` with kind=`init-remote` follows the same dispatch path and triggers performAutoSwitch on success

**`tests/commands/init-remote.test.ts`** new file (mirrors clone.test.ts):
- Validation: missing name → reply with usage
- Validation: invalid name → reply with "invalid project name"
- Validation: target dir exists → reply with "/workspace/X already exists"
- Validation: GH_TOKEN missing → reply with "GH_TOKEN not set"
- Happy path: dispatch to createProject with correct args
- Failure path: createProject rejection → describeError reply

**`tests/commands/deploy.test.ts`** new file:
- Validation: no project switched → "Use /switch first"
- Validation: missing COOLIFY_URL/TOKEN/UUIDs → descriptive failure
- First-deploy path: getCoolifyApp returns null → uses buildFirstDeployPrompt → on `deployed:UUID:FQDN` reply, calls setCoolifyApp + replies with FQDN
- Subsequent-deploy path: getCoolifyApp returns existing → uses buildSubsequentDeployPrompt → on `deployed` reply, replies with stored FQDN
- Failure path: agent replies with `failed: ...` → showError surfaces it
- `parseDeployReply` unit tests for all marker shapes

**`tests/commands/help.test.ts`** extension:
- `/init-remote` and `/deploy` appear in help text (loop iteration covers them automatically)

### Integration verification (manual on Unraid, after deploy)

1. `/init-remote tg-deploy-smoke-1` → see streaming view → final auto-switch confirmation
2. Visit https://github.com/`<owner>`/tg-deploy-smoke-1 → confirm private repo with one commit
3. Chat with agent: "build me a simple Astro hello-world site"
4. `/deploy` → see streaming view → final "✅ Deployed: https://..." message
5. Open the deploy URL → confirm site loads
6. Chat: "change the heading to 'Hello, World 2'"
7. `/deploy` again → confirm Coolify rebuilds, page updates after a minute
8. Verify chat_state row has coolify_app_uuid + coolify_fqdn populated

## Migration

This is a behavior addition + schema migration. The schema migration is idempotent and runs on bridge startup (in `openChatStateDb`). Existing chats keep working; the new columns are NULL until first `/deploy`.

Rollout:
1. Land all code changes via subagent-driven-development
2. Update opencode-image Dockerfile (gh + jq)
3. Update deploy/.env.example documenting the new env vars
4. Update BOOTSTRAP.md with one-time Coolify GitHub App + token setup section
5. User adds the 6 new env vars to `/mnt/user/appdata/opencode/.env` on Unraid
6. SSH deploy: `git pull && docker compose build && docker compose up -d` (rebuilds both opencode-image and tg-bridge)
7. User runs the 8-step smoke test above

## Risks

- **Coolify v3 vs v4 endpoints**: V1 hardcodes v4 paths (`/api/v1/applications/private-github-app`, `/api/v1/deploy`). If user is on v3, agent will get 404 and surface "failed: Coolify response missing uuid or fqdn" — easy fix once we know the version.
- **Coolify API response shape**: V1 assumes `{ uuid, fqdn, ... }` on app creation. If the actual shape differs, the agent script's `jq -r '.uuid // empty'` will surface the issue clearly. We can adjust once we see a real response.
- **GH_TOKEN scope insufficient**: User must grant `repo` + `workflow` (latter for actions later). If only `repo`, `gh repo create` works but Coolify GitHub App webhook may need `workflow`. Easy fix: regenerate token.
- **Default port 3000 mismatch**: V1 always tells Coolify to expose 3000. Astro/Next/SvelteKit/Express all use 3000 by default. Static sites (no port) will need user to change it in Coolify UI. Acceptable for V1.
- **No cleanup on partial failure**: If `/init-remote` creates the local dir but `gh repo create` fails (e.g. name collision), the local dir is stranded. User must `docker exec opencode rm -rf /workspace/<name>` and retry. V2 could add cleanup logic.
- **chat_state coolify_app_uuid pinned to a specific (chat, project)**: If user switches between chats and re-runs `/deploy` on the same project, the first chat's Coolify app stays bound; the second chat creates a duplicate app. V2 could share by project_path only.
- **Concurrent deploys**: grammy serializes per-update, but a stale `/deploy` (sent while previous still running) waits in the queue. User sees "⏳ Deploying…" promptly but actual work happens after queue drains. Acceptable; matches existing per-chat-serial behavior.

## Out of scope (logged for V2/V3)

- Build pack flag (`/deploy --build-pack dockerfile`)
- Port flag (`/deploy --port 8080`)
- Domain flag (`/deploy --domain my-site.com`)
- Environment variable management (`/env-set KEY=value`)
- Multi-environment per app (staging vs production)
- `/deploy-status` polling Coolify for build status
- `/rollback` triggering Coolify rollback
- `/destroy` removing the Coolify app + GitHub repo
- Cleanup on `/init-remote` partial failure
- Coolify v3 endpoint compatibility
- Per-project Coolify app shared across chats
