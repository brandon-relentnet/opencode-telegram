# Telegram Bot Refinements — Design

**Date:** 2026-05-04
**Status:** Proposed
**Builds on:** All prior specs (render overhaul, project creation, question tool, init-remote + deploy)

## Problem

The bot is functional but feels rough. Three concrete issues + a deeper UX gap:

1. **Final reply echoes the user's prompt back at them.** Looking at a real session, the bot's final message starts with the literal user input ("I want this to be made entirely mobile design first please. Proceed") followed by the agent's actual response. This makes long messages confusingly recursive.

2. **Markdown doesn't render.** The agent emits CommonMark (`**bold**`, `# headers`, `- lists`, code fences). The bridge escapes them as MarkdownV2 — but MarkdownV2 uses `*bold*` (single asterisk), has no headers, and doesn't speak CommonMark dialect. Result: literal `**` and `#` characters in the rendered output.

3. **State sometimes stuck on `_thinking…_`.** Even when the agent has finished, the placeholder occasionally never updates. User can't tell if the bot is still working, hung, or done.

4. **Underlying gap: state is invisible.** There's no anchor in the chat that tells you "what project am I in, what session, what's the deploy URL, what's the model, is something running right now?" Users have to remember or run `/status`. Combined with #3, this creates a "did the bot crash?" feeling that erodes trust.

## Goals

1. Final reply contains only the agent's own text (no user echoes)
2. Agent's CommonMark renders with appropriate emphasis, code spans, code fences, lists, links
3. Stuck-on-thinking is rare and self-recovers; if it does happen, user can cancel
4. A pinned status message at the top of every chat surfaces all current state, updates live
5. Slash commands appear in Telegram's `/` autocomplete on every device
6. Common state-management actions (switch project, switch session, deploy, change model) are accessible via tap, not type
7. Acknowledgement of received commands is immediate via Telegram reactions, before any work begins

## Non-goals

- Markdown features Telegram doesn't support (tables, footnotes, math)
- Rich media in pinned status (just text + emoji + buttons; no inline images)
- Cross-chat state (each Telegram chat remains independent)
- Group/topic support (DM-only assumption preserved)
- Project rename/delete commands (deferred)
- /history, /share, project descriptions (deferred)
- Bot startup recovery for sessions that idled while bot was offline (edge case; defer)
- Long-code-block expand/collapse (defer to a later refinement)

## Architecture

### Three coordinated subsystems

```
┌─────────────────────────────────────────────────────────────┐
│  Telegram Bot Update Flow                                   │
│                                                              │
│  User message ─► reaction(👍) ─► Turn(streaming + cancel)   │
│                                  │                           │
│                                  ▼                           │
│                       Final view (HTML) + reaction(✅/❌)   │
│                                  │                           │
│                                  ▼                           │
│              Pinned status updates (debounced)               │
└─────────────────────────────────────────────────────────────┘

┌──────────────────┐   ┌──────────────────┐   ┌─────────────────┐
│  Render layer    │   │  Status layer    │   │  Discovery layer│
│  - HTML output   │   │  - Pinned msg    │   │  - setMyCommands│
│  - User filter   │   │  - Debounced     │   │  - Tap-to-act   │
│  - Heartbeat     │   │  - Re-pin guard  │   │    keyboards    │
│  - Cancel button │   │  - In-mem state  │   │  - Reactions    │
└──────────────────┘   └──────────────────┘   └─────────────────┘
```

The three subsystems are decoupled. Each module has a small public API the others call. We add ~5 new files, modify ~6 existing files.

### Data additions

`chat_state` table (idempotent migration in `openChatStateDb`):
```sql
ALTER TABLE chat_state ADD COLUMN pinned_message_id INTEGER;
ALTER TABLE chat_state ADD COLUMN pin_paused        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_state ADD COLUMN last_user_message_id INTEGER;
```

In-memory only (per chat, lost on bridge restart):
- `currentTurn: Turn | null` — references the active Turn so cancel button can hit it
- `lastActivity: { kind: "idle" | "working" | "failed"; at: number; detail?: string }` — drives the status line

## Components

### `tg-bridge/src/format.ts` — modify

