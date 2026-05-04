# Telegram Bot Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three-tier refinement of the Telegram bridge (correctness fixes, pinned status surface, in-flight UX) so the bot feels polished on a phone.

**Architecture:** Three coordinated subsystems sharing infrastructure. Render layer adopts Telegram HTML via `marked`; Status layer adds an in-memory `PinnedStatusManager` driven by chat_state mutations; In-flight layer extends `Turn` with heartbeat + cancel button. New runtime dep: `marked`.

**Tech Stack:** TypeScript (Node 22, ESM, strict), grammy, vitest, pino, better-sqlite3, marked. Project uses `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Tests use `mock.calls[0]!` per existing convention.

**Spec:** `docs/superpowers/specs/2026-05-04-telegram-bot-refinements-design.md`

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `tg-bridge/src/format.ts` | Modify | Filter user-role text parts (A1); switch render output to HTML; richer tool lines (C3) |
| `tg-bridge/src/markdown-to-html.ts` | Create | Convert agent's CommonMark to Telegram-flavored HTML via marked |
| `tg-bridge/src/safe-telegram.ts` | Modify | HTML mode primary; plain-text fallback strips HTML tags |
| `tg-bridge/src/turn.ts` | Modify | Heartbeat (C1) + cancel button (C2) + uses HTML render output |
| `tg-bridge/src/event-router.ts` | Modify | Subscribe to message.created + dispatch to handlers (for A1 message-role tracking) |
| `tg-bridge/src/chat-state.ts` | Modify | Add pinned_message_id + pin_paused + last_user_message_id columns |
| `tg-bridge/src/pinned-status.ts` | Create | PinnedStatusManager: per-chat live state, debounced flush, render + pin lifecycle |
| `tg-bridge/src/reactions.ts` | Create | Thin wrappers around bot.api.setMessageReaction |
| `tg-bridge/src/commands/pin.ts` | Create | /pin and /unpin commands |
| `tg-bridge/src/commands/sessions.ts` | Create | /sessions tap-to-switch (B4) |
| `tg-bridge/src/commands/projects.ts` | Modify | Inline keyboard tap-to-switch (B5) |
| `tg-bridge/src/commands/model.ts` | Modify | Inline keyboard tap-to-set (B5) |
| `tg-bridge/src/commands/help.ts` | Modify | Lists /pin /unpin /sessions |
| `tg-bridge/src/message-handler.ts` | Modify | Filter user parts (A1); call reactions (B3); call pinned status (B1); store user_message_id |
| `tg-bridge/src/index.ts` | Modify | setMyCommands at startup (B2); wire PinnedStatusManager; add cancel/pin/sess/proj callback prefixes |
| `tg-bridge/src/project-creator.ts` | Modify | Filter user parts (A1) |
| `tg-bridge/src/commands/deploy.ts` | Modify | Filter user parts (A1) |
| `tg-bridge/package.json` | Modify | Add marked dep |
| 14 test files | Create/Modify | Coverage for all new behavior |

**Total:** 4 new source files + 11 modified, 1 new dep, ~50 new tests.

---

## Task 1: A1 — Filter user-role text parts from final view

**Files:**
- Modify: `tg-bridge/src/event-router.ts`
- Modify: `tg-bridge/src/format.ts`
- Modify: `tg-bridge/src/message-handler.ts`
- Modify: `tg-bridge/src/project-creator.ts`
- Modify: `tg-bridge/src/commands/deploy.ts`
- Modify: `tg-bridge/tests/format.test.ts`
- Modify: `tg-bridge/tests/event-router.test.ts`

**Goal:** Stop the bot from echoing the user's prompt in final replies. Root cause (verified via opencode source): when bridge calls `client.session.promptAsync(sid, text)`, opencode creates a USER message containing the prompt text. opencode then emits `message.part.updated` events for that user message's text parts BEFORE emitting events for the assistant's response. Bridge's `onPartUpdated` accumulates ALL parts indiscriminately. `concatenateTextParts` then includes the user prompt in the final view.

**Fix approach:** Subscribe to `message.created` events to track each message's role per session. Filter parts at render time by looking up their `messageID` in a per-session role map.

- [ ] **Step 1: Probe live session to confirm root cause**

```bash
ssh root@87.99.138.104 'U=$(grep ^OPENCODE_USERNAME= /opt/opencode-telegram/.env | cut -d= -f2-) && P=$(grep ^OPENCODE_SERVER_PASSWORD= /opt/opencode-telegram/.env | cut -d= -f2-) && SID=$(curl -s -u "$U:$P" "http://100.127.115.94:4096/session?directory=/workspace/test-remote-repo" | jq -r ".[0].id") && echo "Session: $SID" && curl -s -u "$U:$P" "http://100.127.115.94:4096/session/$SID/messages" | jq "[.[] | {role: .info.role, parts: [.parts[] | {type, text: (.text // empty)[:80]}]}][:6]"'
```

Expected: shows user-role messages with text parts containing the prompt text. Confirms the bridge's part collection is correct but the FILTER is missing.

- [ ] **Step 2: Write failing tests**

Append to `tg-bridge/tests/format.test.ts` inside an existing describe block:

```typescript
describe("concatenateTextParts user-role filtering", () => {
  it("skips text parts marked role=user", () => {
    const parts = [
      { type: "text", text: "fix the navbar", role: "user" },
      { type: "text", text: "Sure, on it.", role: "assistant" },
    ];
    expect(concatenateTextParts(parts)).toBe("Sure, on it\\.");
  });

  it("skips text parts whose messageID matches a user-message id", () => {
    const parts = [
      { type: "text", text: "fix the navbar", messageID: "msg_user_1" },
      { type: "text", text: "Sure, on it.", messageID: "msg_assist_1" },
    ];
    const userIds = new Set(["msg_user_1"]);
    expect(concatenateTextParts(parts, { userMessageIds: userIds })).toBe("Sure, on it\\.");
  });

  it("includes parts with no role/messageID metadata (safe default)", () => {
    const parts = [{ type: "text", text: "hello" }];
    expect(concatenateTextParts(parts)).toBe("hello");
  });
});
```

Append to `tg-bridge/tests/event-router.test.ts`:

```typescript
it("dispatches message.created to onMessageCreated handlers", async () => {
  const onMessageCreated = vi.fn();
  const events = [
    { type: "message.created", properties: { info: { id: "msg_1", sessionID: "ses_1", role: "user" } } },
  ];
  const fakeClient = makeClientWithStream(events);
  const router = new EventRouter(fakeClient);
  router.registerSession("ses_1", {
    onPartUpdated: vi.fn(),
    onIdle: vi.fn(),
    onError: vi.fn(),
    onPermissionUpdated: vi.fn(),
    onMessageCreated,
  });
  const ac = new AbortController();
  void router.start(ac.signal, ["/x"]);
  await tick();
  ac.abort();
  expect(onMessageCreated).toHaveBeenCalledWith({ info: { id: "msg_1", sessionID: "ses_1", role: "user" } });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/format.test.ts tests/event-router.test.ts`
Expected: 4 new tests fail (concatenateTextParts ignores options arg; EventRouter doesn't dispatch message.created).

- [ ] **Step 4: Implement format.ts changes**

In `tg-bridge/src/format.ts`, extend `MaybeTextPart`:
```typescript
export interface MaybeTextPart {
  type: string;
  text?: string;
  role?: string;
  messageID?: string;
  [k: string]: unknown;
}
```

Modify `concatenateTextParts` signature to accept options:
```typescript
export interface ConcatTextOptions {
  userMessageIds?: Set<string>;
}

export function concatenateTextParts(
  parts: readonly MaybeTextPart[],
  options: ConcatTextOptions = {},
): string {
  const userIds = options.userMessageIds;
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type !== "text") continue;
    if (typeof p.text !== "string") continue;
    if (p.text.trim().length === 0) continue;
    // Filter user-role parts via role field if present
    if (typeof p.role === "string" && p.role.toLowerCase() === "user") continue;
    // Or via messageID lookup if caller supplied a set
    if (userIds && typeof p.messageID === "string" && userIds.has(p.messageID)) continue;
    texts.push(escapeMarkdownV2(p.text));
  }
  return texts.join("\n\n");
}
```

Update `renderFinalView` to accept the same options and pass through to `concatenateTextParts`.

- [ ] **Step 5: Implement event-router.ts changes**

In `tg-bridge/src/event-router.ts`, extend `SessionEventHandler`:
```typescript
onMessageCreated?(msg: unknown): void;
```

Add a case to `dispatch()`:
```typescript
case "message.created":
  handler.onMessageCreated?.(evt.properties);
  return;
```

Add `"message.created"` to `isKnownType()`.

- [ ] **Step 6: Implement message-handler.ts changes**

In `tg-bridge/src/message-handler.ts`, add to the per-prompt scope:
```typescript
const userMessageIds = new Set<string>();
```

Add handler method on the `SessionEventHandler`:
```typescript
onMessageCreated(msg) {
  const m = msg as { info?: { id?: string; role?: string } };
  if (m.info?.role === "user" && typeof m.info.id === "string") {
    userMessageIds.add(m.info.id);
  }
},
```

Pass `{ userMessageIds }` to `renderFinalView` calls in `onIdle`.

- [ ] **Step 7: Apply same changes in project-creator.ts and commands/deploy.ts**

Both files have parallel collectedParts patterns. Add the same `userMessageIds` set + `onMessageCreated` handler. Pass to render calls.

- [ ] **Step 8: Run all tests**

Run: `cd tg-bridge && npx vitest run`
Expected: 314 baseline + ~6 new = ~320 passing.

- [ ] **Step 9: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add tg-bridge/src/event-router.ts tg-bridge/src/format.ts tg-bridge/src/message-handler.ts tg-bridge/src/project-creator.ts tg-bridge/src/commands/deploy.ts tg-bridge/tests/format.test.ts tg-bridge/tests/event-router.test.ts
git commit -m "format: filter user-role text parts from final view

opencode's promptAsync creates a user message containing the prompt
text BEFORE the assistant responds. Bridge's onPartUpdated previously
accumulated ALL parts including the user's, so concatenateTextParts
echoed the user prompt back in the final view.

Fix: subscribe to message.created events; track user-message IDs per
session; filter parts at render time. Defense in depth via two paths:
(1) check part.role === 'user' if present, (2) check messageID
membership in the supplied set. Either path is sufficient."
```

---

## Task 2: A3 — Diagnose + fix stuck-on-thinking

**Files:**
- Modify: `tg-bridge/src/turn.ts`
- Modify: `tg-bridge/src/event-router.ts` (potentially)
- Modify: `tg-bridge/tests/turn.test.ts`

**Goal:** When the agent finishes work, the placeholder always updates to the final view. Today this fails intermittently — the user sees `_thinking…_` indefinitely.

