# Telegram Bridge Render Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current segment-joining renderer (which produces unbalanced MarkdownV2 fences and crashes the bridge) with a streaming-view + final-view renderer wrapped in safeEdit/safeSend helpers that never throw.

**Architecture:** Two render modes: `renderStreamingView(parts)` (compact tool list while agent works, no fenced blocks) and `renderFinalView(parts)` (concatenated text + muted summary header after `session.idle`). All Telegram calls routed through `safeEdit`/`safeSend` that retry as plain text on parse error and never throw, eliminating the unhandled-rejection crash class.

**Tech Stack:** TypeScript (Node 22, ESM, strict), grammy, vitest, pino. Project uses `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Test mocks use `mock.calls[0]!` non-null assertions per existing convention.

**Spec:** `docs/superpowers/specs/2026-05-02-telegram-render-overhaul-design.md`

---

## File Structure

| File | Disposition | Responsibility |
|---|---|---|
| `tg-bridge/src/format.ts` | Modify (extend, then remove dead code at end) | Pure render helpers: tool emoji, tool line, streaming view, summary header, text concatenation, final view. No I/O. |
| `tg-bridge/src/safe-telegram.ts` | Create | Wrap `bot.editMessageText` / `bot.sendMessage` with MarkdownV2 → plain text fallback. Never throw. |
| `tg-bridge/src/turn.ts` | Modify | Switch internals to use `renderStreamingView` + `renderFinalView` + `safeEdit` + `safeSend`. Public surface unchanged. |
| `tg-bridge/src/message-handler.ts` | Modify | Add defensive `try/catch` around `turn.finalize()` and `turn.showError()` calls (defense in depth — `safeEdit` already prevents throws, but onIdle/onError are async functions called from a fire-and-forget dispatch). |
| `tg-bridge/tests/format.test.ts` | Modify | Add tests for new helpers; remove tests for removed exports at end. |
| `tg-bridge/tests/safe-telegram.test.ts` | Create | Unit tests for fallback chain. |
| `tg-bridge/tests/turn.test.ts` | Modify | Update assertion patterns to match new render output; add no-throw tests. |
| `tg-bridge/tests/message-handler.test.ts` | Modify (optional, only if existing tests break) | Add no-throw test for finalize-rejecting case. |

**Total:** 4 source files + 3 test files + 1 new file.

---

## Task 1: Add `toolEmoji` + `renderToolLine` helpers to `format.ts`

**Files:**
- Modify: `tg-bridge/src/format.ts`
- Test: `tg-bridge/tests/format.test.ts`

**Goal:** Add two pure helpers used by the streaming-view renderer in Task 2. Old `renderParts` and friends untouched.

- [ ] **Step 1: Write the failing test**

Append to `tg-bridge/tests/format.test.ts`:

```typescript
import { toolEmoji, renderToolLine } from "../src/format.js";

describe("toolEmoji", () => {
  it("returns the file emoji for read/write/edit", () => {
    expect(toolEmoji("read")).toBe("📄");
    expect(toolEmoji("write")).toBe("📄");
    expect(toolEmoji("edit")).toBe("📄");
  });

  it("returns the search emoji for grep/glob", () => {
    expect(toolEmoji("grep")).toBe("🔍");
    expect(toolEmoji("glob")).toBe("🔍");
  });

  it("returns the bolt emoji for bash", () => {
    expect(toolEmoji("bash")).toBe("⚡");
  });

  it("returns the globe emoji for webfetch", () => {
    expect(toolEmoji("webfetch")).toBe("🌐");
  });

  it("returns a wrench fallback for unknown tools", () => {
    expect(toolEmoji("anything-else")).toBe("🔧");
  });
});