`MaybeTextPart` extended to include optional `role: string`. `concatenateTextParts` filters parts where `role === "user"` (case-insensitive). Existing call sites unchanged. Tests updated to cover both shapes.

### `tg-bridge/src/markdown-to-html.ts` — new

Wrapper around `marked` (added as a runtime dep, ~50KB) that converts the agent's CommonMark output to Telegram-flavored HTML. The renderer overrides:

| CommonMark | Telegram HTML | Notes |
|---|---|---|
| `**bold**` / `__bold__` | `<b>...</b>` | |
| `*italic*` / `_italic_` | `<i>...</i>` | |
| `~~strike~~` | `<s>...</s>` | |
| `` `code` `` | `<code>...</code>` | |
| ` ```lang\ncode\n``` ` | `<pre><code class="language-X">...</code></pre>` | Telegram supports syntax classes |
| `# H1`, `## H2`, etc. | `<b>...</b>\n` | Telegram has no header tag — degrade to bold + newline |
| `- item` / `* item` | `• item\n` | Telegram has no `<ul>` |
| `1. item` | `1. item\n` | Pass-through; Telegram renders the digit |
| `[text](url)` | `<a href="url">text</a>` | url-validated; bare URLs auto-linked |
| `> quote` | `<blockquote>...</blockquote>` | Telegram supports `<blockquote>` |
| Tables, footnotes, HTML, etc. | Stripped | |

Public API:
```typescript
export function commonmarkToTelegramHtml(input: string): string
export function escapeHtml(text: string): string  // for static template parts
```

`escapeHtml` replaces `&` `<` `>` only (Telegram's HTML mode is strict).

### `tg-bridge/src/safe-telegram.ts` — modify

`safeEdit` and `safeSend` gain HTML support. Strategy:
1. Try `parse_mode: "HTML"` first
2. On `can't parse entities` error, retry with `parse_mode: undefined` (plain text — strip HTML tags via simple regex)
3. On second failure, log warn + return

Plain-text strip is `text.replace(/<[^>]+>/g, "")` plus HTML entity decode (`&amp;` → `&`, `&lt;` → `<`, `&gt;` → `>`). Still lossy but readable. New helper `stripHtml(text: string): string`.

The MarkdownV2 path is still supported for callers that haven't migrated (we'll migrate everything in this spec). Eventually remove MarkdownV2 entirely.

### `tg-bridge/src/turn.ts` — modify

`Turn` gains:
- `private heartbeatTimer: NodeJS.Timeout | null` — fires every 10s while not finalized
- `private startedAt: number` — set in constructor
- `private cancelButtonAttached: boolean` — once true, render appends inline keyboard with `[ ⏹ Cancel ]`

New method `startHeartbeat()`: schedules an interval that re-renders the streaming view with updated elapsed-time. The streaming view's `_thinking…_` line becomes `_thinking · 12s elapsed_` after the first heartbeat.

`renderStreamingView` (in `format.ts`) gains an optional `elapsedSeconds?: number` parameter and an optional `cancelCallbackData?: string`. When `cancelCallbackData` is set, the message includes `reply_markup` with one inline button.

`Turn.cancel()` (already exists from earlier work) is the action wired to the cancel button.

`Turn` is constructed with optional `cancelCallbackData?: string`. If provided, the cancel button shows. The bridge generates `cancel:<sessionId>` and registers a handler in `index.ts`.

### `tg-bridge/src/format.ts:renderToolLine` — modify (C3)

Tool lines get richer when timing/output info is available:

| State | Render |
|---|---|
| `pending` / `running` | `📄 read \`config.py\`` (current behavior) |
| `completed` with `state.metadata.outputBytes` | `📄 read \`config.py\` · 124 lines` (or bytes if not text) |
| `completed` with `state.time.start` and `state.time.end` | append ` · 0.2s` |
| `error` | `❌ bash \`bad command\` · failed` (no timing) |

Source data: opencode's `Tool*State` exposes `time: { start, end? }` and tool-specific metadata. We narrow per-tool name:
- `read`: `metadata.lines` if present
- `bash`: `metadata.exitCode` if present
- `grep` / `glob`: `metadata.matchCount` if present
- `webfetch`: stripped URL display

If metadata isn't present (e.g. older opencode versions), fall back to current minimal rendering. No regression risk.