**Investigation first; implementation second.** The fix shape depends on what the investigation reveals.

- [ ] **Step 1: Reproduce + diagnose**

```bash
ssh root@87.99.138.104 'journalctl -u tg-bridge --since "24 hours ago" --no-pager -o cat | grep -E "appendPart|onIdle|finalize|prompt failed|errored|reconnect" | tail -100'
```

Look for sessions where `appendPart` fires but `onIdle` never does. Check if any error events or reconnects coincide. Also probe the SDK:

```bash
ssh root@87.99.138.104 'U=$(grep ^OPENCODE_USERNAME= /opt/opencode-telegram/.env | cut -d= -f2-) && P=$(grep ^OPENCODE_SERVER_PASSWORD= /opt/opencode-telegram/.env | cut -d= -f2-) && curl -sN -u "$U:$P" -H "Accept: text/event-stream" "http://100.127.115.94:4096/event?directory=/workspace/test-remote-repo" | head -100 &
SLEEP_PID=$!
sleep 3
# In another terminal trigger a prompt; for now just observe what events arrive
sleep 10
kill $SLEEP_PID 2>/dev/null'
```

Document findings in a comment at the top of the implemented Task 2 fix.

Likely root causes (one or more):
- `session.idle` arrives but reaches a Turn that's already finalized (race) → `onIdle` no-op'd, but a previous Turn was actually responsible for the message
- `session.idle` never fires for `promptAsync` flows — opencode might emit a different event (`session.completed`, `assistant.message.completed`, etc.) for async prompts
- A bash tool that hangs (e.g. `npm install` waiting for prompt input) keeps the session "running" indefinitely

- [ ] **Step 2: Write failing tests for the watchdog approach**

The watchdog: if a Turn sees no `appendPart` activity for IDLE_WATCHDOG_MS (default 60s) AND `session.idle` hasn't fired, treat it as idle and call `finalize()`.

Append to `tg-bridge/tests/turn.test.ts`:

```typescript
describe("Turn idle watchdog", () => {
  it("calls finalize() if no part updates arrive for IDLE_WATCHDOG_MS", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000, idleWatchdogMs: 60000 });
    turn.appendPart({ id: "p1", type: "text", text: "thinking..." });
    await vi.advanceTimersByTimeAsync(1500);
    expect(bot.calls.edits.length).toBeGreaterThan(0);
    // No more parts arrive; advance past watchdog
    await vi.advanceTimersByTimeAsync(60000);
    // Watchdog should have triggered finalize()
    // After finalize, further parts are ignored
    turn.appendPart({ id: "p2", type: "text", text: "late" });
    await vi.advanceTimersByTimeAsync(2000);
    // Verify finalized state by checking that no edit fired for "late"
    const finalEditCount = bot.calls.edits.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(bot.calls.edits.length).toBe(finalEditCount);
    vi.useRealTimers();
  });

  it("watchdog resets when new part arrives within window", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000, idleWatchdogMs: 60000 });
    turn.appendPart({ id: "p1", type: "text", text: "first" });
    await vi.advanceTimersByTimeAsync(50000); // approaching deadline
    turn.appendPart({ id: "p2", type: "text", text: "second" });
    await vi.advanceTimersByTimeAsync(50000); // reset by p2; total elapsed > 60s but no fire
    // Should not have finalized yet because watchdog reset on p2
    turn.appendPart({ id: "p3", type: "text", text: "third" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(bot.calls.edits.length).toBeGreaterThan(0);
    // Final edit for p3 should reflect three parts being known
    vi.useRealTimers();
  });

  it("explicit finalize cancels the watchdog", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000, idleWatchdogMs: 60000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await turn.finalize();
    // Watchdog should be cancelled; no double-finalize
    await vi.advanceTimersByTimeAsync(60000);
    // No second finalize edit beyond what finalize() already did
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/turn.test.ts`
Expected: 3 new tests fail (Turn doesn't have idle watchdog).

- [ ] **Step 4: Implement watchdog in Turn**

In `tg-bridge/src/turn.ts`:
```typescript
interface TurnOptions {
  throttleMs?: number;
  idleWatchdogMs?: number;  // default 60000
}

private watchdogTimer: NodeJS.Timeout | null = null;
private readonly idleWatchdogMs: number;

constructor(/* existing */, options: TurnOptions = {}) {
  // existing
  this.idleWatchdogMs = options.idleWatchdogMs ?? 60_000;
}

appendPart(part: IncomingPart): void {
  // existing logic
  this.resetWatchdog();
}

private resetWatchdog(): void {
  if (this.finalized) return;
  if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
  this.watchdogTimer = setTimeout(() => {
    if (this.finalized) return;
    // Watchdog fired: treat as idle and finalize
    void this.finalize().catch(() => undefined);
  }, this.idleWatchdogMs);
}

async finalize(): Promise<void> {
  if (this.watchdogTimer) {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }
  // existing finalize body
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tg-bridge && npx vitest run tests/turn.test.ts`
Expected: 3 new tests pass; existing tests stay green.

- [ ] **Step 6: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add tg-bridge/src/turn.ts tg-bridge/tests/turn.test.ts
git commit -m "turn: idle watchdog kicks finalize() if events stop for 60s

Defends against the stuck-on-thinking class of bug where session.idle
never arrives (or arrives racy) and the placeholder hangs forever.
Watchdog resets on every appendPart so active streams are never cut
off. Default 60s window — short enough that real stuck states recover
quickly, long enough that a paused tool isn't prematurely finalized."
```

---

## Task 3: B2 — Register slash commands via setMyCommands

**Files:**
- Modify: `tg-bridge/src/index.ts`

**Goal:** Telegram's `/` autocomplete shows all bot commands on every device.

- [ ] **Step 1: Add the call after bot construction in index.ts**

In `tg-bridge/src/index.ts`, after the bot is constructed but before `bot.start()`:

```typescript
async function registerCommands(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "help",        description: "Show available commands" },
      { command: "projects",    description: "List projects (tap to switch)" },
      { command: "switch",      description: "Switch to a project" },
      { command: "init",        description: "Create a local project" },
      { command: "initremote",  description: "Create project + private GitHub repo" },
      { command: "clone",       description: "Clone a git repo into workspace" },
      { command: "new",         description: "Start a fresh session in current project" },
      { command: "abort",       description: "Cancel the current operation" },
      { command: "status",      description: "Show current chat state" },
      { command: "model",       description: "List models (tap to set)" },
      { command: "sessions",    description: "Recent sessions (tap to switch)" },
      { command: "deploy",      description: "Push + deploy current project to Coolify" },
      { command: "pin",         description: "Re-engage the pinned status message" },
      { command: "unpin",       description: "Pause auto-updates of pinned status" },
    ]);
  } catch (err) {
    log.warn({ err }, "setMyCommands failed; commands still work via typing");
  }
}

// Call before bot.start():
await registerCommands(bot);
```

- [ ] **Step 2: Manual verification (no unit test for setMyCommands)**

Build + deploy + open Telegram, type `/`, expect autocomplete list.

- [ ] **Step 3: Commit**

```bash
git add tg-bridge/src/index.ts
git commit -m "bot: register slash commands via setMyCommands at startup

Surfaces the full command list in Telegram's / autocomplete on every
device. Failure is non-fatal — commands still work via typing."
```

---

## Task 4: B3 — Reactions on user messages

**Files:**
- Create: `tg-bridge/src/reactions.ts`
- Create: `tg-bridge/tests/reactions.test.ts`
- Modify: `tg-bridge/src/message-handler.ts` (apply reactions on entry/finalize)

**Goal:** Bot reacts 👍 immediately when receiving a user message, then ✅ on success or ❌ on failure (or ⏸ on cancel).

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/reactions.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { reactProcessing, reactDone, reactFailed, reactCancelled } from "../src/reactions.js";

function makeBot() {
  return {
    api: { setMessageReaction: vi.fn(async () => true) },
  };
}

describe("reactions module", () => {
  it("reactProcessing sets 👍", async () => {
    const bot = makeBot();
    await reactProcessing(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "👍" },
    ]);
  });
  it("reactDone sets ✅", async () => {
    const bot = makeBot();
    await reactDone(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "✅" },
    ]);
  });
  it("reactFailed sets ❌", async () => {
    const bot = makeBot();
    await reactFailed(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "❌" },
    ]);
  });
  it("reactCancelled sets ⏸", async () => {
    const bot = makeBot();
    await reactCancelled(bot as never, 1, 50);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(1, 50, [
      { type: "emoji", emoji: "⏸" },
    ]);
  });
  it("swallows API errors silently", async () => {
    const bot = { api: { setMessageReaction: vi.fn(async () => { throw new Error("rate limit"); }) } };
    const log = { warn: vi.fn() };
    await expect(reactProcessing(bot as never, 1, 50, log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/reactions.test.ts`
Expected: fail with module-not-found.

- [ ] **Step 3: Create reactions.ts**

```typescript
import type { Logger } from "pino";

export interface ReactionBot {
  api: {
    setMessageReaction(
      chatId: number,
      messageId: number,
      reactions: Array<{ type: "emoji"; emoji: string }>,
    ): Promise<unknown>;
  };
}

type ReactionLogger = Partial<Pick<Logger, "warn">>;

async function react(
  bot: ReactionBot,
  chatId: number,
  messageId: number,
  emoji: string,
  log?: ReactionLogger,
): Promise<void> {
  try {
    await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
  } catch (err) {
    log?.warn?.({ err, chatId, messageId, emoji }, "setMessageReaction failed");
  }
}

export const reactProcessing = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) => react(b, c, m, "👍", l);
export const reactDone       = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) => react(b, c, m, "✅", l);
export const reactFailed     = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) => react(b, c, m, "❌", l);
export const reactCancelled  = (b: ReactionBot, c: number, m: number, l?: ReactionLogger) => react(b, c, m, "⏸", l);
```

- [ ] **Step 4: Wire into message-handler.ts**

