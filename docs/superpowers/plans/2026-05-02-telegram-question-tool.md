# Telegram Question-Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent's `question` tool calls visible and answerable in Telegram via inline keyboards (single-select, multi-select, custom-typed). Also fix `detectSuccess` so `/init` and `/clone` reliably auto-switch when the agent emits preamble text in earlier messages.

**Architecture:** New `QuestionService` (parallel to `PermissionService`) renders each `QuestionInfo` as a Telegram inline-keyboard message. Per-request state tracks which questions are answered; submit `POST /question/{requestID}/reply` when all are done. EventRouter dispatches three new event types (`question.asked`, `question.replied`, `question.rejected`) to optional handler methods. `index.ts` text handler intercepts messages when chat is awaiting a custom answer.

**Tech Stack:** TypeScript (Node 22, ESM, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), grammy, vitest, pino. Test mocks use `mock.calls[0]!` per existing convention.

**Spec:** `docs/superpowers/specs/2026-05-02-telegram-question-tool-design.md`

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `tg-bridge/src/project-creator.ts` | Modify | Repair `detectSuccess` (Task 1) |
| `tg-bridge/tests/project-creator.test.ts` | Modify | Replace existing detectSuccess tests with new ones covering preamble + verbose-reply cases |
| `tg-bridge/src/opencode-client.ts` | Modify | Add `respondToQuestion`, `rejectQuestion` SDK wrappers |
| `tg-bridge/tests/opencode-client.test.ts` | Modify | Tests for the two new methods (mock the SDK call paths) |
| `tg-bridge/src/event-router.ts` | Modify | Extend `SessionEventHandler` interface with optional question methods; dispatch `question.asked` / `question.replied` / `question.rejected` |
| `tg-bridge/tests/event-router.test.ts` | Modify | Tests for the 3 new event types |
| `tg-bridge/src/question-service.ts` | Create | The core service — sendRequest, handleCallback, handleCustomAnswer, notifyReplied, notifyRejected, autoReject |
| `tg-bridge/tests/question-service.test.ts` | Create | Unit tests for single-select / multi-select / custom / cleanup paths |
| `tg-bridge/src/message-handler.ts` | Modify | `MessageHandlerDeps.questions` field; `onQuestionAsked` / `onQuestionReplied` / `onQuestionRejected` handlers |
| `tg-bridge/tests/message-handler.test.ts` | Modify | Test that question events forward to QuestionService |
| `tg-bridge/src/index.ts` | Modify | Instantiate `QuestionService`; extend callback_query handler for `qst:` prefix; intercept text messages when chat is awaiting custom answer |

**Total:** 6 source files modified + 1 source file created + 5 test files (4 modified + 1 created).

---

## Task 1: Repair `detectSuccess` (Fix 1)

**Files:**
- Modify: `tg-bridge/src/project-creator.ts:55-80`
- Modify: `tg-bridge/tests/project-creator.test.ts` (replace existing detectSuccess tests)

**Goal:** When the agent emits preamble text in an earlier message and the marker word in a later message, detect success correctly.

- [ ] **Step 1: Update existing tests to cover the multi-message + verbose-reply cases**

Replace the existing `describe("detectSuccess", ...)` block in `tg-bridge/tests/project-creator.test.ts` with the following. (The existing block has 8-14 tests asserting old behavior; the new block supersedes them.)

```typescript
describe("detectSuccess", () => {
  it("returns false for empty parts array", () => {
    expect(detectSuccess([], "init")).toBe(false);
    expect(detectSuccess([], "clone")).toBe(false);
  });

  it("returns false when no text parts are present", () => {
    expect(
      detectSuccess(
        [{ type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } } as MaybeTextPart],
        "init",
      ),
    ).toBe(false);
  });

  it("matches a single 'initialized' text part for init", () => {
    expect(detectSuccess([{ type: "text", text: "initialized" }], "init")).toBe(true);
  });

  it("matches a single 'cloned' text part for clone", () => {
    expect(detectSuccess([{ type: "text", text: "cloned" }], "clone")).toBe(true);
  });

  it("matches the LAST text part when earlier text parts contain preamble (init)", () => {
    expect(
      detectSuccess(
        [
          { type: "text", text: "I need to run the exact command you specified." },
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } },
          { type: "text", text: "initialized" },
        ],
        "init",
      ),
    ).toBe(true);
  });

  it("matches the LAST text part when earlier text parts contain preamble (clone)", () => {
    expect(
      detectSuccess(
        [
          { type: "text", text: "I'll clone that for you now." },
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "x" } } },
          { type: "text", text: "cloned" },
        ],
        "clone",
      ),
    ).toBe(true);
  });

  it("matches a verbose final reply containing the marker as a word (init)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "Successfully initialized the project at /workspace/foo." }],
        "init",
      ),
    ).toBe(true);
  });

  it("matches a verbose final reply containing the marker as a word (clone)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "I have cloned the repository into /workspace/foo." }],
        "clone",
      ),
    ).toBe(true);
  });

  it("returns false when the last text part starts with 'failed:' even if it contains the marker", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "failed: was already initialized" }],
        "init",
      ),
    ).toBe(false);
    expect(
      detectSuccess(
        [{ type: "text", text: "failed: target was already cloned" }],
        "clone",
      ),
    ).toBe(false);
  });

  it("returns false when 'failed:' has trailing whitespace differences", () => {
    // Confirms /^failed:/i is case-insensitive but anchored at start
    expect(detectSuccess([{ type: "text", text: "Failed: foo" }], "init")).toBe(false);
    expect(detectSuccess([{ type: "text", text: "FAILED: bar" }], "clone")).toBe(false);
  });

  it("returns false when only 'initialize' (root word, missing 'd') appears (init)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "I will run init to initialize the directory." }],
        "init",
      ),
    ).toBe(false);
  });

  it("returns false when only 'clone' (verb, not past-tense) appears (clone)", () => {
    expect(
      detectSuccess(
        [{ type: "text", text: "I'll clone the repo now." }],
        "clone",
      ),
    ).toBe(false);
  });

  it("ignores empty/whitespace-only text parts when finding the last", () => {
    expect(
      detectSuccess(
        [
          { type: "text", text: "preamble" },
          { type: "text", text: "initialized" },
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
        "init",
      ),
    ).toBe(true);
  });

  it("returns false when the wrong marker appears (cloned in an init request)", () => {
    expect(detectSuccess([{ type: "text", text: "cloned" }], "init")).toBe(false);
    expect(detectSuccess([{ type: "text", text: "initialized" }], "clone")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cd tg-bridge && npx vitest run tests/project-creator.test.ts`

Expected: most of the new tests FAIL because the existing `detectSuccess` checks the start of concatenated text, not the last part as a contained word. (The "initialized" and "cloned" simple cases may pass; the preamble cases will fail.)

- [ ] **Step 3: Update `detectSuccess` in `tg-bridge/src/project-creator.ts`**

Find the existing function (around line 67-80) and replace its body with:

```typescript
export function detectSuccess<P extends MaybeTextPart>(
  parts: readonly P[],
  kind: CreationKind,
): boolean {
  // Use the LAST non-empty text part — the agent's final reply per our
  // prompt contract. Earlier text parts may be preamble narration like
  // "I need to run the exact command...".
  const textParts = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text ?? "").trim())
    .filter((t) => t.length > 0);
  const last = textParts.at(-1) ?? "";
  // Hard fail signal: agent followed our "failed: ..." contract.
  if (/^failed:/i.test(last)) return false;
  // Match the marker as a contained word, so verbose replies like
  // "Successfully initialized the directory" also match.
  const marker = kind === "clone" ? /\bcloned\b/i : /\binitialized\b/i;
  return marker.test(last);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd tg-bridge && npx vitest run tests/project-creator.test.ts`

Expected: all detectSuccess tests pass. Other project-creator tests (createProject orchestration, etc.) unaffected.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: full suite passes (216 baseline + new detectSuccess tests; remove-and-replace means the count may net zero or drop slightly depending on how many old tests existed). Typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/project-creator.ts tg-bridge/tests/project-creator.test.ts
git commit -m "Fix detectSuccess: check last text part for marker as word

When the agent emits preamble text in an earlier assistant message
and the marker word in a later message, the previous concatenate-
then-check-prefix approach failed (concatenated text starts with
preamble, not marker). New approach: check only the LAST non-empty
text part for the marker as a contained word (\\binitialized\\b /
\\bcloned\\b). Hard-fail on /^failed:/i prefix.

Handles the verified case ses_211f94bc9ffeDRVqdN1IhBhiJn where the
agent emitted msg[1] = preamble + bash tool, msg[2] = 'initialized'."
```

---

## Task 2: Add `respondToQuestion` and `rejectQuestion` SDK wrappers

**Files:**
- Modify: `tg-bridge/src/opencode-client.ts`
- Modify: `tg-bridge/tests/opencode-client.test.ts`

**Goal:** Wrap the SDK's question-reply and question-reject endpoints so the bridge can submit answers to opencode.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/opencode-client.test.ts` (after the existing tests, inside the same top-level `describe` if there is one, or as a new `describe`):