### `tg-bridge/src/pinned-status.ts` — new

The heart of B1. Single class `PinnedStatusManager` holding per-chat live state in memory:

```typescript
interface ChatLiveState {
  // Persistent (mirrors chat_state row)
  projectPath: string | null
  sessionId: string | null
  model: string | null
  coolifyApp: { uuid: string; fqdn: string } | null
  pinnedMessageId: number | null
  pinPaused: boolean
  // Ephemeral (in-memory only)
  status: "idle" | "working" | "failed" | "aborted"
  statusDetail: string | null            // e.g. "fixing navbar"
  lastActivityAt: number                 // ms epoch
}

class PinnedStatusManager {
  setIdle(chatId, detail?)
  setWorking(chatId, detail?)
  setFailed(chatId, detail)
  setAborted(chatId)
  // Triggered by chat_state mutations
  onProjectChange(chatId)
  onSessionChange(chatId)
  onModelChange(chatId)
  onCoolifyAppChange(chatId)
  // Pin lifecycle
  enablePin(chatId)   // /pin command
  pausePin(chatId)    // bot detects unpin via Telegram error
}
```

Update strategy:
- Each setter mutates in-memory state and schedules a `flushStatus(chatId)` call
- `flushStatus` is debounced per chat — at most 1 flush per 1000ms
- `flushStatus` renders the status block and calls `safeEdit(pinnedMessageId)` if pinned exists, else `safeSend` + `pinChatMessage` to create + pin
- On `safeEdit` failure (message gone), recreate + re-pin
- On `safeSend` or `pinChatMessage` failure, set `pinPaused = true` and log warn
- `enablePin` always creates a fresh status message + pins + clears pin_paused

Status message body (HTML):
```
<b>🟢 Idle · slam-dunk-2</b>
<i>Session</i>: <code>ses_abc...</code> · 5 messages
<i>Model</i>: <code>claude-sonnet-4-5</code>
<i>Deploy</i>: ✅ <a href="https://abc.relentnet.dev">abc.relentnet.dev</a>
<i>Last activity</i>: 2 min ago
```

Inline keyboard:
```
[ Switch project ] [ Sessions ]
[ New session ]    [ Models ]
[ Deploy ]
```

Buttons trigger callbacks that the bridge routes to existing handlers:
- `pin:switch` → invoke `handleProjects` (B5 with inline kbd)
- `pin:sessions` → invoke new `handleSessions` (B4)
- `pin:new` → invoke `handleNew`
- `pin:models` → invoke `handleModel` (with inline kbd)
- `pin:deploy` → invoke `handleDeploy`

When `status === "working"`, status emoji becomes `⏳` and detail appears under the project line. When `failed`, `❌`. When `aborted`, `⏸`.

### `tg-bridge/src/commands/pin.ts` — new

Implements `/pin` and `/unpin`.

- `/pin` — re-engage the pinned status (clears `pin_paused`, creates fresh pinned message)
- `/unpin` — pause auto-pin updates (sets `pin_paused = true`, leaves the existing pin in place; user can manually unpin via Telegram if they want)

Both register a public help line.

### `tg-bridge/src/commands/sessions.ts` — new (B4)

`/sessions` lists recent opencode sessions for the current project. Implementation:

```typescript
const sessions = await client.session.list({ query: { directory: stateRow.projectPath } })
// Take latest 8, build inline keyboard:
// [ Session A · 12 msgs · 5 min ago ]
// [ Session B · 3 msgs · 2 hr ago ]
// ...
```

Each button's `callback_data` is `sess:<sessionId>`. The bridge's callback handler calls `state.setSession(chatId, sessionId)` + `router.ensureDirectory(...)` + sends a confirmation message.

### `tg-bridge/src/commands/projects.ts` — modify (B5)

Currently lists project names as text. Convert to inline keyboard:
```
[ slam-dunk-2 ]
[ test-deploy-3 ]
[ existing-project ]
```

Each button's `callback_data` is `proj:<name>`. Bridge handler invokes existing `handleSwitch` logic with the name.

Limit to 50 most recent (sort by mtime). Above 50, show first 50 + a "type /switch <name>" footer.

### `tg-bridge/src/commands/model.ts` — modify