In `handleTextMessage`, immediately after extracting `userMessageId` (the user's prompt message ID):

```typescript
import { reactProcessing, reactDone, reactFailed } from "../reactions.js";

// At top of handleTextMessage after userMessageId is known:
void reactProcessing(deps.bot as never, chatId, userMessageId, deps.log);

// In onIdle handler, after successful finalize:
void reactDone(deps.bot as never, chatId, userMessageId, deps.log);

// In onError handler:
void reactFailed(deps.bot as never, chatId, userMessageId, deps.log);
```

NOTE: `userMessageId` should be `ctx.message.message_id`. Capture it in `handleTextMessage`.

- [ ] **Step 5: Update tests + run**

Run: `cd tg-bridge && npx vitest run`
Expected: all tests pass; +5 new = ~325.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/reactions.ts tg-bridge/tests/reactions.test.ts tg-bridge/src/message-handler.ts
git commit -m "Add reactions module + wire 👍/✅/❌ on user messages

Bot reacts 👍 immediately on receipt of a user message, then ✅ when
the turn finalizes successfully or ❌ on error. Swallows API errors
silently — reactions are best-effort, never blocking the main flow."
```

---

## Task 5: A2 — CommonMark to Telegram HTML

**Files:**
- Modify: `tg-bridge/package.json` (add marked)
- Create: `tg-bridge/src/markdown-to-html.ts`
- Modify: `tg-bridge/src/safe-telegram.ts` (HTML primary, plain-text strip fallback)
- Modify: `tg-bridge/src/format.ts` (renderFinalView outputs HTML)
- Modify: `tg-bridge/src/turn.ts` (uses HTML render output via safeEdit's HTML mode)
- Create: `tg-bridge/tests/markdown-to-html.test.ts`
- Modify: `tg-bridge/tests/safe-telegram.test.ts`
- Modify: `tg-bridge/tests/format.test.ts`

**Goal:** Agent's CommonMark renders correctly. Bold, italic, code, code fences, lists, links, headers (degraded to bold) all work.

- [ ] **Step 1: Install marked**

```bash
cd tg-bridge && npm install marked@^14.1.4
```

(Pin to v14 — major v14 has a stable API; v15 may exist but we tested against v14.)

- [ ] **Step 2: Write failing tests for markdown-to-html**

Create `tg-bridge/tests/markdown-to-html.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { commonmarkToTelegramHtml, escapeHtml } from "../src/markdown-to-html.js";

describe("escapeHtml", () => {
  it("escapes & < > only", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
  it("leaves quotes alone (Telegram HTML allows them in attribute values)", () => {
    expect(escapeHtml("a \"b\" 'c'")).toBe("a \"b\" 'c'");
  });
});

describe("commonmarkToTelegramHtml", () => {
  it("converts bold", () => {
    expect(commonmarkToTelegramHtml("**hi**").trim()).toBe("<b>hi</b>");
  });
  it("converts italic", () => {
    expect(commonmarkToTelegramHtml("*hi*").trim()).toBe("<i>hi</i>");
  });
  it("converts inline code", () => {
    expect(commonmarkToTelegramHtml("`code`").trim()).toBe("<code>code</code>");
  });
  it("converts fenced code with language", () => {
    const out = commonmarkToTelegramHtml("```ts\nconst x = 1;\n```").trim();
    expect(out).toBe('<pre><code class="language-ts">const x = 1;\n</code></pre>');
  });
  it("converts fenced code without language", () => {
    const out = commonmarkToTelegramHtml("```\nplain\n```").trim();
    expect(out).toBe("<pre><code>plain\n</code></pre>");
  });
  it("converts headings to bold (Telegram has no header tag)", () => {
    expect(commonmarkToTelegramHtml("# Hi").trim()).toBe("<b>Hi</b>");
    expect(commonmarkToTelegramHtml("## Sub").trim()).toBe("<b>Sub</b>");
  });
  it("converts bullet list with • marker", () => {
    const out = commonmarkToTelegramHtml("- one\n- two").trim();
    expect(out).toBe("• one\n• two");
  });
  it("converts ordered list preserving numbers", () => {
    const out = commonmarkToTelegramHtml("1. one\n2. two").trim();
    expect(out).toBe("1. one\n2. two");
  });
  it("converts links", () => {
    expect(commonmarkToTelegramHtml("[click](https://example.com)").trim()).toBe(
      '<a href="https://example.com">click</a>',
    );
  });
  it("converts blockquotes", () => {
    expect(commonmarkToTelegramHtml("> quoted").trim()).toBe("<blockquote>quoted</blockquote>");
  });
  it("strips raw HTML tags from input", () => {
    expect(commonmarkToTelegramHtml("<script>alert('x')</script>").trim()).not.toContain("<script>");
  });
  it("escapes & < > in plain text content", () => {
    expect(commonmarkToTelegramHtml("a < b & c > d").trim()).toBe("a &lt; b &amp; c &gt; d");
  });
  it("handles paragraphs separated by blank lines", () => {
    expect(commonmarkToTelegramHtml("para1\n\npara2").trim()).toBe("para1\n\npara2");
  });
  it("preserves backticks inside code spans by escaping them", () => {
    // Markdown: `` ` `` is inline code containing a backtick
    const out = commonmarkToTelegramHtml("`` ` ``").trim();
    expect(out).toBe("<code>`</code>");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/markdown-to-html.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Create markdown-to-html.ts**

```typescript
import { Marked, Renderer } from "marked";

/**
 * Telegram HTML mode supports a strict subset of HTML:
 *   <b> <i> <u> <s> <code> <pre> <a href> <blockquote> <span class="tg-spoiler">
 * No <ul>/<ol>/<li>, no <h1>-<h6>, no <p>, no tables.
 * We render Markdown into that subset.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class TelegramRenderer extends Renderer {
  paragraph(text: string): string { return text + "\n\n"; }
  heading(text: string): string { return `<b>${text}</b>\n`; }
  strong(text: string): string { return `<b>${text}</b>`; }
  em(text: string): string { return `<i>${text}</i>`; }
  del(text: string): string { return `<s>${text}</s>`; }
  codespan(text: string): string { return `<code>${escapeHtml(text)}</code>`; }
  code(code: string, lang?: string): string {
    const cls = lang ? ` class="language-${lang.replace(/"/g, "")}"` : "";
    return `<pre><code${cls}>${escapeHtml(code)}\n</code></pre>`;
  }
  link(href: string, _title: string | null | undefined, text: string): string {
    const safeHref = href.replace(/"/g, "&quot;");
    return `<a href="${safeHref}">${text}</a>`;
  }
  blockquote(quote: string): string { return `<blockquote>${quote.trim()}</blockquote>`; }
  list(body: string, ordered: boolean, start: number | ""): string {
    if (ordered) {
      // Numbered list — use the digit prefix
      let n = (typeof start === "number" ? start : 1) - 1;
      return body
        .trim()
        .split("\n")
        .map((line) => `${++n}. ${line.replace(/^[-•]\s*/, "")}`)
        .join("\n") + "\n";
    }
    return body.trim().split("\n").map((l) => l.startsWith("•") ? l : `• ${l}`).join("\n") + "\n";
  }
  listitem(text: string): string { return `${text}\n`; }
  br(): string { return "\n"; }
  hr(): string { return "\n———\n"; }
  // No <table>, <image>, <html> support — return their text or empty
  table(): string { return ""; }
  image(): string { return ""; }
  html(): string { return ""; }
  text(text: string): string { return escapeHtml(text); }
}

const marked = new Marked({
  renderer: new TelegramRenderer(),
  gfm: true,
  breaks: false,
  pedantic: false,
});

export function commonmarkToTelegramHtml(input: string): string {
  if (!input) return "";
  const result = marked.parse(input, { async: false });
  if (typeof result !== "string") return "";
  return result.trim();
}
```

- [ ] **Step 5: Run tests + iterate**

Run: `cd tg-bridge && npx vitest run tests/markdown-to-html.test.ts`
Iterate until all 14 tests pass. Some tests may need slight adjustment for marked's exact whitespace handling.

- [ ] **Step 6: Update safe-telegram.ts to support HTML**

In `tg-bridge/src/safe-telegram.ts`, add helper `stripHtml` and adjust the safeEdit/safeSend logic:

```typescript
export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Update safeEdit/safeSend signatures to accept parseMode:
export type ParseMode = "MarkdownV2" | "HTML";

export async function safeEdit(
  bot: SafeEditBot,
  chatId: number,
  messageId: number,
  text: string,
  log?: SafeLogger,
  parseMode: ParseMode = "HTML",  // default flips from MarkdownV2 to HTML
): Promise<void> {
  try {
    await bot.editMessageText(chatId, messageId, text, { parse_mode: parseMode });
  } catch (err) {
    try {
      const plain = parseMode === "HTML" ? stripHtml(text) : stripMarkdownV2Escapes(text);
      await bot.editMessageText(chatId, messageId, plain, {});
    } catch (err2) {
      log?.warn?.({ err, err2, chatId, messageId, parseMode }, "safeEdit failed both modes");
    }
  }
}
// Same shape change for safeSend.
```

- [ ] **Step 7: Update format.ts renderFinalView**

`renderFinalView` currently produces MarkdownV2. Change it to produce HTML by:
- Passing `text` parts through `commonmarkToTelegramHtml`
- Replacing `escapeMarkdownV2` calls with `escapeHtml` for static template strings
- Replacing `_used N tools · ..._` (italic via underscore) with `<i>used N tools · ...</i>`

```typescript
// In renderFinalView:
const summary = renderToolSummaryHtml(parts);
const body = concatenateTextPartsHtml(parts, options);
// ... compose ...
```

Add new functions `renderToolSummaryHtml` and `concatenateTextPartsHtml` that produce HTML output. Keep the existing MarkdownV2 versions for streaming view.

- [ ] **Step 8: Update format.test.ts**

Update existing assertions to expect HTML output for renderFinalView. Streaming view tests stay on MarkdownV2 (no change needed).

- [ ] **Step 9: Run full suite + typecheck**

Run: `cd tg-bridge && npx vitest run && npm run typecheck`
Expected: all pass; ~14 new + format.ts test updates.

- [ ] **Step 10: Commit**

```bash
git add tg-bridge/package.json tg-bridge/package-lock.json tg-bridge/src/markdown-to-html.ts tg-bridge/src/safe-telegram.ts tg-bridge/src/format.ts tg-bridge/src/turn.ts tg-bridge/tests/markdown-to-html.test.ts tg-bridge/tests/safe-telegram.test.ts tg-bridge/tests/format.test.ts
git commit -m "format: render final view as Telegram HTML via marked

Switches the final-reply rendering from MarkdownV2 to HTML so the
agent's CommonMark output (bold, italic, code, fences, lists, links,
quotes, headers degraded to bold) renders correctly. Streaming view
stays MarkdownV2 (simpler character set, no nested escaping issues).

safeEdit/safeSend default to HTML mode; on parse failure, strip tags
and retry as plain text. Adds marked@^14 (~50KB) as a runtime dep."
```

---

## Task 6: chat_state schema migration for pinned status

**Files:**
- Modify: `tg-bridge/src/chat-state.ts`
- Modify: `tg-bridge/tests/chat-state.test.ts`

**Goal:** Add 3 nullable columns: `pinned_message_id`, `pin_paused`, `last_user_message_id`. Idempotent migration. New repo methods.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/chat-state.test.ts`:

```typescript
describe("ChatStateRepo pinned-status fields", () => {
  it("setPinnedMessageId + getPinnedMessageId roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getPinnedMessageId(1)).toBeNull();
    repo.setPinnedMessageId(1, 1234);
    expect(repo.getPinnedMessageId(1)).toBe(1234);
  });

  it("setPinPaused + getPinPaused roundtrip (default false)", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getPinPaused(1)).toBe(false);
    repo.setPinPaused(1, true);
    expect(repo.getPinPaused(1)).toBe(true);
    repo.setPinPaused(1, false);
    expect(repo.getPinPaused(1)).toBe(false);
  });

  it("setLastUserMessageId + getLastUserMessageId roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getLastUserMessageId(1)).toBeNull();
    repo.setLastUserMessageId(1, 999);
    expect(repo.getLastUserMessageId(1)).toBe(999);
  });

  it("creates the new columns on construction (idempotent)", () => {
    const db = new Database(":memory:");
    new ChatStateRepo(db);
    new ChatStateRepo(db);
    const cols = db.prepare("PRAGMA table_info(chat_state)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("pinned_message_id")).toBe(true);
    expect(names.has("pin_paused")).toBe(true);
    expect(names.has("last_user_message_id")).toBe(true);
  });

  it("migrates existing rows: NULL pinned_message_id, FALSE pin_paused", () => {
    const db = new Database(":memory:");
    // Set up an OLD-style schema row first
    db.exec(`CREATE TABLE chat_state (chat_id INTEGER PRIMARY KEY, project_path TEXT, session_id TEXT, model TEXT, updated_at INTEGER NOT NULL);`);
    db.prepare("INSERT INTO chat_state (chat_id, project_path, session_id, updated_at) VALUES (?, ?, ?, ?)")
      .run(1, "/x", "ses_y", Date.now());
    // Construct repo — should ALTER TABLE add new columns
    const repo = new ChatStateRepo(db);
    expect(repo.getPinnedMessageId(1)).toBeNull();
    expect(repo.getPinPaused(1)).toBe(false);
    expect(repo.getLastUserMessageId(1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests + fail**

Run: `cd tg-bridge && npx vitest run tests/chat-state.test.ts`

Expected: 5 new tests fail (methods missing, columns missing).

- [ ] **Step 3: Implement schema migration + methods**

In `tg-bridge/src/chat-state.ts`, add a `migrateSchema(db)` function called from constructor BEFORE prepared statements:

```typescript
function migrateSchema(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(chat_state)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("pinned_message_id")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN pinned_message_id INTEGER");
  }
  if (!colNames.has("pin_paused")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN pin_paused INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.has("last_user_message_id")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN last_user_message_id INTEGER");
  }
}
```

Add to the SCHEMA constant for fresh DBs (so new chat_state tables include the columns from the start):
```sql
CREATE TABLE IF NOT EXISTS chat_state (
  chat_id              INTEGER PRIMARY KEY,
  project_path         TEXT,
  session_id           TEXT,
  model                TEXT,
  pinned_message_id    INTEGER,
  pin_paused           INTEGER NOT NULL DEFAULT 0,
  last_user_message_id INTEGER,
  updated_at           INTEGER NOT NULL
);
```

In the constructor:
```typescript
constructor(private db: Database.Database) {
  db.exec(SCHEMA);
  migrateSchema(db); // For DBs that pre-date the new columns
  // ... existing prepared statements ...
  this.getPinnedStmt   = db.prepare("SELECT pinned_message_id FROM chat_state WHERE chat_id = ?");
  this.setPinnedStmt   = db.prepare("UPDATE chat_state SET pinned_message_id = ?, updated_at = ? WHERE chat_id = ?");
  this.getPausedStmt   = db.prepare("SELECT pin_paused FROM chat_state WHERE chat_id = ?");
  this.setPausedStmt   = db.prepare("UPDATE chat_state SET pin_paused = ?, updated_at = ? WHERE chat_id = ?");
  this.getLastUserStmt = db.prepare("SELECT last_user_message_id FROM chat_state WHERE chat_id = ?");
  this.setLastUserStmt = db.prepare("UPDATE chat_state SET last_user_message_id = ?, updated_at = ? WHERE chat_id = ?");
}
```

Add public methods:
```typescript
getPinnedMessageId(chatId: number): number | null {
  const row = this.getPinnedStmt.get(chatId) as { pinned_message_id: number | null } | undefined;
  return row?.pinned_message_id ?? null;
}
setPinnedMessageId(chatId: number, messageId: number | null): void {
  this.ensureRow(chatId);
  this.setPinnedStmt.run(messageId, Date.now(), chatId);
}
getPinPaused(chatId: number): boolean {
  const row = this.getPausedStmt.get(chatId) as { pin_paused: number } | undefined;
  return Boolean(row?.pin_paused);
}
setPinPaused(chatId: number, paused: boolean): void {
  this.ensureRow(chatId);
  this.setPausedStmt.run(paused ? 1 : 0, Date.now(), chatId);
}
getLastUserMessageId(chatId: number): number | null {
  const row = this.getLastUserStmt.get(chatId) as { last_user_message_id: number | null } | undefined;
  return row?.last_user_message_id ?? null;
}
setLastUserMessageId(chatId: number, messageId: number): void {
  this.ensureRow(chatId);
  this.setLastUserStmt.run(messageId, Date.now(), chatId);
}

private ensureRow(chatId: number): void {
  // Helper that inserts an empty row if none exists, so the UPDATE statements have something to hit
  this.db.prepare("INSERT OR IGNORE INTO chat_state (chat_id, updated_at) VALUES (?, ?)").run(chatId, Date.now());
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd tg-bridge && npx vitest run && npm run typecheck`
Expected: all pass; +5 new = ~330.

- [ ] **Step 5: Commit**

```bash
git add tg-bridge/src/chat-state.ts tg-bridge/tests/chat-state.test.ts
git commit -m "chat-state: add pinned_message_id + pin_paused + last_user_message_id

Idempotent ALTER TABLE migration in openChatStateDb. Existing rows
get NULL for the new ID columns and FALSE for pin_paused. New repo
methods support per-chat pinned-status state."
```

---

## Task 7: B1 — PinnedStatusManager core

**Files:**
- Create: `tg-bridge/src/pinned-status.ts`
- Create: `tg-bridge/tests/pinned-status.test.ts`

**Goal:** Per-chat in-memory live state, debounced flush, render the status block, manage the pin lifecycle. Wiring into the rest of the codebase happens in Task 8.

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/pinned-status.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { PinnedStatusManager } from "../src/pinned-status.js";
import { ChatStateRepo } from "../src/chat-state.js";

function makeBot() {
  const sent: Array<unknown[]> = [];
  const edits: Array<unknown[]> = [];
  const pins: Array<unknown[]> = [];
  return {
    sent,
    edits,
    pins,
    api: {
      sendMessage: vi.fn(async (...args: unknown[]) => { sent.push(args); return { message_id: 999 }; }),
      editMessageText: vi.fn(async (...args: unknown[]) => { edits.push(args); }),
      pinChatMessage: vi.fn(async (...args: unknown[]) => { pins.push(args); }),
      unpinChatMessage: vi.fn(async () => undefined),
    },
  };
}

let repo: ChatStateRepo;
beforeEach(() => {
  const db = new Database(":memory:");
  repo = new ChatStateRepo(db);
});

describe("PinnedStatusManager", () => {
  it("creates + pins a fresh status message on first flush", async () => {
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    expect(bot.sent).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
    expect(repo.getPinnedMessageId(1)).toBe(999);
  });

  it("edits the existing pinned message on subsequent flushes", async () => {
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    psm.setWorking(1, "fixing navbar");
    await psm.flushNow(1);
    expect(bot.sent).toHaveLength(1);
    expect(bot.edits).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
  });

  it("debounces multiple state changes within window", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 1000 });
    psm.setIdle(1);
    psm.setWorking(1, "a");
    psm.setWorking(1, "b");
    await vi.advanceTimersByTimeAsync(500);
    expect(bot.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(bot.sent).toHaveLength(1);
    vi.useRealTimers();
  });

  it("respects pin_paused: skips flush entirely", async () => {
    const bot = makeBot();
    repo.setPinPaused(1, true);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    expect(bot.sent).toHaveLength(0);
    expect(bot.edits).toHaveLength(0);
  });

  it("re-creates pinned message when edit fails (message gone)", async () => {
    const bot = makeBot();
    bot.api.editMessageText.mockRejectedValueOnce(new Error("message to edit not found"));
    repo.setPinnedMessageId(1, 999);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    expect(bot.edits).toHaveLength(1); // First attempt
    expect(bot.sent).toHaveLength(1); // Recreate
    expect(bot.pins).toHaveLength(1);
  });

  it("enablePin: clears pin_paused, sends + pins fresh message", async () => {
    const bot = makeBot();
    repo.setPinPaused(1, true);
    repo.setPinnedMessageId(1, 555);
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.enablePin(1);
    expect(repo.getPinPaused(1)).toBe(false);
    expect(bot.sent).toHaveLength(1);
    expect(bot.pins).toHaveLength(1);
  });

  it("pausePin: sets pin_paused", async () => {
    const bot = makeBot();
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    await psm.pausePin(1);
    expect(repo.getPinPaused(1)).toBe(true);
  });

  it("renders Idle status with project + session + model + deploy", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    repo.setModel(1, "anthropic/claude-sonnet-4-5");
    repo.setCoolifyApp(1, "/workspace/site", "uuid-1", "site.example.com");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setIdle(1);
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    expect(sentText).toContain("Idle");
    expect(sentText).toContain("site"); // project name (last segment)
    expect(sentText).toContain("ses_abc");
    expect(sentText).toContain("claude-sonnet-4-5");
    expect(sentText).toContain("site.example.com");
  });

  it("renders Working status with detail line", async () => {
    const bot = makeBot();
    repo.setProject(1, "/workspace/site", "ses_abc");
    const psm = new PinnedStatusManager(bot as never, repo, { debounceMs: 0 });
    psm.setWorking(1, "fixing navbar mobile responsive");
    await psm.flushNow(1);
    const sentText = String(bot.sent[0]![1]);
    expect(sentText).toContain("Working");
    expect(sentText).toContain("fixing navbar");
  });
});
```

- [ ] **Step 2: Run tests + fail**

Run: `cd tg-bridge && npx vitest run tests/pinned-status.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Create pinned-status.ts**

```typescript
import type { Logger } from "pino";
import { escapeHtml } from "./markdown-to-html.js";
import type { ChatStateRepo } from "./chat-state.js";

export interface PinnedStatusBot {
  api: {
    sendMessage(chatId: number, text: string, opts: object): Promise<{ message_id: number }>;
    editMessageText(chatId: number, messageId: number, text: string, opts: object): Promise<unknown>;
    pinChatMessage(chatId: number, messageId: number, opts?: object): Promise<unknown>;
    unpinChatMessage(chatId: number, messageId: number): Promise<unknown>;
  };
}

export type StatusKind = "idle" | "working" | "failed" | "aborted";

interface LiveState {
  status: StatusKind;
  statusDetail: string | null;
  lastActivityAt: number;
}

interface Options {
  debounceMs?: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export class PinnedStatusManager {
  private live = new Map<number, LiveState>();
  private timers = new Map<number, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly log: Options["log"];

  constructor(
    private bot: PinnedStatusBot,
    private repo: ChatStateRepo,
    options: Options = {},
  ) {
    this.debounceMs = options.debounceMs ?? 1000;
    this.log = options.log;
  }

  setIdle(chatId: number, detail?: string): void {
    this.live.set(chatId, { status: "idle", statusDetail: detail ?? null, lastActivityAt: Date.now() });
    this.schedule(chatId);
  }
  setWorking(chatId: number, detail: string): void {
    this.live.set(chatId, { status: "working", statusDetail: detail, lastActivityAt: Date.now() });
    this.schedule(chatId);
  }
  setFailed(chatId: number, detail: string): void {
    this.live.set(chatId, { status: "failed", statusDetail: detail, lastActivityAt: Date.now() });
    this.schedule(chatId);
  }
  setAborted(chatId: number): void {
    this.live.set(chatId, { status: "aborted", statusDetail: null, lastActivityAt: Date.now() });
    this.schedule(chatId);
  }
  notifyStateChange(chatId: number): void {
    // Called by chat-state mutation hooks (project/session/model/coolify changes)
    this.schedule(chatId);
  }

  async enablePin(chatId: number): Promise<void> {
    this.repo.setPinPaused(chatId, false);
    // Force a fresh message + pin
    const live = this.live.get(chatId) ?? { status: "idle" as const, statusDetail: null, lastActivityAt: Date.now() };
    this.live.set(chatId, live);
    await this.createAndPin(chatId);
  }

  async pausePin(chatId: number): Promise<void> {
    this.repo.setPinPaused(chatId, true);
  }

  async flushNow(chatId: number): Promise<void> {
    const t = this.timers.get(chatId);
    if (t) { clearTimeout(t); this.timers.delete(chatId); }
    await this.flush(chatId);
  }

  private schedule(chatId: number): void {
    if (this.debounceMs === 0) {
      void this.flush(chatId);
      return;
    }
    const existing = this.timers.get(chatId);
    if (existing) clearTimeout(existing);
    this.timers.set(chatId, setTimeout(() => {
      this.timers.delete(chatId);
      void this.flush(chatId);
    }, this.debounceMs));
  }

  private async flush(chatId: number): Promise<void> {
    if (this.repo.getPinPaused(chatId)) return;
    const text = this.renderStatus(chatId);
    const pinnedId = this.repo.getPinnedMessageId(chatId);
    if (pinnedId == null) {
      await this.createAndPin(chatId);
      return;
    }
    try {
      await this.bot.api.editMessageText(chatId, pinnedId, text, {
        parse_mode: "HTML",
        reply_markup: this.buildKeyboard(),
      });
    } catch (err) {
      this.log?.warn?.({ err, chatId, pinnedId }, "edit pinned status failed; recreating");
      await this.createAndPin(chatId);
    }
  }

  private async createAndPin(chatId: number): Promise<void> {
    const text = this.renderStatus(chatId);
    let msgId: number;
    try {
      const sent = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: this.buildKeyboard(),
        disable_notification: true,
      });
      msgId = sent.message_id;
    } catch (err) {
      this.log?.warn?.({ err, chatId }, "sendMessage for pinned status failed; pausing pin");
      this.repo.setPinPaused(chatId, true);
      return;
    }
    try {
      await this.bot.api.pinChatMessage(chatId, msgId, { disable_notification: true });
      this.repo.setPinnedMessageId(chatId, msgId);
    } catch (err) {
      this.log?.warn?.({ err, chatId, msgId }, "pinChatMessage failed; pausing pin");
      this.repo.setPinPaused(chatId, true);
    }
  }

  private renderStatus(chatId: number): string {
    const row = this.repo.get(chatId);
    const live = this.live.get(chatId) ?? { status: "idle" as StatusKind, statusDetail: null, lastActivityAt: Date.now() };
    const projectName = row?.projectPath ? row.projectPath.split("/").pop() ?? "(none)" : "(none)";
    const sessionId = row?.sessionId ?? "(none)";
    const model = row?.model ?? "(default)";
    const coolify = row?.projectPath ? this.repo.getCoolifyApp(chatId, row.projectPath) : null;
    const elapsedMin = Math.floor((Date.now() - live.lastActivityAt) / 60000);

    const statusEmoji = { idle: "🟢", working: "⏳", failed: "❌", aborted: "⏸" }[live.status];
    const statusLabel = { idle: "Idle", working: "Working", failed: "Failed", aborted: "Aborted" }[live.status];

    const lines: string[] = [];
    lines.push(`<b>${statusEmoji} ${statusLabel} · ${escapeHtml(projectName)}</b>`);
    if (live.statusDetail) lines.push(`<i>${escapeHtml(live.statusDetail)}</i>`);
    lines.push(`<i>Session</i>: <code>${escapeHtml(sessionId)}</code>`);
    lines.push(`<i>Model</i>: <code>${escapeHtml(model)}</code>`);
    if (coolify) {
      lines.push(`<i>Deploy</i>: ✅ <a href="https://${escapeHtml(coolify.fqdn)}">${escapeHtml(coolify.fqdn)}</a>`);
    }
    lines.push(`<i>Last activity</i>: ${elapsedMin === 0 ? "just now" : `${elapsedMin} min ago`}`);
    return lines.join("\n");
  }

  private buildKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: "Switch project", callback_data: "pin:switch" },
          { text: "Sessions", callback_data: "pin:sessions" },
        ],
        [
          { text: "New session", callback_data: "pin:new" },
          { text: "Models", callback_data: "pin:models" },
        ],
        [
          { text: "Deploy", callback_data: "pin:deploy" },
        ],
      ],
    };
  }
}
```

- [ ] **Step 4: Run tests + iterate**

Run: `cd tg-bridge && npx vitest run tests/pinned-status.test.ts`
Iterate until all 9 tests pass.

- [ ] **Step 5: Run full suite + typecheck**

Run: `cd tg-bridge && npx vitest run && npm run typecheck`
Expected: all pass; +9 new.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/pinned-status.ts tg-bridge/tests/pinned-status.test.ts
git commit -m "Add PinnedStatusManager with debounced flush + pin lifecycle

Per-chat in-memory live state (idle/working/failed/aborted) combined
with persistent state from chat_state. Renders an HTML status block
with project + session + model + Coolify URL + 5 inline buttons.
Debounced flush absorbs rapid mutations. Recreates+repins on edit
failure. Respects pin_paused (set by /unpin or by send/pin failure)."
```

