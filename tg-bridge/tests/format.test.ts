import { describe, it, expect } from "vitest";
import {
  escapeMarkdownV2,
  toolEmoji,
  renderToolLine,
  renderStreamingView,
  renderTransparentView,
  formatDuration,
  buildCancelKeyboard,
  renderPinnedStatus,
  renderStreamingHeader,
  type RenderablePart,
  type PinnedStatusState,
  type StreamingHeaderState,
} from "../src/format.js";

describe("escapeMarkdownV2", () => {
  it("escapes all reserved characters", () => {
    expect(escapeMarkdownV2("a_b*c[d](e)f~g`h>i#j+k-l=m|n{o}p.q!r")).toBe(
      "a\\_b\\*c\\[d\\]\\(e\\)f\\~g\\`h\\>i\\#j\\+k\\-l\\=m\\|n\\{o\\}p\\.q\\!r",
    );
  });

  it("leaves plain ASCII letters and digits untouched", () => {
    expect(escapeMarkdownV2("hello world 123")).toBe("hello world 123");
  });
});

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
    // The `.` in the filename is a MarkdownV2-reserved character; renderToolLine
    // escapes it inside the code span. Telegram unescapes \X for any X inside
    // code spans, so this displays as "src/auth.ts" to the user.
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

  it("renders an errored tool with a red X prefix and a · failed suffix", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "bash",
        state: { status: "error", input: { command: "missing" }, error: "command not found" },
      }),
    ).toBe("❌ bash `missing` · failed");
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
    // The JSON braces are MarkdownV2-reserved; escapeMarkdownV2 escapes them
    // inside the code span. Telegram strips the backslashes when rendering.
    expect(
      renderToolLine({
        type: "tool",
        tool: "custom",
        state: { status: "running", input: { foo: 42, bar: true } },
      }),
    ).toBe("🔧 custom `\\{\"foo\":42,\"bar\":true\\}`");
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

  it("renders just the tool name when input is an empty object", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "custom",
        state: { status: "running", input: {} },
      }),
    ).toBe("🔧 custom");
  });

  it("returns empty string for non-tool parts", () => {
    expect(renderToolLine({ type: "text", text: "hi" })).toBe("");
  });

  it("escapes backslashes inside the code span", () => {
    expect(
      renderToolLine({
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "echo foo\\bar" } },
      }),
    ).toBe("⚡ bash `echo foo\\\\bar`");
  });
});

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
    // First retained tool line should be file5.py (indices 5..34 retained).
    // The `.` is escaped inside the code span — see renderToolLine doc.
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
    expect(out).toBe("❌ bash `bad` · failed\n_thinking…_");
  });
});

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

describe("renderFinalView (HTML output)", () => {
  it("returns '<i>(no response)</i>' for empty parts", () => {
    expect(renderFinalView([])).toBe("<i>(no response)</i>");
  });

  it("returns just text when no tools used", () => {
    expect(
      renderFinalView([{ type: "text", text: "The answer is 42." }]),
    ).toBe("The answer is 42.");
  });

  it("returns header + body when tools were used", () => {
    expect(
      renderFinalView([
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" } } },
        { type: "text", text: "Working dir is /workspace." },
      ]),
    ).toBe("<i>used 1 tool · 1 bash</i>\n\nWorking dir is /workspace.");
  });

  it("returns header + '<i>(no response text)</i>' when tools used but no text", () => {
    expect(
      renderFinalView([
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" } } },
      ]),
    ).toBe("<i>used 1 tool · 1 bash</i>\n\n<i>(no response text)</i>");
  });

  it("includes error count in summary header", () => {
    expect(
      renderFinalView([
        { type: "tool", tool: "bash", state: { status: "error", input: { command: "bad" } } },
        { type: "text", text: "Failed to run command." },
      ]),
    ).toBe(
      "<i>used 1 tool · 1 bash · 1 error</i>\n\nFailed to run command.",
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
      "<i>used 1 tool · 1 read</i>\n\nLet me check the project structure.\n\nIt&#39;s a FastAPI app.",
    );
  });

  it("renders CommonMark bold/code in text parts as HTML", () => {
    expect(
      renderFinalView([
        { type: "text", text: "Use **bold** and `code`." },
      ]),
    ).toBe("Use <b>bold</b> and <code>code</code>.");
  });

  it("renders fenced code with language class", () => {
    expect(
      renderFinalView([
        { type: "text", text: "```ts\nconst x = 1;\n```" },
      ]),
    ).toBe('<pre><code class="language-ts">const x = 1;\n</code></pre>');
  });
});

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
    expect(renderToolLine(part)).toBe("📄 read `src/index\\.ts` · 124 lines · 0.2s");
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

