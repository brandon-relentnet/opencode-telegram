# Telegram Question-Tool Bridge — Design

**Date:** 2026-05-02
**Status:** Proposed
**Related:**
- `2026-05-02-telegram-project-creation-design.md` (`detectSuccess` lives in `project-creator.ts`, modified here)
- `2026-05-02-telegram-render-overhaul-design.md` (Turn + safe-telegram already in place; reused for question-rendering logic)

## Problems to solve

### Problem 1: `/init` and `/clone` don't auto-switch when the agent prefaces with narration

User runs `/init <name>`. The opencode session creates the directory successfully. The agent emits TWO assistant messages instead of one — the first is `tool-calls` finish (preamble text + bash tool call), the second is `stop` finish (the requested marker word "initialized"). The bridge calls `detectSuccess(collectedParts, kind)` at `session.idle`. The current implementation concatenates ALL text parts and checks if the result STARTS WITH "initialized". Result: `"I need to run...\ninitialized"` starts with "I need" → no match → no auto-switch → user sees the agent's transcript and has to manually `/switch <name>`.

Verified with curl against opencode at `ses_211f94bc9ffeDRVqdN1IhBhiJn` — message[1] = `assistant/tool-calls` with preamble text, message[2] = `assistant/stop` with text `"initialized"`.

### Problem 2: opencode's `question` tool is invisible to Telegram users

opencode 1.14.32 ships a built-in `question` tool with this contract (verified in `@opencode-ai/sdk` types):

```ts
type QuestionRequest = {
  id: string;            // requestID, e.g. "qst_..."
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: { messageID: string; callID: string };
};
type QuestionInfo = {
  question: string;
  header: string;            // ≤30 chars
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;          // default true; allows free-text answer
};
type QuestionAnswer = Array<string>;  // selected labels for one question
```

Events emitted by opencode:
- `question.asked` (`type` = `"question.asked"`, `properties` = `QuestionRequest`)
- `question.replied` (`properties` = `{ sessionID, requestID, answers }`)
- `question.rejected` (`properties` = `{ sessionID, requestID }`)

REST endpoints:
- `POST /question/{requestID}/reply` body: `{ answers: Array<QuestionAnswer> }` (one entry per question, each entry is the array of selected labels)
- `POST /question/{requestID}/reject`
- `GET /question` lists pending

Today the bridge ignores all three event types. opencode's question tool waits for an interactive client; if none answers within its timeout, it auto-completes with the (Recommended) options selected. Verified with `ses_211f83372ffe4gS3HVUyxVxnQo`: agent asked two questions, the tool's output was `"User has answered your questions: ... = (Recommended), ... = (Recommended)"` despite the user never answering anything in Telegram. The agent then proceeded with assumptions the user never confirmed.

## Goals

1. `/init` and `/clone` reliably auto-switch when the agent succeeds, even with multiple assistant messages or verbose final replies
2. When the agent uses the `question` tool, the questions appear in Telegram as inline-keyboard messages, the user answers via button presses, and the answers are submitted to opencode for the agent to consume
3. Support the full `question` tool surface: single-select, multi-select (`multiple: true`), and custom-typed answers (`custom !== false`)
4. Multiple questions in one `QuestionRequest` are presented as one Telegram message per question, answered in any order, submitted as a batch when all are answered
5. If opencode emits `question.replied` (i.e. someone else answered, or auto-default fired), or `question.rejected`, cancel any pending Telegram keyboards and edit them to a final state explaining what happened
6. Bridge never crashes from a malformed event or a Telegram failure during the question flow — same safety standards as the rest of the bridge

## Non-goals

- Per-chat persistence of pending question state across bridge restarts (V2 — restarts during a pending question are accepted as user-visible loss)
- Visual countdown indicating opencode's auto-default-after-timeout window (the bridge has no visibility into opencode's internal timeout)
- Routing questions to chats that don't have an active session for the question's sessionID (silently log and ignore — opencode will eventually time them out)
- Answering questions via free text typed in the main chat thread WITHOUT first pressing "Type your own" (V2 if requested; for V1 the only way to answer is via the keyboard)
- Cancelling a pending question by command (V2; user can wait for opencode timeout or send `/abort`)

