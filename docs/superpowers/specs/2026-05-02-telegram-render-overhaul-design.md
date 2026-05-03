# Telegram Bridge Render Overhaul — Design

**Date:** 2026-05-02
**Status:** Proposed
**Supersedes:** Render sections of `2026-05-02-headless-opencode-server-design.md`

## Problem

The current render path produces malformed MarkdownV2 that crashes the bridge mid-turn and never delivers the final assistant reply.

### Symptom observed

User sends a prompt that triggers multiple tool calls (e.g. "what's in this project?" → 3× read, 1× grep, 1× bash). The placeholder updates a few times during streaming, then stops. The bridge container restarts and the user never sees the assistant's final answer.

### Root cause

Two compounding bugs:

1. **Unbalanced code fences from segment joining.** `format.ts:101` joins tool segments with `""`. Each tool segment is `_called \`tool\`_\n\`\`\`\n<body>\n\`\`\`` — when concatenated, the closing ` ``` ` of tool A and the italic header `_called \`tool B\`_` end up adjacent with no separating newline. Telegram's MarkdownV2 parser sees `\`\`\`_called` and either parses it as a new code block start (which never closes) or fails outright with `Bad Request: can't parse entities: Can't find end of Pre entity at byte offset N`.

2. **Unhandled rejection kills the process.** `Turn.finalize()` (`turn.ts:73-97`) does NOT wrap `editMessageText` in try/catch. When Telegram returns 400, the rejection bubbles to `onIdle()` in `message-handler.ts`, which discards the promise via `void turn.finalize()`. Node 22's default policy on unhandled rejection is `--unhandled-rejections=throw` → process exits → Docker restarts the container → in-flight session state is lost → final reply never delivered.

### Beyond the bug

Even when rendering doesn't crash, the streaming output is jarring: tool input/output bodies are crammed into the placeholder via fenced code blocks that grow on every edit, the message reflows on each delta, and the final state visually resembles a debugger transcript more than a chat reply.

User has loosened opencode's permission policy to `allow` for everything, removing the keyboard-prompt friction. With permissions out of the way, the rendering UX is now the dominant pain point and warrants a redesign rather than a patch.

## Goals

1. Bridge never crashes due to render output, regardless of message content
2. Streaming view is calm, scannable, and small (mobile-friendly)
3. Final reply is always delivered and is dominated by the assistant's actual answer, with tool activity demoted to metadata
4. Render output is structurally guaranteed to be valid MarkdownV2 (no class of bug where partial state produces invalid markup)
5. Fall back to plain text if MarkdownV2 fails for any reason — never lose the message

## Non-goals