describe("renderStreamingView retry status", () => {
  it("renders rate-limit banner when retryStatus provided", () => {
    const out = renderStreamingView([], {
      retryStatus: {
        attempt: 2,
        message: "rate_limit_exceeded",
        next: 1_000_000_030_000,
        now: 1_000_000_000_000,
      },
    });
    expect(out).toBe("_⏳ rate\\_limit\\_exceeded · attempt 2 · retry in 30s_");
  });

  it("shows 'retrying now' when next is in the past", () => {
    const out = renderStreamingView([], {
      retryStatus: {
        attempt: 1,
        message: "Provider returned 429",
        next: 1_000_000_000_000,
        now: 1_000_000_001_000,
      },
    });
    expect(out).toContain("retrying now");
  });

  it("formats long retry windows in m s", () => {
    const out = renderStreamingView([], {
      retryStatus: {
        attempt: 3,
        message: "msg",
        next: 1_000_000_125_000,
        now: 1_000_000_000_000,
      },
    });
    expect(out).toContain("retry in 2m 5s");
  });

  it("truncates very long messages with ellipsis", () => {
    const long = "x".repeat(100);
    const out = renderStreamingView([], {
      retryStatus: { attempt: 1, message: long, next: 1, now: 0 },
    });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(200);
  });

  it("retry banner takes priority over elapsedSeconds", () => {
    const out = renderStreamingView([], {
      elapsedSeconds: 120,
      retryStatus: { attempt: 1, message: "msg", next: 1_000, now: 0 },
    });
    expect(out).not.toContain("thinking");
    expect(out).toContain("⏳");
  });

  it("retry banner appears below tool lines when both present", () => {
    const out = renderStreamingView(
      [
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "x.ts" } },
        },
      ],
      { retryStatus: { attempt: 1, message: "msg", next: 1_000, now: 0 } },
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("📄 read");
    expect(lines[1]).toContain("⏳");
  });
});

describe("renderStreamingView cancel button", () => {
  it("does not include button text in the rendered string (button is reply_markup only)", () => {
    // The string output is just text — no Cancel button glyph baked in.
    // The button itself is attached separately as reply_markup by the caller.
    const out = renderStreamingView([]);
    expect(out).not.toContain("Cancel");
    expect(out).not.toContain("⏹");
  });
});

describe("buildCancelKeyboard", () => {
  it("returns inline_keyboard with single Cancel button keyed by sessionId", () => {
    const kb = buildCancelKeyboard("ses_xyz");
    expect(kb).toEqual({
      inline_keyboard: [[{ text: "⏹ Cancel", callback_data: "cancel:ses_xyz" }]],
    });
  });

  it("embeds the sessionId verbatim in callback_data", () => {
    const kb = buildCancelKeyboard("ses_abc123");
    expect(kb.inline_keyboard[0]?.[0]?.callback_data).toBe("cancel:ses_abc123");
  });
});

describe("renderPinnedStatus", () => {
  const fullState: PinnedStatusState = {
    projectName: "bltft-gold",
    branch: "main",
    agentMode: "build",
    modelId: "anthropic/claude-sonnet-4-5",
    tokensUsed: 23_000,
    contextLimit: 200_000,
    costMicros: 420_000,
    coolifyFqdn: "bltft.relentnet.dev",
    lastDeployAgo: "12m ago",
    ahead: 3,
    dirty: 0,
  };

  it("renders the full 4-line layout when every field is present", () => {
    const out = renderPinnedStatus(fullState);
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("🟢 <b>bltft-gold</b> · main · build");
    expect(lines[1]).toBe("sonnet-4-5 · 23k/200k ctx · $0.42");
    expect(lines[2]).toBe(
      '✅ <a href="https://bltft.relentnet.dev">bltft.relentnet.dev</a> (12m ago)',
    );
    expect(lines[3]).toBe("🔀 3 ahead of origin");
  });

  it("omits the Coolify line when coolifyFqdn is null", () => {
    const out = renderPinnedStatus({ ...fullState, coolifyFqdn: null });
    expect(out).not.toContain("✅");
    expect(out).not.toContain("bltft.relentnet.dev");
    // Lines 1, 2, and the git line still render → 3 lines total.
    expect(out.split("\n")).toHaveLength(3);
  });

  it("renders em-dash placeholders when token / model / cost info is missing", () => {
    const out = renderPinnedStatus({
      ...fullState,
      modelId: null,
      tokensUsed: null,
      contextLimit: null,
      costMicros: null,
      coolifyFqdn: null,
      ahead: 0,
      dirty: 0,
    });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("🟢 <b>bltft-gold</b> · main · build");
    expect(lines[1]).toBe("— · —/— ctx · —");
  });

  it("renders both ahead and dirty on the git line when both > 0", () => {
    const out = renderPinnedStatus({
      ...fullState,
      coolifyFqdn: null,
      ahead: 3,
      dirty: 2,
    });
    const lines = out.split("\n");
    // line 0 + line 1 + git line (no coolify)
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("🔀 3 ahead · 2 dirty");
  });

  it("renders only the dirty count when ahead is 0 but dirty > 0", () => {
    const out = renderPinnedStatus({
      ...fullState,
      coolifyFqdn: null,
      ahead: 0,
      dirty: 5,
    });
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("🔀 5 dirty");
  });

  it("omits the git line entirely when ahead and dirty are both 0", () => {
    const out = renderPinnedStatus({
      ...fullState,
      coolifyFqdn: null,
      ahead: 0,
      dirty: 0,
    });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(out).not.toContain("🔀");
  });

  it("renders branch as em-dash when not a git repo", () => {
    const out = renderPinnedStatus({
      ...fullState,
      branch: null,
      ahead: null,
      dirty: null,
      coolifyFqdn: null,
    });
    const lines = out.split("\n");
    // No git line at all when ahead/dirty are null.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("🟢 <b>bltft-gold</b> · — · build");
  });

  it("escapes user-controlled strings (project name, branch, fqdn) as HTML", () => {
    const out = renderPinnedStatus({
      ...fullState,
      projectName: "evil<&>name",
      branch: "br<a>nch",
      coolifyFqdn: "host&.dev",
    });
    expect(out).toContain("evil&lt;&amp;&gt;name");
    expect(out).toContain("br&lt;a&gt;nch");
    expect(out).toContain("host&amp;.dev");
    expect(out).not.toContain("evil<&>name");
    expect(out).not.toContain("br<a>nch");
  });
});