## Architecture

### Routing

`question.asked.properties.sessionID` carries the session that originated the question. Same routing model as `permission.asked`. EventRouter dispatches by sessionID to whichever `SessionEventHandler` registered it.

For the project-creator one-shot session, the registered handler is the orchestration's custom one — but `question` events should NEVER fire there in practice (the prompts in `buildClonePrompt`/`buildInitPrompt` are deterministic shell commands). If they do, the handler will silently no-op (matches existing `onPermissionUpdated` no-op) until V2 adds support there.

For regular chat sessions, the `message-handler.ts` handler is registered. Its new `onQuestionAsked` forwards to `QuestionService.sendRequest`.

### Component overview

```
opencode SSE (question.asked)
  ↓
EventRouter.dispatch (new switch case)
  ↓
SessionEventHandler.onQuestionAsked(req)
  ↓
QuestionService.sendRequest(chatId, req):
  - For each question (i, q) in req.questions:
    - Send a Telegram message with inline keyboard
    - Track per-request state: { request, perQuestionState[], chatId, messageIds[], sessionID, requestID }
    - perQuestionState[i] = { selected: Set<string>, customAnswer: string|null, doneState: "pending"|"answered" }
  - Set timeout (configurable, default 15min) → autoReject

User clicks a button:
  ↓
bot.on("callback_query:data") handler in index.ts (extended for "qst:" prefix)
  ↓
QuestionService.handleCallback(ctx)
  - Parse callback data: qst:<requestID>:<questionIdx>:<action>:<argIdx?>
  - Update state for that question
  - Re-render keyboard for that question's message
  - If question done: increment doneCount
  - If all questions done: POST /question/{requestID}/reply

User clicks "Type your own":
  ↓
QuestionService records "awaiting custom answer for chat=X, request=R, question=Q"
  ↓
User sends a text message
  ↓
bot.on("message:text") in index.ts: if chat is awaiting custom answer, route to QuestionService.handleCustomAnswer(text)
  - Add typed text to state (single-select: replace; multi-select: append)
  - Re-render keyboard
  - Reset awaiting state
  - DO NOT call handleTextMessage (the regular chat handler)

opencode emits question.replied or question.rejected:
  ↓
EventRouter dispatches → handler.onQuestionReplied / onQuestionRejected
  ↓
QuestionService.cancelPending(requestID, reason)
  - Edit each per-question Telegram message to show final state
  - Clear pending state
```

### `tg-bridge/src/event-router.ts` changes

Add to `SessionEventHandler` interface (all new methods optional with `?` to avoid breaking the project-creator handler):

```ts
export interface SessionEventHandler {
  onPartUpdated(part: unknown): void;
  onIdle(): void;
  onError(err: unknown): void;
  onPermissionUpdated(perm: unknown): void;
  onQuestionAsked?(req: unknown): void;
  onQuestionReplied?(payload: unknown): void;
  onQuestionRejected?(payload: unknown): void;
}
```

Add three new cases to `dispatch`:

```ts
case "question.asked":
  handler.onQuestionAsked?.(evt.properties);
  return;
case "question.replied":
  handler.onQuestionReplied?.(evt.properties);
  return;
case "question.rejected":
  handler.onQuestionRejected?.(evt.properties);
  return;
```

Add the three types to `isKnownType`. `extractSessionId` continues to read `properties.sessionID` for these (which IS present on all three).

### `tg-bridge/src/opencode-client.ts` changes

Add to `BridgeOpencodeClient` interface:

```ts
/**
 * Submit answers for a question request.
 * `answers` has one entry per question in the original request, in order.
 * Each entry is the array of selected option labels (single-select wraps a
 * single label in an array; multi-select includes all selected; custom
 * answers are appended as raw strings).
 */
respondToQuestion(requestId: string, answers: Array<Array<string>>): Promise<boolean>;

/**
 * Reject a question request (the agent's tool call returns rejected).
 * Used by the bridge when an internal error prevents collecting answers.
 */
rejectQuestion(requestId: string): Promise<boolean>;
```

Implementation calls `client.question.reply({ path: { requestID }, body: { answers } })` and `client.question.reject({ path: { requestID } })` — verify these SDK method names at implementation time (the dispatcher pattern is `client.<resource>.<method>` per existing usage like `client.session.prompt`).

### `tg-bridge/src/question-service.ts` (new file, ~300 LOC estimate)

Public interface:

```ts
export interface QuestionBot {
  sendMessage(chatId, text, opts: { parse_mode: "MarkdownV2"; reply_markup: InlineKeyboard }): Promise<{ message_id: number }>;
  editMessageText(chatId, messageId, text, opts: { parse_mode: "MarkdownV2"; reply_markup?: InlineKeyboard }): Promise<unknown>;
  answerCallbackQuery(id, opts?: { text?: string }): Promise<unknown>;
}

export interface QuestionRequest {
  id: string;            // requestID
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: { messageID?: string; callID?: string };
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRepliedEvent {
  sessionID: string;
  requestID: string;
  answers: Array<Array<string>>;
}

export interface QuestionRejectedEvent {
  sessionID: string;
  requestID: string;
}

export interface CallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { chat: { id: number }; message_id: number };
}

export interface QuestionServiceOptions {
  /** Timeout per question request after which the bridge auto-rejects. Default 15 minutes. */
  timeoutMs?: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

export class QuestionService {
  constructor(bot: QuestionBot, client: OpencodeClient, options?: QuestionServiceOptions);

  /** Render `req`'s questions to the chat. One inline-keyboard message per question. */
  sendRequest(chatId: number, req: QuestionRequest): Promise<void>;

  /** Handle a callback_query whose `data` starts with `qst:`. Returns true if it claimed the callback. */
  handleCallback(cb: CallbackQuery): Promise<boolean>;

  /** Returns true if `chatId` is currently waiting for a free-text custom answer. */
  isAwaitingCustomAnswer(chatId: number): boolean;

  /** Consume `text` as the custom answer for whatever this chat is waiting on. */
  handleCustomAnswer(chatId: number, text: string): Promise<void>;

  /** Called from EventRouter on `question.replied`. Cleans up Telegram UI for the request. */
  notifyReplied(payload: QuestionRepliedEvent): Promise<void>;

  /** Called from EventRouter on `question.rejected`. Cleans up Telegram UI for the request. */
  notifyRejected(payload: QuestionRejectedEvent): Promise<void>;
}
```

### Internal state shape

```ts
interface PerQuestionState {
  selected: string[];        // labels currently selected (kept as array to preserve order)
  customAnswers: string[];   // free-text answers added via "Type your own"
  done: boolean;
  messageId: number;         // Telegram message_id where this question's keyboard lives
}

interface PendingRequest {
  requestId: string;
  sessionId: string;
  chatId: number;
  questions: QuestionInfo[];
  questionStates: PerQuestionState[];
  timer: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

class QuestionService {
  private pending = new Map<string, PendingRequest>();              // by requestID
  private awaiting = new Map<number, { requestId: string; questionIdx: number }>();  // by chatId
}
```

Why store by `requestId` only (not by `chatId`): a chat could in theory have multiple concurrent question requests if the agent asks multiple questions in quick succession (unlikely; opencode typically waits for one to resolve before asking another). Map-by-requestId handles this transparently.

The `awaiting` map is keyed by chatId because at most ONE custom-answer prompt is active per chat at a time (the user would be confused otherwise).

### Callback-data encoding