- Permission keyboard rendering (separate concern, currently working)
- Slash command output rendering (working, untouched)
- File-diff rendering (deferred, opencode doesn't emit `EventSessionDiff` for our usage)
- Multi-turn conversation history rendering (Telegram inherently shows history; bridge only renders one turn at a time)
- Image / file attachment rendering (out of scope — opencode parts may include `file` types but bridge currently ignores them, will continue to)

## Architecture

### Current

```
EventRouter → Turn.appendPart(part)
                 ↓
              Turn.scheduleEdit() → Turn.editNow() → bot.editMessageText(renderParts(allParts))
                                                                          ↑
                                                              format.ts joins segments with ""
                                                              each segment uses fenced code blocks

EventRouter → Turn.finalize() → bot.editMessageText(renderParts(allParts)) — same renderer, different timing
                              → bot.sendMessage(chunk) for chunks 2+
```

Single render path. No distinction between "streaming view" and "final view". Errors from `editMessageText` in finalize() crash the process.

### Proposed

```
EventRouter → Turn.appendPart(part)
                 ↓
              Turn.scheduleEdit() → Turn.editStreaming() → bot.editMessageText(renderStreamingView(parts))
                                                                                ↑
                                                                  Compact tool list, no fences

EventRouter → Turn.finalize() → bot.editMessageText(renderFinalView(parts))
                              → bot.sendMessage(chunk) for chunks 2+
                                ↑
                                Concatenated text + muted summary header

All Telegram calls wrapped in safeEdit/safeSend helpers:
  - try MarkdownV2
  - on parse error, retry as plain text (escape stripped)
  - on persistent failure, log and continue (never throw)
```

Two render functions. Both produce structurally simple output (no fenced code blocks of variable content). `Turn` distinguishes streaming vs finalizing. All Telegram calls are unconditionally try/catch'd at the lowest layer.

## Components

### `format.ts` — rewritten

Public exports:

| Function | Purpose |
|---|---|
| `escapeMarkdownV2(text)` | unchanged — escapes reserved chars outside code spans |
| `renderStreamingView(parts, options?)` | produces the placeholder content while agent is working |
| `renderFinalView(parts, options?)` | produces the final reply content after `session.idle` |
| `RenderablePart` (type) | unchanged shape, still discriminated on `type` |

Internal helpers (not exported):

- `toolEmoji(name)` — `📄` (read/write/edit), `🔍` (grep/glob), `⚡` (bash), `🌐` (webfetch), `🔧` (anything else)
- `summarizeToolInput(name, input)` — unchanged from current `format.ts:35`, returns a single-string summary of the most informative input field
- `renderToolLine(part)` — produces one line: `📄 read \`config.py\`` or `❌ bash \`bad command\``
- `renderToolSummary(parts)` — produces the muted header: `_used 5 tools · 3 read · 1 grep · 1 bash_` (and `· N errors` if any)
- `concatenateTextParts(parts)` — joins all text parts in order with `\n\n`, returns escaped MarkdownV2

#### Renderer behavior — streaming view

Input: ordered list of parts (text + tool, in arrival order).

Algorithm:

1. Filter to tool parts only; ignore text parts during streaming (we don't show partial assistant text — it's the source of half-rendered markdown bugs)
2. For each tool part, produce one line via `renderToolLine`:
   - Status `pending` or `running`: `📄 read \`config.py\``
   - Status `completed`: same line — no output body shown during streaming
   - Status `error`: `❌ read \`config.py\`` (red emoji prefix instead of tool emoji)
3. If more than 30 tool lines, replace oldest into one collapsed line: `_…N earlier actions…_`
4. Append a final line `_thinking…_` (italic) to indicate work in progress
5. Join all lines with `\n` and return

Empty case (no tools yet): just `_thinking…_`.

Output format example:

```
📄 read `config.py`
📄 read `db.py`
🔍 grep `FastAPI`
⚡ bash `pwd`
_thinking…_
```

This output uses ONLY: inline code (single backticks), italic (underscores), emoji, newlines. No fenced code blocks. No multi-line tool bodies. Structurally cannot produce unbalanced fences.

Inline code with backtick characters in the input: backticks inside the input are escaped as `\\` per MarkdownV2 spec for code-span content. The `summarizeToolInput` output goes through `escapeMarkdownV2` first (escapes outside-code reserveds), then is wrapped in backticks. If the original input contains a literal backtick, we replace it with `'` before wrapping (lossy but safe). This is documented in the renderer.

#### Renderer behavior — final view

Input: full ordered list of parts at `session.idle` time.

Algorithm:

1. Compute tool counts: total, per-name (read, grep, bash, etc.), error count
2. If at least one tool was used:
   - Header line: `_used N tools · {breakdown}{· N errors if any}_`
   - Followed by `\n\n`
3. Else: no header
4. Concatenate all text parts in order, joined by `\n\n`, escaped via `escapeMarkdownV2`
5. If body is empty AND tools were used: `_(no response text)_`
6. If body is empty AND no tools: `_(no response)_`
7. Return header + body

Output format example (with tools):

```
_used 5 tools · 3 read · 1 grep · 1 bash_

The application is a FastAPI backend with a React frontend\. The main entry point is `backend/app/main\.py`, which configures CORS\.\.\.
```

Output format example (no tools):

```
The application is a FastAPI backend with a React frontend\. The main entry point is `backend/app/main\.py`\.\.\.
```

Same MarkdownV2 safety guarantees: no fenced code blocks, no multi-line dynamic content. Inline code (backticks) appears only inside the assistant's text and is whatever the LLM emitted (if the LLM emits valid markdown, we preserve it; if not, escaping handles it). Headers and italics are statically composed by the renderer.

### `turn.ts` — minor refactor

Public surface unchanged: `appendPart`, `showError`, `finalize`.

Internal changes:

| Method | Change |
|---|---|
| `editNow` | call `renderStreamingView(parts)` instead of `renderParts(parts)`; wrap call in `safeEdit` (see below) |
| `finalize` | call `renderFinalView(parts)` instead of `renderParts(parts)`; wrap all Telegram calls in `safeEdit`/`safeSend`; never throws |
| `renderCurrent` (private) | removed — replaced by direct calls to the new renderers |

`appendPart`, `showError`, throttling logic, finalized flag — all unchanged.

### `safe-telegram.ts` — new file

Two thin wrappers around `bot.editMessageText` / `bot.sendMessage`:

```typescript
export async function safeEdit(bot, chatId, messageId, text, log): Promise<void>
export async function safeSend(bot, chatId, text, log): Promise<{ message_id: number } | null>
```

Both:

1. Try `parse_mode: "MarkdownV2"`
2. On any error, retry once with `parse_mode: undefined` (plain text — strip backslash escapes from the text first via a `stripMarkdownV2Escapes(text)` helper)
3. On second failure, log a warning and return (`safeEdit`) or return `null` (`safeSend`)
4. Never throw

This guarantees no Telegram error propagates out of these helpers, so `Turn.finalize()` and `Turn.editNow()` cannot crash the process.

`stripMarkdownV2Escapes(text)` is a simple `replace(/\\(.)/g, "$1")` — undoes the escaping we did, leaving raw text with the agent's intent (italics/code visible as `_x_` and backticks, but readable).

### Other files — touched only in tests

- `chunker.ts` — unchanged. Still chunks on line boundaries. The new render output is line-oriented and never has fenced code blocks, so the chunker's fence-balancing logic is dormant for the new output but harmless.
- `event-router.ts`, `message-handler.ts`, `index.ts`, slash commands — unchanged.

## Data flow

### Streaming (one tool call arriving)

```
opencode → SSE event {message.part.updated, properties.part: ToolPart}
event-router → handler.onPartUpdated(part)
message-handler → turn.appendPart(part)
turn.appendPart → parts.set(id, part); scheduleEdit()
turn.scheduleEdit → setTimeout(throttleMs - elapsed, editNow)
turn.editNow → text = renderStreamingView(parts); safeEdit(bot, chatId, msgId, text)
safeEdit → bot.editMessageText(...{parse_mode: MarkdownV2}) [success path]
       OR → bot.editMessageText(...{plain text}) [fallback path]
       OR → log.warn, return [final fallback]
```

### Finalize (session.idle)

```
opencode → SSE event {session.idle, properties.sessionID}
event-router → handler.onIdle()
message-handler → void turn.finalize().catch(log.error) [defensive .catch]
turn.finalize → text = renderFinalView(parts)
              → chunks = chunkForTelegram(text)
              → safeEdit(bot, chatId, placeholderId, chunks[0])
              → for chunk in chunks[1..]: safeSend(bot, chatId, chunk)
```

`finalize` itself never throws (everything inside is safeEdit/safeSend), but `message-handler` adds a defensive `.catch` anyway in case future changes introduce throws.

## Edge cases — explicit decisions

| Case | Behavior |
|---|---|
| 0 tools, normal text response | Final view: just the text. No summary header. |
| 0 tools, empty text response | Final view: `_(no response)_` |
| Tools used, empty text response | Final view: `_used N tools · ...header..._\n\n_(no response text)_` |
| Multi-text-part response | Concatenate all text parts in order with `\n\n` between them |
| Tool errored, agent recovered | Streaming: `❌` prefix on that line; Final: error counted in header `· 1 error` |
| All tools errored, agent gave up | Same as above; final text reflects the give-up |
| Final view exceeds 4096 chars | Chunker splits at line boundaries; first chunk replaces placeholder via `safeEdit`; subsequent chunks via `safeSend` as new messages |
| Streaming view tool count > 30 | Collapse oldest tool lines into one summary line: `_…20 earlier actions…_` |
| Tool input has backticks | Replace backticks with `'` before inline-code-wrapping (lossy but safe) |
| Tool input is structured object with no preferred field | Fall back to `JSON.stringify(input).slice(0, 80)` |
| Telegram returns 400 (parse error) | `safeEdit` retries with plain text (escapes stripped) |
| Telegram returns 429 (rate limit) | `@grammyjs/auto-retry` (already installed) honors `retry_after`; `safeEdit` will see the eventual outcome |
| Telegram returns 5xx | `safeEdit` logs warn and returns; user sees stale placeholder; next event will trigger another edit attempt |
| `safeEdit` fails twice | Log warn `{ error, textLength, chatId }` and return; do not crash |

## Testing strategy

### Unit tests

New tests in `tests/format.test.ts`:

1. `renderStreamingView`:
   - empty parts → `_thinking…_`
   - one read tool pending → `📄 read \`config.py\`\n_thinking…_`
   - five mixed tools → 5 lines + `_thinking…_`, correct emoji per family
   - tool with error → `❌` prefix
   - 35 tools → first 5 collapsed into `_…5 earlier actions…_` + 30 latest + thinking line
   - tool input with backticks → backticks replaced with `'` in output
   - text parts present → ignored during streaming

2. `renderFinalView`:
   - 0 tools, text → just text, no header
   - 0 tools, no text → `_(no response)_`
   - 5 tools, text → header with breakdown + body
   - 5 tools, no text → header + `_(no response text)_`
   - 1 tool error, text → header includes `· 1 error`
   - 3 text parts → all concatenated with `\n\n`
   - text containing backticks/underscores → escaped correctly

New tests in `tests/safe-telegram.test.ts`:

1. `safeEdit`:
   - Success path: returns normally, single Telegram call
   - MarkdownV2 parse error → retry with plain text → success
   - Both attempts fail → log warn, no throw
   - `stripMarkdownV2Escapes` unescapes correctly

2. `safeSend`:
   - Symmetric tests

Update existing tests in `tests/turn.test.ts`:

- `editNow` now uses `renderStreamingView` — assertion patterns change but flow is the same
- `finalize` now uses `renderFinalView` — same
- New test: `finalize` survives Telegram error (mock bot.editMessageText to throw, assert no rejection)
- New test: `editNow` survives Telegram error (same)

Remove or update tests in `tests/format.test.ts` that asserted fenced code block output for tools (no longer applicable).

### Integration verification (manual on Unraid)

After deploy:

1. Send `What's in this project?` to a switched-to project. Expect streaming view of tool reads, then final reply with summary header.
2. Send `pwd in bash` (small, single tool). Expect 1-line streaming, then short final reply with `_used 1 tool · 1 bash_` header.
3. Send `Hi` (no tools). Expect just `_thinking…_` then plain text reply with no header.
4. Force a Telegram error: send a prompt that produces output containing intentional malformed markdown (tricky — but verifying via unit tests is the primary mechanism).
5. Verify `docker logs tg-bridge` shows no `Bad Request: can't parse entities` errors after deploy. Verify no container restarts in `docker ps` uptime column.

## Migration

This is a behavior change but not a data change. No state migration needed. `chat-state.sqlite` schema unchanged. Compose / Dockerfile / .env unchanged.

Rollout: standard ssh + git pull + docker compose build tg-bridge + restart. The first prompt after deploy uses the new renderer.

## Risks

- **Phone-only emoji rendering** — unicode emoji like `📄` `🔍` `⚡` render reliably across iOS, Android, Desktop, Web Telegram clients. No risk.
- **Italic rendering on third-party clients (Beeper)** — Beeper strips inline_keyboard but renders normal markdown. The streaming view uses italic; if Beeper drops italics it degrades to plain text, which is still readable.
- **Performance under high tool counts** — `renderStreamingView` is O(N) per edit and is called at most once per second. With up to 30 lines retained, output is ~600 bytes — well under Telegram limits and edit-rate constraints.
- **Loss of agent narration during streaming** — by design we hide partial text parts during streaming. The full text is preserved and shown in the final view. If user finds this confusing, fallback path is to add streaming text to the bottom of the streaming view in a future iteration. Keep the option open by structuring `renderStreamingView` to support an optional `showText: boolean` flag (deferred — implement only if requested).
- **Plain-text fallback losing formatting** — if MarkdownV2 fails twice, user sees raw text with backslash escapes stripped. Loses italic/code emphasis but preserves all information. Acceptable.

## Out of scope (logged for future)

- Streaming the agent's text incrementally (the C-style mockup) — rejected for this iteration due to MarkdownV2 partial-render fragility
- Showing tool output bodies in any view — out of scope; if user wants to see what `read` returned, they open opencode web UI
- File diff rendering with `EventSessionDiff` — opencode doesn't emit this for our usage
- Per-tool collapsible sections (Telegram doesn't support it natively anyway)
- Token usage / cost rendering in the summary header — interesting, deferred