---

## Task 8: Wire PinnedStatusManager into all state mutations

**Files:**
- Modify: `tg-bridge/src/index.ts` (instantiate PSM, register pin: callbacks)
- Modify: `tg-bridge/src/commands/switch.ts` (call PSM.notifyStateChange after setProject)
- Modify: `tg-bridge/src/commands/new.ts` (call PSM.notifyStateChange)
- Modify: `tg-bridge/src/commands/model.ts` (call PSM.notifyStateChange)
- Modify: `tg-bridge/src/commands/deploy.ts` (call PSM.notifyStateChange after Coolify app set)
- Modify: `tg-bridge/src/message-handler.ts` (PSM.setWorking on receive, setIdle on finalize, setFailed on error)
- Modify: `tg-bridge/src/project-creator.ts` (same)

**Goal:** Every state-changing operation calls into the manager so the pinned message stays in sync.

- [ ] **Step 1: Instantiate in index.ts**

In `tg-bridge/src/index.ts`:
```typescript
import { PinnedStatusManager } from "./pinned-status.js";

const pinnedStatus = new PinnedStatusManager(bot, state, { log });
```

Pass `pinnedStatus` to all command-handler dep objects (one new field per deps interface).

- [ ] **Step 2: Add pin: callback router in index.ts**

```typescript
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("pin:")) {
    await ctx.answerCallbackQuery();
    const action = data.slice(4);
    if (action === "switch") return handleProjects(ctx as never, projectsDeps);
    if (action === "sessions") return handleSessions(ctx as never, sessionsDeps);
    if (action === "new") return handleNew(ctx as never, newDeps);
    if (action === "models") return handleModel(ctx as never, modelDeps);
    if (action === "deploy") return handleDeploy(ctx as never, deployDeps);
    return;
  }
  // existing routing
});
```