```typescript
describe("respondToQuestion", () => {
  it("calls client.question.reply with the requestID and answers", async () => {
    const replyMock = vi.fn(async () => ({ data: true, request: {}, response: {} }));
    // Patch the SDK factory to return our spy
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        question: { reply: replyMock, reject: vi.fn() },
        // stubs for unrelated methods so makeOpencodeClient doesn't crash
        session: { create: vi.fn(), abort: vi.fn(), prompt: vi.fn(), list: vi.fn() },
        project: { list: vi.fn() },
        config: { providers: vi.fn() },
        postSessionIdPermissionsPermissionId: vi.fn(),
      }),
    }));
    const { makeOpencodeClient } = await import("../src/opencode-client.js");
    const client = makeOpencodeClient({
      baseUrl: "http://x",
      username: "u",
      password: "p",
    });
    const result = await client.respondToQuestion("qst_abc", [["A", "B"], ["C"]]);
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]![0]).toEqual({
      path: { requestID: "qst_abc" },
      body: { answers: [["A", "B"], ["C"]] },
    });
    expect(result).toBe(true);
    vi.doUnmock("@opencode-ai/sdk");
  });

  it("returns true on success and false when SDK returns falsy data", async () => {
    const replyMock = vi.fn(async () => ({ data: false, request: {}, response: {} }));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        question: { reply: replyMock, reject: vi.fn() },
        session: { create: vi.fn(), abort: vi.fn(), prompt: vi.fn(), list: vi.fn() },
        project: { list: vi.fn() },
        config: { providers: vi.fn() },
        postSessionIdPermissionsPermissionId: vi.fn(),
      }),
    }));
    const { makeOpencodeClient } = await import("../src/opencode-client.js");
    const client = makeOpencodeClient({
      baseUrl: "http://x",
      username: "u",
      password: "p",
    });
    const result = await client.respondToQuestion("qst_x", []);
    expect(result).toBe(false);
    vi.doUnmock("@opencode-ai/sdk");
  });
});

describe("rejectQuestion", () => {
  it("calls client.question.reject with the requestID", async () => {
    const rejectMock = vi.fn(async () => ({ data: true, request: {}, response: {} }));
    vi.doMock("@opencode-ai/sdk", () => ({
      createOpencodeClient: () => ({
        question: { reply: vi.fn(), reject: rejectMock },
        session: { create: vi.fn(), abort: vi.fn(), prompt: vi.fn(), list: vi.fn() },
        project: { list: vi.fn() },
        config: { providers: vi.fn() },
        postSessionIdPermissionsPermissionId: vi.fn(),
      }),
    }));
    const { makeOpencodeClient } = await import("../src/opencode-client.js");
    const client = makeOpencodeClient({
      baseUrl: "http://x",
      username: "u",
      password: "p",
    });
    const result = await client.rejectQuestion("qst_xyz");
    expect(rejectMock).toHaveBeenCalledTimes(1);
    expect(rejectMock.mock.calls[0]![0]).toEqual({
      path: { requestID: "qst_xyz" },
    });
    expect(result).toBe(true);
    vi.doUnmock("@opencode-ai/sdk");
  });
});
```

NOTE on SDK method names: the plan assumes `client.question.reply` and `client.question.reject`. Verify by inspecting the SDK at implementation time. If the actual paths are e.g. `client.postQuestionRequestIDReply` (matching the existing permission pattern at `opencode-client.ts:196`), update both the test and the implementation accordingly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/opencode-client.test.ts`

Expected: FAIL with "respondToQuestion is not a function" or similar.

- [ ] **Step 3: Add interface methods + implementation in `tg-bridge/src/opencode-client.ts`**

In the `BridgeOpencodeClient` interface (around line 61-112), add after `respondToPermission`:

```typescript
  /**
   * Submit answers for a question request.
   *
   * `answers` has one entry per question in the original request, in the
   * same order. Each entry is the array of selected option labels;
   * single-select wraps a single label in an array; multi-select includes
   * all selected; custom-typed answers are appended as raw strings.
   *
   * Returns the SDK's success flag (typically true for 2xx).
   */
  respondToQuestion(requestId: string, answers: Array<Array<string>>): Promise<boolean>;

  /**
   * Reject a pending question request. Used by the bridge when it can no
   * longer collect answers (e.g. internal timeout, persistent submit
   * failure). opencode treats this as the question being cancelled; the
   * agent's `question` tool returns rejected.
   */
  rejectQuestion(requestId: string): Promise<boolean>;
```

In `makeOpencodeClient` (around line 130-221), add after `respondToPermission`:

```typescript
    async respondToQuestion(requestId, answers) {
      const { data } = await client.question.reply({
        path: { requestID: requestId },
        body: { answers },
      });
      return Boolean(data);
    },

    async rejectQuestion(requestId) {
      const { data } = await client.question.reject({
        path: { requestID: requestId },
      });
      return Boolean(data);
    },
```

If the SDK exposes these via a different shape (e.g. `client.postQuestionRequestIDReply` or `client.questionReply`), substitute accordingly. Find the actual method by inspecting `@opencode-ai/sdk` types at `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` (or similar) for symbols matching `Question.*Reply` / `Question.*Reject`.

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd tg-bridge && npx vitest run`

Expected: all tests pass; the 3 new tests for respondToQuestion + rejectQuestion are green.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/opencode-client.ts tg-bridge/tests/opencode-client.test.ts
git commit -m "Add respondToQuestion + rejectQuestion SDK wrappers

Wraps opencode's POST /question/{requestID}/reply and
POST /question/{requestID}/reject endpoints. Used by the upcoming
QuestionService to submit answers gathered from Telegram inline
keyboards. Pattern parallels respondToPermission."
```

---

## Task 3: Extend `EventRouter` for question events

**Files:**
- Modify: `tg-bridge/src/event-router.ts`
- Modify: `tg-bridge/tests/event-router.test.ts`

**Goal:** Dispatch `question.asked`, `question.replied`, `question.rejected` events to optional handler methods.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/event-router.test.ts` (inside the existing top-level `describe`):

```typescript
  it("dispatches question.asked to onQuestionAsked", async () => {
    const onQuestionAsked = vi.fn();
    const onIdle = vi.fn();
    const onError = vi.fn();
    const onPartUpdated = vi.fn();
    const onPermissionUpdated = vi.fn();
    const events: Array<unknown> = [
      { type: "question.asked", properties: { id: "qst_1", sessionID: "ses_1", questions: [] } },
    ];
    const fakeClient = {
      subscribeToEvents: vi.fn(async function* () {
        for (const e of events) yield e;
      }),
    };
    const router = new EventRouter(fakeClient as never);
    router.registerSession("ses_1", {
      onPartUpdated,
      onIdle,
      onError,
      onPermissionUpdated,
      onQuestionAsked,
    });
    const ac = new AbortController();
    const startPromise = router.start(ac.signal, ["/x"]);
    // Let the SSE generator drain
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await startPromise;
    expect(onQuestionAsked).toHaveBeenCalledTimes(1);
    expect(onQuestionAsked.mock.calls[0]![0]).toEqual({
      id: "qst_1",
      sessionID: "ses_1",
      questions: [],
    });
  });

  it("dispatches question.replied to onQuestionReplied", async () => {
    const onQuestionReplied = vi.fn();
    const events: Array<unknown> = [
      {
        type: "question.replied",
        properties: { sessionID: "ses_1", requestID: "qst_1", answers: [["A"]] },
      },
    ];
    const fakeClient = {
      subscribeToEvents: vi.fn(async function* () {
        for (const e of events) yield e;
      }),
    };
    const router = new EventRouter(fakeClient as never);
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle: vi.fn(),
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      onQuestionReplied,
    });
    const ac = new AbortController();
    const startPromise = router.start(ac.signal, ["/x"]);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await startPromise;
    expect(onQuestionReplied).toHaveBeenCalledTimes(1);
    expect(onQuestionReplied.mock.calls[0]![0]).toEqual({
      sessionID: "ses_1",
      requestID: "qst_1",
      answers: [["A"]],
    });
  });

  it("dispatches question.rejected to onQuestionRejected", async () => {
    const onQuestionRejected = vi.fn();
    const events: Array<unknown> = [
      { type: "question.rejected", properties: { sessionID: "ses_1", requestID: "qst_1" } },
    ];
    const fakeClient = {
      subscribeToEvents: vi.fn(async function* () {
        for (const e of events) yield e;
      }),
    };
    const router = new EventRouter(fakeClient as never);
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle: vi.fn(),
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      onQuestionRejected,
    });
    const ac = new AbortController();
    const startPromise = router.start(ac.signal, ["/x"]);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await startPromise;
    expect(onQuestionRejected).toHaveBeenCalledTimes(1);
  });

  it("does not crash when handler omits optional question methods", async () => {
    const events: Array<unknown> = [
      { type: "question.asked", properties: { id: "qst_1", sessionID: "ses_1", questions: [] } },
    ];
    const fakeClient = {
      subscribeToEvents: vi.fn(async function* () {
        for (const e of events) yield e;
      }),
    };
    const router = new EventRouter(fakeClient as never);
    router.registerSession("ses_1", {
      onPartUpdated: vi.fn(),
      onIdle: vi.fn(),
      onError: vi.fn(),
      onPermissionUpdated: vi.fn(),
      // intentionally no onQuestionAsked
    });
    const ac = new AbortController();
    const startPromise = router.start(ac.signal, ["/x"]);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    // Should resolve without throwing
    await startPromise;
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/event-router.test.ts`