describe("renderToolLine", () => {
  it("renders a pending read tool with file path in inline code", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "read",
        state: { status: "pending", input: { filePath: "src/auth.ts" } },
      }),
    ).toBe("📄 read `src/auth\\.ts`");
  });

  it("renders a running bash tool with the command in inline code", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "pwd" } },
      }),
    ).toBe("⚡ bash `pwd`");
  });

  it("renders a completed grep tool with the pattern", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "grep",
        state: { status: "completed", input: { pattern: "FastAPI" }, output: "ignored during streaming" },
      }),
    ).toBe("🔍 grep `FastAPI`");
  });

  it("renders an errored tool with a red X prefix instead of the tool emoji", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "bash",
        state: { status: "error", input: { command: "missing" }, error: "command not found" },
      }),
    ).toBe("❌ bash `missing`");
  });

  it("replaces backticks in tool input arguments to keep the inline code span valid", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "echo `date`" } },
      }),
    ).toBe("⚡ bash `echo 'date'`");
  });

  it("falls back to JSON.stringify when no preferred field is present", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "custom",
        state: { status: "running", input: { foo: 42, bar: true } },
      }),
    ).toBe("🔧 custom `{\"foo\":42,\"bar\":true}`");
  });

  it("renders just the tool name when input is missing", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "custom",
        state: { status: "running" },
      }),
    ).toBe("🔧 custom");
  });

  it("returns empty string for non-tool parts", () => {
    expect(renderToolLine({ type: "text", text: "hi" })).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/format.test.ts`

Expected: FAIL with "Could not find imports `toolEmoji`, `renderToolLine`" or similar export-missing errors.

- [ ] **Step 3: Add the helpers to `format.ts`**

Edit `tg-bridge/src/format.ts`. Add these exports near the top (after the existing `escapeMarkdownV2` / `escapeCode` block, before the existing `RenderablePart` type):

```typescript
const TOOL_EMOJI: Record<string, string> = {
  read: "📄",
  write: "📄",
  edit: "📄",
  grep: "🔍",
  glob: "🔍",
  bash: "⚡",
  webfetch: "🌐",
};

export function toolEmoji(name: string): string {
  return TOOL_EMOJI[name] ?? "🔧";
}

/**
 * Render a tool part as a single line: "<emoji> <name> `<arg>`".
 * Used by renderStreamingView; also reusable for the live "while-running" state.
 *
 * - status "error" prefixes ❌ instead of the tool emoji.
 * - Backticks in the input are replaced with single quotes so the inline-code
 *   span remains balanced. Lossy but safe.
 * - If input has no preferred field, falls back to JSON.stringify(input) truncated to 80 chars.
 * - Non-tool parts return "".
 */
export function renderToolLine(part: RenderablePart): string {
  if (part.type !== "tool") return "";
  const tp = part as { type: "tool"; tool: string; state: ToolState };
  const isError = tp.state.status === "error";
  const emoji = isError ? "❌" : toolEmoji(tp.tool);
  const escapedTool = escapeMarkdownV2(tp.tool);
  const summary = summarizeToolInput(tp.tool, tp.state.input);
  if (!summary) return `${emoji} ${escapedTool}`;
  const safeForCode = summary.replace(/`/g, "'");
  const escaped = escapeMarkdownV2(safeForCode);
  return `${emoji} ${escapedTool} \`${escaped}\``;
}
```

The existing `summarizeToolInput` returns `""` when input is null/undefined or has no preferred key. The new test "renders just the tool name when input is missing" exercises that path.

The fallback-to-JSON-stringify case requires a small edit to `summarizeToolInput`. Modify the existing function to handle the no-preferred-key case:

```typescript
function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
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
  if (preferredKey) {
    const value = obj[preferredKey];
    if (value !== undefined) {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      // Only fall through to JSON-stringify of the whole object if the preferred-key
      // value is itself empty.
      if (str.length > 0) return str.length > 80 ? `${str.slice(0, 80)}…` : str;
    }
  }
  // Fall back: stringify the entire input, truncated.
  const json = JSON.stringify(obj);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}
```

Note: this changes `summarizeToolInput`'s behavior in one edge case (empty preferred-key value now falls through to full JSON instead of returning ""). The existing `renderToolPart` (still alive at this point) only consumes `summarizeToolInput`'s result for the italic header, where the change is a strict improvement (more info instead of nothing). No existing test should break — verify in step 4.

- [ ] **Step 4: Run all tests to verify the new ones pass and nothing else broke**

Run: `cd tg-bridge && npx vitest run`

Expected: all previous tests still pass; 8 new tests pass (5 toolEmoji + 8 renderToolLine — wait, 5 emoji + 8 line = 13. Recount: emoji has 5 cases, line has 8 cases. Total +13 new tests on top of existing 126 = 139 expected.)

Actual count check: emoji tests = 5, renderToolLine tests = 8. Total +13.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/format.ts tg-bridge/tests/format.test.ts
git commit -m "Add toolEmoji + renderToolLine helpers for compact tool rendering

Step 1 of render overhaul. These helpers underpin the new streaming-view
renderer (Task 2). Old renderParts/renderTextPart/renderToolPart still
present and used by Turn — will be removed in the cleanup task once Turn
is switched over."
```

---

## Task 2: Add `renderStreamingView` to `format.ts`

**Files:**
- Modify: `tg-bridge/src/format.ts`
- Test: `tg-bridge/tests/format.test.ts`

**Goal:** Add the streaming-view renderer that composes tool lines + a thinking line, with a cap at 30 visible lines.

- [ ] **Step 1: Write the failing test**

Append to `tg-bridge/tests/format.test.ts`:

```typescript
import { renderStreamingView } from "../src/format.js";

describe("renderStreamingView", () => {
  it("returns just the thinking marker when no tools present", () => {
    expect(renderStreamingView([])).toBe("_thinking…_");
  });

  it("ignores text parts during streaming and shows only the thinking marker", () => {
    expect(
      renderStreamingView([{ type: "text", text: "partial assistant text" }]),
    ).toBe("_thinking…_");
  });

  it("renders one tool line followed by the thinking marker", () => {
    const out = renderStreamingView([
      {
        type: "tool",
        tool: "read",
        state: { status: "pending", input: { filePath: "config.py" } },
      },
    ]);
    expect(out).toBe("📄 read `config\\.py`\n_thinking…_");
  });

  it("renders multiple tool lines in order with the thinking marker last", () => {
    const out = renderStreamingView([
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "a.py" } },
      },
      {
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "pwd" } },
      },
      {
        type: "tool",
        tool: "grep",
        state: { status: "pending", input: { pattern: "FastAPI" } },
      },
    ]);
    expect(out).toBe(
      "📄 read `a\\.py`\n⚡ bash `pwd`\n🔍 grep `FastAPI`\n_thinking…_",
    );
  });

  it("collapses oldest tool lines when more than 30 tools are present", () => {
    // 35 tools → 5 oldest collapsed into one summary line, 30 latest shown, then thinking
    const parts: RenderablePart[] = Array.from({ length: 35 }, (_, i) => ({
      type: "tool" as const,
      tool: "read",
      state: { status: "completed" as const, input: { filePath: `file${i}.py` } },
    }));
    const out = renderStreamingView(parts);
    const lines = out.split("\n");
    // 1 collapsed summary + 30 tool lines + 1 thinking = 32 lines total
    expect(lines).toHaveLength(32);
    expect(lines[0]).toBe("_…5 earlier actions…_");
    // First retained tool line should be file5.py (indices 5..34 retained)
    expect(lines[1]).toBe("📄 read `file5\\.py`");
    // Last tool line (line 30) should be file34.py
    expect(lines[30]).toBe("📄 read `file34\\.py`");
    // Final line is the thinking marker
    expect(lines[31]).toBe("_thinking…_");
  });

  it("does not collapse when exactly 30 tools are present", () => {
    const parts: RenderablePart[] = Array.from({ length: 30 }, (_, i) => ({
      type: "tool" as const,
      tool: "read",
      state: { status: "completed" as const, input: { filePath: `f${i}.py` } },
    }));
    const out = renderStreamingView(parts);
    const lines = out.split("\n");
    expect(lines).toHaveLength(31); // 30 tools + thinking
    expect(lines[0]).toBe("📄 read `f0\\.py`");
    expect(lines[30]).toBe("_thinking…_");
  });

  it("includes errored tools in the count and renders them with X prefix", () => {
    const out = renderStreamingView([
      {
        type: "tool",
        tool: "bash",
        state: { status: "error", input: { command: "bad" }, error: "no such file" },
      },
    ]);
    expect(out).toBe("❌ bash `bad`\n_thinking…_");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/format.test.ts`

Expected: FAIL with "renderStreamingView is not a function" or import error.

- [ ] **Step 3: Implement `renderStreamingView`**

Add to `tg-bridge/src/format.ts` (after `renderToolLine`):

```typescript
const STREAMING_VIEW_CAP = 30;
const THINKING_MARKER = "_thinking…_";

/**
 * Render the placeholder content while the agent is working.
 *
 * Filters to tool parts only (text parts are hidden during streaming to
 * avoid partial-MarkdownV2 rendering bugs). Each tool becomes one line via
 * renderToolLine. If more than STREAMING_VIEW_CAP tools are present, the
 * oldest are collapsed into a single italic summary line. A trailing
 * "_thinking…_" line indicates work in progress.
 *
 * The output uses only: inline code (single backticks), italic
 * (underscores), emoji, newlines. NO fenced code blocks. Structurally
 * cannot produce unbalanced fences.
 */
export function renderStreamingView(parts: readonly RenderablePart[]): string {
  const toolParts = parts.filter((p) => p.type === "tool");
  const lines: string[] = [];
  if (toolParts.length > STREAMING_VIEW_CAP) {
    const collapsed = toolParts.length - STREAMING_VIEW_CAP;
    lines.push(`_…${collapsed} earlier actions…_`);
    for (let i = collapsed; i < toolParts.length; i++) {
      const part = toolParts[i];
      if (part) lines.push(renderToolLine(part));
    }
  } else {
    for (const part of toolParts) lines.push(renderToolLine(part));
  }
  lines.push(THINKING_MARKER);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all previous tests pass; 7 new tests pass. Total: 139 + 7 = 146.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/format.ts tg-bridge/tests/format.test.ts
git commit -m "Add renderStreamingView for compact placeholder updates

Streaming view shows one line per tool call (emoji + name + arg in inline
code) followed by '_thinking…_'. Caps at 30 visible tools; older entries
collapse into a single italic summary line. No fenced code blocks =
structurally cannot produce unbalanced markdown."
```

---

## Task 3: Add `renderToolSummary`, `concatenateTextParts`, `renderFinalView` to `format.ts`

**Files:**
- Modify: `tg-bridge/src/format.ts`
- Test: `tg-bridge/tests/format.test.ts`

**Goal:** Add the final-view renderer that produces a muted summary header + concatenated text body.

- [ ] **Step 1: Write the failing test**

Append to `tg-bridge/tests/format.test.ts`:

```typescript
import {
  renderToolSummary,
  concatenateTextParts,
  renderFinalView,
} from "../src/format.js";

describe("renderToolSummary", () => {
  it("returns empty string when no tools present", () => {
    expect(renderToolSummary([])).toBe("");
    expect(renderToolSummary([{ type: "text", text: "hi" }])).toBe("");
  });

  it("describes a single tool", () => {
    expect(
      renderToolSummary([
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "pwd" } },
        },
      ]),
    ).toBe("_used 1 tool · 1 bash_");
  });

  it("describes multiple tools with per-name breakdown", () => {
    const parts: RenderablePart[] = [
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "a" } } },
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "b" } } },
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "c" } } },
      { type: "tool", tool: "grep", state: { status: "completed", input: { pattern: "x" } } },
      { type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" } } },
    ];
    expect(renderToolSummary(parts)).toBe(
      "_used 5 tools · 3 read · 1 grep · 1 bash_",
    );
  });

  it("appends an error count when any tool errored", () => {
    const parts: RenderablePart[] = [
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "a" } } },
      { type: "tool", tool: "bash", state: { status: "error", input: { command: "bad" } } },
    ];
    expect(renderToolSummary(parts)).toBe(
      "_used 2 tools · 1 read · 1 bash · 1 error_",
    );
  });

  it("uses 'errors' (plural) for multiple errors", () => {
    const parts: RenderablePart[] = [
      { type: "tool", tool: "bash", state: { status: "error", input: { command: "a" } } },
      { type: "tool", tool: "bash", state: { status: "error", input: { command: "b" } } },
      { type: "tool", tool: "bash", state: { status: "error", input: { command: "c" } } },
    ];
    expect(renderToolSummary(parts)).toBe(
      "_used 3 tools · 3 bash · 3 errors_",
    );
  });

  it("preserves first-appearance order in the breakdown", () => {
    const parts: RenderablePart[] = [
      { type: "tool", tool: "bash", state: { status: "completed", input: { command: "a" } } },
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "b" } } },
      { type: "tool", tool: "bash", state: { status: "completed", input: { command: "c" } } },
    ];
    expect(renderToolSummary(parts)).toBe("_used 3 tools · 2 bash · 1 read_");
  });
});

describe("concatenateTextParts", () => {
  it("returns empty string for no text parts", () => {
    expect(concatenateTextParts([])).toBe("");
    expect(
      concatenateTextParts([
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "pwd" } },
        },
      ]),
    ).toBe("");
  });

  it("escapes a single text part", () => {
    expect(
      concatenateTextParts([{ type: "text", text: "hello (world)." }]),
    ).toBe("hello \\(world\\)\\.");
  });

  it("joins multiple text parts with double newline, escaping each", () => {
    expect(
      concatenateTextParts([
        { type: "text", text: "let me check." },
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "a" } },
        },
        { type: "text", text: "the answer is X." },
      ]),
    ).toBe("let me check\\.\n\nthe answer is X\\.");
  });

  it("ignores empty text parts (after trim)", () => {
    expect(
      concatenateTextParts([
        { type: "text", text: "first" },
        { type: "text", text: "" },
        { type: "text", text: "   " },
        { type: "text", text: "last" },
      ]),
    ).toBe("first\n\nlast");
  });
});

describe("renderFinalView", () => {
  it("returns '_(no response)_' for empty parts", () => {
    expect(renderFinalView([])).toBe("_\\(no response\\)_");
  });

  it("returns just text when no tools used", () => {
    expect(
      renderFinalView([{ type: "text", text: "The answer is 42." }]),
    ).toBe("The answer is 42\\.");
  });

  it("returns header + body when tools were used", () => {
    expect(
      renderFinalView([
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" } } },
        { type: "text", text: "Working dir is /workspace." },
      ]),
    ).toBe("_used 1 tool · 1 bash_\n\nWorking dir is /workspace\\.");
  });

  it("returns header + '_(no response text)_' when tools used but no text", () => {
    expect(
      renderFinalView([
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" } } },
      ]),
    ).toBe("_used 1 tool · 1 bash_\n\n_\\(no response text\\)_");
  });

  it("includes error count in summary header", () => {
    expect(
      renderFinalView([
        { type: "tool", tool: "bash", state: { status: "error", input: { command: "bad" } } },
        { type: "text", text: "Failed to run command." },
      ]),
    ).toBe(
      "_used 1 tool · 1 bash · 1 error_\n\nFailed to run command\\.",
    );
  });

  it("concatenates multiple text parts", () => {
    expect(
      renderFinalView([
        { type: "text", text: "Let me check the project structure." },
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "a.py" } },
        },
        { type: "text", text: "It's a FastAPI app." },
      ]),
    ).toBe(
      "_used 1 tool · 1 read_\n\nLet me check the project structure\\.\n\nIt's a FastAPI app\\.",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/format.test.ts`

Expected: FAIL with "renderToolSummary / concatenateTextParts / renderFinalView is not a function".

- [ ] **Step 3: Implement the three new functions**

Add to `tg-bridge/src/format.ts` (after `renderStreamingView`):

```typescript
/**
 * Render the muted summary header for the final view: "_used N tools · ...details..._".
 * Returns "" if no tools are present.
 */
export function renderToolSummary(parts: readonly RenderablePart[]): string {
  const toolParts = parts.filter((p) => p.type === "tool") as Array<{
    type: "tool";
    tool: string;
    state: ToolState;
  }>;
  if (toolParts.length === 0) return "";

  // Per-name counts in first-appearance order.
  const counts = new Map<string, number>();
  let errorCount = 0;
  for (const p of toolParts) {
    counts.set(p.tool, (counts.get(p.tool) ?? 0) + 1);
    if (p.state.status === "error") errorCount++;
  }

  const total = toolParts.length;
  const totalLabel = `${total} ${total === 1 ? "tool" : "tools"}`;
  const breakdown = Array.from(counts.entries()).map(([name, n]) => `${n} ${name}`);
  const segments = [totalLabel, ...breakdown];
  if (errorCount > 0) {
    segments.push(`${errorCount} ${errorCount === 1 ? "error" : "errors"}`);
  }
  // Build "used 5 tools · 3 read · 1 grep · 1 bash · 1 error" then italicize.
  const inner = `used ${segments.join(" · ")}`;
  // The whole header is one italic span. The inside contains "·" (not reserved)
  // and digits/letters/spaces. No escaping needed for the static template;
  // tool names are already lowercase ASCII identifiers from opencode.
  return `_${inner}_`;
}

/**
 * Concatenate all text parts in order, joined by "\n\n", with each part
 * escaped via escapeMarkdownV2. Empty / whitespace-only text parts are
 * skipped. Tool parts are ignored.
 */
export function concatenateTextParts(parts: readonly RenderablePart[]): string {
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type !== "text") continue;
    const text = (p as { text?: string }).text;
    if (typeof text !== "string") continue;
    if (text.trim().length === 0) continue;
    texts.push(escapeMarkdownV2(text));
  }
  return texts.join("\n\n");
}

/**
 * Render the final reply: muted summary header (if any tools used) +
 * concatenated text body (if any text present).
 *
 * Edge cases:
 *   - No tools, with text: just the text
 *   - No tools, no text: "_(no response)_"
 *   - Tools used, no text: header + "_(no response text)_"
 *   - Tools used, with text: header + body
 */
export function renderFinalView(parts: readonly RenderablePart[]): string {
  const summary = renderToolSummary(parts);
  const body = concatenateTextParts(parts);

  if (summary === "" && body === "") return `_${escapeMarkdownV2("(no response)")}_`;
  if (summary === "") return body;
  if (body === "") return `${summary}\n\n_${escapeMarkdownV2("(no response text)")}_`;
  return `${summary}\n\n${body}`;
}
```

- [ ] **Step 4: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all previous tests pass; 14 new tests pass (5 renderToolSummary + 4 concatenateTextParts + 6 renderFinalView — recount: summary=6, concat=4, final=6 = 16). Total: 146 + 16 = 162.

If the count differs, recount the `it(...)` blocks added in Step 1. Each `it` is one test.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/format.ts tg-bridge/tests/format.test.ts
git commit -m "Add renderFinalView with summary header + concatenated text body

The final reply view is dominated by the assistant's actual answer.
Tool activity is demoted to a muted italic header that lists the count
+ per-name breakdown + error count. Multiple text parts in one
assistant message are concatenated with double-newline separators,
preserving the agent's narration flow."
```

---

## Task 4: Create `safe-telegram.ts` with `safeEdit`, `safeSend`, and `stripMarkdownV2Escapes`

**Files:**
- Create: `tg-bridge/src/safe-telegram.ts`
- Create: `tg-bridge/tests/safe-telegram.test.ts`

**Goal:** Wrap Telegram edit/send calls with a parse-error fallback chain. Never throw.

- [ ] **Step 1: Write the failing test**

Create `tg-bridge/tests/safe-telegram.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { safeEdit, safeSend, stripMarkdownV2Escapes } from "../src/safe-telegram.js";

interface FakeBot {
  editMessageText: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function makeBot(): FakeBot {
  return {
    editMessageText: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ message_id: 999 })),
  };
}