```
qst:<requestID>:<questionIdx>:<action>[:<argIdx>]
```

Actions:
- `pick:<optionIdx>` — single-select: lock answer to this option
- `tgl:<optionIdx>` — multi-select: toggle this option's selection
- `custom` — request custom-typed answer
- `done` — multi-select: finalize this question's answer
- `cancel` — (V2; not in V1 — handled by opencode's `/abort`)

Total tag set in V1: `pick`, `tgl`, `custom`, `done`. Action+argIdx parsing is straightforward (see PermissionService for the precedent).

callback_data limit: Telegram allows 1-64 bytes. requestID is `qst_<24-hex>` (~28 chars), questionIdx and optionIdx are small integers. Worst case: `qst:qst_aaaaaaaaaaaaaaaaaaaaaaaa:99:tgl:99` = 41 bytes. Comfortably within limit.

### Per-question keyboard layouts

**Single-select**, `multiple !== true`:

```
Header (bold, italic): _Image source_

Question text: Where should beagle pictures come from?

[ Dog CEO API (Recommended) ]    ← option 0, callback "qst:R:0:pick:0"
  └ description: Free public API with random beagle photos…
[ Curated set of links ]          ← option 1, callback "qst:R:0:pick:1"
  └ description: I'll use a hand-picked list…
[ ✏️ Type your own ]              ← if custom !== false, callback "qst:R:0:custom"
```

Layout: option label + description on separate lines in the message body; one keyboard row per option button. The "Type your own" button is its own row at the bottom.

**Multi-select**, `multiple === true`:

```
Header: _Features_ (multi-select)

Question text: What features do you want?

[ ☐ Dark mode ]                   ← callback "qst:R:0:tgl:0"
[ ☐ Animations ]                  ← callback "qst:R:0:tgl:1"
[ ☐ Counter ]                     ← callback "qst:R:0:tgl:2"
[ ✏️ Type your own ]              ← callback "qst:R:0:custom"
[ ✅ Done ]                       ← callback "qst:R:0:done"
```

On toggle: edit the message to swap `☐` ↔ `☑` for that option (and keep the rest unchanged). Custom answers added via "Type your own" appear in the message body as a free-text "Custom: <text>" line above the keyboard but are NOT toggled buttons — they're just stored in state.

**After question is answered:**

Message body changes to a final form, keyboard is removed:

```
✓ Image source: Dog CEO API (Recommended)
```

For multi-select: `✓ Features: Dark mode, Counter`. For custom answers: `✓ Image source: Custom answer "I want a public API"`.

**Custom-answer prompt:**

When user clicks "Type your own", the bridge:
1. Edits the question's keyboard message: appends a new line `_Type your custom answer in the next message…_` to the message body. Keyboard kept (so user can still pick a button if they change their mind — pressing any button cancels the awaiting state).
2. Sets `awaiting[chatId] = { requestId, questionIdx }`.
3. Sends an `answerCallbackQuery` with `text: "Type your answer"` to dismiss the loading spinner.

When user sends the text message:
1. `index.ts` text handler checks `questions.isAwaitingCustomAnswer(chatId)` BEFORE invoking `handleTextMessage`. If true, routes to `questions.handleCustomAnswer(chatId, text)`.
2. `handleCustomAnswer`:
   - Single-select mode: sets `selected = []`, appends text to `customAnswers`, marks question done
   - Multi-select mode: appends text to `customAnswers`, leaves question in pending state (user clicks Done to finalize)
   - Re-renders the question's message body to include the custom answer line
   - Clears the awaiting state
   - If single-select & question is now done: increments doneCount, possibly submits the whole request

**All questions answered → submit:**

When `doneCount === questions.length`:

1. For each question, build the answer array: `[...selected, ...customAnswers]`
2. POST: `respondToQuestion(requestId, answers)`
3. On success: edit each question's message to remove keyboards (replace with the `✓` summary). No additional confirmation toast.
4. On failure: edit each question's message to append `_⚠️ Failed to submit to opencode_` and log warn

### Handling `question.replied` / `question.rejected` from opencode

If opencode auto-defaults the request (no client answered in time), it emits `question.replied` with the picked answers. Or someone else (web UI) answered. Or the agent decided to cancel.

`QuestionService.notifyReplied(payload)`:
1. Look up `pending[payload.requestID]`. If absent: ignore (we already resolved it).
2. Cancel timer. Mark resolved.
3. For each question's Telegram message, edit to a final form with the answers opencode received: `✓ Image source: Dog CEO API (Recommended) (resolved by opencode)`. Adapt the wording.
4. Clear awaiting state for this chat (if applicable) so a typed text message reverts to normal handling.
5. Delete from `pending`.

`notifyRejected(payload)`: similar, but final message is `❌ Image source: cancelled` or `_(question cancelled by opencode)_`.

### Wire-up in `index.ts`

Modifications:

```ts
// New imports
import { QuestionService } from "./question-service.js";

// After permissions construction:
const questions = new QuestionService(permBot as never, client, { log });

// Pass to message-handler deps:
bot.on("message:text", (ctx) => {
  // Custom-answer interception comes BEFORE handleTextMessage.
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  if (
    typeof chatId === "number" &&
    typeof text === "string" &&
    !text.startsWith("/") &&     // slash commands always handled by their own bot.command()
    questions.isAwaitingCustomAnswer(chatId)
  ) {
    void questions.handleCustomAnswer(chatId, text)
      .catch((err) => log.error({ err: describeError(err), chatId }, "handleCustomAnswer failed"));
    return;
  }
  return handleTextMessage(ctx, {
    state, client, router, permissions, questions,  // pass through
    bot: turnBot,
    defaultModel: config.defaultModel,
    log,
  });
});

// Extend the callback_query handler:
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data ?? "";
  if (data.startsWith("qst:")) {
    await questions.handleCallback({ ...ctx.callbackQuery, message: msg ?? undefined });
    return;
  }
  // existing perm: handling
  await permissions.handleCallback(...);
});
```

### Wire-up in `message-handler.ts`

`MessageHandlerDeps` gains `questions: Pick<QuestionService, "sendRequest" | "notifyReplied" | "notifyRejected">`.

The handler object gains:

```ts
onQuestionAsked(req) {
  void deps.questions
    .sendRequest(chatId, req as never)
    .catch((err) => deps.log?.error?.({ err: describeError(err), chatId, sessionId, requestId: (req as { id?: string })?.id }, "questionService.sendRequest failed"));
},
onQuestionReplied(payload) {
  void deps.questions.notifyReplied(payload as never).catch(/* log */);
},
onQuestionRejected(payload) {
  void deps.questions.notifyRejected(payload as never).catch(/* log */);
},
```

`project-creator.ts` does NOT need question wiring for V1 (the deterministic prompts won't trigger questions). If they do, the handler's no-op leaves opencode to time out.

## Detailed flows

### Flow A: agent asks 2 single-select questions

1. Agent → opencode → `question` tool called with `req = { id: "qst_X", sessionID: "ses_Y", questions: [Q1, Q2] }`
2. opencode emits `question.asked` event
3. EventRouter routes to message-handler's handler (registered for ses_Y)
4. handler.onQuestionAsked(req) → `questions.sendRequest(chatId, req)`
5. QuestionService:
   - Send msg1 with Q1 keyboard, store `messageId` in state
   - Send msg2 with Q2 keyboard, store `messageId`
   - Initialize `pending["qst_X"] = { ..., questionStates: [{...}, {...}] }`
   - Start timer
6. User taps Q1 option 0:
   - `handleCallback({ data: "qst:qst_X:0:pick:0" })`
   - Parse → request "qst_X", question 0, pick option 0
   - Update `questionStates[0] = { selected: ["Dog CEO API (Recommended)"], done: true, ... }`
   - Edit msg1: keyboard removed, body shows `✓ Image source: Dog CEO API (Recommended)`
   - `answerCallbackQuery(id)` with no text
   - doneCount = 1; not all done; wait
7. User taps Q2 option 1:
   - Same flow; doneCount = 2; all done!
   - Build answers: `[["Dog CEO API (Recommended)"], ["Curated set of links"]]`
   - `respondToQuestion("qst_X", answers)` → opencode → tool result returned to agent
   - Edit msg2 final form similar to step 6
   - Clear timer; delete pending entry
8. opencode then emits `question.replied` with the same answers (echo)
   - QuestionService.notifyReplied: pending was already deleted → no-op

### Flow B: multi-select with custom answer

1. Agent asks Q with `multiple: true`, options A/B/C, `custom: true`
2. QuestionService renders ☐A / ☐B / ☐C / ✏️ Type your own / ✅ Done
3. User taps ☐A → keyboard re-renders to ☑A / ☐B / ☐C / ✏️ Type your own / ✅ Done; `selected = ["A"]`
4. User taps ☐B → ☑A / ☑B / ☐C / ...; `selected = ["A", "B"]`
5. User taps "Type your own"
   - Bridge: edits message body to append `_Type your custom answer in the next message…_`; sets awaiting; answerCallbackQuery
6. User types "I want feature X" → bridge intercepts, calls `handleCustomAnswer("I want feature X")`:
   - `customAnswers = ["I want feature X"]`
   - Re-renders message body: shows `Custom: I want feature X` plus the ☑/☐ keyboard rows still selectable
   - Clears awaiting
7. User taps ✅ Done
   - `selected = ["A", "B"]`, `customAnswers = ["I want feature X"]`
   - Final answer: `["A", "B", "I want feature X"]`
   - Edits message: `✓ Features: A, B, "I want feature X"`
   - doneCount++; if all done, submit

### Flow C: opencode auto-replies after timeout

1. User receives the question keyboard but is AFK
2. opencode's internal timeout fires (~30s? unknown; not the bridge's concern)
3. opencode picks (Recommended) defaults, emits `question.replied { answers: [["Dog CEO API (Recommended)"], ["Clean & minimal (Recommended)"]] }`
4. EventRouter routes to handler.onQuestionReplied(payload)
5. handler → `questions.notifyReplied(payload)`
6. QuestionService:
   - Edit each question's message: keyboard removed, body shows `✓ Image source: Dog CEO API (Recommended) (resolved by opencode)` etc.
   - Clears awaiting state if applicable
   - Cancels timer; deletes pending

### Flow D: agent uses /init

1. User: `/init smoke-test`
2. project-creator dispatches the deterministic shell prompt
3. Agent emits 2 messages: preamble + bash, then "initialized"
4. session.idle → handler.onIdle:
   - `detectSuccess(collectedParts, "init")` → checks LAST text part `"initialized"` → matches `\binitialized\b` → returns true
   - performAutoSwitch fires → user sees "Switched to smoke-test" confirmation
5. Resolved.

(No question tool involved.)

## Edge cases

| Case | Behavior |
|---|---|
| `req.questions` is empty array | Log warn; immediately submit `respondToQuestion(req.id, [])` so opencode doesn't hang |
| `req.questions[i].options` empty AND `custom === false` | Question has no answerable input. Render the question text with a single "❌ Cancel" button that submits an empty answer for that question. (Edge case; probably impossible from a well-behaved agent.) |
| `custom === false` and user has no good option | No "Type your own" button. User picks the closest option. |
| Same chat receives a NEW QuestionRequest while one is already pending | Both are tracked independently (different requestIDs). User sees both; can answer in any order. |
| Bridge restarts mid-question | Pending state is in-memory only → lost. opencode will eventually time out. User's tap on a stale button gets `"already responded or expired"` toast. (Same pattern as PermissionService.) |
| Telegram fails to send the question message | Log warn; do NOT submit anything to opencode (let it time out so the agent learns the request failed). Pending state is recorded but with a `null` messageId for that question; subsequent callback presses can't reach it because there's no message. |
| Custom-answer mode + user types `/abort` | `/abort` is a slash command; bot.command handles it before our text handler. Awaiting state stays set. The /abort itself aborts the agent's session, which causes opencode to emit `question.rejected` → notifyRejected clears awaiting. Acceptable. |
| Custom-answer mode + user types `/help` | Same as above — slash commands are NOT intercepted as custom answers. /help works normally; awaiting persists. |
| Two questions in one request, user types text intended for question 1 but custom-answer state is for question 2 | Bridge can't know intent. The text goes to the awaiting question. User sees the custom answer attached to the wrong question; they can re-tap "Type your own" to retry. Acceptable. |
| Submit fails with HTTP error | Log error; edit each question's message to append `_⚠️ Failed to submit (HTTP <code>)_`; do not retry (opencode will time out and emit question.replied with defaults; that's our cleanup signal) |
| `notifyReplied` arrives before all answers gathered (race) | Cancel pending state; edit messages to show what opencode received. User's still-pending taps become stale (`"already responded or expired"`) |
| `notifyReplied` arrives but pending entry was already deleted | No-op. Possible echo from opencode after our submit. |
| User taps a button, callback arrives, but `pending[requestId]` is undefined | `answerCallbackQuery(id, { text: "Already responded or expired" })`. Same UX as PermissionService stale-callback handling. |
| Inline keyboard exceeds Telegram's row/button limits | Telegram allows up to 100 buttons per keyboard. Realistic question = ≤10 options + Type your own + Done. No risk. |
| Question text contains MarkdownV2 reserved chars | Renderer must use `escapeMarkdownV2` for the question/header/option labels in the body text, and escape backticks in any inline code; same care as elsewhere. |

