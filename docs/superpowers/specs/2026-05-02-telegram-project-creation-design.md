# Telegram Project Creation (`/clone`, `/init`) — Design

**Date:** 2026-05-02
**Status:** Approved
**Builds on:** `2026-05-02-telegram-render-overhaul-design.md` (uses the streaming + final view from that work)

## Problem

Users cannot bootstrap new projects from Telegram. Today:

- `/projects` lists existing subdirectories of `/workspace`
- `/switch <name>` requires the project to **already exist** on disk (`commands/switch.ts:45` rejects non-existent paths)
- `/new` only resets the conversation **within** the current project
- The bridge container has `/workspace:ro` (read-only, see `deploy/compose.yaml:62`) and lacks `git`/`ssh-client`, so it cannot mutate workspace contents

To work on a new repo from a phone, the user has to SSH into Unraid, `git clone` manually, then return to Telegram and `/switch`. This breaks the "code from any device" promise.

## Goals

1. Provide `/clone <git-url> [name]` to clone an existing git repo into `/workspace`
2. Provide `/init <name>` to create a new empty project (mkdir + `git init`) under `/workspace`
3. After successful creation, automatically switch the chat to the new project (no second command required)
4. Surface failures (auth, network, name collision, host-key prompts) to the user with enough context to debug
5. Add zero infrastructure: no compose changes, no Dockerfile changes, no new dependencies

## Non-goals

- Private HTTPS clones with embedded credentials. SSH-key auth is the supported path. HTTPS-public works; HTTPS-private fails with the underlying git error.
- Branch/tag/commit selection at clone time (always uses remote default branch). User can `git checkout` after via opencode.
- Removing/renaming projects from Telegram (use SSH or opencode web for now).
- Concurrent-creation race protection. Single-user system; last-write-wins on chat-state is acceptable.
- Bypassing opencode's permission system. Server policy is `allow` for everything, so bash runs without keyboard prompts. If a future policy tightens bash, the existing permission flow handles it.
- Token-free creation (deferred — see Risks).

## Architecture

### Execution strategy: LLM-via-prompt

Both commands send a **deterministic, tightly-constrained prompt** to a one-shot opencode session anchored at `/workspace` (the parent directory). The LLM uses its `bash` tool to execute the actual `git clone` or `mkdir + git init` command. Bridge then auto-switches the chat to the newly-created project.

**Why this approach (recap of the brainstorm):**

- Zero infrastructure changes (no compose update, no new images, no SSH-key remount on bridge, no UID-1001 file-permission fiddliness)
- Reuses the streaming + final view from the render overhaul — user sees `⚡ bash \`git clone ...\`` live as it runs
- Reuses the existing permission flow (currently `allow` everywhere)
- Reuses the existing safeEdit/safeSend safety net
- Trade-off: ~$0.005-$0.02 per command in Anthropic tokens. Acceptable for the convenience.

### Data flow (clone, success path)

```
User: /clone git@github.com:foo/bar.git
   ↓
clone.ts handler:
  1. Parse name (explicit arg, else basename of URL minus .git)
  2. Validate: name format (alphanumeric + - _, no leading dot, no path separators)
  3. Validate: target path /workspace/<name> does not exist (readdirSync on parent)
  4. Validate: URL matches a permissive git-URL regex
  5. Send placeholder "cloning <name>…"
  6. Delegate to project-creator.ts
   ↓
project-creator.ts:
  1. createSession(title=`tg:clone:<name>`, directory=/workspace)
  2. Build a dedicated SessionEventHandler (NOT the standard message-handler one):
     - onPartUpdated → drives a Turn (streaming view, same as user-typed prompts)
     - onIdle → check assistant text for success marker; on success run auto-switch then replace placeholder
     - onError → show error via Turn.showError
  3. Register handler with EventRouter (via ensureDirectory(/workspace) for SSE coverage)
  4. Fire-and-forget client.prompt(sessionId, deterministic-prompt, { directory: /workspace })
   ↓
opencode runs the LLM:
  - Stream: bash tool call for `git clone -o StrictHostKeyChecking=accept-new <URL> /workspace/<NAME>`
  - Bridge's Turn renders the streaming view live
  - On idle: assistant text = "cloned"
   ↓
project-creator's onIdle handler:
  1. Detect /^cloned/i in concatenated text parts
  2. Run auto-switch logic (extracted from switch.ts):
     - createSession(title=`tg:<name>`, directory=/workspace/<name>)
     - state.setProject(chatId, /workspace/<name>, sessionId)
     - router.ensureDirectory(/workspace/<name>)
  3. Replace the placeholder via safeEdit with the standard switch-confirmation message
     (same format as /switch's existing reply: "*Switched to <name>*\nProject: ...\nSession: ...")
  4. Discard the create-session — short-lived, won't be reused
```