Expected: 4 new tests fail (handler methods called 0 times because dispatch doesn't route question events).

- [ ] **Step 3: Update `tg-bridge/src/event-router.ts`**

Modify the `SessionEventHandler` interface (lines 4-9) to add optional methods:

```typescript
export interface SessionEventHandler {
  onPartUpdated(part: unknown): void;
  onIdle(): void;
  onError(err: unknown): void;
  onPermissionUpdated(perm: unknown): void;
  /**
   * Optional: handle a `question.asked` event. The bridge's
   * QuestionService implements this to render the question as
   * a Telegram inline-keyboard message. Handlers that don't
   * support questions (e.g. project-creator's deterministic-shell
   * sessions) can omit this method.
   */
  onQuestionAsked?(req: unknown): void;
  /**
   * Optional: handle `question.replied` (someone answered, possibly
   * via opencode's auto-default after timeout). QuestionService uses
   * this to clean up pending Telegram keyboards.
   */
  onQuestionReplied?(payload: unknown): void;
  /** Optional: handle `question.rejected`. Symmetric cleanup hook. */
  onQuestionRejected?(payload: unknown): void;
}
```

Add three new cases in `dispatch` (currently at line 143-166), inserted before the `default:`:

```typescript
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

Add the three event types to `isKnownType` (line 178-186):

```typescript
  private isKnownType(type: string): boolean {
    return (
      type === "message.part.updated" ||
      type === "session.idle" ||
      type === "session.error" ||
      type === "permission.asked" ||
      type === "permission.updated" ||
      type === "question.asked" ||
      type === "question.replied" ||
      type === "question.rejected"
    );
  }
```

`extractSessionId` already reads `evt.properties.sessionID`, which works for all three new event types (verified against SDK types: `QuestionRequest.sessionID`, `QuestionReplied.sessionID`, `QuestionRejected.sessionID`). No change needed there.

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd tg-bridge && npx vitest run tests/event-router.test.ts`

Expected: 4 new tests pass; existing event-router tests unaffected.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: full suite passes; typecheck exits 0. Other tests that construct `SessionEventHandler` (message-handler.test.ts, project-creator.test.ts) should NOT need updates — the new methods are optional.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/event-router.ts tg-bridge/tests/event-router.test.ts
git commit -m "EventRouter: dispatch question.asked / question.replied / question.rejected

Adds three optional methods to SessionEventHandler so consumers can
opt in to question handling. opencode emits these three event types
when the agent uses the question tool. Routing is by sessionID
(present on all three event payloads, verified in SDK types).

QuestionService (next task) will implement onQuestionAsked +
onQuestionReplied + onQuestionRejected. project-creator's handler
omits them — its deterministic shell prompts don't trigger questions."
```

---

## Task 4: `QuestionService` core — single-select only

**Files:**
- Create: `tg-bridge/src/question-service.ts`
- Create: `tg-bridge/tests/question-service.test.ts`

**Goal:** Render single-select questions as inline keyboards. Handle `pick` callbacks. Submit `respondToQuestion` when all questions in a request are answered. Multi-select, custom answers, and cleanup hooks come in Tasks 5-7.

- [ ] **Step 1: Write failing tests for the single-select happy path**

Create `tg-bridge/tests/question-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QuestionService, type QuestionRequest, type QuestionBot } from "../src/question-service.js";
import type { OpencodeClient } from "../src/opencode-client.js";

function makeBot(): QuestionBot & {
  _sentMessages: Array<{ chatId: number; text: string; opts: unknown }>;
  _editedMessages: Array<{ chatId: number; messageId: number; text: string; opts: unknown }>;
} {
  const sentMessages: Array<{ chatId: number; text: string; opts: unknown }> = [];
  const editedMessages: Array<{ chatId: number; messageId: number; text: string; opts: unknown }> = [];
  let nextMsgId = 1000;
  return {
    _sentMessages: sentMessages,
    _editedMessages: editedMessages,
    sendMessage: vi.fn(async (chatId: number, text: string, opts: unknown) => {
      const id = nextMsgId++;
      sentMessages.push({ chatId, text, opts });
      return { message_id: id };
    }),
    editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, opts: unknown) => {
      editedMessages.push({ chatId, messageId, text, opts });
      return undefined;
    }),
    answerCallbackQuery: vi.fn(async () => undefined),
  };
}

function makeClient(): OpencodeClient & {
  _replies: Array<{ requestId: string; answers: Array<Array<string>> }>;
  _rejects: Array<string>;
} {
  const replies: Array<{ requestId: string; answers: Array<Array<string>> }> = [];
  const rejects: Array<string> = [];
  return {
    _replies: replies,
    _rejects: rejects,
    respondToQuestion: vi.fn(async (requestId: string, answers: Array<Array<string>>) => {
      replies.push({ requestId, answers });
      return true;
    }),
    rejectQuestion: vi.fn(async (requestId: string) => {
      rejects.push(requestId);
      return true;
    }),
    // Stubs for unused methods — type-narrowed so TS doesn't complain
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(),
    prompt: vi.fn(),
    listProjects: vi.fn(),
    listProviders: vi.fn(),
    respondToPermission: vi.fn(),
    subscribeToEvents: vi.fn(),
  } as never;
}

describe("QuestionService — single-select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one Telegram message per question with a single-select keyboard", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick a color",
          header: "Color",
          options: [
            { label: "Red", description: "warm" },
            { label: "Blue", description: "cool" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    expect(bot._sentMessages).toHaveLength(1);
    const sent = bot._sentMessages[0]!;
    expect(sent.chatId).toBe(42);
    expect(sent.text).toContain("Color"); // header
    expect(sent.text).toContain("Pick a color"); // question text
    // Verify keyboard structure
    const opts = sent.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    const buttons = opts.reply_markup.inline_keyboard.flat();
    const labels = buttons.map((b) => b.text);
    expect(labels).toContain("Red");
    expect(labels).toContain("Blue");
    // "Type your own" should be present (custom defaults to true)
    expect(labels.some((l) => l.toLowerCase().includes("type your own"))).toBe(true);
    // Callback data uses qst:<requestID>:<qIdx>:pick:<optIdx>
    const redBtn = buttons.find((b) => b.text === "Red");
    expect(redBtn?.callback_data).toBe("qst:qst_1:0:pick:0");
  });

  it("omits 'Type your own' when custom is false", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_2",
      sessionID: "ses_1",
      questions: [
        {
          question: "Yes or no?",
          header: "Confirm",
          custom: false,
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    const opts = bot._sentMessages[0]!.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    const buttons = opts.reply_markup.inline_keyboard.flat();
    const labels = buttons.map((b) => b.text);
    expect(labels.some((l) => l.toLowerCase().includes("type your own"))).toBe(false);
  });

  it("on pick callback, edits message to show selected answer and submits when all done", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_3",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick one",
          header: "H",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(99, req);
    const claimed = await service.handleCallback({
      id: "cb1",
      data: "qst:qst_3:0:pick:0",
      message: { chat: { id: 99 }, message_id: bot._sentMessages[0]!.opts ? 1000 : 1000 },
    });
    expect(claimed).toBe(true);
    // Should have edited the message and submitted to opencode
    expect(bot._editedMessages.length).toBeGreaterThanOrEqual(1);
    const lastEdit = bot._editedMessages[bot._editedMessages.length - 1]!;
    expect(lastEdit.text).toContain("A"); // selected label appears in final state
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_3", answers: [["A"]] });
  });

  it("with multiple questions, waits for all to be answered before submitting", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_4",
      sessionID: "ses_1",
      questions: [
        {
          question: "Q1",
          header: "H1",
          options: [{ label: "A", description: "" }, { label: "B", description: "" }],
        },
        {
          question: "Q2",
          header: "H2",
          options: [{ label: "X", description: "" }, { label: "Y", description: "" }],
        },
      ],
    };
    await service.sendRequest(99, req);
    expect(bot._sentMessages).toHaveLength(2);
    // Answer Q2 first
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_4:1:pick:1",
      message: { chat: { id: 99 }, message_id: 1001 },
    });
    expect(client._replies).toHaveLength(0); // not all done
    // Then Q1
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_4:0:pick:0",
      message: { chat: { id: 99 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_4", answers: [["A"], ["Y"]] });
  });

  it("returns false from handleCallback for non-qst: prefixes", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const claimed = await service.handleCallback({ id: "cb1", data: "perm:xyz:once" });
    expect(claimed).toBe(false);
  });

  it("answers stale callback with 'Already responded' when request is unknown", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const claimed = await service.handleCallback({
      id: "cb1",
      data: "qst:qst_unknown:0:pick:0",
    });
    expect(claimed).toBe(true);
    expect(bot.answerCallbackQuery).toHaveBeenCalledWith("cb1", expect.objectContaining({ text: expect.stringMatching(/already|expired/i) }));
  });

  it("immediately submits empty answers when req.questions is empty", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_empty",
      sessionID: "ses_1",
      questions: [],
    };
    await service.sendRequest(42, req);
    expect(bot._sentMessages).toHaveLength(0);
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_empty", answers: [] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: FAIL with "Failed to load url ../src/question-service.js. Does the file exist?"