## Test strategy

### Unit tests for `detectSuccess` (Fix 1)

In `tg-bridge/tests/project-creator.test.ts`, add cases for:
1. Two text parts: preamble + "initialized" → success ✓
2. Two text parts: preamble + "Successfully initialized the project" → success ✓
3. Two text parts: preamble + "failed: directory not writable" → not success ✓
4. Two text parts: preamble + "failed: was already initialized" → not success ✓ (failed: prefix wins despite contained "initialized")
5. Single text part: "I will run init" → not success ✓ (no `\binitialized\b` match)
6. Empty: no text parts → not success ✓ (preserved from existing behavior)
7. Clone variant: preamble + "cloned" → success ✓
8. Clone variant: preamble + "I have cloned the repo successfully" → success ✓

### Unit tests for `QuestionService`

In new file `tg-bridge/tests/question-service.test.ts`:

**sendRequest:**
- Single question: sends one message with correct keyboard layout
- Multi-question: sends N messages, stores messageIds, initializes per-question state
- Multi-select question: keyboard has ☐ buttons, "Type your own" if `custom !== false`, "Done"
- Single-select with `custom === false`: no "Type your own" button
- Question with empty options + `custom === false`: renders cancel button (or skip + log)
- Empty `req.questions`: immediately submits empty answers