Same pattern as projects. List available models from `client.model.list()` (or our hard-coded fallback set) as inline keyboard. Tap → set model.

### `tg-bridge/src/index.ts` — modify

- Add `bot.api.setMyCommands([...])` at startup (B2). Lists every public slash command with description.
- Register `pin:`, `sess:`, `proj:`, `model:`, `cancel:` callback prefixes in the existing `callback_query:data` router.
- Wire `PinnedStatusManager` instance + thread it through to all commands and message-handler.
- React to user message before processing (B3): bot.api.setMessageReaction(chatId, messageId, ['👍']) on entry.
- React with `✅` after success or `❌` after failure when the Turn finalizes.

### `tg-bridge/src/reactions.ts` — new (small)

Wrapper module:
```typescript
export async function reactProcessing(bot, chatId, messageId, log?)  // 👍
export async function reactDone(bot, chatId, messageId, log?)         // ✅
export async function reactFailed(bot, chatId, messageId, log?)       // ❌
```

Calls `bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👍' }])`. Wrapped in try/catch since reactions can fail silently (rate limit, message deleted) and we don't want them blocking the main flow.

### `tg-bridge/src/event-router.ts` — investigation work for A3

Plan:
1. SSH into VPS, pull recent journalctl, grep for sessions where `appendPart` fires but `idle` never fires
2. Probe opencode's event stream after a `promptAsync` call vs `prompt` call to see what events differ
3. Likely fixes (one or more):
   - **Event subscription**: `promptAsync` may use a different event topic. Subscribe additionally if needed.
   - **Idle watchdog**: if `appendPart` activity stops for 60s with no `idle`, treat as idle. Add `lastPartAt` timestamp on Turn; periodic check.
   - **Explicit poll fallback**: every 30s while a Turn is active, poll `client.session.get(sessionId)` and check `state.status`. If `idle` per opencode, drive `Turn.finalize()` manually.

The investigation determines which fix(es). Specs the watchdog + poll as the two implementation candidates; chooses one based on findings. Tests assert the watchdog fires at the right time without false positives.

### Migration / testing

- `chat_state` schema migration is idempotent (`PRAGMA table_info` + `ALTER TABLE` if column missing). Existing rows get NULL for `pinned_message_id`, FALSE for `pin_paused`, NULL for `last_user_message_id`. No user-visible breakage on first deploy; pinned status appears on the first state mutation after upgrade.
- All 5 tests touched + ~30 new tests across the new modules.
- The `marked` runtime dep is added; tests cover unusual inputs (nested code, malformed markdown, empty input, very long input, pathological nesting depths).

## Data flow (key paths)

### User sends a message during active project

```
1. User: "fix the navbar mobile responsive"
2. Bridge handlers fire:
   a. Reaction: 👍 on user message (B3)
   b. PinnedStatusManager.setWorking(chatId, "fix the navbar...")
   c. flushStatus updates pinned message: ⏳ Working · "fix the navbar..."
3. Turn created with cancelCallbackData="cancel:<sessionId>"
4. Turn.startHeartbeat() begins; placeholder shows _thinking · 0s elapsed_ + [⏹ Cancel]
5. Tool calls stream; renderStreamingView shows them
6. Heartbeat at 10s, 20s, 30s updates elapsed time
7. session.idle fires → Turn.finalize() runs
   a. renderFinalView produces HTML (commonmarkToTelegramHtml)
   b. safeEdit replaces placeholder with HTML reply
   c. Reaction: ✅ on user message (B3)
   d. PinnedStatusManager.setIdle(chatId)
   e. flushStatus updates pinned: 🟢 Idle · "last activity 0s ago"
```

### User taps "Switch project" button on pinned message

```
1. callback_query: data="pin:switch"
2. Router routes to handleProjects (B5)
3. handleProjects sends NEW message with [project1] [project2] ... inline keyboard
4. User taps [project2]
5. callback_query: data="proj:project2"
6. Router invokes existing handleSwitch logic with name="project2"
7. handleSwitch creates session + updates chat_state + sends switch confirmation
8. PinnedStatusManager.onProjectChange(chatId) → flushStatus updates pinned message
```

### User manually unpins the bot's status message