- [ ] **Step 3: Wire setWorking / setIdle / setFailed**

In `message-handler.ts:handleTextMessage`:
```typescript
deps.pinnedStatus.setWorking(chatId, ctx.message.text.slice(0, 60));

// in onIdle handler:
deps.pinnedStatus.setIdle(chatId);

// in onError handler:
deps.pinnedStatus.setFailed(chatId, describeError(err).slice(0, 80));
```

Same pattern in `project-creator.ts` and `commands/deploy.ts`'s deploy orchestrator.

- [ ] **Step 4: Wire notifyStateChange on chat_state mutations**

After every `state.setProject` / `state.setSession` / `state.setModel` / `state.setCoolifyApp` call across `commands/switch.ts`, `commands/new.ts`, `commands/model.ts`, `commands/deploy.ts`, `project-creator.ts`:
```typescript
deps.pinnedStatus.notifyStateChange(chatId);
```

- [ ] **Step 5: Update existing command tests**

Add `pinnedStatus: makePinnedStatus()` to deps fixtures across:
- `tests/message-handler.test.ts`
- `tests/project-creator.test.ts`
- `tests/commands/switch.test.ts`
- `tests/commands/new.test.ts`
- `tests/commands/model.test.ts`
- `tests/commands/deploy.test.ts`

Where `makePinnedStatus()` returns:
```typescript
() => ({
  setIdle: vi.fn(),
  setWorking: vi.fn(),
  setFailed: vi.fn(),
  setAborted: vi.fn(),
  notifyStateChange: vi.fn(),
})
```

- [ ] **Step 6: Run all tests + typecheck**

Run: `cd tg-bridge && npx vitest run && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add tg-bridge/src/index.ts tg-bridge/src/commands/{switch,new,model,deploy}.ts tg-bridge/src/message-handler.ts tg-bridge/src/project-creator.ts tg-bridge/tests/
git commit -m "Wire PinnedStatusManager into all state-changing flows

Every project/session/model/coolify mutation calls notifyStateChange.
Every Turn lifecycle event calls setWorking/setIdle/setFailed. Pin
inline keyboard's 5 buttons route to the existing command handlers
via 'pin:' callback prefix."
```

