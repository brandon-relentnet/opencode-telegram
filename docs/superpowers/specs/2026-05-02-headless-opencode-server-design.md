# Headless opencode server with Telegram bridge — design

**Date:** 2026-05-02
**Status:** Draft, awaiting user review
**Phase:** 1 of 3 (Phase 2 = use it for a week and fix gaps; Phase 3 = optional custom client, separate spec)

## 1. Goal

Make opencode usable from any device the author owns — laptop and phone — by running an always-on opencode server on the author's Unraid box and accessing it remotely:

- **Laptop:** the existing `opencode web` UI over Tailscale. No custom code.
- **Phone:** a Telegram bot that bridges Telegram chats to the opencode SDK. Custom code.

The phone-side bot is the new artifact. The laptop side is configuration only.

## 2. Non-goals (Phase 1)

- Voice-message input.
- Image / screenshot input.
- Multi-user / team features. The whitelist supports more than one Telegram user ID, but there is no user/team data model.
- A custom PWA or native mobile app. Deferred to Phase 3.
- HTTPS termination via Tailscale Serve. Tailnet traffic is already encrypted by WireGuard; this is polish.
- A `/clone` command for fetching new repos via the bot. Author clones from their laptop; the agent works on what is already mounted.
- Surfacing opencode's session-sharing feature through the bot.

## 3. Architecture

### 3.1 High-level

```
┌────────────────────────────────────────────────────────────────────────┐
│                         Tailscale (mesh VPN)                           │
│                                                                        │
│   [Phone — Telegram app]              [Laptop — opencode web/TUI]      │
│             │                                       │                  │
│             ▼                                       │                  │
│      Telegram cloud                                 │                  │
│             ▲                                       │                  │
│             │ long-poll                             │                  │
└─────────────┼───────────────────────────────────────┼──────────────────┘
              │                                       │
              │                                       │ (via Tailscale)
              │                                       │
   ╔══════════╪═══════════════════════════════════════╪══════════════════╗
   ║ Unraid host (Tailscale plugin → tailnet IP)      │                  ║
   ║                                                  │                  ║
   ║  ┌───────────────────────────────────────────────┼─────────────┐    ║
   ║  │ Docker bridge network: opencode-net           │             │    ║
   ║  │                                               ▼             │    ║
   ║  │  ┌─────────────────┐    HTTP/SSE   ┌─────────────────────┐  │    ║
   ║  │  │  tg-bridge      │ ───────────▶  │  opencode           │  │    ║
   ║  │  │  (Node + grammy │ ◀───────────  │  serve :4096        │  │    ║
   ║  │  │  + opencode SDK)│               │                     │  │    ║
   ║  │  └─────────────────┘               └─────────────────────┘  │    ║
   ║  │         │                                  │ │ │            │    ║
   ║  └─────────┼──────────────────────────────────┼─┼─┼────────────┘    ║
   ║            │                                  │ │ │                 ║
   ║       /data/sqlite                  /workspace │ │ /opencode-state  ║
   ║       (chat→session map)            (your repos)│  (auth, sessions) ║
   ║                                                 │                   ║
   ║                                                 ~/.ssh (ro)         ║
   ╚═════════════════════════════════════════════════════════════════════╝
```

Three layers:

1. **Transport.** Telegram cloud handles phone↔bridge; Tailscale handles laptop↔opencode. Each handles its own auth and TLS.
2. **Compute.** Two containers on a Docker bridge network on Unraid. The bridge talks to opencode over HTTP. opencode does the actual coding work.
3. **State.** Three persistent volumes: `/workspace` (repos on the cache pool), `/opencode-state` (auth tokens, session history), `/data/sqlite` (the bridge's chat→session mapping).

### 3.2 Why this approach (vs alternatives)

Two containers in Compose, rather than one combined container or a hybrid in which the bot runs natively on Unraid, because:

- **Separation of concerns.** opencode's lifecycle (slow start, hot LSPs) is different from the bot's (fast restart for code changes).
- **Independent restarts.** Reloading bot code doesn't take opencode's LSP servers down with it.
- **Portability.** The whole stack moves to a non-Unraid Docker host with no rework if needed later.
- **One process per container.** Standard Docker hygiene; smaller images; clearer logs.

Tailscale via the Unraid plugin (rather than as a sidecar container) because the host is already going to use Tailscale for other services. A sidecar is portable but redundant here.

## 4. Components

### 4.1 `opencode` container

**Base image:** `node:22-bookworm-slim`. opencode itself is published as `opencode-ai` on npm.

**Bake into the image:**

- opencode (latest stable; pin to a known-good version in the Dockerfile).
- `git`, `openssh-client` for git operations.
- LSP servers for the languages the author actually uses. Initial set, to be confirmed at implementation time:
  - `typescript-language-server` + `typescript`
  - `pyright`
  - `gopls`
  - `rust-analyzer`
- CLI tools opencode benefits from: `ripgrep`, `fd-find`, `jq`, `curl`, basic build essentials.

**Command:** `opencode serve --hostname 0.0.0.0 --port 4096`.

**Mounts:**

| Container path | Type | Purpose |
|---|---|---|
| `/workspace` | rw | Repos to work on (cache pool on Unraid) |
| `/root/.local/share/opencode` | rw | Auth tokens, session history, projects DB |
| `/root/.config/opencode` | rw | `config.json`, custom agents/commands |
| `/root/.ssh` | ro, mode 0600 | Deploy keys for git |

**Environment:**

- `OPENCODE_SERVER_USERNAME=opencode`
- `OPENCODE_SERVER_PASSWORD=<random 32-byte hex>` — basic-auth for the laptop's `opencode web` and for the bridge

**Published ports:** `4096:4096` to the Unraid host, so the host's Tailscale plugin makes it reachable on the tailnet.

**Resource limits (initial):** `mem_limit: 4g`, `cpus: 2.0`. Tune to actual headroom.

### 4.2 `tg-bridge` container

**Base image:** `node:22-bookworm-slim`. Pure Node app, no system deps.

**Stack:**

- `grammy` — Telegram bot framework
- `@opencode-ai/sdk` — official opencode JS SDK (HTTP client + SSE)
- `better-sqlite3` — embedded SQLite for chat state
- `zod` — env validation
- `pino` — structured logging
- `vitest` — tests

**Code organization:**

```
tg-bridge/
├── Dockerfile
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts               # entry: validate config, start bot
│   ├── config.ts              # zod-validated env
│   ├── auth.ts                # whitelist middleware
│   ├── opencode-client.ts     # thin SDK wrapper
│   ├── chat-state.ts          # SQLite repository
│   ├── streaming.ts           # SSE → buffered Telegram edits
│   ├── permissions.ts         # permission.request → inline keyboard
│   ├── format.ts              # opencode parts → Telegram MarkdownV2
│   ├── chunker.ts             # split long output, preserve code fences
│   └── commands/
│       ├── new.ts
│       ├── projects.ts
│       ├── switch.ts
│       ├── abort.ts
│       ├── status.ts
│       └── help.ts
└── tests/
    ├── chunker.test.ts
    ├── chat-state.test.ts
    ├── format.test.ts
    ├── auth.test.ts
    └── commands.test.ts
```

**Mounts:** `/data` ← `/mnt/user/appdata/opencode/bridge` (SQLite file).

**Environment:**

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_ALLOWED_USER_IDS` — comma-separated numeric Telegram user IDs
- `OPENCODE_URL=http://opencode:4096`
- `OPENCODE_USERNAME=opencode`
- `OPENCODE_PASSWORD` — same value as `OPENCODE_SERVER_PASSWORD` from the opencode container
- `WORKSPACE_ROOT=/workspace` — used to validate project switches
- `LOG_LEVEL=info`

**Published ports:** none. Bot uses Telegram long-polling (outbound) and connects to opencode (also outbound from the bridge's perspective).

**Resource limits (initial):** `mem_limit: 256m`, `cpus: 0.5`.

### 4.3 Networking

- Both containers join a Compose-defined bridge network `opencode-net`.
- Bridge resolves `opencode` via service DNS.
- Only opencode publishes a port to the host (so Tailscale can serve it).
- Bridge is outbound-only; nothing inbound. No public attack surface for the bot.

### 4.4 Tailscale

- Use the existing Tailscale Unraid plugin. The Unraid host has a tailnet IP.
- From any tailnet device, reach `opencode web` at `http://<unraid-tailnet-ip>:4096` with basic auth (`opencode` / `OPENCODE_SERVER_PASSWORD`).
- Optional later polish: `tailscale serve` on the host to give it a friendly HTTPS URL.

## 5. Data flow

### 5.1 Sending a message

1. User sends text to the bot via Telegram.
2. Bridge receives the update via long-poll.
3. Bridge runs whitelist middleware. If `from.id` is not in `TELEGRAM_ALLOWED_USER_IDS`, the update is dropped silently.
4. Bridge looks up `chat_state` by `chat_id`: `{ project_path, session_id, model }`. If no row exists or `project_path` is unset, the bridge does *not* auto-pick a project; it replies with the output of `/projects` and asks the user to `/switch <name>` first. The user's original message is dropped (they re-send after switching).
5. Bridge calls `POST /session/:id/prompt_async` on opencode with the text. Returns 204 immediately.
6. Bridge subscribes to opencode's global `/event` SSE stream (or stays subscribed if already connected).
7. Bridge sends a placeholder Telegram message: "thinking…".
8. As `text-delta` events arrive, bridge accumulates the buffer and edits the placeholder, throttled to ≤ 1 edit/sec per chat (Telegram limit).
9. On `message-finish`, bridge does a final formatting pass and, if the result exceeds 4096 chars, splits at safe boundaries (see § 6) and sends additional messages.

The async prompt + global SSE pattern is preferred over the synchronous `/session/:id/message` endpoint because it doesn't tie up an HTTP request for the full response duration and gives the bridge a single stream to listen on.

### 5.2 Permission requests

opencode emits a `permission.request` SSE event when a tool call needs user approval. The bridge:

1. Looks up the chat by session ID (the SSE event includes `sessionID`; bridge maintains a reverse index `session_id → chat_id`).
2. Sends a Telegram message with an inline keyboard:
   - "Allow `<tool>` with `<short summary of input>`?"
   - Buttons: `✅ Once` `✓ Always` `❌ Deny`
3. Stores `(permission_id, telegram_message_id)` mapping in memory (with a TTL) so the callback handler knows which permission the button refers to.
4. On `callback_query`, posts to `/session/:sessionID/permissions/:permissionID` with `{ response: "allow" | "deny", remember: <bool> }`.
5. Edits the original message to show the chosen action, then proceeds.

If the user does not respond within 10 minutes, the bridge auto-denies and notifies the chat.

### 5.3 Permission policy defaults

The baked-in opencode `config.json` configures the permission policy with this intent (exact schema keys to be confirmed against the opencode config reference at implementation time):

- File reads, writes, and edits inside `/workspace`: **allow** (no prompt).
- Bash command execution: **ask** (surfaced as inline keyboard via the bridge).
- Network fetch by the agent: **ask**.
- Anything that would touch a path outside `/workspace`: blocked at the container boundary, since nothing else is mounted.

### 5.4 Slash commands

| Command | Behavior |
|---|---|
| `/new` | Create a new opencode session in the current project. Update `chat_state.session_id`. |
| `/projects` | List directories under `/workspace`. Reply with a plain numbered list. |
| `/switch <name>` | Validate that `/workspace/<name>` exists. Create new session in it. Update `chat_state`. |
| `/abort` | `POST /session/:id/abort`. Tells opencode to halt the running tool. |
| `/status` | Show current project, session ID, model, last-message timestamp. |
| `/help` | Inline list of commands. |
| `/model <providerID/modelID>` | Optional: switch model for subsequent turns. Argument is the canonical opencode model identifier (e.g. `anthropic/claude-sonnet-4-5`). Stored in `chat_state.model`; passed as the `model` field of subsequent `/session/:id/prompt_async` calls. `/model` with no argument shows the current selection and a list of available providers from `GET /provider`. |

### 5.5 Failure modes

| Scenario | Handling |
|---|---|
| opencode container down | Bridge HTTP fails. Reply "❌ opencode unreachable, retrying". Auto-retry connection every 5 s; resume when up. |
| SSE disconnect mid-stream | Bridge reconnects to `/event`. opencode replays recent events on reconnect; bridge dedupes by event ID. |
| Telegram 429 | Honor `retry_after`; drop intermediate edits, send the most recent buffered text. |
| Permission timeout (no user response) | After 10 min, auto-deny; notify chat. |
| opencode container restart mid-task | Session state persists in volume. Bridge detects the SSE disconnect and reconnects. On the user's next message, the bridge checks via `GET /session/status` whether the previous turn completed; if not, it prepends a one-time "⚠️ previous response was interrupted by a server restart" notice before forwarding the new prompt. User can `/new` to start clean or just continue. |
| Bridge container restart | Reconnects to opencode; reads chat_state from SQLite; resumes. In-flight Telegram message updates may be lost; next user message picks up clean. |
| Whitelist rejection | Drop the update silently. Log a warning. Do not respond (don't reveal that the bot is whitelisted). |

## 6. Output formatting

### 6.1 Telegram message size

Telegram's text limit is 4096 characters per message. The chunker splits long output:

- Prefer to split at `\n\n` boundaries (paragraph breaks).
- Never split inside a fenced code block. If a code block doesn't fit in one chunk, close the fence at the chunk boundary and re-open it on the next chunk with the same language hint.
- Chunks are sent as separate messages, in order.

### 6.2 MarkdownV2

opencode `Part`s are rendered to Telegram MarkdownV2:

- `text` parts: escape MarkdownV2 special characters; render as plain text.
- `code` parts and inline code: wrap in single backticks (escaped) for inline, triple backticks for blocks. Telegram accepts a language hint after the opening triple-backtick; preserve it from the opencode part.
- `tool-call` parts: render as a small italicized note ("_called `read_file` on `src/auth.ts`_") to give the user visibility without flooding.
- `tool-result` parts: render as a code block, truncated past 50 lines with a note ("…truncated, full result on opencode web").
- File diffs: rendered as a unified diff in a code block, truncated past 50 lines with the same note.

## 7. Persistence and security

### 7.1 Volume layout on Unraid

| Container path | Unraid path | Pool | Purpose |
|---|---|---|---|
| `/workspace` | `/mnt/user/code` | cache | Repos. Pin to cache via Mover settings. |
| `/root/.local/share/opencode` | `/mnt/user/appdata/opencode/data` | cache | Auth, sessions. |
| `/root/.config/opencode` | `/mnt/user/appdata/opencode/config` | cache | Config, custom agents, commands. |
| `/root/.ssh` | `/mnt/user/appdata/opencode/ssh` | cache | SSH deploy keys, mode 0600. |
| `/data` (bridge) | `/mnt/user/appdata/opencode/bridge` | cache | SQLite. |

### 7.2 Secrets

- `.env` file at `/mnt/user/appdata/opencode/.env`, mode 0600, owned by root. Compose loads it via `env_file:`. Contains `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `OPENCODE_SERVER_PASSWORD`.
- Anthropic auth: stored in `/root/.local/share/opencode/auth.json` after the OAuth flow; persists in the data volume. No API key file to manage.
- Git/SSH: a dedicated ed25519 deploy key under `/mnt/user/appdata/opencode/ssh/`, registered with GitHub.

### 7.3 Backup

- `appdata/opencode/*` is captured by the user's existing Unraid `appdata` backup (CA Backup/Restore plugin).
- Repos are backed by `git push` (the canonical backup). A periodic Unraid user-script can run `git -C <repo> push` for each repo as a safety net.

### 7.4 Network exposure

| Service | Inbound | Outbound | Reachable from |
|---|---|---|---|
| opencode | LAN + tailnet on `:4096`, basic-auth | https → providers, https → GitHub | tailnet only |
| tg-bridge | none | https → api.telegram.org, http → opencode:4096 | nothing inbound |

The bridge has no public attack surface. opencode is reachable only via the tailnet.

## 8. Bootstrap (one-time setup)

This will become `BOOTSTRAP.md`:

1. **Install Tailscale** on Unraid (Community Apps plugin). Log in. Note the host's tailnet IP.
2. **Create the Telegram bot.** DM @BotFather → `/newbot` → save the token. DM @userinfobot to find your numeric Telegram user ID.
3. **Generate `.env`** at `/mnt/user/appdata/opencode/.env` with the values gathered above plus a random 32-byte hex string for `OPENCODE_SERVER_PASSWORD`.
4. **Generate the SSH deploy key** under `/mnt/user/appdata/opencode/ssh/`. Add the public key to GitHub.
5. **Clone this project's repo** to `/mnt/user/code/opencode-server/` (or wherever).
6. `docker compose -f deploy/compose.yaml up -d` from a terminal on Unraid (or via the `compose.manager` plugin).
7. **Anthropic OAuth.** Open `http://<unraid-tailnet-ip>:4096` in a laptop browser. Sign in with the basic-auth password. Click "Connect Anthropic". Complete the OAuth flow. The token is saved into the data volume.
8. **First message.** DM the bot from your phone: `/help`. Expect a reply.

## 9. Testing

### 9.1 Unit tests (vitest)

Pure functions only:

- `chunker`: arbitrary string ≤ 4096 chars; never break inside code fences; preserve language across splits.
- `format`: opencode `Part[]` → Telegram MarkdownV2 with correct escaping.
- `chat-state`: insert/get/update; default values; SQLite migration from empty.
- `auth`: whitelist accepts/rejects exact IDs; treats whitespace and missing values correctly.

### 9.2 Integration tests (vitest + grammy testing helpers + mocked opencode SDK)

- Command handlers: `/new`, `/projects`, `/switch`, `/abort`, `/status`, `/help` each produce expected effects on chat-state and HTTP calls.
- Permission flow: SSE `permission.request` event → inline keyboard message → simulated callback → correct `POST /session/:id/permissions/:permissionID` to opencode with right body.
- Streaming: bridge buffers deltas, edits at most once/sec, handles 429 with `retry_after`.

### 9.3 End-to-end (manual, in BOOTSTRAP.md)

After `compose up`:

- DM bot `/help` → expect command list.
- DM "what is 2+2" → expect "4" with no errors.
- DM "list files in this project" → opencode runs the tool; bridge surfaces the result.
- DM something requiring bash → expect inline keyboard, tap `Once`, expect output.

We do not test against the real Telegram API in CI. grammy's `Bot.handleUpdate(...)` lets us drive the bot with synthetic updates.

## 10. Open questions to resolve at implementation time

- Exact opencode version to pin in the Dockerfile.
- Final LSP set baked into the image (depends on languages the author actually uses).
- Whether to include a `/diff` command in Phase 1 (sends recent git diff as a Telegram document) or defer to Phase 2.
- Whether to surface a "trust this session" shortcut after the first permission allow, beyond what `remember: true` already does.

These are minor enough to settle when writing the implementation plan; none affect the architecture.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Telegram bot token leaks → impersonator can DM users on the bot | Whitelist gates all incoming messages; impersonator gets nothing. Rotate token via @BotFather if leaked. |
| Anthropic OAuth refresh token leaks (volume copied) | The volume is on `appdata`; access to it requires Unraid host access, which already implies full compromise. No additional mitigation in scope. |
| Agent runs a destructive command in `/workspace` | Container can only touch `/workspace`. Recovery: `git restore`, Unraid array snapshots, or backups. Permission for `bash` is `ask` by default. |
| Container fills disk with logs | Compose log driver: `json-file` with `max-size: 10m`, `max-file: 3`. |
| LSP servers leak memory or hang | `mem_limit` on opencode container; restart policy `unless-stopped`. |
| User leaves Telegram chat open with sensitive prompts on a borrowed phone | Out of scope; same risk as any chat app. |

## 12. Phased plan

- **Phase 1 (this spec):** server on Unraid, laptop via Tailscale, Telegram bridge for phone. Scope captured above.
- **Phase 2:** use the system for at least one week. Track friction in a notes file. Make small targeted fixes; no new architecture.
- **Phase 3 (separate spec, only if motivated):** custom client. Likely options: a small PWA served by a third container, or a Tauri app. Decide based on actual Phase 2 friction.
