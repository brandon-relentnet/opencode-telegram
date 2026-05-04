# Telegram Bot Information Density — Design

**Date:** 2026-05-05
**Status:** Proposed
**Builds on:** `2026-05-04-telegram-bot-refinements-design.md` (Tier 2 pinned status)

## Problem

You can't tell what state the bot is in at a glance. opencode's web UI shows model, agent mode, context-tokens-used, working directory, and current branch all the time. The Telegram bot shows only the project name, a long opaque session ID, and the model. Result: when you come back to a session after lunch, you don't know which branch you're on, how much context you've burned, what mode the agent is in, or how much you've spent.

The pinned message you asked for in the previous round was a step in the right direction, but:

1. The session ID (`ses_20c68175dffel3P1LclRHnoz2v`) takes a whole line and tells you nothing actionable
2. There's no branch indication, so when you ask the agent to "create a feature branch and start working", you can't tell if it actually did
3. There's no token-usage indicator, so you can't tell when you're approaching context limits
4. There's no agent-mode indicator (build / plan / etc.)
5. There's no per-session cost visibility

## Goals

1. Surface the five things opencode's UI surfaces (model, mode, tokens, directory, branch) in a glanceable way
2. Pinned message stays compact (5 lines max) — no scrolling
3. Add a `/info` command for the full state dump on demand
4. Surface the session slug (`clever-meadow`) instead of the long ID
5. No new branch/PR commands — the agent already handles git via prompts; we just need to *see* the result

## Non-goals

- New `/branch` or `/pr` commands. The agent does git work via natural-language prompts; the bridge just observes and reports.
- Real-time token deltas during streaming (defer to a future iteration; per-message-completion granularity is enough)
- Agent-mode switching commands (read-only display in V1)
- Multi-project parallel state (one chat = one active project, same as today)
- Cost forecasting / budget alerts

## Architecture

Three info surfaces, each with a different responsibility:

| Surface | Updated when | Lifetime | Purpose |
|---|---|---|---|
| Pinned status message | Any state change (debounced ~1s) | Permanent (until /unpin) | Always-visible glanceable state |
| Streaming view header | On Turn start + on each completed assistant message | Ephemeral (one Turn) | Live spend/usage signal during work |
| `/info` command output | On invocation | Ephemeral (one message) | Rich detail when you need everything |

### Surface 1: Pinned status message (redesigned)

Five lines max. Lines 1-2 always present; lines 3-5 conditional:

```
🟢 bltft-gold · main · build              ← always
sonnet-4.5 · 23k/200k ctx · $0.42         ← always (sub "—" for unknown values)
✅ bltft.relentnet.dev (12m ago)          ← only when Coolify app exists
🔀 3 ahead of origin                      ← only when ahead > 0

[Sessions] [Model] [Deploy] [Info]
```

Drops from current pinned:
- Long session ID (`ses_20c681...`) — replaced by session slug shown only in `/info`
- Verbose project path (`/workspace/X`) — just project name now
- "Session:" / "Model:" / "Deploy:" labels — implicit from layout

Adds:
- Branch (line 1 after project name)
- Agent mode (line 1 after branch)
- Cumulative input+output tokens / context limit (line 2)
- Cumulative cost (line 2)
- "ahead of origin" git state (line 4 when relevant)

The 5 inline buttons drop `[Branch]` (no branch commands in this iteration). Adds `[Info]`.

When state is unknown for a field (e.g. tokens before any message has completed), render `—` rather than omitting. Consistent layout.

### Surface 2: Streaming view header

Add a single header line above the existing tool list:

```
sonnet-4.5 · build · 24k tokens · $0.04 this turn
─────
📄 read x.ts · 124 lines · 0.2s
🔍 grep foo
_thinking · 12s elapsed_
```

Header shows: model, mode, current cumulative tokens (NOT delta — too noisy), this-turn-cost (delta from before turn started). Separator line `─────` for visual break.

Header omitted when no token info is known (first turn, no completed assistant messages yet).