---

## Task 9: /pin and /unpin commands

**Files:**
- Create: `tg-bridge/src/commands/pin.ts`
- Create: `tg-bridge/tests/commands/pin.test.ts`
- Modify: `tg-bridge/src/index.ts` (register both commands)
- Modify: `tg-bridge/src/commands/help.ts` (mention them)

**Goal:** User can /pin to re-engage and /unpin to pause.

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/commands/pin.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handlePin, handleUnpin } from "../../src/commands/pin.js";

function makeCtx() {
  return { chat: { id: 1 }, reply: vi.fn(async () => undefined) };
}
function makeDeps() {
  return {
    pinnedStatus: {
      enablePin: vi.fn(async () => undefined),
      pausePin: vi.fn(async () => undefined),
    },
  };
}

describe("/pin", () => {
  it("calls enablePin and replies confirming", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handlePin(ctx as never, deps as never);
    expect(deps.pinnedStatus.enablePin).toHaveBeenCalledWith(1);
    expect(ctx.reply).toHaveBeenCalled();
  });
});

describe("/unpin", () => {
  it("calls pausePin and replies confirming", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleUnpin(ctx as never, deps as never);
    expect(deps.pinnedStatus.pausePin).toHaveBeenCalledWith(1);
    expect(ctx.reply).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run + fail**

Run: `cd tg-bridge && npx vitest run tests/commands/pin.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Create commands/pin.ts**

```typescript
import type { Context } from "grammy";
import type { PinnedStatusManager } from "../pinned-status.js";

export interface PinDeps {
  pinnedStatus: Pick<PinnedStatusManager, "enablePin" | "pausePin">;
}

export async function handlePin(ctx: Context, deps: PinDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  await deps.pinnedStatus.enablePin(chatId);
  await ctx.reply("📌 Pinned status engaged. I'll keep it updated.");
}

export async function handleUnpin(ctx: Context, deps: PinDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  await deps.pinnedStatus.pausePin(chatId);
  await ctx.reply("📌 Pinned status paused. Run /pin to re-engage.");
}
```

- [ ] **Step 4: Register in index.ts**

```typescript
import { handlePin, handleUnpin } from "./commands/pin.js";
bot.command("pin", (ctx) => handlePin(ctx, { pinnedStatus }));
bot.command("unpin", (ctx) => handleUnpin(ctx, { pinnedStatus }));
```

- [ ] **Step 5: Update help.ts**

Add to RAW:
```
/pin — re-engage the pinned status message
/unpin — pause auto-updates of pinned status
```

- [ ] **Step 6: Update help test**

Add `/pin` and `/unpin` to the for-loop check in `tests/commands/help.test.ts`.

- [ ] **Step 7: Run + commit**

```bash
git add tg-bridge/src/commands/pin.ts tg-bridge/src/index.ts tg-bridge/src/commands/help.ts tg-bridge/tests/commands/pin.test.ts tg-bridge/tests/commands/help.test.ts
git commit -m "Add /pin and /unpin commands

/pin re-engages the pinned status (sends + pins fresh message,
clears pin_paused). /unpin pauses auto-updates without unpinning;
existing pin stays put. Run /pin again to resume."
```

---

## Task 10: B4 — /sessions tap-to-switch

**Files:**
- Create: `tg-bridge/src/commands/sessions.ts`
- Create: `tg-bridge/tests/commands/sessions.test.ts`
- Modify: `tg-bridge/src/index.ts` (register, add sess: callback prefix)
- Modify: `tg-bridge/src/commands/help.ts`

**Goal:** /sessions lists recent sessions for current project as inline keyboard. Tap → switch.

- [ ] **Step 1: Write failing tests**

Create `tg-bridge/tests/commands/sessions.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleSessions, handleSessionCallback } from "../../src/commands/sessions.js";

function makeCtx(opts: { chatId?: number; data?: string } = {}) {
  return {
    chat: { id: opts.chatId ?? 1 },
    reply: vi.fn(async () => ({ message_id: 999 })),
    answerCallbackQuery: vi.fn(async () => undefined),
    callbackQuery: opts.data ? { data: opts.data } : undefined,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof handleSessions>[1]> = {}) {
  return {
    state: {
      get: vi.fn(() => ({ chatId: 1, projectPath: "/workspace/site", sessionId: "ses_old", model: null, updatedAt: 0 })),
      setSession: vi.fn(),
    },
    client: {
      listSessions: vi.fn(async () => [
        { id: "ses_a", title: "fix navbar", time: { updated: Date.now() - 5 * 60_000 } },
        { id: "ses_b", title: "add dark mode", time: { updated: Date.now() - 60 * 60_000 } },
      ]),
    },
    router: { ensureDirectory: vi.fn() },
    pinnedStatus: { notifyStateChange: vi.fn() },
    ...overrides,
  };
}

describe("/sessions", () => {
  it("replies with no project message when state has no projectPath", async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ state: { get: vi.fn(() => null), setSession: vi.fn() } });
    await handleSessions(ctx as never, deps as never);
    expect(String(ctx.reply.mock.calls[0]![0])).toMatch(/switch/i);
  });

  it("lists sessions with inline keyboard", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessions(ctx as never, deps as never);
    expect(deps.client.listSessions).toHaveBeenCalledWith({ directory: "/workspace/site" });
    const opts = ctx.reply.mock.calls[0]![1] as { reply_markup?: { inline_keyboard?: unknown[][] } };
    expect(opts?.reply_markup?.inline_keyboard?.length).toBeGreaterThanOrEqual(2);
    const firstButton = (opts.reply_markup!.inline_keyboard![0] as Array<{ callback_data: string }>)[0]!;
    expect(firstButton.callback_data).toBe("sess:ses_a");
  });
});