```
1. User taps "Unpin message" in Telegram
2. (Telegram doesn't notify the bot)
3. Next state change triggers flushStatus
4. safeEdit on pinned_message_id succeeds (the message still exists, just isn't pinned anymore)
5. (No detection — user accepted the bot can re-pin if they want)
   OR
4'. safeEdit fails (message was deleted entirely, not just unpinned)
5'. Try sendMessage + pinChatMessage; this re-pins. User loses their unpin.

To honor "respect /unpin until /pin": if the user wants the bot to STOP auto-pinning, they run /unpin. /pin re-engages.
```

The fully-pinned-but-respect-unpin design: bot ONLY tries to unpin/re-pin when explicit /pin is run. The auto-edit on the existing pinned message is fine because it doesn't change the pinned/unpinned state. If user manually unpins, the message stays edited but not pinned. This is acceptable behavior.

### Cancel button tapped during a running turn

```
1. callback_query: data="cancel:<sessionId>"
2. Router locates the active Turn for that sessionId in PinnedStatusManager.currentTurn
3. Turn.cancel() runs:
   a. Sets cancelled flag
   b. Cancels heartbeat timer
   c. safeEdit replaces placeholder with "⏸ Cancelled by user"
4. Bridge calls client.session.abort(sessionId) so opencode stops the agent
5. PinnedStatusManager.setAborted(chatId) → flushStatus
6. Reaction: replaces 👍 with ⏸ on user's original message
```

## Edge cases

| Case | Behavior |
|---|---|
| User `/pin` but never had a pinned message | Send + pin a fresh status message |
| User `/pin` while pinned exists | Unpin + delete old, send + pin new |
| User `/unpin` (not Telegram unpin) | Set `pin_paused=true`, leave pinned message in place, no further updates until `/pin` |
| User manually unpins via Telegram | Bot doesn't detect; auto-edit still works on the now-unpinned message; if message was deleted, re-pin fails (set `pin_paused=true`) |
| Status update during Telegram rate limit (429) | `safeEdit` already handles retry via `@grammyjs/auto-retry`; if it ultimately fails, log + skip; next update retries |
| Pinned message edit fails because message gone | `flushStatus` falls back to send + re-pin |
| Status update mid-turn (working → working with new detail) | Debounce absorbs; at most 1 update per 1000ms |
| Reaction call fails (network blip, rate limit) | Caught + logged, doesn't block the Turn |
| HTML conversion produces invalid Telegram entities (e.g. unbalanced `<b>`) | `safeEdit` falls back to plain text via `stripHtml` |
| Markdown contains `<script>` tag | `marked` strips by default; `escapeHtml` would also strip `<` to `&lt;` |
| Tool line with metadata.lines undefined | Falls back to minimal `📄 read \`config.py\`` |
| Heartbeat fires after Turn already finalized | `if (this.finalized) return;` guard at top |
| Cancel button tapped after Turn already finalized | callback_query handler checks Turn state; toast "Already done" |
| User taps tap-to-switch button for project that no longer exists | Bridge re-checks via `existsSync`; replies with friendly error |
| `setMyCommands` fails on bot startup | Log warn; commands still work via typing |
| Bot restart: `currentTurn` map is empty | Cancel buttons on old messages are no-ops; toast "Turn not found, may have completed" |

## Testing strategy

### Unit tests

- `format.test.ts`: filter user-role text parts (A1) — assert assistant-only parts in concatenation
- `markdown-to-html.test.ts` (NEW): bold/italic/code/fenced/headers-degrade/lists/links/quotes/passes/strips
- `safe-telegram.test.ts`: HTML mode + plain-text fallback; stripHtml round-trip
- `turn.test.ts`: heartbeat fires + stops on finalize; cancel button rendered when callbackData set; elapsed-time format
- `format.test.ts`: renderToolLine (C3) — extracts metadata.lines, time delta, etc; falls back when missing
- `pinned-status.test.ts` (NEW): debounce; flush sequencing; pin paused respected; recreate on edit-fail; status text shape
- `reactions.test.ts` (NEW): all 3 helpers swallow errors
- `commands/sessions.test.ts` (NEW): inline keyboard shape; callback routing
- `commands/projects.test.ts`: now produces inline keyboard
- `commands/model.test.ts`: now produces inline keyboard
- `commands/pin.test.ts` (NEW): /pin re-engages; /unpin pauses
- `chat-state.test.ts`: new columns roundtrip; migration idempotent