### Surface 3: `/info` command

Full state dump in one message. HTML-formatted (uses our existing markdown→HTML pipeline):

```
📁 bltft-gold
   Path: /workspace/bltft-gold
   GitHub: brandon-relentnet/bltft-gold

🌿 Git
   Branch: main
   Status: 3 modified, 1 untracked
   Behind/ahead origin: 0/3
   Last commit: abc123 "feat: add auth" (15m ago)

🎭 Session
   Slug: clever-meadow
   ID: ses_20c68175dffel3P1LclRHnoz2v
   Started: 2:14 PM (47 min ago)

🤖 Model
   anthropic/claude-sonnet-4-5 · build mode
   Context: 23,481 / 200,000 tokens (12%)
   Cost so far: $0.42

☁️ Deploy
   App: bltft (uuid abc-123)
   URL: https://bltft.relentnet.dev
   Last deployed: 12m ago, success
   Dashboard: https://empower.relentnet.com/applications/abc-123
```

Sections omitted gracefully when their data is absent (no Coolify app → no Deploy section; no GitHub remote → no GitHub line).

## Data sources

| Field | Source | Refresh strategy |
|---|---|---|
| Project name | `chat_state.project_path` (basename) | Already tracked |
| Project path | `chat_state.project_path` | Already tracked |
| GitHub remote | `git remote get-url origin` (cached 30s) | On `/info` only |
| Branch | `git branch --show-current` (cached 5s) | On every pinned flush |
| Git status | `git status --porcelain` (cached 5s) | On `/info` and pinned-flush |
| Ahead/behind | `git rev-list --count origin/main..HEAD` and `HEAD..origin/main` | Cached 5s |
| Last commit | `git log -1 --format='%h %s|%ar'` | Cached 5s |
| Session slug | `Session.slug` from opencode SDK; cached in `chat_state.session_slug` | Set on `/switch` and `/new` |
| Session ID | `chat_state.session_id` | Already tracked |
| Session started-at | `Session.time.created` from opencode | Cached on session creation |
| Agent mode | `message.info.agent` from opencode | Update on every assistant-message-created event |
| Model ID | `chat_state.model` | Already tracked |
| Context limit | `provider.models[<id>].limit.context` from opencode `/provider` API | Cached in `chat_state.context_limit` per model |
| Cumulative tokens (5 fields) | Sum of `message.info.tokens.{input,output,reasoning,cache.read,cache.write}` over assistant messages in current session | Update on every assistant-message-completed event |
| Cumulative cost | Sum of `message.info.cost` (USD float) over assistant messages | Update on every assistant-message-completed event; stored as integer micros (1e-6 USD) to avoid float drift |
| Coolify app uuid | `chat_state.coolify_app_uuid` | Already tracked |
| Coolify FQDN | `chat_state.coolify_fqdn` | Already tracked |
| Coolify last-deploy time | NEW: `chat_state.last_deploy_at` | Set on deploy success |

## Schema additions to `chat_state`

```sql
-- All nullable, idempotent migration via existing migrateSchema pattern.
session_slug                  TEXT,
branch                        TEXT,        -- last-known branch; refreshed on pinned flush
agent_mode                    TEXT,        -- 'build' | 'plan' | 'review' | etc.
cumulative_tokens_input       INTEGER NOT NULL DEFAULT 0,
cumulative_tokens_output      INTEGER NOT NULL DEFAULT 0,
cumulative_tokens_reasoning   INTEGER NOT NULL DEFAULT 0,
cumulative_tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
cumulative_tokens_cache_write INTEGER NOT NULL DEFAULT 0,
cumulative_cost_micros        INTEGER NOT NULL DEFAULT 0,  -- 1e-6 USD; integer to avoid float drift
context_limit                 INTEGER,     -- per-model, refreshed when model or provider info changes
session_started_at            INTEGER,     -- ms since epoch
last_activity_at              INTEGER,     -- ms since epoch; bumped on every event
last_deploy_at                INTEGER      -- ms since epoch; bumped on /deploy success
```