- [ ] **Step 3: Create `tg-bridge/src/question-service.ts`**

```typescript
import type { Logger } from "pino";
import { escapeMarkdownV2 } from "./format.js";
import type { OpencodeClient } from "./opencode-client.js";

export interface QuestionBot {
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
    opts: {
      parse_mode: "MarkdownV2";
      reply_markup?: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    },
  ): Promise<unknown>;

  answerCallbackQuery(id: string, opts?: { text?: string }): Promise<unknown>;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: Array<QuestionOption>;
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: { messageID?: string; callID?: string };
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
  /** Auto-reject after this many ms if not all questions answered. Default: 15 minutes. */
  timeoutMs?: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

interface PerQuestionState {
  selected: string[];
  customAnswers: string[];
  done: boolean;
  messageId: number | null;
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

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class QuestionService {
  private pending = new Map<string, PendingRequest>();
  // chatId → which (request, question) is awaiting a custom-typed answer
  private awaiting = new Map<number, { requestId: string; questionIdx: number }>();
  private timeoutMs: number;
  private log: Pick<Logger, "info" | "warn" | "error"> | undefined;

  constructor(
    private bot: QuestionBot,
    private client: OpencodeClient,
    options?: QuestionServiceOptions,
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options?.log;
  }

  async sendRequest(chatId: number, req: QuestionRequest): Promise<void> {
    if (req.questions.length === 0) {
      this.log?.warn?.({ requestId: req.id }, "QuestionRequest with empty questions array; submitting immediately");
      await this.client.respondToQuestion(req.id, []);
      return;
    }

    const questionStates: PerQuestionState[] = req.questions.map(() => ({
      selected: [],
      customAnswers: [],
      done: false,
      messageId: null,
    }));

    // Send each question's keyboard message (single-select for V1).
    for (let i = 0; i < req.questions.length; i++) {
      const q = req.questions[i]!;
      const state = questionStates[i]!;
      try {
        const sent = await this.bot.sendMessage(chatId, this.renderQuestionMessage(q, state), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: this.buildKeyboard(req.id, i, q, state) },
        });
        state.messageId = sent.message_id;
      } catch (err) {
        this.log?.warn?.({ err, chatId, requestId: req.id, questionIdx: i }, "failed to send question message");
        // Leave messageId null; this question can't be answered. The request will eventually time out.
      }
    }

    const timer = setTimeout(() => {
      void this.autoReject(req.id);
    }, this.timeoutMs);

    this.pending.set(req.id, {
      requestId: req.id,
      sessionId: req.sessionID,
      chatId,
      questions: req.questions,
      questionStates,
      timer,
      resolved: false,
    });
  }

  async handleCallback(cb: CallbackQuery): Promise<boolean> {
    const data = cb.data ?? "";
    if (!data.startsWith("qst:")) return false;

    const parts = data.split(":");
    // qst:<requestID>:<questionIdx>:<action>[:<argIdx>]
    if (parts.length < 4) {
      this.log?.warn?.({ data }, "qst callback data malformed");
      return true;
    }
    const [, requestId, qIdxStr, action, argIdxStr] = parts as [string, string, string, string, string | undefined];
    const qIdx = parseInt(qIdxStr, 10);
    const argIdx = argIdxStr !== undefined ? parseInt(argIdxStr, 10) : undefined;

    const entry = this.pending.get(requestId);
    if (!entry || entry.resolved) {
      await this.bot
        .answerCallbackQuery(cb.id, { text: "Already responded or expired" })
        .catch((err) => this.log?.warn?.({ err }, "answerCallbackQuery failed"));
      return true;
    }

    if (qIdx < 0 || qIdx >= entry.questions.length) {
      this.log?.warn?.({ requestId, qIdx }, "qst callback question index out of range");
      return true;
    }
    const q = entry.questions[qIdx]!;
    const state = entry.questionStates[qIdx]!;

    // For V1: only `pick` action is implemented; `tgl`, `custom`, `done` come in later tasks.
    if (action === "pick") {
      if (state.done) {
        await this.bot
          .answerCallbackQuery(cb.id, { text: "Already answered" })
          .catch(() => undefined);
        return true;
      }
      if (argIdx === undefined || argIdx < 0 || argIdx >= q.options.length) {
        this.log?.warn?.({ requestId, qIdx, argIdx }, "qst pick option index out of range");
        return true;
      }
      const option = q.options[argIdx]!;
      state.selected = [option.label];
      state.done = true;
      // Edit message: show the picked answer, remove keyboard
      if (state.messageId !== null) {
        await this.bot
          .editMessageText(
            entry.chatId,
            state.messageId,
            this.renderAnsweredMessage(q, state),
            { parse_mode: "MarkdownV2" },
          )
          .catch((err) => this.log?.warn?.({ err }, "editMessageText (pick) failed"));
      }
      await this.bot.answerCallbackQuery(cb.id).catch(() => undefined);
      // If all questions are done, submit to opencode
      const allDone = entry.questionStates.every((s) => s.done);
      if (allDone) await this.submitAll(entry);
      return true;
    }

    // Unknown action — log and ignore. (Future tasks add tgl/custom/done.)
    this.log?.warn?.({ action }, "unknown qst callback action; ignoring");
    return true;
  }

  private async submitAll(entry: PendingRequest): Promise<void> {
    if (entry.resolved) return;
    entry.resolved = true;
    clearTimeout(entry.timer);
    const answers: Array<Array<string>> = entry.questionStates.map((s) => [
      ...s.selected,
      ...s.customAnswers,
    ]);
    try {
      await this.client.respondToQuestion(entry.requestId, answers);
      this.log?.info?.({ requestId: entry.requestId }, "submitted question answers to opencode");
    } catch (err) {
      this.log?.error?.({ requestId: entry.requestId, err }, "respondToQuestion failed");
      // Annotate each question's message with a failure note
      for (let i = 0; i < entry.questions.length; i++) {
        const state = entry.questionStates[i]!;
        if (state.messageId === null) continue;
        const q = entry.questions[i]!;
        const failureText =
          this.renderAnsweredMessage(q, state) +
          "\n\n_" +
          escapeMarkdownV2("⚠️ Failed to submit to opencode") +
          "_";
        await this.bot
          .editMessageText(entry.chatId, state.messageId, failureText, {
            parse_mode: "MarkdownV2",
          })
          .catch(() => undefined);
      }
    } finally {
      this.pending.delete(entry.requestId);
    }
  }

  private async autoReject(requestId: string): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    try {
      await this.client.rejectQuestion(requestId);
    } catch (err) {
      this.log?.warn?.({ requestId, err }, "rejectQuestion failed during autoReject");
    }
    // Edit each question's message to show timeout
    for (let i = 0; i < entry.questions.length; i++) {
      const state = entry.questionStates[i]!;
      if (state.messageId === null) continue;
      const q = entry.questions[i]!;
      await this.bot
        .editMessageText(
          entry.chatId,
          state.messageId,
          `*${escapeMarkdownV2(q.header)}*\n_${escapeMarkdownV2("⏱ Timed out")}_`,
          { parse_mode: "MarkdownV2" },
        )
        .catch(() => undefined);
    }
    this.pending.delete(requestId);
    // Clear any awaiting custom-answer state for this chat
    if (this.awaiting.get(entry.chatId)?.requestId === requestId) {
      this.awaiting.delete(entry.chatId);
    }
  }

  private renderQuestionMessage(q: QuestionInfo, _state: PerQuestionState): string {
    // V1: just the header + question text. Multi-select state markers
    // will be rendered into this in Task 5 once `tgl` action is added.
    return `*${escapeMarkdownV2(q.header)}*\n${escapeMarkdownV2(q.question)}`;
  }

  private renderAnsweredMessage(q: QuestionInfo, state: PerQuestionState): string {
    const allSelected = [...state.selected, ...state.customAnswers.map((c) => `"${c}"`)];
    const summary = allSelected.length > 0 ? allSelected.join(", ") : "(no answer)";
    return `✓ *${escapeMarkdownV2(q.header)}*: ${escapeMarkdownV2(summary)}`;
  }

  private buildKeyboard(
    requestId: string,
    qIdx: number,
    q: QuestionInfo,
    _state: PerQuestionState,
  ): Array<Array<{ text: string; callback_data: string }>> {
    // V1: single-select only. Multi-select buttons (tgl + Done) come in Task 5;
    // custom-answer button comes in Task 6.
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i]!;
      rows.push([
        { text: opt.label, callback_data: `qst:${requestId}:${qIdx}:pick:${i}` },
      ]);
    }
    if (q.custom !== false) {
      rows.push([
        { text: "✏️ Type your own", callback_data: `qst:${requestId}:${qIdx}:custom` },
      ]);
    }
    return rows;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: 7 new tests pass (single-select happy path, custom-button presence/absence, pick → submit, multi-question batch, non-qst prefix returns false, stale callback, empty questions short-circuit).

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: full suite passes; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/question-service.ts tg-bridge/tests/question-service.test.ts
git commit -m "QuestionService: single-select rendering + submit-on-done

V1 of the question tool bridge. Each question becomes one Telegram
inline-keyboard message. On 'pick' callback, the message edits to
show the chosen answer and the keyboard is removed. When all
questions in a request are answered, submits via respondToQuestion.

Auto-reject timer (default 15min) calls rejectQuestion if not all
answers gathered. Stale callbacks get an 'Already responded or
expired' toast.

Multi-select (tgl/done actions), custom-typed answers (custom action
+ awaiting-state), and notifyReplied/notifyRejected cleanup come in
Tasks 5-7."
```