### Integration verification (manual on VPS)

1. Send message → expect 👍 reaction within 1s
2. Wait → expect ✅ reaction (or ❌) when done
3. Verify final message has HTML rendering: bold, italic, code spans, code fences with language, lists with bullets, links clickable
4. Verify pinned message exists at top of chat with status block + 5 buttons
5. Tap "Switch project" → see inline keyboard of project buttons → tap one → confirmation arrives → pinned message updates
6. Tap "Sessions" → see inline keyboard of recent sessions → tap one → switches
7. Verify no echo of user input in agent reply
8. Type `/` → see all bot commands in autocomplete
9. Send long-running prompt → expect heartbeat updates ("12s", "22s", ...) and `[⏹ Cancel]` button
10. Tap cancel → placeholder shows "⏸ Cancelled by user"; opencode session aborted
11. Run `/unpin` → bot stops updating pinned message; existing pin stays
12. Run `/pin` → bot creates fresh status + pins
13. Verify state stuck-on-thinking is gone (or at minimum, cancel button works to recover)

## Risks

- **`marked` security**: HTML injection possible if marked is misconfigured. We use it in "no-html-passthrough" mode (`mangle: false, headerIds: false, breaks: false, gfm: true`) and run output through Telegram's HTML parser which is strict. Safe.
- **Pinned message spam**: pinning a message in Telegram by default sends a "User pinned message" notification to all chat members. In a 1:1 DM that's just a small banner. Configurable via `disable_notification: true`.
- **Reaction rate limits**: Telegram allows ~10 reactions/sec per chat. Our usage is 2-3 reactions per turn. Far below limit.
- **Heartbeat edits + final edit racing**: Turn class already serializes via `inFlightEdit`. Heartbeat respects this.
- **chat_state migration on existing user**: NULL columns mean status is "no pin" until first state change. First state change creates + pins. No interruption.
- **opencode SDK shape drift**: A3 investigation may reveal events change with newer opencode versions. Watchdog + poll fallback insulates against this.
- **Long-running tool inflates elapsed time display**: If a `bash` runs `npm install` for 5 minutes, the heartbeat shows `_thinking · 5m elapsed_`. That's accurate; no special handling needed.
- **Inline keyboard data limit**: Telegram callback_data is 64 bytes. Project names can be up to 30 chars; `proj:<30-char-name>` = 35 bytes. Safe. Session IDs are ~24 chars; `sess:<id>` = 30 bytes. Safe.
- **Bot context lost on restart**: in-memory `PinnedStatusManager` state lost. Status message stays pinned but shows last persisted state until next state change. Acceptable.

## Out of scope (deferred to V2/V3)

- Project rename / delete commands
- /history (show last N session messages)
- /share (gist export)
- Long code-block expand/collapse
- Per-message "show details" expand button
- Bot startup recovery for sessions that idled offline
- Multi-user / topic threads
- Web App / Mini App integration
- Inline mode (@botname queries from any chat)
- Notification settings configuration via /notifications
- Custom emoji per-project (theming)
- Localization (English only for now)

## Build order

Sized to coherent commits:

1. **A1** filter user-role text parts (~30 min)
2. **A3a** investigation: SSH + journalctl + probe opencode events; commit findings to spec
3. **A3b** implement chosen fix (watchdog or poll)
4. **B2** setMyCommands at startup (~15 min)
5. **B3** reactions module + wire into message-handler (~1 hr)
6. **A2** markdown-to-html + safeEdit HTML mode + format.ts uses HTML (~3 hr)
7. **chat_state schema migration** for B1 (~30 min)
8. **B1** PinnedStatusManager + wire into all state mutations (~3 hr)
9. **B4** /sessions command + tap-to-switch (~1 hr)
10. **B5** /projects + /model with inline keyboards (~1 hr)
11. **C3** richer tool lines (~1 hr)
12. **C1** Turn heartbeat (~1 hr)
13. **C2** Turn cancel button (~1 hr)
14. **Build + deploy + smoke verify**

Total: ~15 tasks, ~25-30 commits, ~50 new tests.