## Component changes

### New: `tg-bridge/src/branch-info.ts`

Pure module that shells out to `git`. ~80 LOC.

```typescript
export interface GitInfo {
  branch: string;
  status: { modified: number; untracked: number };
  ahead: number;
  behind: number;
  lastCommit: { sha: string; message: string; ageMs: number } | null;
  remote: string | null;  // 'brandon-relentnet/bltft-gold' or null
}

export function getCurrentBranch(projectPath: string): Promise<string | null>;
export function getGitInfo(projectPath: string): Promise<GitInfo>;  // for /info
```

Internally caches per-project for 5 seconds (Map<projectPath, {data, expiresAt}>) to avoid hammering on rapid state changes. Uses `node:child_process.exec` with a 3-second timeout per command.

### New: `tg-bridge/src/cost-tracker.ts`

Subscribes to `message.created` events (already wired). When a message is `role: assistant` AND has tokens populated AND has not yet been counted (de-duped by `info.id`), update chat_state cumulative counters.

```typescript
export class CostTracker {
  constructor(private state: ChatStateRepo) {}
  /** Record an assistant message's token + cost contribution. Idempotent. */
  recordAssistantMessage(chatId: number, info: { id: string; tokens: ...; cost: number; agent: string }): void;
  /** Reset all cumulative counters for this chat (called on /new and /switch). */
  reset(chatId: number): void;
}
```

De-duplication is critical: opencode emits multiple `message.part.updated` events per message; without dedup we'd count the same message N times. Track `seen_message_ids: Set<string>` in memory per chat. Cleared on `/new`/`/switch`.

### New: `tg-bridge/src/commands/info.ts`

Aggregates everything for `/info`:
- Reads chat_state
- Calls `getGitInfo(projectPath)`
- Calls opencode for current session info (slug, started_at)
- Calls opencode for current model's provider info (context limit)
- Renders HTML using our existing markdown→HTML pipeline

~150 LOC.

### Modified: `tg-bridge/src/format.ts`