**handleCallback (single-select):**
- `pick` action: marks question done, edits message to `✓` form, increments doneCount
- All questions done: submits `respondToQuestion` with assembled answers, edits all messages
- Stale callback (request not in pending): answers with "Already responded or expired"
- Unknown action: logs warn, does not crash

**handleCallback (multi-select):**
- `tgl` action toggles selection: re-renders keyboard with ☑/☐ states
- `done` action with empty selection: submits empty answer (or shows "select at least one"? V1 = allows empty)
- `done` action with selections: marks done, includes selections in final answer

**handleCallback (custom):**
- `custom` action: sets awaiting state, edits message to show "type your custom answer", answerCallbackQuery with toast
- `isAwaitingCustomAnswer(chatId)` returns true after the action

**handleCustomAnswer:**
- Single-select: replaces `selected`, marks question done
- Multi-select: appends to `customAnswers`, leaves question pending
- Re-renders the question's message
- Clears awaiting state

**notifyReplied:**
- Pending exists: edits all questions' messages to "(resolved by opencode)" form, clears state
- Pending missing: silent no-op

**notifyRejected:**
- Pending exists: edits all questions' messages to "(cancelled)" form, clears state

**Timeout (auto-reject):**
- Timer fires → `rejectQuestion(requestId)` called, all messages edited to "(timed out)" form, state cleared