---

## Task 5: `QuestionService` — multi-select support

**Files:**
- Modify: `tg-bridge/src/question-service.ts`
- Modify: `tg-bridge/tests/question-service.test.ts`

**Goal:** When a question has `multiple: true`, render toggle-style ☐/☑ buttons + a "Done" button. Re-render keyboard on each toggle. Submit on "Done".

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/question-service.test.ts` after the single-select describe block:

```typescript
describe("QuestionService — multi-select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders ☐ buttons + Done button for multi-select questions", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick features",
          header: "Features",
          multiple: true,
          options: [
            { label: "Dark mode", description: "" },
            { label: "Animations", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    const opts = bot._sentMessages[0]!.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    const flat = opts.reply_markup.inline_keyboard.flat();
    const labels = flat.map((b) => b.text);
    // Each option prefixed with ☐
    expect(labels.some((l) => l === "☐ Dark mode")).toBe(true);
    expect(labels.some((l) => l === "☐ Animations")).toBe(true);
    // Done button present
    expect(labels.some((l) => l === "✅ Done")).toBe(true);
    // Type your own present (custom defaults to true)
    expect(labels.some((l) => l.toLowerCase().includes("type your own"))).toBe(true);
    // tgl callback for options
    const dmBtn = flat.find((b) => b.text === "☐ Dark mode");
    expect(dmBtn?.callback_data).toBe("qst:qst_m1:0:tgl:0");
    const doneBtn = flat.find((b) => b.text === "✅ Done");
    expect(doneBtn?.callback_data).toBe("qst:qst_m1:0:done");
  });

  it("on tgl callback, edits keyboard to show ☑ for toggled option, does not submit", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m2",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m2:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(0); // not submitted
    const lastEdit = bot._editedMessages[bot._editedMessages.length - 1]!;
    const opts = lastEdit.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } };
    const labels = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l === "☑ A")).toBe(true);
    expect(labels.some((l) => l === "☐ B")).toBe(true);
  });

  it("on tgl callback for already-selected option, untoggles it (☑ → ☐)", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m3",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    // Toggle A on
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m3:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    // Toggle A off
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_m3:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    const lastEdit = bot._editedMessages[bot._editedMessages.length - 1]!;
    const opts = lastEdit.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } };
    const labels = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l === "☐ A")).toBe(true);
  });

  it("on done callback, marks question done with current selections and submits if all done", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m4",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
            { label: "C", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    // Toggle A and C
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m4:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_m4:0:tgl:2",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(0);
    // Done
    await service.handleCallback({
      id: "cb3",
      data: "qst:qst_m4:0:done",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_m4", answers: [["A", "C"]] });
  });

  it("done with no selections submits an empty answer for that question", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m5",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m5:0:done",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_m5", answers: [[]] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: 5 new tests fail (multi-select branches not yet implemented).

- [ ] **Step 3: Update `tg-bridge/src/question-service.ts`**

Modify `buildKeyboard` to handle multi-select:

```typescript
  private buildKeyboard(
    requestId: string,
    qIdx: number,
    q: QuestionInfo,
    state: PerQuestionState,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (q.multiple === true) {
      // Multi-select: ☐/☑ toggles, Done button at bottom
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i]!;
        const checked = state.selected.includes(opt.label);
        const prefix = checked ? "☑" : "☐";
        rows.push([
          { text: `${prefix} ${opt.label}`, callback_data: `qst:${requestId}:${qIdx}:tgl:${i}` },
        ]);
      }
      if (q.custom !== false) {
        rows.push([
          { text: "✏️ Type your own", callback_data: `qst:${requestId}:${qIdx}:custom` },
        ]);
      }
      rows.push([{ text: "✅ Done", callback_data: `qst:${requestId}:${qIdx}:done` }]);
    } else {
      // Single-select
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i]!;
        rows.push([
          { text: opt.label, callback_data: `qst:${requestId}:${qIdx}:pick:${i}` },
        ]);
      }
      if (q.custom !== false) {
        rows.push([
          { text: "✏️ Type your own", callback_data: `qst:${requestId}:${qIdx}:custom` },
        ]);
      }
    }
    return rows;
  }
```

Add `tgl` and `done` handling in `handleCallback`. Find the existing `if (action === "pick")` block and add these BEFORE the unknown-action warn:

```typescript
    if (action === "tgl") {
      if (state.done) {
        await this.bot.answerCallbackQuery(cb.id, { text: "Already answered" }).catch(() => undefined);
        return true;
      }
      if (argIdx === undefined || argIdx < 0 || argIdx >= q.options.length) {
        this.log?.warn?.({ requestId, qIdx, argIdx }, "qst tgl option index out of range");
        return true;
      }
      const option = q.options[argIdx]!;
      const idx = state.selected.indexOf(option.label);
      if (idx >= 0) {
        state.selected.splice(idx, 1);
      } else {
        state.selected.push(option.label);
      }
      // Re-render the keyboard (message body stays the same)
      if (state.messageId !== null) {
        await this.bot
          .editMessageText(
            entry.chatId,
            state.messageId,
            this.renderQuestionMessage(q, state),
            {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: this.buildKeyboard(requestId, qIdx, q, state) },
            },
          )
          .catch((err) => this.log?.warn?.({ err }, "editMessageText (tgl) failed"));
      }
      await this.bot.answerCallbackQuery(cb.id).catch(() => undefined);
      return true;
    }

    if (action === "done") {
      if (state.done) {
        await this.bot.answerCallbackQuery(cb.id, { text: "Already answered" }).catch(() => undefined);
        return true;
      }
      state.done = true;
      // Edit the message to show the final selections, remove keyboard
      if (state.messageId !== null) {
        await this.bot
          .editMessageText(
            entry.chatId,
            state.messageId,
            this.renderAnsweredMessage(q, state),
            { parse_mode: "MarkdownV2" },
          )
          .catch((err) => this.log?.warn?.({ err }, "editMessageText (done) failed"));
      }
      await this.bot.answerCallbackQuery(cb.id).catch(() => undefined);
      const allDone = entry.questionStates.every((s) => s.done);
      if (allDone) await this.submitAll(entry);
      return true;
    }
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: all multi-select tests pass; existing single-select tests still pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/question-service.ts tg-bridge/tests/question-service.test.ts
git commit -m "QuestionService: multi-select with ☐/☑ toggle + Done

For questions with multiple: true, render checkbox-style buttons
and a Done button. Toggle action re-renders the keyboard with the
updated state. Done marks the question answered and submits if
all questions in the request are done. Empty selection at Done
submits an empty answer array for that question (opencode handles
the semantic)."
```

---

## Task 6: `QuestionService` — custom-typed answers

**Files:**
- Modify: `tg-bridge/src/question-service.ts`
- Modify: `tg-bridge/tests/question-service.test.ts`

**Goal:** "Type your own" button sets per-chat awaiting state. The user's next text message is captured as a custom answer (intercepted by index.ts before the regular text handler).

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/question-service.test.ts`:

```typescript
describe("QuestionService — custom answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("on custom callback, sets awaiting state and toasts the user", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_c1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    expect(service.isAwaitingCustomAnswer(42)).toBe(false);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_c1:0:custom",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(service.isAwaitingCustomAnswer(42)).toBe(true);
    expect(bot.answerCallbackQuery).toHaveBeenCalledWith(
      "cb1",
      expect.objectContaining({ text: expect.stringMatching(/type|custom/i) }),
    );
  });

  it("handleCustomAnswer in single-select replaces selected, marks done, submits", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_c2",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_c2:0:custom",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    await service.handleCustomAnswer(42, "I want X instead");
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_c2", answers: [["I want X instead"]] });
    // Awaiting cleared
    expect(service.isAwaitingCustomAnswer(42)).toBe(false);
  });

  it("handleCustomAnswer in multi-select appends to customAnswers, leaves question pending", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_c3",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    // Toggle A
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_c3:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    // Custom answer
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_c3:0:custom",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    await service.handleCustomAnswer(42, "Custom thing");
    // Not yet submitted
    expect(client._replies).toHaveLength(0);
    expect(service.isAwaitingCustomAnswer(42)).toBe(false);
    // Done
    await service.handleCallback({
      id: "cb3",
      data: "qst:qst_c3:0:done",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_c3", answers: [["A", "Custom thing"]] });
  });

  it("handleCustomAnswer when not awaiting is a no-op", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    await service.handleCustomAnswer(42, "should be ignored");
    expect(client._replies).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: 4 new tests fail (custom action and handleCustomAnswer not yet implemented).

- [ ] **Step 3: Update `tg-bridge/src/question-service.ts`**

In `handleCallback`, add a `custom` action handler before the unknown-action warn:

```typescript
    if (action === "custom") {
      if (state.done) {
        await this.bot.answerCallbackQuery(cb.id, { text: "Already answered" }).catch(() => undefined);
        return true;
      }
      this.awaiting.set(entry.chatId, { requestId, questionIdx: qIdx });
      await this.bot
        .answerCallbackQuery(cb.id, { text: "Type your custom answer in the next message" })
        .catch(() => undefined);
      return true;
    }
```

Add the public methods at the end of the class (before the closing `}`):

```typescript
  isAwaitingCustomAnswer(chatId: number): boolean {
    return this.awaiting.has(chatId);
  }

  async handleCustomAnswer(chatId: number, text: string): Promise<void> {
    const ctx = this.awaiting.get(chatId);
    if (!ctx) return;
    this.awaiting.delete(chatId);
    const entry = this.pending.get(ctx.requestId);
    if (!entry || entry.resolved) return;
    if (ctx.questionIdx < 0 || ctx.questionIdx >= entry.questions.length) return;
    const q = entry.questions[ctx.questionIdx]!;
    const state = entry.questionStates[ctx.questionIdx]!;
    if (state.done) return;

    if (q.multiple === true) {
      // Multi-select: append to customAnswers, leave pending until Done
      state.customAnswers.push(text);
      // Re-render keyboard message body to include the new custom answer
      if (state.messageId !== null) {
        await this.bot
          .editMessageText(
            entry.chatId,
            state.messageId,
            this.renderQuestionMessage(q, state),
            {
              parse_mode: "MarkdownV2",
              reply_markup: { inline_keyboard: this.buildKeyboard(ctx.requestId, ctx.questionIdx, q, state) },
            },
          )
          .catch((err) => this.log?.warn?.({ err }, "editMessageText (custom-multi) failed"));
      }
      return;
    }

    // Single-select: replace selected with the custom answer, mark done, submit if all done
    state.selected = [];
    state.customAnswers = [text];
    state.done = true;
    if (state.messageId !== null) {
      await this.bot
        .editMessageText(
          entry.chatId,
          state.messageId,
          this.renderAnsweredMessage(q, state),
          { parse_mode: "MarkdownV2" },
        )
        .catch((err) => this.log?.warn?.({ err }, "editMessageText (custom-single) failed"));
    }
    const allDone = entry.questionStates.every((s) => s.done);
    if (allDone) await this.submitAll(entry);
  }
```

Update `renderQuestionMessage` to surface custom answers in the message body when present (multi-select case):

```typescript
  private renderQuestionMessage(q: QuestionInfo, state: PerQuestionState): string {
    const lines: string[] = [
      `*${escapeMarkdownV2(q.header)}*`,
      escapeMarkdownV2(q.question),
    ];
    // Show custom-typed answers (multi-select shows them inline above the keyboard)
    for (const c of state.customAnswers) {
      lines.push(`_${escapeMarkdownV2(`Custom: "${c}"`)}_`);
    }
    return lines.join("\n");
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: all 4 new tests pass; existing single-select and multi-select tests still pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/question-service.ts tg-bridge/tests/question-service.test.ts
git commit -m "QuestionService: custom-typed answers via 'Type your own'

Custom callback sets per-chat awaiting state. The intercepted text
becomes the answer. Single-select: replaces selection, marks done,
submits if all done. Multi-select: appends to customAnswers, leaves
pending until Done. The text-intercept itself happens in index.ts
(Task 8) so the regular text handler doesn't treat the answer as a
new prompt."
```

---

## Task 7: `QuestionService` — `notifyReplied` / `notifyRejected` cleanup

**Files:**
- Modify: `tg-bridge/src/question-service.ts`
- Modify: `tg-bridge/tests/question-service.test.ts`

**Goal:** When opencode emits `question.replied` (e.g. it auto-defaulted) or `question.rejected`, clean up any pending Telegram keyboards in this bridge so users don't tap stale buttons.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/question-service.test.ts`:

```typescript
describe("QuestionService — opencode-side cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("notifyReplied edits all pending question messages to show opencode's answers and clears state", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_r1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Q1",
          header: "H1",
          options: [{ label: "A", description: "" }],
        },
        {
          question: "Q2",
          header: "H2",
          options: [{ label: "X", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    // opencode auto-defaults
    await service.notifyReplied({
      sessionID: "ses_1",
      requestID: "qst_r1",
      answers: [["A"], ["X"]],
    });
    // Each question's message should be edited to a final form mentioning the answer
    const editsByMsgId = new Map<number, string>();
    for (const e of bot._editedMessages) editsByMsgId.set(e.messageId, e.text);
    expect(editsByMsgId.size).toBeGreaterThanOrEqual(2);
    for (const [, text] of editsByMsgId) {
      expect(text.toLowerCase()).toMatch(/resolved|opencode/);
    }
    // No new submission to opencode (we didn't gather these)
    expect(client._replies).toHaveLength(0);
  });

  it("notifyRejected edits all pending question messages to show cancelled and clears state", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_rj1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Q",
          header: "H",
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    await service.notifyRejected({ sessionID: "ses_1", requestID: "qst_rj1" });
    const lastEdit = bot._editedMessages[bot._editedMessages.length - 1]!;
    expect(lastEdit.text.toLowerCase()).toMatch(/cancelled|rejected/);
  });

  it("notifyReplied for an unknown request is a silent no-op", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    await service.notifyReplied({
      sessionID: "ses_x",
      requestID: "qst_unknown",
      answers: [],
    });
    expect(bot._editedMessages).toHaveLength(0);
  });

  it("after notifyReplied, isAwaitingCustomAnswer for that chat returns false", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_r2",
      sessionID: "ses_1",
      questions: [{ question: "Q", header: "H", options: [{ label: "A", description: "" }] }],
    };
    await service.sendRequest(42, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_r2:0:custom",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(service.isAwaitingCustomAnswer(42)).toBe(true);
    await service.notifyReplied({
      sessionID: "ses_1",
      requestID: "qst_r2",
      answers: [["A"]],
    });
    expect(service.isAwaitingCustomAnswer(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: 4 new tests fail (notifyReplied / notifyRejected don't exist).

- [ ] **Step 3: Update `tg-bridge/src/question-service.ts`**

Add two new public methods at the end of the class (before the closing `}`):

```typescript
  async notifyReplied(payload: QuestionRepliedEvent): Promise<void> {
    const entry = this.pending.get(payload.requestID);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    clearTimeout(entry.timer);
    // Edit each question's message to show what opencode received
    for (let i = 0; i < entry.questions.length; i++) {
      const q = entry.questions[i]!;
      const state = entry.questionStates[i]!;
      if (state.messageId === null) continue;
      const ocAnswers = payload.answers[i] ?? [];
      const summary = ocAnswers.length > 0 ? ocAnswers.join(", ") : "(none)";
      const text = `✓ *${escapeMarkdownV2(q.header)}*: ${escapeMarkdownV2(summary)}\n_${escapeMarkdownV2("(resolved by opencode)")}_`;
      await this.bot
        .editMessageText(entry.chatId, state.messageId, text, { parse_mode: "MarkdownV2" })
        .catch((err) => this.log?.warn?.({ err, requestId: payload.requestID }, "editMessageText (notifyReplied) failed"));
    }
    if (this.awaiting.get(entry.chatId)?.requestId === payload.requestID) {
      this.awaiting.delete(entry.chatId);
    }
    this.pending.delete(payload.requestID);
  }

  async notifyRejected(payload: QuestionRejectedEvent): Promise<void> {
    const entry = this.pending.get(payload.requestID);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    clearTimeout(entry.timer);
    for (let i = 0; i < entry.questions.length; i++) {
      const q = entry.questions[i]!;
      const state = entry.questionStates[i]!;
      if (state.messageId === null) continue;
      const text = `❌ *${escapeMarkdownV2(q.header)}*: ${escapeMarkdownV2("cancelled by opencode")}`;
      await this.bot
        .editMessageText(entry.chatId, state.messageId, text, { parse_mode: "MarkdownV2" })
        .catch((err) => this.log?.warn?.({ err, requestId: payload.requestID }, "editMessageText (notifyRejected) failed"));
    }
    if (this.awaiting.get(entry.chatId)?.requestId === payload.requestID) {
      this.awaiting.delete(entry.chatId);
    }
    this.pending.delete(payload.requestID);
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd tg-bridge && npx vitest run tests/question-service.test.ts`

Expected: all 4 new tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/question-service.ts tg-bridge/tests/question-service.test.ts
git commit -m "QuestionService: notifyReplied / notifyRejected cleanup hooks

When opencode emits question.replied (e.g. auto-default after timeout
or another client answered) or question.rejected (cancelled), clean
up any pending Telegram keyboards. Edit each question's message to a
final state showing the resolution. Clear awaiting custom-answer
state. Delete the pending entry so subsequent button taps get the
'already responded or expired' toast."
```

---

## Task 8: Wire `QuestionService` into `message-handler.ts` and `index.ts`

**Files:**
- Modify: `tg-bridge/src/message-handler.ts`
- Modify: `tg-bridge/src/index.ts`
- Modify: `tg-bridge/tests/message-handler.test.ts`

**Goal:** Forward `question.asked` / `question.replied` / `question.rejected` events from message-handler's session handler to QuestionService. In index.ts, route `qst:` callbacks to QuestionService and intercept text messages when chat is awaiting a custom answer.

- [ ] **Step 1: Write failing tests**

Append to `tg-bridge/tests/message-handler.test.ts`:

```typescript
  it("forwards question.asked to questions.sendRequest", async () => {
    const sentPlaceholder = { message_id: 999 };
    const ctx = makeFakeCtx({
      message: { text: "hello", chat: { id: 1 }, from: { id: 100 } },
      reply: vi.fn(async () => sentPlaceholder),
    });
    let capturedHandler: SessionEventHandler | undefined;
    const router = {
      registerSession: vi.fn((_sid, handler) => {
        capturedHandler = handler;
        return () => undefined;
      }),
    };
    const sendRequest = vi.fn(async () => undefined);
    const notifyReplied = vi.fn(async () => undefined);
    const notifyRejected = vi.fn(async () => undefined);
    const deps = {
      state: makeFakeState({ projectPath: "/workspace/x", sessionId: "ses_42" }),
      client: makeFakeClient(),
      router: router as never,
      permissions: { sendRequest: vi.fn() },
      questions: { sendRequest, notifyReplied, notifyRejected },
      bot: { editMessageText: vi.fn(), sendMessage: vi.fn() },
      defaultModel: "anthropic/claude-sonnet-4-5",
    };
    await handleTextMessage(ctx as never, deps as never);
    expect(capturedHandler).toBeDefined();
    capturedHandler!.onQuestionAsked!({ id: "qst_1", sessionID: "ses_42", questions: [] });
    // sendRequest is fire-and-forget; let the microtask queue drain
    await new Promise((r) => setImmediate(r));
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0]![0]).toBe(1);
    expect(sendRequest.mock.calls[0]![1]).toEqual({ id: "qst_1", sessionID: "ses_42", questions: [] });
  });

  it("forwards question.replied and question.rejected to QuestionService", async () => {
    const sentPlaceholder = { message_id: 999 };
    const ctx = makeFakeCtx({
      message: { text: "hello", chat: { id: 1 }, from: { id: 100 } },
      reply: vi.fn(async () => sentPlaceholder),
    });
    let capturedHandler: SessionEventHandler | undefined;
    const router = {
      registerSession: vi.fn((_sid, handler) => {
        capturedHandler = handler;
        return () => undefined;
      }),
    };
    const notifyReplied = vi.fn(async () => undefined);
    const notifyRejected = vi.fn(async () => undefined);
    const deps = {
      state: makeFakeState({ projectPath: "/workspace/x", sessionId: "ses_42" }),
      client: makeFakeClient(),
      router: router as never,
      permissions: { sendRequest: vi.fn() },
      questions: { sendRequest: vi.fn(), notifyReplied, notifyRejected },
      bot: { editMessageText: vi.fn(), sendMessage: vi.fn() },
      defaultModel: "anthropic/claude-sonnet-4-5",
    };
    await handleTextMessage(ctx as never, deps as never);
    expect(capturedHandler).toBeDefined();
    capturedHandler!.onQuestionReplied!({ sessionID: "ses_42", requestID: "qst_1", answers: [] });
    capturedHandler!.onQuestionRejected!({ sessionID: "ses_42", requestID: "qst_2" });
    await new Promise((r) => setImmediate(r));
    expect(notifyReplied).toHaveBeenCalledTimes(1);
    expect(notifyRejected).toHaveBeenCalledTimes(1);
  });
```

(Adapt the helper imports — `makeFakeCtx`, `makeFakeState`, `makeFakeClient`, `SessionEventHandler` — to match the existing test file's conventions. Look at the file's existing imports/helpers and reuse them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tg-bridge && npx vitest run tests/message-handler.test.ts`

Expected: 2 new tests fail (handler doesn't have onQuestionAsked/Replied/Rejected; deps.questions doesn't exist).

- [ ] **Step 3: Update `tg-bridge/src/message-handler.ts`**

Add to the `MessageHandlerDeps` interface (around line 12-31), after `permissions:`:

```typescript
  /**
   * Question service for rendering opencode's question tool calls as
   * Telegram inline keyboards. The handler forwards onQuestionAsked /
   * onQuestionReplied / onQuestionRejected here.
   */
  questions: {
    sendRequest(chatId: number, req: unknown): Promise<void>;
    notifyReplied(payload: unknown): Promise<void>;
    notifyRejected(payload: unknown): Promise<void>;
  };
```

In the handler object (line 67-116), add three new methods after `onPermissionUpdated`:

```typescript
    onQuestionAsked(req) {
      const requestId = (req as { id?: string })?.id;
      deps.log?.info?.({ chatId, sessionId, requestId }, "question.asked event received");
      deps.questions
        .sendRequest(chatId, req)
        .catch((err) => {
          deps.log?.error?.(
            { chatId, sessionId, requestId, err: describeError(err) },
            "questions.sendRequest failed",
          );
        });
    },
    onQuestionReplied(payload) {
      const requestId = (payload as { requestID?: string })?.requestID;
      deps.log?.info?.({ chatId, sessionId, requestId }, "question.replied event received");
      deps.questions.notifyReplied(payload).catch((err) => {
        deps.log?.error?.(
          { chatId, sessionId, requestId, err: describeError(err) },
          "questions.notifyReplied failed",
        );
      });
    },
    onQuestionRejected(payload) {
      const requestId = (payload as { requestID?: string })?.requestID;
      deps.log?.info?.({ chatId, sessionId, requestId }, "question.rejected event received");
      deps.questions.notifyRejected(payload).catch((err) => {
        deps.log?.error?.(
          { chatId, sessionId, requestId, err: describeError(err) },
          "questions.notifyRejected failed",
        );
      });
    },
```

- [ ] **Step 4: Update `tg-bridge/src/index.ts`**

Add the import at the top:

```typescript
import { QuestionService } from "./question-service.js";
```

After the `permissions` instantiation (around line 81-84), add:

```typescript
  const questions = new QuestionService(permBot as never, client, { log });
```

In the `bot.on("callback_query:data", ...)` handler (around line 123-148), restructure so `qst:` data routes to questions and `perm:` to permissions:

```typescript
  bot.on("callback_query:data", async (ctx) => {
    log.info(
      {
        callbackId: ctx.callbackQuery.id,
        data: ctx.callbackQuery.data,
        from: ctx.from?.id,
        chat: ctx.chat?.id,
      },
      "callback_query received",
    );
    const data = ctx.callbackQuery.data ?? "";
    const msg = ctx.callbackQuery.message;
    const cb = {
      id: ctx.callbackQuery.id,
      data,
      ...(msg
        ? {
            message: {
              chat: { id: msg.chat.id },
              message_id: msg.message_id,
            },
          }
        : {}),
    };
    if (data.startsWith("qst:")) {
      await questions.handleCallback(cb);
      return;
    }
    await permissions.handleCallback(cb);
  });
```

In the `bot.on("message:text", ...)` handler (around line 151-161), intercept custom-answer text BEFORE invoking handleTextMessage:

```typescript
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text;
    // Intercept text intended as a custom answer to a pending question.
    // Slash commands (`/...`) are NOT intercepted — they go to bot.command()
    // first; this handler only fires for non-command text.
    if (
      typeof chatId === "number" &&
      typeof text === "string" &&
      !text.startsWith("/") &&
      questions.isAwaitingCustomAnswer(chatId)
    ) {
      try {
        await questions.handleCustomAnswer(chatId, text);
      } catch (err) {
        log.error({ err, chatId }, "questions.handleCustomAnswer failed");
      }
      return;
    }
    await handleTextMessage(ctx, {
      state,
      client,
      router,
      permissions,
      questions,
      bot: turnBot,
      defaultModel: config.defaultModel,
      log,
    });
  });
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd tg-bridge && npx vitest run
cd tg-bridge && npm run typecheck
```

Expected: full suite passes; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/message-handler.ts tg-bridge/src/index.ts tg-bridge/tests/message-handler.test.ts
git commit -m "Wire QuestionService into message-handler + index

message-handler's session event handler now forwards
onQuestionAsked / onQuestionReplied / onQuestionRejected to the
QuestionService. index.ts instantiates QuestionService, routes
qst: callback data to it, and intercepts text messages when chat
is awaiting a custom-typed answer (so the answer doesn't get
treated as a new prompt by the regular text handler)."
```

---

## Task 9: Build, deploy, smoke verify

**Files:** None modified. Final integration check.

- [ ] **Step 1: Final build + tests + typecheck**

```bash
cd /Users/doni/code/test-opencode-headless/tg-bridge
npm run build
npx vitest run
npm run typecheck
```

Expected: build succeeds; all tests pass (estimate ~250 total — verify by running); typecheck exits 0.

- [ ] **Step 2: Inspect commits**

```bash
cd /Users/doni/code/test-opencode-headless
git log --oneline -10
```

Expected: 8 new commits on top of the previous main HEAD, one per Task 1-8.

- [ ] **Step 3: Push to origin**

```bash
git push origin main
```

- [ ] **Step 4: Deploy to Unraid**

```bash
ssh root@192.168.86.81 'cd /mnt/user/appdata/opencode/repo && git pull --ff-only && docker compose -f deploy/compose.yaml build tg-bridge && docker compose -f deploy/compose.yaml up -d tg-bridge'
```

Expected: pull shows the 8 new commits; docker build succeeds; container is recreated.

- [ ] **Step 5: Verify container health**

```bash
ssh root@192.168.86.81 'docker ps --filter name=tg-bridge --format "{{.Status}}"'
ssh root@192.168.86.81 'docker logs tg-bridge --tail=30'
```

Expected: `Up X seconds` (NOT `Restarting`). Logs show standard `seeding event subscriptions` / `opencode event subscription opening` / `starting`. No error trace.

- [ ] **Step 6: User smoke test (HUMAN action)**

These steps require the user's Telegram client. Document the expected outcomes:

1. **Fix 1 verification**: Run `/init smoke-test-2` (or new name). Expected: streaming → `Switched to smoke-test-2` confirmation message replaces the placeholder. NOT the agent's transcript.

2. **Question tool — single-select**: From a switched-to project, send a prompt that's likely to trigger the agent to ask: e.g. `Build me a simple website`. The agent will probably use the question tool. Expected: each question appears as a separate Telegram message with inline-keyboard buttons. Tap an option → message edits to `✓ <header>: <choice>` and the keyboard disappears. Agent continues with the chosen answer.

3. **Question tool — multi-select**: If the agent uses a `multiple: true` question, you'll see ☐ buttons. Tap to toggle to ☑. Tap "✅ Done" to submit. Expected: message edits to `✓ <header>: <comma-separated picks>`.

4. **Question tool — custom answer**: Tap "✏️ Type your own". Bridge replies with a toast "Type your custom answer in the next message". Send a text message. Expected: in single-select mode, the question is marked answered with your custom text; in multi-select mode, the custom text appears in the message body and you can still tap Done.

5. **Question tool — opencode auto-default**: If you wait too long without answering, opencode will auto-pick (Recommended) defaults and emit `question.replied`. Expected: each pending question's message edits to `✓ <header>: <opencode's pick> (resolved by opencode)`.

6. **No regressions**: confirm `/projects`, `/help`, `/switch`, `/abort`, `/status`, `/model`, regular text messages, permission keyboards (if you re-enable), etc. all still work.

- [ ] **Step 7: Verify no errors in deployed bridge logs**

```bash
ssh root@192.168.86.81 'docker logs tg-bridge --since=10m | grep -iE "error|reject|fail" | head -30'
```

Expected: empty or only benign warnings (e.g. occasional `editMessageText (tgl) failed` if a user toggled rapidly enough to hit Telegram's edit rate limit — auto-retry handles 429).

- [ ] **Step 8: Final cleanup**

If smoke test surfaces any regression: fix in a new commit, push, redeploy. Otherwise no action.

---

## Self-Review

### Spec coverage

- ✅ Fix 1 (`detectSuccess` repair) — Task 1
- ✅ SDK methods `respondToQuestion` / `rejectQuestion` — Task 2
- ✅ EventRouter dispatches the 3 new event types with optional handler methods — Task 3
- ✅ QuestionService — single-select rendering + submit-on-done — Task 4
- ✅ QuestionService — multi-select with toggle — Task 5
- ✅ QuestionService — custom-typed answers — Task 6
- ✅ QuestionService — notifyReplied / notifyRejected cleanup — Task 7
- ✅ QuestionService — auto-reject timeout — Task 4 (autoReject method, `timeoutMs` option)
- ✅ Routing by sessionID (parallel to permissions) — Task 3 (extractSessionId already reads `properties.sessionID` for these event types)
- ✅ Wire-up in message-handler + index.ts — Task 8
- ✅ Deploy + smoke test — Task 9

### Edge cases coverage

| Case | Task | Behavior |
|---|---|---|
| Empty `req.questions` | Task 4 | `sendRequest` short-circuits and submits empty answers immediately |
| `custom === false` | Task 4 (single-select), Task 5 (multi-select) | "Type your own" button omitted |
| Stale callback (request unknown) | Task 4 | "Already responded or expired" toast |
| Callback for already-answered question | Task 4 (pick), Task 5 (tgl/done) | "Already answered" toast |
| All chats receive question for a session they don't own | Task 3 (handler routing) | Handler not registered → event dropped (logged unrouted). Same as permissions. |
| Bridge restart mid-question | Acknowledged in spec, no special handling | In-memory state lost; opencode times out; user sees stale-callback toast on tap |
| `/abort` during pending question | Acknowledged in spec | `/abort` aborts session → opencode emits `question.rejected` → notifyRejected cleans up |
| Telegram fails to send a question message | Task 4 | Log warn; `messageId = null`; subsequent callbacks for that question ignored |
| Submit fails | Task 4 (`submitAll`) | Edit each question's message to append `⚠️ Failed to submit to opencode` |
| Auto-reject timeout fires | Task 4 (`autoReject`) | Each question's message edits to `⏱ Timed out`; `rejectQuestion` called |

### Type consistency

- `QuestionRequest`, `QuestionRepliedEvent`, `QuestionRejectedEvent`, `QuestionInfo`, `QuestionOption`, `QuestionBot`, `CallbackQuery`, `QuestionServiceOptions`, `PerQuestionState`, `PendingRequest` — all defined in question-service.ts (Task 4) and used consistently across Tasks 5-7
- `respondToQuestion(requestId, answers)` and `rejectQuestion(requestId)` signatures defined in opencode-client.ts (Task 2) and used unchanged in QuestionService (Task 4) and autoReject path (Task 4)
- `SessionEventHandler` extension in event-router.ts (Task 3) uses `onQuestionAsked?(req: unknown)` etc. — consumers in message-handler (Task 8) match this loose `unknown` shape and cast to QuestionService's typed shape at the call site

### Placeholder scan

No "TBD", "TODO", "implement later", or vague "add error handling" instructions. Every step has explicit code or test.

### Test count tracking (estimates; verify task-by-task during execution)

| Task | Tests added | Tests removed | Cumulative total |
|---|---|---|---|
| baseline | — | — | 216 |
| Task 1 | +14 (new detectSuccess block) | -8 to -14 (replaces existing block — verify exact count) | ~216-222 |
| Task 2 | +3 (respondToQuestion x2, rejectQuestion x1) | 0 | ~219-225 |
| Task 3 | +4 (3 dispatch + 1 no-crash) | 0 | ~223-229 |
| Task 4 | +7 (single-select describe block) | 0 | ~230-236 |
| Task 5 | +5 (multi-select) | 0 | ~235-241 |
| Task 6 | +4 (custom-typed answers) | 0 | ~239-245 |
| Task 7 | +4 (notifyReplied/Rejected) | 0 | ~243-249 |
| Task 8 | +2 (message-handler forwarding) | 0 | ~245-251 |
| **Final** | | | **~245-251** |

If actuals differ by ≤5 from these estimates, recount tests in each task's Step 1 — variance from test-helper consolidation is normal.