Replace `renderPinnedStatusBody` (or whatever it's currently called in pinned-status.ts) with a 5-line HTML renderer.

Add `renderStreamingHeader(state)` returning the new header line. Returns `""` when no token info available, in which case the streaming view renders unchanged.

### Modified: `tg-bridge/src/pinned-status.ts`

- Use new render function
- New button row: `[Sessions] [Model] [Deploy] [Info]` (drops `[Branch]`)
- New callback handlers: `pin:info` → invoke `handleInfo`

### Modified: `tg-bridge/src/chat-state.ts`

Schema additions per above. New getter/setter methods:
- `getSessionSlug` / `setSessionSlug`
- `getBranch` / `setBranch`
- `getAgentMode` / `setAgentMode`
- `getCumulativeStats(chatId): { tokens: {...5}, costMicros: number }`
- `incrementCumulativeStats(chatId, delta)` — atomic increment via prepared SQL UPDATE
- `getContextLimit` / `setContextLimit`
- `getSessionStartedAt` / `setSessionStartedAt`
- `getLastActivityAt` / `setLastActivityAt`
- `getLastDeployAt` / `setLastDeployAt`
- `resetCumulativeStats(chatId)` — used on /new + /switch

### Modified: `tg-bridge/src/opencode-client.ts`

`Session` shape exposed by the wrapper gains optional `slug?: string` field. The v1 SDK's session object already contains it; the wrapper currently strips most fields and exposes `{ id, directory }`. Widen to `{ id, directory, slug?, time? }`.

Add `getModelContextLimit(providerId, modelId): Promise<number | null>` — calls `/provider` and extracts `providers.<providerID>.models.<modelID>.limit.context`. Used by `/info` and pinned-flush.

### Modified: `tg-bridge/src/message-handler.ts`, `project-creator.ts`, `commands/deploy.ts`

Each handler:
- On `message.created` event with `role: assistant`: capture `info.agent`, update `chat_state.agent_mode`
- On `message.created` event with `role: assistant` AND `info.tokens` populated: feed to CostTracker
- On `session.idle`: bump `last_activity_at`

### Modified: `tg-bridge/src/commands/switch.ts`, `new.ts`

- Capture session slug + started_at from createSession response and persist to chat_state
- Reset CostTracker on switch/new

### Modified: `tg-bridge/src/index.ts`

Register `/info` command + its callback route. Add to `setMyCommands` list. Update help text.

## Reset semantics

- `/new` → resets cumulative tokens, cost, agent_mode, last_activity, session_started_at, session_slug. Branch unchanged. Coolify app unchanged.
- `/switch <project>` → same as /new (new session implicitly). Plus branch refreshes on next pinned flush.
- `/init` / `/initremote` / `/clone` → reset on auto-switch (which is already a /switch internally).
- Bridge restart → keeps everything from chat_state (we trust persistent state); CostTracker's in-memory `seen_message_ids` cache is rebuilt by querying recent messages on first event. (Acceptable to slightly under-count if a message arrives twice across a restart boundary.)

## Edge cases

- **First turn, no completed messages yet** — token + cost fields show `—`. Streaming header omitted.
- **Cost = 0 (Anthropic Pro/Max OAuth)** — render `$0.00` not blank. Free win for users on prepaid.
- **Context limit unknown** (provider/model not in `/provider` response) — show `23k tokens` (no denominator) instead of `23k/—`.
- **Project path is not a git repo** — `branch` and `git status` return null; pinned line 1 shows just `🟢 project · build` (no branch segment); `/info` Git section says "not a git repository".
- **Model changed mid-session** — context_limit is per-model. Refresh on `/model` change.
- **Two chats sharing a project** — they have separate chat_state rows; cumulative stats stay independent (correct).
- **Slug missing on session** — fall back to first 8 chars of session ID.
- **Pinned message size** — 5 lines + button row; well under Telegram's 4096-char limit.
- **Branch detection slow on big repos** — `git branch --show-current` is fast (single ref read); 5s cache covers any spike.
- **`git status --porcelain` slow on huge repos** — only invoked on `/info`, which is on-demand. Fine.
- **`/info` while bridge is restarting** — graceful: the data sources that fail return null; sections render with "—" placeholders.

## Risks

- **`message.info.cost`** may be `null` or absent on some providers. Guard with `?? 0`.
- **Token field names** — assumed `info.tokens.{input,output,reasoning,cache.read,cache.write}` based on earlier curl probe. Implementation verifies before counting; falls through to 0 on shape mismatch.
- **Slug field availability** — verified earlier (`slug: "clever-meadow"` in session JSON). If a future opencode build drops it, fall back to ID prefix.
- **Provider context-limit field** — needs probe; could be `provider.models.<id>.limit.context` or `provider.models.<id>.context_window` etc. Implementation probes and falls through to null if absent.
- **`child_process.exec` timeout** — git ops hang on a corrupt repo would block the pinned flush. Mitigate via 3s timeout + try/catch returning null. Pinned shows `—` for those fields rather than blocking.

## Migration

- Schema additions are idempotent (existing `migrateSchema` pattern). Old chat_state rows get NULL/0 defaults.
- Existing pinned messages get the new layout on the next state-change-driven flush (no manual action). Layout looks slightly different; user notices once and moves on.
- No external state to migrate.

## Out of scope (logged for V2/V3)

- Real-time token deltas during streaming (sub-message granularity)
- Agent mode switching (`/mode plan|build`)
- Branch/PR commands (you said no — agent handles via prompts)
- Cost forecasting + budget alerts
- Multi-project parallel pinned messages
- Per-message cost annotation in tool lines (could add `$0.001` after timing; defer)
- Streaming view: branch indicator (probably noisy; pinned has it)
- Notification when context approaches 80% (could be useful; defer)