describe("renderStreamingHeader", () => {
  const fullState: StreamingHeaderState = {
    modelId: "anthropic/claude-sonnet-4-5",
    agentMode: "build",
    tokensCumulative: 24_000,
    costThisTurnMicros: 40_000,
  };

  it("renders the single-line header with separator below", () => {
    const out = renderStreamingHeader(fullState);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("sonnet\\-4\\-5 · build · 24k tokens · $0\\.04 this turn");
    expect(lines[1]).toBe("─────");
  });

  it("returns empty string when no token info is available", () => {
    const out = renderStreamingHeader({
      ...fullState,
      tokensCumulative: null,
    });
    expect(out).toBe("");
  });

  it("renders em-dash for missing cost", () => {
    const out = renderStreamingHeader({
      ...fullState,
      costThisTurnMicros: null,
    });
    expect(out).toContain("24k tokens");
    expect(out).toContain("— this turn");
  });

  it("renders em-dash for missing model + agentMode", () => {
    const out = renderStreamingHeader({
      ...fullState,
      modelId: null,
      agentMode: null,
    });
    const lines = out.split("\n");
    // Still renders since tokens are present.
    expect(lines[0]).toContain("— · — · 24k tokens");
  });
});

describe("renderTransparentView", () => {
  it("renders prose + tool inline + done marker on final", () => {
    const out = renderTransparentView(
      [
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "pwd" } } },
        { type: "text", text: "Working dir is /workspace.", role: "assistant" },
      ],
      { final: true },
    );
    expect(out).toContain("bash");
    expect(out).toContain("pwd");
    expect(out).toContain("Working dir is /workspace");
    expect(out).toContain("─ done ─");
  });

  it("filters user-role text parts", () => {
    const out = renderTransparentView(
      [
        { type: "text", text: "what time is it?", role: "user" },
        { type: "text", text: "It's 3pm.", role: "assistant" },
      ],
      { final: true },
    );
    expect(out).not.toContain("what time is it");
    expect(out).toContain("3pm");
  });

  it("filters assistant text that echoes the user's prompt", () => {
    const out = renderTransparentView(
      [
        { type: "text", text: "fix the navbar mobile responsive", role: "assistant" },
        { type: "text", text: "Done — added the breakpoints.", role: "assistant" },
      ],
      { final: true, lastUserPrompt: "fix the navbar mobile responsive" },
    );
    expect(out).not.toContain("fix the navbar mobile responsive");
    expect(out).toContain("Done");
  });

  it("emits thinking placeholder while non-final", () => {
    const out = renderTransparentView([], {});
    expect(out).toContain("thinking…");
    expect(out).not.toContain("─ done ─");
  });

  it("renders reasoning parts in dimmed expandable blockquote", () => {
    const out = renderTransparentView(
      [
        { type: "reasoning", text: "I should check the tests first" },
      ],
      { final: true },
    );
    expect(out).toContain("<blockquote");
    expect(out).toContain("I should check the tests first");
  });
});