### Integration tests for `EventRouter`

In `tg-bridge/tests/event-router.test.ts`:

- Dispatches `question.asked` event → handler.onQuestionAsked called with properties
- Dispatches `question.replied` → handler.onQuestionReplied called
- Dispatches `question.rejected` → handler.onQuestionRejected called
- Handler without `onQuestionAsked` (uses `?` optional) → no crash, log unrouted? (No — known type with no handler method is fine; only types with no handler at all warn.)

### Manual verification on Unraid (Task 9)

After deploy:
1. From a switched-to project, send a prompt that's likely to trigger the agent's `question` tool (e.g. "build me a beagle website")
2. Verify questions appear as inline keyboards in Telegram
3. Tap an option → verify the message updates to show the picked answer, agent continues
4. Test multi-select if the agent uses one (toggle, Done)
5. Test "Type your own" if the agent allows custom (type a reply, verify it shows in the message)
6. Test `/init <name>` → verify it auto-switches (Fix 1)
7. Verify no bridge restart in `docker ps` after the test runs

## Risks

- **Custom-answer text intercept correctness**: A user might type a casual message thinking the bridge is in normal mode while it's actually awaiting. Mitigation: clear visual cue in the question message ("Type your custom answer in the next message…") that the user must explicitly opt into via "Type your own" button.
- **opencode timeout duration unknown**: We don't know how long opencode waits before auto-defaulting. If it's <5s, our keyboards may be irrelevant. Worth manually observing during smoke test; if it's a problem, may need to investigate opencode source for tuning.
- **Race**: agent asks Q, user is mid-tapping when opencode auto-defaults. User's tap arrives after we've cleaned up. Behavior: `"Already responded or expired"` toast. Acceptable.
- **State scaling**: `pending` Map grows with concurrent question requests. Cap is in practice <10 (a single agent rarely has more than 1-2 outstanding questions). No memory concern.
- **Bridge restart loses pending**: same as permissions — accepted limitation. Documented.

## Implementation phasing

This spec covers V1 (full feature parity per user request). Phases inside V1 (each phase = a separable commit):

1. Fix 1: `detectSuccess` repair
2. Add SDK methods: `respondToQuestion`, `rejectQuestion`
3. Extend EventRouter: dispatch the 3 new event types, optional handler methods
4. QuestionService — single-select-only core (sendRequest, handleCallback for `pick`, submit on done)
5. QuestionService — multi-select (handleCallback for `tgl`/`done`, keyboard re-render)
6. QuestionService — custom answers (handleCallback for `custom`, isAwaitingCustomAnswer, handleCustomAnswer)
7. QuestionService — cleanup (notifyReplied, notifyRejected, autoReject timeout)
8. Wire into message-handler.ts + index.ts (callback router, text intercept)
9. Build + deploy + manual verify

Each phase has its own tests. Test count baseline ≈ 216 → estimate ≈ 250 final.

## Out of scope (logged for V2)

- Per-chat persistence of pending state across bridge restarts
- Visual countdown of opencode's auto-default timeout
- Free-text answers without first pressing "Type your own"
- Bridge command to cancel a pending question
- Question support in `project-creator.ts` (the deterministic prompts shouldn't trigger it)
- Custom answer preview/edit before submit