describe("session callback", () => {
  it("switches session on tap", async () => {
    const ctx = makeCtx({ data: "sess:ses_a" });
    const deps = makeDeps();
    await handleSessionCallback(ctx as never, deps as never);
    expect(deps.state.setSession).toHaveBeenCalledWith(1, "ses_a");
    expect(deps.pinnedStatus.notifyStateChange).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run + fail**

Run: `cd tg-bridge && npx vitest run tests/commands/sessions.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Create commands/sessions.ts**

```typescript
import type { Context } from "grammy";
import { escapeHtml } from "../markdown-to-html.js";
import type { ChatStateRepo } from "../chat-state.js";
import type { OpencodeClient } from "../opencode-client.js";
import type { PinnedStatusManager } from "../pinned-status.js";

export interface SessionsDeps {
  state: Pick<ChatStateRepo, "get" | "setSession">;
  client: { listSessions(args: { directory: string }): Promise<Array<{ id: string; title?: string; time?: { updated?: number } }>> };
  router: { ensureDirectory(directory: string): boolean };
  pinnedStatus: Pick<PinnedStatusManager, "notifyStateChange">;
}

const MAX_BUTTONS = 8;

export async function handleSessions(ctx: Context, deps: SessionsDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (typeof chatId !== "number") return;
  const stateRow = deps.state.get(chatId);
  if (!stateRow?.projectPath) {
    await ctx.reply("Use /switch first to pick a project.");
    return;
  }
  const sessions = await deps.client.listSessions({ directory: stateRow.projectPath });
  const sorted = sessions
    .slice()
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, MAX_BUTTONS);
  if (sorted.length === 0) {
    await ctx.reply("No sessions for this project yet.");
    return;
  }
  const keyboard = sorted.map((s) => {
    const ago = humanizeAgo(s.time?.updated ?? 0);
    const title = (s.title ?? s.id.slice(0, 12)).slice(0, 30);
    return [{ text: `${title} · ${ago}`, callback_data: `sess:${s.id}` }];
  });
  await ctx.reply(`<b>Sessions in ${escapeHtml(stateRow.projectPath.split("/").pop() ?? "")}</b>`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function handleSessionCallback(ctx: Context, deps: SessionsDeps): Promise<void> {
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  const chatId = ctx.chat?.id;
  if (!data || typeof chatId !== "number") return;
  if (!data.startsWith("sess:")) return;
  const sessionId = data.slice(5);
  await ctx.answerCallbackQuery();
  deps.state.setSession(chatId, sessionId);
  deps.pinnedStatus.notifyStateChange(chatId);
  await ctx.reply(`Switched to session <code>${escapeHtml(sessionId)}</code>`, { parse_mode: "HTML" });
}

function humanizeAgo(updatedAt: number): string {
  if (updatedAt === 0) return "?";
  const min = Math.floor((Date.now() - updatedAt) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}
```

- [ ] **Step 4: Add to OpencodeClient**

In `tg-bridge/src/opencode-client.ts`, add `listSessions` to the interface + implementation if not present. (May already exist; check `BridgeOpencodeClient` definition.)

- [ ] **Step 5: ChatStateRepo.setSession**

Verify `setSession(chatId, sessionId)` exists in `chat-state.ts`. If not, add it (similar shape to `setProject`).

- [ ] **Step 6: Wire into index.ts**

```typescript
import { handleSessions, handleSessionCallback } from "./commands/sessions.js";
const sessionsDeps = { state, client, router, pinnedStatus };
bot.command("sessions", (ctx) => handleSessions(ctx, sessionsDeps));

// In callback_query:data router:
if (data.startsWith("sess:")) return handleSessionCallback(ctx, sessionsDeps);
```

- [ ] **Step 7: Add to help + test help loop**

```
/sessions — recent sessions in this project (tap to switch)
```

- [ ] **Step 8: Run all tests + typecheck**

Run: `cd tg-bridge && npx vitest run && npm run typecheck`

- [ ] **Step 9: Commit**

```bash
git add tg-bridge/src/commands/sessions.ts tg-bridge/src/opencode-client.ts tg-bridge/src/chat-state.ts tg-bridge/src/index.ts tg-bridge/src/commands/help.ts tg-bridge/tests/commands/sessions.test.ts tg-bridge/tests/commands/help.test.ts
git commit -m "Add /sessions tap-to-switch (B4)

Lists up to 8 most-recent opencode sessions for the current project
as an inline keyboard. Tap → updates chat_state.session_id, notifies
PinnedStatusManager, replies with confirmation."
```

---

## Task 11: B5 — /projects + /model with inline keyboards

**Files:**
- Modify: `tg-bridge/src/commands/projects.ts` (replace text listing with inline keyboard)
- Modify: `tg-bridge/src/commands/model.ts` (replace text listing with inline keyboard)
- Modify: `tg-bridge/src/index.ts` (add proj: and model: callback prefixes)
- Modify: existing tests for both commands

**Goal:** /projects and /model produce inline keyboards. Tap → switch / set.

- [ ] **Step 1: Update projects.ts to render inline keyboard**

In `tg-bridge/src/commands/projects.ts`:
```typescript
const dirs = readdirSync(deps.workspaceRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
  .map((d) => d.name)
  .slice(0, 50);

if (dirs.length === 0) { await ctx.reply("No projects yet."); return; }

const keyboard = dirs.map((name) => [{ text: name, callback_data: `proj:${name}` }]);
await ctx.reply("<b>Projects</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
```

Add new exported `handleProjectCallback`:
```typescript
export async function handleProjectCallback(ctx: Context, deps: ProjectsDeps): Promise<void> {
  const data = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  if (!data?.startsWith("proj:")) return;
  const name = data.slice(5);
  await ctx.answerCallbackQuery();
  // Reuse handleSwitch logic; pass synthetic ctx with .match=name
  await handleSwitch({ ...ctx, match: name } as never, deps as never);
}
```

(Or simpler: factor `handleSwitch`'s body into `switchToProject(chatId, name, deps)` and call from both.)

- [ ] **Step 2: Same pattern for model.ts**

```typescript
const models = await deps.client.listModels(); // or hardcoded fallback list
const keyboard = models.slice(0, 16).map((m) => [{ text: m, callback_data: `model:${m}` }]);
await ctx.reply("<b>Models</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
```

Add `handleModelCallback`.

- [ ] **Step 3: Wire callbacks in index.ts**

```typescript
if (data.startsWith("proj:")) return handleProjectCallback(ctx, projectsDeps);
if (data.startsWith("model:")) return handleModelCallback(ctx, modelDeps);
```

- [ ] **Step 4: Update existing tests + add callback tests**

Update `tests/commands/projects.test.ts` and `tests/commands/model.test.ts` to expect inline_keyboard in reply opts. Add new tests for handleProjectCallback / handleModelCallback.

- [ ] **Step 5: Run tests + typecheck**

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/commands/{projects,model}.ts tg-bridge/src/index.ts tg-bridge/tests/commands/{projects,model}.test.ts
git commit -m "/projects and /model: inline keyboard tap-to-switch (B5)

Replaces text listings with inline_keyboard buttons. Each button
carries proj:<name> or model:<id> callback data. Bridge routes the
callback to the existing switch/setModel logic. PinnedStatusManager
notified after the state change."
```

---

## Task 12: C3 — Richer tool lines

**Files:**
- Modify: `tg-bridge/src/format.ts:renderToolLine`
- Modify: `tg-bridge/tests/format.test.ts`

**Goal:** Tool lines display additional metadata when available: line count for `read`, exit code for `bash`, match count for `grep`/`glob`, elapsed time always (when state has `time.start` and `time.end`).

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/format.test.ts`:

```typescript
describe("renderToolLine richer (C3)", () => {
  it("appends line count for completed read tool when metadata.lines present", () => {
    const part = {
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "src/index.ts" },
        metadata: { lines: 124 },
        time: { start: 1000, end: 1200 },
      },
    };
    expect(renderToolLine(part)).toBe("📄 read `src/index.ts` · 124 lines · 0.2s");
  });

  it("appends match count for completed grep when metadata.matchCount present", () => {
    const part = {
      type: "tool",
      tool: "grep",
      state: {
        status: "completed",
        input: { pattern: "FastAPI" },
        metadata: { matchCount: 7 },
        time: { start: 1000, end: 1500 },
      },
    };
    expect(renderToolLine(part)).toBe("🔍 grep `FastAPI` · 7 matches · 0.5s");
  });

  it("appends only timing when metadata absent", () => {
    const part = {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "pwd" }, time: { start: 1000, end: 1100 } },
    };
    expect(renderToolLine(part)).toBe("⚡ bash `pwd` · 0.1s");
  });

  it("falls back to minimal rendering when neither metadata nor time present", () => {
    const part = {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "x.ts" } },
    };
    expect(renderToolLine(part)).toBe("📄 read `x\\.ts`");
  });

  it("running state ignores metadata + time", () => {
    const part = {
      type: "tool",
      tool: "read",
      state: { status: "running", input: { filePath: "x.ts" }, metadata: { lines: 99 } },
    };
    expect(renderToolLine(part)).toBe("📄 read `x\\.ts`");
  });

  it("error state shows · failed instead of timing", () => {
    const part = {
      type: "tool",
      tool: "bash",
      state: { status: "error", input: { command: "bad" }, time: { start: 1000, end: 1100 } },
    };
    expect(renderToolLine(part)).toBe("❌ bash `bad` · failed");
  });

  it("formats sub-second times as 0.Xs", () => {
    expect(formatDuration(150)).toBe("0.2s");
  });

  it("formats over-second times as Xs", () => {
    expect(formatDuration(1500)).toBe("2s");
  });

  it("formats over-minute times as MmSs", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});
```

(Add `formatDuration` as exported helper.)

- [ ] **Step 2: Implement**

In `tg-bridge/src/format.ts:renderToolLine`, after computing `summary`:
```typescript
const state = tp.state;
const isError = state.status === "error";
const isCompleted = state.status === "completed";

const suffix: string[] = [];
if (isError) {
  suffix.push("failed");
} else if (isCompleted) {
  // Tool-specific metadata
  const md = state.metadata as Record<string, unknown> | undefined;
  if (md) {
    if (tp.tool === "read" && typeof md.lines === "number") suffix.push(`${md.lines} lines`);
    else if ((tp.tool === "grep" || tp.tool === "glob") && typeof md.matchCount === "number") {
      suffix.push(`${md.matchCount} ${md.matchCount === 1 ? "match" : "matches"}`);
    } else if (tp.tool === "bash" && typeof md.exitCode === "number" && md.exitCode !== 0) {
      suffix.push(`exit ${md.exitCode}`);
    }
  }
  // Timing
  if (state.time?.start && state.time?.end) {
    suffix.push(formatDuration(state.time.end - state.time.start));
  }
}

const suffixStr = suffix.length > 0 ? ` · ${suffix.join(" · ")}` : "";

if (!summary) return `${emoji} ${escapedTool}${suffixStr}`;
const safeForCode = summary.replace(/`/g, "'");
const escaped = escapeMarkdownV2(safeForCode);
return `${emoji} ${escapedTool} \`${escaped}\`${suffixStr}`;
```

Add helper:
```typescript
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}
```

- [ ] **Step 3: Run tests + commit**

```bash
git add tg-bridge/src/format.ts tg-bridge/tests/format.test.ts
git commit -m "format: richer tool lines with metadata + timing (C3)

Completed tools show line count (read), match count (grep/glob),
non-zero exit code (bash), and elapsed time when available. Errored
tools show · failed. Running/pending unchanged. Falls back gracefully
when metadata or time fields aren't present (older opencode versions)."
```

---

## Task 13: C1 — Turn heartbeat with elapsed time

**Files:**
- Modify: `tg-bridge/src/turn.ts`
- Modify: `tg-bridge/src/format.ts:renderStreamingView` (accept elapsedSeconds)
- Modify: `tg-bridge/tests/turn.test.ts`
- Modify: `tg-bridge/tests/format.test.ts`

**Goal:** Every 10 seconds, the streaming-view placeholder updates the `_thinking…_` line to `_thinking · 12s elapsed_`. Resets to fresh time on each `appendPart`.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/format.test.ts`:

```typescript
describe("renderStreamingView with elapsed time", () => {
  it("includes elapsed time when option provided", () => {
    const out = renderStreamingView([], { elapsedSeconds: 12 });
    expect(out).toBe("_thinking · 12s elapsed_");
  });
  it("formats minutes for long elapsed", () => {
    const out = renderStreamingView([], { elapsedSeconds: 125 });
    expect(out).toBe("_thinking · 2m 5s elapsed_");
  });
  it("omits elapsed when not provided (backward compat)", () => {
    const out = renderStreamingView([]);
    expect(out).toBe("_thinking…_");
  });
});
```

Append to `tg-bridge/tests/turn.test.ts`:

```typescript
describe("Turn heartbeat (C1)", () => {
  it("starts heartbeat after first appendPart", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100, heartbeatMs: 10000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150); // first edit fires
    const editsBefore = bot.calls.edits.length;
    await vi.advanceTimersByTimeAsync(10000); // heartbeat tick
    expect(bot.calls.edits.length).toBeGreaterThan(editsBefore);
    const lastEditText = bot.calls.edits[bot.calls.edits.length - 1]![2] as string;
    expect(lastEditText).toMatch(/elapsed/);
    vi.useRealTimers();
  });

  it("heartbeat stops on finalize", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100, heartbeatMs: 10000 });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await turn.finalize();
    const editsAfterFinalize = bot.calls.edits.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(bot.calls.edits.length).toBe(editsAfterFinalize);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Update renderStreamingView signature**

In `tg-bridge/src/format.ts`:
```typescript
export interface StreamingViewOptions {
  elapsedSeconds?: number;
  cancelCallbackData?: string; // For Task 14
}

export function renderStreamingView(parts: readonly RenderablePart[], options: StreamingViewOptions = {}): string {
  // ... existing tool rendering ...
  const thinking = options.elapsedSeconds != null
    ? `_thinking · ${formatDurationFromSeconds(options.elapsedSeconds)} elapsed_`
    : "_thinking…_";
  lines.push(thinking);
  return lines.join("\n");
}

function formatDurationFromSeconds(sec: number): string {
  // Same shape as formatDuration but takes seconds directly
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}
```

- [ ] **Step 3: Add heartbeat to Turn**

In `tg-bridge/src/turn.ts`:
```typescript
interface TurnOptions {
  throttleMs?: number;
  idleWatchdogMs?: number;
  heartbeatMs?: number;
}

private heartbeatTimer: NodeJS.Timeout | null = null;
private heartbeatStarted = false;
private readonly startedAt: number;
private readonly heartbeatMs: number;

constructor(/* existing */, options: TurnOptions = {}) {
  this.startedAt = Date.now();
  this.heartbeatMs = options.heartbeatMs ?? 10_000;
  // ... existing ...
}

appendPart(part: IncomingPart): void {
  if (this.finalized) return;
  // existing logic
  if (!this.heartbeatStarted) {
    this.heartbeatStarted = true;
    this.heartbeatTimer = setInterval(() => {
      if (this.finalized) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        return;
      }
      // Trigger an edit by enqueueing a no-op part change; or directly:
      void this.editNow();
    }, this.heartbeatMs);
  }
  this.resetWatchdog();
}

private async editNow(): Promise<void> {
  if (this.finalized) return;
  const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
  const text = renderStreamingView(this.partsArray() as never, { elapsedSeconds });
  // existing safeEdit call
}

async finalize(): Promise<void> {
  if (this.heartbeatTimer) {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
  // existing
}
```

- [ ] **Step 4: Run tests + commit**

Run: `cd tg-bridge && npx vitest run && npm run typecheck`

```bash
git add tg-bridge/src/turn.ts tg-bridge/src/format.ts tg-bridge/tests/turn.test.ts tg-bridge/tests/format.test.ts
git commit -m "turn: 10s heartbeat updates streaming-view elapsed time (C1)

Streaming view's thinking line includes elapsed seconds (or m/s) so
the user can see the bot is alive vs stuck. Heartbeat starts on first
appendPart, stops on finalize. Updates piggy-back on the existing
edit pipeline so respect the 1/sec throttle."
```

---

## Task 14: C2 — Cancel button on streaming view

**Files:**
- Modify: `tg-bridge/src/turn.ts`
- Modify: `tg-bridge/src/format.ts:renderStreamingView` (already extended in Task 13)
- Modify: `tg-bridge/src/safe-telegram.ts` (safeEdit accepts reply_markup)
- Modify: `tg-bridge/src/message-handler.ts` (registers cancel handler, passes callback data to Turn)
- Modify: `tg-bridge/src/index.ts` (cancel: callback prefix routes to active Turn)
- Modify: `tg-bridge/tests/turn.test.ts`
- Modify: `tg-bridge/tests/format.test.ts`

**Goal:** Streaming view includes a `[ ⏹ Cancel ]` inline button. Tap → bridge calls `Turn.cancel()` and `client.session.abort(sessionId)`.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/format.test.ts`:

```typescript
describe("renderStreamingView cancel button", () => {
  it("does not include button by default", () => {
    const out = renderStreamingView([]);
    // String output only — no reply_markup baked in
    expect(out).not.toContain("Cancel");
  });
});

describe("buildCancelKeyboard", () => {
  it("returns inline_keyboard with single Cancel button", () => {
    const kb = buildCancelKeyboard("ses_xyz");
    expect(kb).toEqual({
      inline_keyboard: [[{ text: "⏹ Cancel", callback_data: "cancel:ses_xyz" }]],
    });
  });
});
```

(Add `buildCancelKeyboard` as exported helper in `format.ts` so callers can attach it via reply_markup.)

Append to `tg-bridge/tests/turn.test.ts`:

```typescript
describe("Turn cancel button", () => {
  it("attaches reply_markup with Cancel button when cancelCallbackData provided", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 100, cancelCallbackData: "cancel:ses_xyz" });
    turn.appendPart({ id: "p1", type: "text", text: "x" });
    await vi.advanceTimersByTimeAsync(150);
    const opts = bot.calls.edits[bot.calls.edits.length - 1]![3] as { reply_markup?: { inline_keyboard?: unknown[][] } };
    const button = opts?.reply_markup?.inline_keyboard?.[0]?.[0] as { callback_data?: string } | undefined;
    expect(button?.callback_data).toBe("cancel:ses_xyz");
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Add buildCancelKeyboard to format.ts**

```typescript
export function buildCancelKeyboard(sessionId: string) {
  return { inline_keyboard: [[{ text: "⏹ Cancel", callback_data: `cancel:${sessionId}` }]] };
}
```

- [ ] **Step 3: Update safeEdit to accept reply_markup**

In `safe-telegram.ts`:
```typescript
export async function safeEdit(
  bot: SafeEditBot,
  chatId: number,
  messageId: number,
  text: string,
  log?: SafeLogger,
  parseMode: ParseMode = "HTML",
  replyMarkup?: object,
): Promise<void> {
  const opts = replyMarkup
    ? { parse_mode: parseMode, reply_markup: replyMarkup }
    : { parse_mode: parseMode };
  // ... existing try/catch with this opts ...
}
```

- [ ] **Step 4: Wire into Turn**

In `turn.ts`:
```typescript
interface TurnOptions {
  throttleMs?: number;
  idleWatchdogMs?: number;
  heartbeatMs?: number;
  cancelCallbackData?: string;  // NEW
}

private readonly cancelCallbackData: string | undefined;

constructor(/* existing */, options: TurnOptions = {}) {
  this.cancelCallbackData = options.cancelCallbackData;
  // existing
}

private async editNow(): Promise<void> {
  if (this.finalized) return;
  const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
  const text = renderStreamingView(this.partsArray() as never, { elapsedSeconds });
  const replyMarkup = this.cancelCallbackData ? buildCancelKeyboard(this.cancelCallbackData.replace(/^cancel:/, "")) : undefined;
  await safeEdit(this.bot, this.chatId, this.placeholderMessageId, text, undefined, "MarkdownV2", replyMarkup);
}
```

- [ ] **Step 5: Track active Turns + register cancel handler in index.ts**

Add to `pinned-status.ts` or a new `active-turns.ts` module:
```typescript
// Map session ID → active Turn (so cancel callback can find it)
const activeTurns = new Map<string, Turn>();
export const ActiveTurns = {
  set(sessionId: string, turn: Turn) { activeTurns.set(sessionId, turn); },
  delete(sessionId: string) { activeTurns.delete(sessionId); },
  get(sessionId: string) { return activeTurns.get(sessionId); },
};
```

In `message-handler.ts`, register on Turn creation:
```typescript
const turn = new Turn(deps.bot, chatId, placeholderId, { cancelCallbackData: `cancel:${session.id}` });
ActiveTurns.set(session.id, turn);
// in onIdle/onError: ActiveTurns.delete(session.id);
```

In `index.ts`'s callback router:
```typescript
if (data.startsWith("cancel:")) {
  await ctx.answerCallbackQuery({ text: "Cancelling..." });
  const sessionId = data.slice(7);
  const turn = ActiveTurns.get(sessionId);
  if (turn) {
    turn.cancel();
    try { await client.session.abort(sessionId); } catch (err) { log.warn({ err, sessionId }, "session.abort failed"); }
    ActiveTurns.delete(sessionId);
  } else {
    await ctx.answerCallbackQuery({ text: "Already done" });
  }
  return;
}
```

- [ ] **Step 6: Run tests + typecheck + commit**

```bash
git add tg-bridge/src/{turn,format,safe-telegram,message-handler,index,active-turns}.ts tg-bridge/tests/{turn,format}.test.ts
git commit -m "turn: [⏹ Cancel] inline button on streaming view (C2)

Bridge tracks active Turns per session ID. Streaming-view edits
include reply_markup with one Cancel button (callback_data
'cancel:<sessionId>'). Tap → Turn.cancel() + client.session.abort()
on opencode side. Toast 'Already done' if turn already finalized."
```

---

## Task 15: Build, push, deploy, smoke verify

**Files:** None modified.

- [ ] **Step 1: Final clean state**

```bash
cd /Users/doni/code/test-opencode-headless/tg-bridge
npm run build
npx vitest run
npm run typecheck
```

Expected: build clean, all tests pass (~360+), typecheck exit 0.

- [ ] **Step 2: Push**

```bash
git log --oneline origin/main..HEAD
git push origin main
```

- [ ] **Step 3: Deploy to VPS**

```bash
ssh root@87.99.138.104 'cd /opt/opencode-telegram/repo && git pull --ff-only && cd tg-bridge && npm install --silent && npm run build && systemctl restart tg-bridge && sleep 4 && systemctl is-active tg-bridge && journalctl -u tg-bridge --since="20 seconds ago" --no-pager -o cat | tail -8'
```

Expected: clean restart, no errors, "starting" in logs.

- [ ] **Step 4: Manual smoke test (USER)**

In Telegram:
1. Type `/` → see all 14 commands in autocomplete (B2)
2. Send a real prompt → see 👍 reaction (B3) within 1s, then ✅ on done
3. Verify final message renders bold/italic/code/lists/links correctly (A2)
4. Verify final message does NOT echo your prompt (A1)
5. Confirm a pinned status message appeared at top with current state + 5 buttons (B1)
6. Tap "Switch project" → see inline keyboard of project buttons → tap one → confirmation + pinned message updates
7. Tap "Sessions" → see inline keyboard → tap one → switches
8. During a long-running prompt: see heartbeat update ("12s", "22s", ...) + [⏹ Cancel] button (C1, C2)
9. Tap Cancel → placeholder shows cancellation; opencode session aborted
10. Run `/unpin` → bot stops auto-updating (existing pin stays)
11. Run `/pin` → bot creates fresh pinned status
12. Force a stuck-on-thinking by killing opencode mid-turn → after 60s watchdog kicks (A3)

- [ ] **Step 5: If smoke surfaces issues, iterate**

---

## Self-Review

### Spec coverage check

- A1 (filter user-role text parts): ✅ Task 1
- A2 (CommonMark → HTML): ✅ Task 5
- A3 (stuck-on-thinking): ✅ Task 2 (watchdog)
- B1 (pinned status): ✅ Tasks 6-8 (schema + manager + wiring)
- B2 (setMyCommands): ✅ Task 3
- B3 (reactions): ✅ Task 4
- B4 (/sessions tap-to-switch): ✅ Task 10
- B5 (/projects + /model tap-to-switch): ✅ Task 11
- C1 (heartbeat): ✅ Task 13
- C2 (cancel button): ✅ Task 14
- C3 (richer tool lines): ✅ Task 12
- /pin + /unpin: ✅ Task 9

All 13 spec items have a task. No gaps.

### Placeholder scan

No "TBD", "TODO", "implement later", "fill in details", or "Similar to Task N". Every step has concrete code or commands.

### Type consistency

- `MaybeTextPart` extended with `role?` and `messageID?` — used consistently in Tasks 1 + 5
- `TurnOptions` extended progressively (Tasks 2/13/14) — `throttleMs`, `idleWatchdogMs`, `heartbeatMs`, `cancelCallbackData` all on one interface
- `safeEdit` signature evolves (Tasks 5 + 14): adds parseMode parameter, then replyMarkup parameter — all later callers updated
- `PinnedStatusManager` API (`setIdle/setWorking/setFailed/setAborted/notifyStateChange/enablePin/pausePin`) consistent across Tasks 7-9
- `ChatStateRepo` new methods (`get/setPinnedMessageId`, `get/setPinPaused`, `get/setLastUserMessageId`) match across Tasks 6 + 7 + 8
- Callback prefixes (`pin:`, `sess:`, `proj:`, `model:`, `cancel:`) all routed in `index.ts` Tasks 8/10/11/14
- `formatDuration(ms)` and `formatDurationFromSeconds(sec)` are distinct helpers — should both live in `format.ts`
- `commonmarkToTelegramHtml` and `escapeHtml` exported from `markdown-to-html.ts` — used in Tasks 5/7/10/11

### Test count

Approximate cumulative: baseline 314 → +~50 = ~365 tests by end of plan.