describe("stripMarkdownV2Escapes", () => {
  it("removes backslash before reserved chars", () => {
    expect(stripMarkdownV2Escapes("hello \\(world\\)\\.")).toBe("hello (world).");
  });

  it("preserves a literal backslash that was double-escaped", () => {
    // Original "x\y" escapes to "x\\\\y"; stripping should yield "x\\y".
    expect(stripMarkdownV2Escapes("x\\\\y")).toBe("x\\y");
  });

  it("leaves plain text untouched", () => {
    expect(stripMarkdownV2Escapes("hello world")).toBe("hello world");
  });

  it("handles a trailing single backslash gracefully", () => {
    expect(stripMarkdownV2Escapes("foo\\")).toBe("foo\\");
  });
});

describe("safeEdit", () => {
  it("calls editMessageText once with MarkdownV2 on success", async () => {
    const bot = makeBot();
    await safeEdit(bot, 1, 50, "hello \\(world\\)");
    expect(bot.editMessageText).toHaveBeenCalledTimes(1);
    expect(bot.editMessageText.mock.calls[0]).toEqual([
      1,
      50,
      "hello \\(world\\)",
      { parse_mode: "MarkdownV2" },
    ]);
  });

  it("retries with plain text when MarkdownV2 fails", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce(undefined);
    await safeEdit(bot, 1, 50, "broken \\(markdown");
    expect(bot.editMessageText).toHaveBeenCalledTimes(2);
    // Second call uses plain text (no parse_mode) and stripped content.
    expect(bot.editMessageText.mock.calls[1]).toEqual([
      1,
      50,
      "broken (markdown",
      {},
    ]);
  });

  it("does not throw when both attempts fail; logs warning", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));
    const log = { warn: vi.fn() };
    await expect(safeEdit(bot, 1, 50, "anything", log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const warnCall = log.warn.mock.calls[0]!;
    expect(warnCall[0]).toMatchObject({
      chatId: 1,
      messageId: 50,
      textLength: "anything".length,
    });
  });

  it("works without a logger (silent failure)", async () => {
    const bot = makeBot();
    bot.editMessageText
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"));
    await expect(safeEdit(bot, 1, 50, "anything")).resolves.toBeUndefined();
  });
});