### Data flow (clone, failure path)

```
... (steps 1-5 same as success path) ...
   ↓
opencode runs the LLM:
  - Stream: bash tool call fails (auth, network, name conflict on disk, etc.)
  - Bridge's Turn renders the streaming view including the bash error
  - On idle: assistant text = "failed: <reason>"
   ↓
project-creator's onIdle handler:
  1. Detect text does NOT match /^cloned/i (or /^initialized/i)
  2. Skip auto-switch
  3. Let the existing Turn.finalize() render the LLM's error response into the placeholder
     (the user sees: streaming view of bash + the final "failed: ..." text)
  4. Chat-state unchanged — user is still in their previous project (or no project)
```

### Init flow

Same as clone but the bridge command is simpler (no URL parsing) and the deterministic prompt uses `mkdir -p /workspace/<NAME> && git init /workspace/<NAME>` instead. The success marker is `initialized`.

## Components

### `tg-bridge/src/commands/clone.ts` — new

Single exported handler `handleClone(ctx, deps)`. Responsibilities:

- Parse arguments: split `ctx.match` on whitespace; first token is URL, second optional token is explicit name override
- Derive name from URL when not explicit: split last `/`-separated segment, strip trailing `.git`, also strip any `:` host prefix for SSH URLs
- Validate name with shared `isSafeProjectName` helper (extracted to a new shared module — see below)
- Validate URL with permissive regex: `^(git@[\w.-]+:|ssh://|https?://)`
- Reject if `/workspace/<name>` already exists (uses bridge's read-only mount)
- Send placeholder via `ctx.reply`, then delegate to `createProject` from `project-creator.ts`

Errors surface as standard Telegram replies (escapeMarkdownV2 + parse_mode MarkdownV2). All wrapped in try/catch + describeError, matching the pattern in switch.ts.

### `tg-bridge/src/commands/init.ts` — new

Single exported handler `handleInit(ctx, deps)`. Responsibilities:

- Parse single arg from `ctx.match`
- Validate name with shared helper
- Reject if `/workspace/<name>` already exists
- Send placeholder, delegate to `createProject` with the init flavor

### `tg-bridge/src/project-creator.ts` — new

Shared helper exporting:

```typescript
export type CreationKind = "clone" | "init";

export interface CreateProjectArgs {
  chatId: number;
  placeholderId: number;
  name: string;
  kind: CreationKind;
  url?: string; // required when kind === "clone"
  workspaceRoot: string;
}

export interface CreateProjectDeps {
  client: OpencodeClient;
  state: ChatStateRepo;
  router: { registerSession(sid: string, h: SessionEventHandler): () => void; ensureDirectory(dir: string): boolean };
  bot: TurnBot;
  defaultModel: string;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export async function createProject(args: CreateProjectArgs, deps: CreateProjectDeps): Promise<void>
```

Internals:

1. Build the deterministic prompt via `buildClonePrompt(url, name)` or `buildInitPrompt(name)` (both private helpers, both pure)
2. Ensure SSE subscription on `/workspace` via `deps.router.ensureDirectory(workspaceRoot)`
3. Create one-shot session: `client.createSession(\`tg:\${kind}:\${name}\`, { directory: workspaceRoot })`
4. Build a Turn for the streaming view (using the placeholder message id)
5. Build a custom SessionEventHandler:
   - `onPartUpdated`: forward to Turn (same as message-handler.ts)
   - `onIdle`: extract assistant text from accumulated parts, check success marker, branch into auto-switch OR fall through to Turn.finalize for error display
   - `onError`: forward to Turn.showError
6. Register handler with EventRouter
7. Fire-and-forget `client.prompt(sessionId, prompt, { model, directory: workspaceRoot })` with `.catch` that logs and shows error via Turn.showError
8. (No await — handler returns immediately, just like message-handler.ts)

The success-detection logic:

```typescript
function detectSuccess(parts: IncomingPart[], kind: CreationKind): boolean {
  const text = parts
    .filter((p): p is { type: "text"; text: string; ...rest } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text.trim())
    .join("\n")
    .trim();
  if (text.length === 0) return false;
  const marker = kind === "clone" ? /^cloned\b/i : /^initialized\b/i;
  return marker.test(text);
}
```

The auto-switch sub-flow (on success detected):

```typescript
async function performAutoSwitch(name: string, args, deps): Promise<void> {
  const projectPath = join(args.workspaceRoot, name);
  const newSession = await deps.client.createSession(`tg:${name}`, { directory: projectPath });
  deps.state.setProject(args.chatId, projectPath, newSession.id);
  deps.router.ensureDirectory(projectPath);
  // Replace placeholder with standard switch confirmation
  await safeEdit(deps.bot, args.chatId, args.placeholderId, buildSwitchConfirmation(name, projectPath, newSession.id));
}
```

`buildSwitchConfirmation` returns the same string format as `switch.ts:68-74` (extracted into a shared helper).

### `tg-bridge/src/commands/switch.ts` — modified (small refactor)

Extract two helpers that `project-creator.ts` reuses:

```typescript
export function isSafeProjectName(name: string): boolean { ... } // moved from local function to exported

export function buildSwitchConfirmation(name: string, projectPath: string, sessionId: string): string { ... }
```

`handleSwitch` body is a thin caller of these helpers + the existing createSession + state-update + ensureDirectory + reply pattern. Behavior unchanged.

### `tg-bridge/src/commands/help.ts` — modified

Add two lines to the RAW help text:

```
/clone <git-url> [name] — clone a git repository into /workspace
/init <name> — create an empty new project under /workspace (with git init)
```

Place between `/switch` and `/abort` for grouping (creation operations together).

### `tg-bridge/src/index.ts` — modified

Two new lines registering the commands:

```typescript
bot.command("clone", (ctx) => handleClone(ctx, { client, state, router, bot: turnBot, workspaceRoot: config.workspaceRoot, defaultModel: config.defaultModel, log }));
bot.command("init", (ctx) => handleInit(ctx, { client, state, router, bot: turnBot, workspaceRoot: config.workspaceRoot, defaultModel: config.defaultModel, log }));
```

Position: after the existing `bot.command("switch", ...)` registration, before `bot.on("callback_query:data", ...)`.

## Deterministic prompts

Carefully designed to maximize LLM compliance:

### Clone prompt

```
Run exactly this single command and report only the result. Do not run any other commands. Do not summarize the output. Do not explore the cloned repository.

git clone -o StrictHostKeyChecking=accept-new <URL> /workspace/<NAME>

If the command succeeds (exit code 0), reply with the single word: cloned

If the command fails, reply with: failed: <one-sentence summary of the error>
```

Notes:

- `-o StrictHostKeyChecking=accept-new` is OpenSSH ≥7.6 default-safe TOFU: accepts new host keys on first contact, refuses changed keys on subsequent contacts. Without this, first-time clones from new hosts hang on a fingerprint prompt.
- The prompt explicitly forbids exploration to keep the session minimal (and the token cost low)
- `<URL>` and `<NAME>` are bridge-substituted at prompt-build time. URL is shell-safe by virtue of git URL syntax (no spaces possible in a valid URL); name is validated against `isSafeProjectName` so it has no shell metacharacters.

### Init prompt

```
Run exactly this single command and report only the result. Do not run any other commands. Do not create README files, .gitignore, or any other content.

mkdir -p /workspace/<NAME> && git init /workspace/<NAME>

If the command succeeds (exit code 0), reply with the single word: initialized

If the command fails, reply with: failed: <one-sentence summary of the error>
```

## Edge cases — explicit decisions

| Case | Behavior |
|---|---|
| `/clone` with no arg | Reply: `Usage: /clone <git-url> [name]` |
| `/clone` with explicit name override that's invalid | Reply: `Invalid project name.` (same wording as switch.ts) |
| `/clone` with URL that doesn't match the git-URL regex | Reply: `Doesn't look like a git URL: <text>` |
| `/clone` to a name that already exists on disk | Reply: `Project '<name>' already exists. Use /switch <name> or pick a different name.` |
| `/clone` with HTTPS public URL | Works; SSH key not needed |
| `/clone` with HTTPS private URL | LLM bash fails with auth error → user sees `failed: Authentication failed` (or similar) in final view |
| `/clone` to a directory whose parent (workspace) is read-only | Won't happen on opencode container — workspace is :rw there. Bridge's :ro is for the bridge's own checks. |
| `/init` with no arg | Reply: `Usage: /init <name>` |
| `/init` with invalid name | Reply: `Invalid project name.` |
| `/init` to a name that already exists | Reply: `Project '<name>' already exists. Use /switch <name> or pick a different name.` |
| LLM ignores the `do not explore` instruction and runs `ls` after clone | Acceptable. Streaming view shows what happened; success-marker detection still works. |
| LLM replies with success marker but the bash tool actually failed | Theoretical; would require LLM to lie. If it happens, user does `/switch <name>` manually and sees an empty/broken directory. Recoverable. |
| Network timeout on git clone | LLM bash tool surfaces the error; final view shows it. No bridge-side timeout. |
| Concurrent /clone for same name from two chats | Last-write-wins on chat-state. Filesystem may have a partial-clone if both started simultaneously. Single-user system; rare; acceptable for V1. |
| User sends another message during the clone | Standard message-handler queues it; opencode processes after the clone session goes idle. Same behavior as any other in-flight prompt. |
| User runs `/abort` during a clone | Existing /abort handler aborts the session. Clone may leave a partial directory on disk. User cleans up via `/clone` to a different name or via opencode web. |
| Telegram edit/send fails during the streaming or final view | safeEdit/safeSend handle it (plain-text fallback, never throws). |

## Testing strategy

### Unit tests

**`tests/commands/clone.test.ts`** — tests the bridge-side validation and dispatch:

1. No args → reply with usage hint, no createProject call
2. Just URL (no name) → derive name from URL basename (3 cases: SSH, HTTPS, HTTPS-with-.git suffix)
3. URL + explicit name → use explicit name
4. Invalid name → reply with validator error, no createProject call
5. Invalid URL format → reply with format error, no createProject call
6. Name already exists on disk (mock readdirSync) → reply with collision error, no createProject call
7. Happy path → calls createProject with correct args (kind: "clone", url, name)

**`tests/commands/init.test.ts`** — analogous:

1. No args → reply with usage hint
2. Invalid name → reply with validator error
3. Name already exists → reply with collision error
4. Happy path → calls createProject with kind: "init"

**`tests/project-creator.test.ts`** — tests the shared creation flow:

1. `buildClonePrompt(url, name)` produces the expected prompt with substitutions
2. `buildInitPrompt(name)` produces the expected prompt
3. `detectSuccess(parts, "clone")` matches `cloned` (case-insensitive, line-leading)
4. `detectSuccess(parts, "init")` matches `initialized`
5. `detectSuccess` rejects partial matches (e.g. `unmatched` doesn't match `init` because of `\b`)
6. `createProject` happy path: registers handler, calls client.createSession with `directory: workspaceRoot`, fires prompt
7. `createProject` on idle with success marker: calls auto-switch (createSession in subdirectory, state.setProject, ensureDirectory, safeEdit with switch confirmation)
8. `createProject` on idle without success marker: falls through to Turn.finalize (error visible to user, no auto-switch)
9. `createProject` on session.error: calls Turn.showError, no auto-switch
10. `createProject` survives `client.prompt` rejection: Turn.showError called with the rejection reason

**`tests/commands/switch.test.ts`** — augment existing tests:

1. Verify `isSafeProjectName` and `buildSwitchConfirmation` are exported (compile-time check)
2. Existing handleSwitch tests still pass after the refactor

### Integration verification (manual on Unraid)

After deploy:

1. `/clone git@github.com:brandon-relentnet/test-tiny-repo.git` — small repo, fast clone. Expected: streaming view shows bash call, final view becomes "Switched to test-tiny-repo" with project + session info. Subsequent message goes to that project.
2. `/init my-test-project` — expected: bash call visible, final view becomes "Switched to my-test-project". `/projects` lists it.
3. `/clone https://github.com/torvalds/linux.git tiny-test` — large public clone. Should succeed eventually (or surface progress); auto-switches when done. (Optional — skip if you don't want to wait.)
4. `/clone https://invalid-url-xxx-yyy.test/foo.git` — expected: bash error visible, no auto-switch, chat-state unchanged.
5. `/init existing-project` (using a name that already exists) — expected: rejected at bridge level, never dispatched to LLM.
6. `/clone` with no args — expected: usage hint.
7. `/init` with `../etc/passwd` — expected: validator rejection.

## Migration

No state migration. No schema change. No compose change. New commands appear in `/help` after deploy.

Rollout: standard ssh + git pull + `docker compose build tg-bridge` + `up -d tg-bridge`. opencode container untouched.

## Risks

- **Token cost**: each `/clone` or `/init` costs roughly $0.005-$0.02. For an indie user, this is trivial; for someone scripting bulk clones, it adds up. Mitigation: deferred to a future opt-in flag (e.g. `BRIDGE_CREATION_USE_LLM=false` switching to a sidecar approach).
- **LLM disobeys**: theoretical. The prompts are extremely constrained, and Claude Sonnet 4.5 follows similar instructions reliably in our testing. Mitigation: the success regex is generous (`^cloned\b`); user can `/switch` manually if auto-switch misfires.
- **SSH host-key surprises**: github.com's ed25519 fingerprint is `+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` and is widely-known. With `accept-new`, first contact accepts and pins. Subsequent fingerprint changes (e.g. github rotates keys) would block clones until known_hosts is cleared inside the opencode container. Documented operational risk.
- **/workspace as a session directory**: opencode treats /workspace as a valid project. Sessions created there are short-lived (one prompt) and get GC'd by opencode's normal session lifecycle. Verified during the per-directory SSE work — /workspace is a legitimate scope.
- **Bash output containing markdown control chars**: the streaming view passes through the existing safeEdit/safeSend wrappers. No new risk.
- **HTTPS-private clones**: out of scope. User who needs them either configures git credential helper inside the opencode container manually, or uses SSH.

## Out of scope (logged for future)

- Token-free creation via sidecar fs-helper container
- `/clone --branch <branch>` flag
- `/clone --depth N` shallow-clone option
- Removing/renaming projects from Telegram
- Listing project metadata (size, last commit, branch) in `/projects`
- Bulk-clone from a config file
