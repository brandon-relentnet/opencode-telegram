import { describe, it, expect } from "vitest";
import {
  escapeMarkdownV2,
  toolEmoji,
  renderToolLine,
  renderStreamingView,
  type RenderablePart,
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
    expect(
      renderToolLine({
        type: "tool",
        tool: "read",
        state: { status: "pending", input: { filePath: "src/auth.ts" } },
      }),
    ).toBe("📄 read `src/auth.ts`");
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

  it("escapes backslashes inside the code span (but not other reserved chars)", () => {
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
    expect(out).toBe("📄 read `config.py`\n_thinking…_");
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
      "📄 read `a.py`\n⚡ bash `pwd`\n🔍 grep `FastAPI`\n_thinking…_",
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
    expect(lines[1]).toBe("📄 read `file5.py`");
    // Last tool line (line 30) should be file34.py
    expect(lines[30]).toBe("📄 read `file34.py`");
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
    expect(lines[0]).toBe("📄 read `f0.py`");
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