describe("safeSend", () => {
  it("calls sendMessage once with MarkdownV2 on success", async () => {
    const bot = makeBot();
    const result = await safeSend(bot, 1, "hello");
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage.mock.calls[0]).toEqual([1, "hello", { parse_mode: "MarkdownV2" }]);
    expect(result).toEqual({ message_id: 999 });
  });

  it("retries with plain text when MarkdownV2 fails", async () => {
    const bot = makeBot();
    bot.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce({ message_id: 1234 });
    const result = await safeSend(bot, 1, "broken \\(markdown");
    expect(bot.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.sendMessage.mock.calls[1]).toEqual([1, "broken (markdown", {}]);
    expect(result).toEqual({ message_id: 1234 });
  });

  it("returns null and logs warning when both attempts fail", async () => {
    const bot = makeBot();
    bot.sendMessage
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"));
    const log = { warn: vi.fn() };
    const result = await safeSend(bot, 1, "anything", log);
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/safe-telegram.test.ts`

Expected: FAIL with "Failed to load url ../src/safe-telegram.js. Does the file exist?"

- [ ] **Step 3: Create `safe-telegram.ts`**

Create `tg-bridge/src/safe-telegram.ts`:

```typescript
import type { Logger } from "pino";

type SafeLogger = Partial<Pick<Logger, "warn">>;

/** Bot surface used by safeEdit. Matches grammy's bot.api.editMessageText shape loosely. */
export interface SafeEditBot {
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: { parse_mode?: "MarkdownV2" },
  ): Promise<unknown>;
}

/** Bot surface used by safeSend. */
export interface SafeSendBot {
  sendMessage(
    chatId: number,
    text: string,
    opts: { parse_mode?: "MarkdownV2" },
  ): Promise<{ message_id: number }>;
}

/**
 * Undo MarkdownV2 escaping by removing backslashes that precede ASCII
 * reserved characters. This is the round-trip inverse of escapeMarkdownV2
 * for content WE escaped. For arbitrary input it removes any "\\X" → "X"
 * substitution, which is fine for our fallback-to-plain-text use case
 * (we want readable text, not perfect inverse).
 */
export function stripMarkdownV2Escapes(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

/**
 * Edit a Telegram message with MarkdownV2; on parse failure, retry once
 * as plain text with escapes stripped. Never throws — on persistent
 * failure, logs a warning (if logger provided) and returns.
 */
export async function safeEdit(
  bot: SafeEditBot,
  chatId: number,
  messageId: number,
  text: string,
  log?: SafeLogger,
): Promise<void> {
  try {
    await bot.editMessageText(chatId, messageId, text, { parse_mode: "MarkdownV2" });
    return;
  } catch (markdownErr) {
    try {
      const plain = stripMarkdownV2Escapes(text);
      await bot.editMessageText(chatId, messageId, plain, {});
      return;
    } catch (plainErr) {
      log?.warn?.(
        {
          chatId,
          messageId,
          textLength: text.length,
          markdownErr,
          plainErr,
        },
        "safeEdit failed in both MarkdownV2 and plain-text mode",
      );
      return;
    }
  }
}

/**
 * Send a Telegram message with MarkdownV2; on parse failure, retry once
 * as plain text. Never throws — on persistent failure, logs a warning
 * and returns null.
 */
export async function safeSend(
  bot: SafeSendBot,
  chatId: number,
  text: string,
  log?: SafeLogger,
): Promise<{ message_id: number } | null> {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  } catch (markdownErr) {
    try {
      const plain = stripMarkdownV2Escapes(text);
      return await bot.sendMessage(chatId, plain, {});
    } catch (plainErr) {
      log?.warn?.(
        {
          chatId,
          textLength: text.length,
          markdownErr,
          plainErr,
        },
        "safeSend failed in both MarkdownV2 and plain-text mode",
      );
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd tg-bridge && npx vitest run tests/safe-telegram.test.ts`

Expected: 11 new tests pass (4 strip + 4 safeEdit + 3 safeSend).

Then run the whole suite to confirm nothing else broke:

`cd tg-bridge && npx vitest run`

Total: 162 + 11 = 173.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/safe-telegram.ts tg-bridge/tests/safe-telegram.test.ts
git commit -m "Add safeEdit/safeSend with MarkdownV2 -> plain text fallback

Wraps Telegram edit/send calls with a two-attempt strategy: try
MarkdownV2 first, fall back to plain text (escapes stripped) on parse
failure, log a warning and return on persistent failure. Never throws.

This prevents the unhandled-rejection class of bug where a single
malformed render crashes the bridge process and Docker restarts the
container, losing in-flight session state."
```

---

## Task 5: Switch `Turn.editNow` to use `renderStreamingView` + `safeEdit`

**Files:**
- Modify: `tg-bridge/src/turn.ts`
- Modify: `tg-bridge/tests/turn.test.ts`

**Goal:** During streaming, the placeholder updates use the new compact view via the safe wrapper. Old `renderParts` still exists in format.ts (used by the OLD finalize until Task 6).

- [ ] **Step 1: Update the failing tests in `turn.test.ts`**

The existing turn.test.ts asserts the old render output (e.g. `bot.calls.edits[0]![2]).toBe("hello")`). With the new streaming view, text parts are HIDDEN during streaming and only `_thinking…_` shows. Update the assertions:

Edit `tg-bridge/tests/turn.test.ts`. Replace the test "edits the placeholder once after throttle window when a part arrives":

```typescript
  it("edits the placeholder once after throttle window when a part arrives", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "hello" });
    expect(bot.calls.edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.calls.edits).toHaveLength(1);
    // Text parts are hidden during streaming; only the thinking marker shows.
    expect(bot.calls.edits[0]![2]).toBe("_thinking…_");
  });
```

Replace the test "absorbs rapid updates into a single edit per throttle window":

```typescript
  it("absorbs rapid updates into a single edit per throttle window", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "running", input: { filePath: "a.py" } },
    });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "a.py" }, output: "ignored" },
    });
    await vi.advanceTimersByTimeAsync(100);
    turn.appendPart({
      id: "t2",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "pwd" } },
    });
    await vi.advanceTimersByTimeAsync(800);
    // After throttle window completes, exactly one edit reflecting the latest state.
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe(
      "📄 read `a\\.py`\n⚡ bash `pwd`\n_thinking…_",
    );
  });
```

Add a new test for safeEdit fallback behavior at the bottom of the `describe("Turn", ...)` block (before the closing `});`):

```typescript
  it("editNow does not crash the process when Telegram rejects the edit", async () => {
    const bot = makeBot();
    // Make every editMessageText call throw.
    bot.editMessageText = vi.fn(async () => {
      throw new Error("can't parse entities");
    });
    // sendMessage is a no-op for this test (not used by editNow).
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "pwd" } },
    });
    // Advance past the throttle to trigger editNow.
    await vi.advanceTimersByTimeAsync(1000);
    // safeEdit retries with plain text (also throws here), then logs and returns.
    // No unhandled rejection; the test reaches this assertion.
    expect(bot.editMessageText).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to confirm the OLD assertions fail**

Run: `cd tg-bridge && npx vitest run tests/turn.test.ts`

Expected: the two updated tests FAIL (their new assertions don't match the still-old-renderer output). Other turn tests may also fail because `finalize` (still using `renderParts`) returns different shapes for tool-only inputs — that's OK; Task 6 fixes finalize. The new fallback test FAILS because `editNow` currently propagates errors.

- [ ] **Step 3: Modify `tg-bridge/src/turn.ts`**

Edit the imports at the top:

```typescript
import { renderStreamingView, renderFinalView, escapeMarkdownV2 } from "./format.js";
import { chunkForTelegram } from "./chunker.js";
import { safeEdit, safeSend } from "./safe-telegram.js";
```

(Remove `renderParts` and `RenderablePart` from the import — they're no longer needed since `renderCurrent` is going away in this task.)

Replace the `editNow` method body:

```typescript
  private async editNow(): Promise<void> {
    if (this.finalized) return;
    const text = renderStreamingView(this.partsArray());
    if (text.length === 0) return;
    const [first] = chunkForTelegram(text);
    if (!first) return;
    try {
      await safeEdit(this.bot, this.chatId, this.placeholderMessageId, first);
    } finally {
      this.inFlightEdit = null;
    }
  }
```

Add a new private helper `partsArray()` and remove `renderCurrent()`:

```typescript
  /** Return parts in arrival order as an array (for renderers that need a sequence). */
  private partsArray(): IncomingPart[] {
    const result: IncomingPart[] = [];
    for (const id of this.partOrder) {
      const p = this.parts.get(id);
      if (p) result.push(p);
    }
    return result;
  }
```

Delete the entire `renderCurrent()` method (lines 136-158 of the original).

NOTE: `partsArray()` returns `IncomingPart[]`, which structurally matches `RenderablePart` (both have `type: string` plus optional fields). The `renderStreamingView` parameter type is `readonly RenderablePart[]`. TypeScript with `exactOptionalPropertyTypes` may complain about the conversion. If so, cast at the call site:

```typescript
const text = renderStreamingView(this.partsArray() as unknown as readonly RenderablePart[]);
```

Add `import type { RenderablePart } from "./format.js";` at the top if needed (only if the cast is necessary). If TypeScript accepts the conversion without a cast, omit the type-only import.

- [ ] **Step 4: Run tests to confirm the new editNow tests pass**

Run: `cd tg-bridge && npx vitest run tests/turn.test.ts`

Expected: the two updated tests pass; the new fallback test passes. The `finalize` tests (still using old renderer through unchanged finalize body) still produce different shapes — they'll fail and be fixed in Task 6. So this step's expected outcome is:

- "does not edit before any part arrives" ✓
- "edits the placeholder once after throttle window when a part arrives" ✓
- "absorbs rapid updates into a single edit per throttle window" ✓
- "finalize edits placeholder with the final render and clears any pending timer" ✗ (Task 6 fixes)
- "finalize splits long output: edits placeholder with first chunk, sends remaining as new messages" ✗ (Task 6)
- "finalize with no parts edits placeholder with a 'no response' marker" ✗ (Task 6)
- "showError edits placeholder with the error text and prevents further edits" ✓ (showError still uses escapeMarkdownV2 + bot.editMessageText directly — unchanged in this task)
- "ignores appendPart after finalize" ✓
- "editNow does not crash the process when Telegram rejects the edit" ✓ (new test passes)

If finalize tests fail in unexpected ways (compile errors, not just assertion failures), check the imports — `renderParts` and `RenderablePart` should be removed but `finalize` still calls them in this task. Wait — re-read finalize body:

```typescript
async finalize(): Promise<void> {
  ...
  const text = this.renderCurrent();
  ...
}
```

`finalize` calls `this.renderCurrent()` which we just deleted. So finalize won't compile. Fix: temporarily restore a thin `renderCurrent()` that returns `renderStreamingView(this.partsArray())` until Task 6:

```typescript
  /** Temporary: keeps finalize() compiling until Task 6 swaps in renderFinalView. */
  private renderCurrent(): string {
    return renderStreamingView(this.partsArray() as unknown as readonly RenderablePart[]);
  }
```

This produces nonsensical finalize output (streaming view with thinking marker as the "final" message), which is fine for the duration of this commit — Task 6 will fix it. The point of Task 5 is that editNow works correctly; finalize is broken-but-compilable-and-doesn't-crash for one commit.

Re-run tests:

`cd tg-bridge && npx vitest run tests/turn.test.ts`

Expected outcomes after the temporary `renderCurrent`:

- editNow tests: ✓
- "finalize edits placeholder with the final render": ✗ (asserts text = "first" but now produces streaming view)
- "finalize splits long output": ✗ (similar)
- "finalize with no parts": this checks `match(/no response/i)` and the streaming view returns "_thinking…_" — doesn't match. ✗
- "showError": ✓ (unchanged)
- "ignores appendPart after finalize": ✓ (just checks edit count, doesn't read content)
- "editNow does not crash": ✓

Three finalize tests are expected to fail in this commit. Document the regression in the commit message as expected and to-be-fixed-in-Task-6.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/turn.ts tg-bridge/tests/turn.test.ts
git commit -m "Switch Turn.editNow to renderStreamingView via safeEdit

Streaming view now hides text parts entirely (showing only tool calls
and a thinking marker) and uses inline-code only — no fenced blocks.
All bot.editMessageText calls during streaming go through safeEdit so
parse failures fall back to plain text and never throw.

Three finalize tests are temporarily failing (they assert old-renderer
output shapes); Task 6 swaps finalize to renderFinalView and re-greens
them with the new assertions."
```

---

## Task 6: Switch `Turn.finalize` to use `renderFinalView` + `safeEdit`/`safeSend`

**Files:**
- Modify: `tg-bridge/src/turn.ts`
- Modify: `tg-bridge/tests/turn.test.ts`

**Goal:** Final view replaces the placeholder with the assistant's text + summary header. All Telegram calls go through safeEdit/safeSend.

- [ ] **Step 1: Update the failing finalize tests in `turn.test.ts`**

Replace the test "finalize edits placeholder with the final render and clears any pending timer":

```typescript
  it("finalize edits placeholder with the final render and clears any pending timer", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "first" });
    await turn.finalize();
    // The pending timer would have fired at +1000ms; finalize ran immediately.
    expect(bot.calls.edits).toHaveLength(1);
    // No tools used → final view is just the escaped text.
    expect(bot.calls.edits[0]![2]).toBe("first");
    // No follow-up edits after finalize
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.sends).toHaveLength(0);
  });
```

Replace the test "finalize splits long output: edits placeholder with first chunk, sends remaining as new messages":

```typescript
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
      (bot.calls.edits[0]![2] as string) +
      bot.calls.sends.map((c) => c[1] as string).join("");
    expect(allText).toContain(para1);
    expect(allText).toContain(para2);
    expect(allText).toContain(para3);
  });
```

Replace the test "finalize with no parts edits placeholder with a 'no response' marker":

```typescript
  it("finalize with no parts edits placeholder with a 'no response' marker", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe("_\\(no response\\)_");
  });
```

Add a new test for the tool-summary case:

```typescript
  it("finalize includes a tool summary header when tools were used", async () => {
    const bot = makeBot();
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({
      id: "t1",
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "pwd" } },
    });
    turn.appendPart({ id: "p1", type: "text", text: "Working dir is /workspace." });
    await turn.finalize();
    expect(bot.calls.edits).toHaveLength(1);
    expect(bot.calls.edits[0]![2]).toBe(
      "_used 1 tool · 1 bash_\n\nWorking dir is /workspace\\.",
    );
  });
```

Add a new test for finalize-survives-Telegram-error:

```typescript
  it("finalize does not crash the process when Telegram rejects the edit", async () => {
    const bot = makeBot();
    bot.editMessageText = vi.fn(async () => {
      throw new Error("can't parse entities");
    });
    const turn = new Turn(bot, 1, 50, { throttleMs: 1000 });
    turn.appendPart({ id: "p1", type: "text", text: "anything" });
    await expect(turn.finalize()).resolves.toBeUndefined();
    expect(bot.editMessageText).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to confirm the new finalize tests fail**

Run: `cd tg-bridge && npx vitest run tests/turn.test.ts`

Expected: 4 finalize tests + 1 new no-crash test fail (because finalize still uses the temporary `renderCurrent`).

- [ ] **Step 3: Modify `tg-bridge/src/turn.ts`**

Replace the entire `finalize()` method body and remove the temporary `renderCurrent()`:

```typescript
  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    if (this.inFlightEdit) await this.inFlightEdit.catch(() => undefined);

    const text = renderFinalView(this.partsArray() as unknown as readonly RenderablePart[]);
    const chunks = chunkForTelegram(text);
    const first = chunks[0];
    if (!first) return; // Should never happen; renderFinalView always returns at least "_(no response)_".

    await safeEdit(this.bot, this.chatId, this.placeholderMessageId, first);
    for (const chunk of chunks.slice(1)) {
      await safeSend(this.bot, this.chatId, chunk);
    }
  }
```

Delete the temporary `renderCurrent()` method added in Task 5.

If `RenderablePart` is no longer imported elsewhere in turn.ts, you can remove the import — but if `partsArray()` returns it (cast at call sites), keep the import as `import type { RenderablePart } from "./format.js"`.

- [ ] **Step 4: Run tests**

Run: `cd tg-bridge && npx vitest run tests/turn.test.ts`

Expected: ALL turn tests pass — original 8 + 1 new from Task 5 (editNow no-crash) + 1 new in this task (finalize no-crash) + 1 new tool-summary test = 11 tests total.

Then full suite:

`cd tg-bridge && npx vitest run`

Expected: 173 (after Task 4) + 2 new turn tests = 175. Subtract any old turn tests that were dropped — confirm by recounting all `it(...)` blocks in turn.test.ts.

- [ ] **Step 5: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add tg-bridge/src/turn.ts tg-bridge/tests/turn.test.ts
git commit -m "Switch Turn.finalize to renderFinalView via safeEdit/safeSend

Final reply now shows muted summary header + concatenated assistant
text. Both editMessageText (for chunk 1) and sendMessage (for chunks
2+) routed through safe wrappers — no unhandled rejection class of
crash possible from this path.

All turn tests green; finalize regression from Task 5 fixed."
```

---

## Task 7: Defensive `try/catch` in `message-handler.ts`

**Files:**
- Modify: `tg-bridge/src/message-handler.ts`
- Modify: `tg-bridge/tests/message-handler.test.ts` (only if existing tests need updating)

**Goal:** Belt-and-suspenders. Even though `Turn.finalize()` and `Turn.showError()` now use safeEdit/safeSend internally, the `onIdle()`/`onError()` handlers should still wrap them in try/catch so future changes that introduce throws can't crash the process via the fire-and-forget dispatch from EventRouter.

- [ ] **Step 1: Read existing message-handler.test.ts**

Run: `cd tg-bridge && cat tests/message-handler.test.ts | head -80`

Verify the test file structure. Note the patterns used (vi.fn, fake bot, etc.).

- [ ] **Step 2: Write the failing test**

Append a new test to `tg-bridge/tests/message-handler.test.ts` inside the existing `describe("handleTextMessage", ...)` block:

```typescript
  it("survives a finalize() rejection without throwing", async () => {
    // Build a deps where Turn's finalize rejects (e.g. by making bot reject everything).
    // We can't easily inject a Turn that rejects, but we can drive it via the
    // SessionEventHandler interface: capture the handler passed to
    // router.registerSession, then invoke onIdle() and verify no rejection bubbles.

    const sentPlaceholder = { message_id: 999 };
    const ctx = makeFakeCtx({
      message: { text: "hello", chat: { id: 1 }, from: { id: 100 } },
      reply: vi.fn(async () => sentPlaceholder),
    });

    const failingBot = {
      editMessageText: vi.fn(async () => {
        throw new Error("telegram down");
      }),
      sendMessage: vi.fn(async () => {
        throw new Error("telegram down");
      }),
    };

    let capturedHandler: SessionEventHandler | undefined;
    const router = {
      registerSession: vi.fn((_sid, handler) => {
        capturedHandler = handler;
        return () => undefined;
      }),
    };

    const deps: MessageHandlerDeps = {
      state: makeFakeState({ projectPath: "/workspace/x", sessionId: "ses_42" }),
      client: makeFakeClient(),
      router: router as never,
      permissions: { sendRequest: vi.fn() },
      bot: failingBot,
      defaultModel: "anthropic/claude-sonnet-4-5",
    };

    await handleTextMessage(ctx as never, deps);

    // onIdle is dispatched fire-and-forget by EventRouter; we invoke it here
    // and confirm no rejection escapes.
    expect(capturedHandler).toBeDefined();
    await expect(
      Promise.resolve(capturedHandler!.onIdle()),
    ).resolves.toBeUndefined();
  });
```

(The exact helper imports — `makeFakeCtx`, `makeFakeState`, `makeFakeClient` — match whatever the existing message-handler.test.ts uses. If those helpers don't exist, replace with inline `vi.fn`-based fakes following the style of the existing tests in the file.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tg-bridge && npx vitest run tests/message-handler.test.ts`

Expected: the new test fails with an unhandled rejection (because `await turn.finalize()` inside `onIdle` will throw — wait, no, with safeEdit in place from Task 6, finalize doesn't throw. So this test passes already!) — verify by running.

If the test passes already (because Task 6's safeEdit prevents the throw), this means the defensive wrapper is not strictly needed. But add it anyway as defense in depth: ANY future change to finalize that doesn't go through safeEdit (e.g. a direct bot call, a new feature) would re-introduce the crash class. Skip Steps 4-6 if test already green; otherwise:

- [ ] **Step 4: Modify `tg-bridge/src/message-handler.ts`**

Replace the `onIdle` handler:

```typescript
    async onIdle() {
      try {
        await turn.finalize();
      } catch (err) {
        deps.log?.error?.(
          { chatId, sessionId, err: describeError(err) },
          "turn.finalize threw despite safeEdit/safeSend wrappers",
        );
      }
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
```

Replace the `onError` handler:

```typescript
    async onError(err) {
      const msg = describeError(err);
      try {
        await turn.showError(msg);
      } catch (showErr) {
        deps.log?.error?.(
          { chatId, sessionId, err: describeError(showErr) },
          "turn.showError threw",
        );
      }
      if (!unregistered) {
        unregistered = true;
        unregister();
      }
    },
```

Note: `Turn.showError` does NOT yet use safeEdit (it was untouched in Tasks 5 and 6). For full safety, also update `Turn.showError` to use safeEdit. Add this to the same task:

Modify `tg-bridge/src/turn.ts` `showError`:

```typescript
  async showError(error: string): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.cancelTimer();
    await safeEdit(
      this.bot,
      this.chatId,
      this.placeholderMessageId,
      `❌ ${escapeMarkdownV2(error)}`,
    );
  }
```

- [ ] **Step 5: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all tests pass; the new message-handler test passes.

- [ ] **Step 6: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add tg-bridge/src/message-handler.ts tg-bridge/src/turn.ts tg-bridge/tests/message-handler.test.ts
git commit -m "Defensive try/catch in onIdle/onError + safeEdit in showError

Belt-and-suspenders: turn.finalize and turn.showError now use safeEdit
internally and shouldn't throw, but the EventRouter dispatch is
fire-and-forget so any future change that re-introduces a throw would
crash the process via unhandled rejection. Wrap both calls in try/catch
that logs and continues.

Also routes Turn.showError through safeEdit (Tasks 5/6 missed it)."
```

---

## Task 8: Remove dead code from `format.ts`

**Files:**
- Modify: `tg-bridge/src/format.ts`
- Modify: `tg-bridge/tests/format.test.ts`

**Goal:** Remove the now-unused `renderParts`, `renderTextPart`, `renderToolPart` functions and the related tests. `RenderablePart`, `ToolState`, `summarizeToolInput`, `escapeMarkdownV2`, `escapeCode` stay (used by the new code).

- [ ] **Step 1: Verify no consumers remain**

Run:

```bash
cd tg-bridge && grep -rn "renderParts\|renderTextPart\|renderToolPart" src/ tests/
```

Expected output: matches only in `format.ts` (declarations) and `format.test.ts` (the old `describe("renderParts", ...)` block + import line).

If any other file matches, that file needs updating before deletion can proceed.

- [ ] **Step 2: Update tests file — remove the old describe block**

Edit `tg-bridge/tests/format.test.ts`. Remove the entire `describe("renderParts", ...)` block (lines 16-119 of the original — now shifted by added tests). Also update the import line at the top to drop `renderParts`:

Change:
```typescript
import { renderParts, escapeMarkdownV2, type RenderablePart } from "../src/format.js";
```

To:
```typescript
import { escapeMarkdownV2, type RenderablePart } from "../src/format.js";
```

(Other imports added in Tasks 1-3 stay.)

- [ ] **Step 3: Run tests to confirm they still pass after removing the old describe**

Run: `cd tg-bridge && npx vitest run tests/format.test.ts`

Expected: all remaining format tests pass. Test count drops by 9 (the removed describe block had 9 it() cases).

- [ ] **Step 4: Remove the dead exports from `format.ts`**

Edit `tg-bridge/src/format.ts`. Delete:

- `function renderTextPart(text: string): string` (3 lines)
- `function renderToolPart(tool: string, state: ToolState): string` (~26 lines)
- `export function renderParts(parts: readonly RenderablePart[]): string` (~17 lines)
- The `TOOL_RESULT_LINE_LIMIT` and `TRUNCATION_NOTICE` constants (no longer used)
- The `escapeCode` function and `CODE_RESERVED_RE` constant (used only by `renderToolPart`, also dead now)

Verify by re-reading the file: only `escapeMarkdownV2`, `RESERVED_RE`, `RenderablePart`, `ToolState`, `summarizeToolInput`, `toolEmoji`, `renderToolLine`, `renderStreamingView`, `renderToolSummary`, `concatenateTextParts`, `renderFinalView`, plus shared constants (`TOOL_EMOJI`, `STREAMING_VIEW_CAP`, `THINKING_MARKER`) should remain.

- [ ] **Step 5: Run all tests**

Run: `cd tg-bridge && npx vitest run`

Expected: all tests pass. Total: 175 - 9 (removed renderParts tests) = 166 tests passing.

- [ ] **Step 6: Run typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0. (If TypeScript complains about unused imports of `escapeCode` or `CODE_RESERVED_RE` from elsewhere, that's a sign something is still reaching for them — should not happen since Step 1 verified no external consumers.)

- [ ] **Step 7: Commit**

```bash
git add tg-bridge/src/format.ts tg-bridge/tests/format.test.ts
git commit -m "Remove dead renderParts/renderTextPart/renderToolPart

These were the old segment-joining renderer that produced unbalanced
MarkdownV2 fences. Their tests assert the old behavior and are no
longer applicable. Replaced by renderStreamingView + renderFinalView
across the previous tasks.

Also drops escapeCode and TOOL_RESULT_LINE_LIMIT (only used by the
removed code)."
```

---

## Task 9: Build, full-suite test, deploy, smoke verify

**Files:** None modified. Final integration check.

- [ ] **Step 1: Final clean build**

Run: `cd tg-bridge && npm run build`

Expected: exit 0; produces `dist/` output.

- [ ] **Step 2: Full test suite**

Run: `cd tg-bridge && npx vitest run`

Expected: all tests pass. Capture the count.

- [ ] **Step 3: Typecheck**

Run: `cd tg-bridge && npm run typecheck`

Expected: exit 0 (both `tsc --noEmit` and `tsc -p tsconfig.test.json`).

- [ ] **Step 4: Inspect git log**

Run: `git log --oneline -10`

Expected: 8 new commits on top of `2291ed3` (the previous main HEAD), one per Task 1-8.

- [ ] **Step 5: Push to origin**

Run: `git push origin main`

Expected: success. Captures the 8 commits.

- [ ] **Step 6: Deploy to Unraid**

Run:

```bash
ssh root@192.168.86.81 'cd /mnt/user/appdata/opencode/repo && git pull && docker compose -f deploy/compose.yaml build tg-bridge && docker compose -f deploy/compose.yaml up -d tg-bridge'
```

Expected: `git pull` shows the 8 new commits fast-forwarded; `docker compose build` succeeds; `docker compose up -d` recreates the tg-bridge container.

- [ ] **Step 7: Verify container is healthy**

Run:

```bash
ssh root@192.168.86.81 'docker ps --filter name=tg-bridge --format "{{.Status}}"'
```

Expected: `Up X seconds (healthy)` or just `Up X seconds`. NOT `Restarting`.

- [ ] **Step 8: Tail logs for clean startup**

Run:

```bash
ssh root@192.168.86.81 'docker logs tg-bridge --tail=30'
```

Expected: log lines `"msg":"seeding event subscriptions"`, `"msg":"opencode event subscription opening"`, `"msg":"starting"`. NO error lines about parse entities, NO Node crash trace.

- [ ] **Step 9: Manual end-to-end smoke test (USER action)**

This step is performed by the user via Telegram. Verification:

1. Send `What's in this project?` to a switched-to project. Expected:
   - Placeholder shows `_thinking…_` first
   - Then a tool line per file read appended below the previous: `📄 read \`...\``
   - Then more tool lines as agent works
   - When idle: placeholder swaps to `_used N tools · M read · ..._\n\n<answer text>`

2. Send `pwd` (small, single tool). Expected:
   - One tool line `⚡ bash \`pwd\`` then `_thinking…_`
   - Final: `_used 1 tool · 1 bash_\n\n<answer>`

3. Send `Hi` (no tools). Expected:
   - Just `_thinking…_` for a moment
   - Final: just the assistant's greeting text, no header

4. Verify `docker ps` uptime is unchanged after the test runs (container did not restart).

- [ ] **Step 10: Commit if any issues surfaced and were fixed during smoke test**

If smoke test surfaces a regression, fix it as a new commit. Otherwise no further action.

- [ ] **Step 11: Final verification log**

Run:

```bash
ssh root@192.168.86.81 'docker logs tg-bridge --since=10m | grep -iE "error|parse|crash" | head -20'
```

Expected: empty output, OR only benign warnings (e.g. `safeEdit failed in both MarkdownV2 and plain-text mode` — which would indicate a renderer bug worth investigating, but does NOT crash the process).

---

## Self-Review

### Spec coverage

- ✅ Streaming view (Task 2)
- ✅ Final view with summary header + concatenated text (Tasks 3)
- ✅ Edge case: 0 tools, empty text → "(no response)" (Task 3)
- ✅ Edge case: tools, empty text → "(no response text)" (Task 3)
- ✅ Edge case: error count in summary header (Task 3)
- ✅ Edge case: streaming view cap at 30 with collapsed line (Task 2)
- ✅ Edge case: backticks in tool input replaced with single quote (Task 1)
- ✅ Edge case: text parts hidden during streaming (Task 2)
- ✅ Edge case: long final reply chunked, header on first chunk only (Task 6 — chunker preserves the header in chunk 1 because it's at the top of `text` before chunking)
- ✅ safeEdit with MarkdownV2 → plain text fallback (Task 4)
- ✅ safeSend with MarkdownV2 → plain text fallback (Task 4)
- ✅ Defensive try/catch in onIdle/onError (Task 7)
- ✅ Turn.showError uses safeEdit (Task 7)
- ✅ Manual integration verification (Task 9)

### Placeholder scan

No "TBD", "TODO", "implement later", "fill in", or vague handlers. Each step has actual code or actual test code.

### Type consistency

- `RenderablePart` type — defined in original format.ts, reused everywhere
- `ToolState` type — defined in format.ts, reused
- `IncomingPart` (in turn.ts) — local interface that structurally matches `RenderablePart`; cast is documented in Task 5 Step 3
- `SafeEditBot` / `SafeSendBot` interfaces in safe-telegram.ts — structurally compatible with grammy's bot.api shape and with `TurnBot` in turn.ts (TurnBot has both methods, so it satisfies both)
- Function names: `safeEdit`, `safeSend`, `stripMarkdownV2Escapes`, `renderStreamingView`, `renderFinalView`, `renderToolSummary`, `concatenateTextParts`, `renderToolLine`, `toolEmoji` — all consistent across tasks

### Cross-task references

- Task 5 references the helpers added in Tasks 1-2 ✓
- Task 6 references the helpers added in Task 3 ✓
- Task 6 references safeEdit/safeSend from Task 4 ✓
- Task 7 references showError on Turn (Task 6's Turn) and the defensive pattern ✓
- Task 8 verifies no consumers of renderParts remain — only safe to run after Tasks 5/6 swap the consumers ✓

### Test count tracking

| Task | Tests added | Tests removed | Cumulative total |
|---|---|---|---|
| baseline | — | — | 126 |
| Task 1 | +13 (5 emoji + 8 line) | 0 | 139 |
| Task 2 | +7 (streaming view) | 0 | 146 |
| Task 3 | +16 (6 summary + 4 concat + 6 final) | 0 | 162 |
| Task 4 | +11 (4 strip + 4 edit + 3 send) | 0 | 173 |
| Task 5 | +1 (editNow no-crash) | 0 | 174 |
| Task 6 | +2 (finalize tool-summary, finalize no-crash) | 0 | 176 |
| Task 7 | +1 (handler no-throw) | 0 | 177 |
| Task 8 | 0 | -9 (renderParts describe block) | 168 |
| **Final** | | | **168** |

If actual counts diverge by ≤3, recount tests in each task's Step 1 and adjust.
