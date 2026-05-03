import { describe, it, expect } from "vitest";
import {
  renderParts,
  escapeMarkdownV2,
  toolEmoji,
  renderToolLine,
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

describe("renderParts", () => {
  it("renders empty input as empty string", () => {
    expect(renderParts([])).toBe("");
  });

  it("escapes text parts", () => {
    const parts: RenderablePart[] = [{ type: "text", text: "hello (world)." }];
    expect(renderParts(parts)).toBe("hello \\(world\\)\\.");
  });

  it("concatenates multiple text parts with no extra separator", () => {
    const parts: RenderablePart[] = [
      { type: "text", text: "first " },
      { type: "text", text: "second" },
    ];
    expect(renderParts(parts)).toBe("first second");
  });

  it("renders a tool call as an italic note before its result", () => {
    const parts: RenderablePart[] = [
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "src/auth.ts" }, output: "file body" },
      },
    ];
    const out = renderParts(parts);
    expect(out).toContain("_called `read`");
    expect(out).toContain("src/auth\\.ts");
    expect(out).toContain("```");
    expect(out).toContain("file body");
  });

  it("truncates tool output past 50 lines and appends a notice", () => {
    const longOutput = Array.from({ length: 75 }, (_, i) => `L${i}`).join("\n");
    const parts: RenderablePart[] = [
      {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: longOutput },
      },
    ];
    const out = renderParts(parts);
    expect(out).toContain("L0");
    expect(out).toContain("L49");
    expect(out).not.toContain("L50");
    expect(out).toContain("truncated");
  });

  it("renders an errored tool with the error message visible", () => {
    const parts: RenderablePart[] = [
      {
        type: "tool",
        tool: "bash",
        state: { status: "error", input: { command: "missing-cmd" }, error: "command not found" },
      },
    ];
    const out = renderParts(parts);
    expect(out).toContain("_called `bash`");
    expect(out).toContain("❌");
    expect(out).toContain("command not found");
  });

  it("renders a pending tool call without a result block", () => {
    const parts: RenderablePart[] = [
      {
        type: "tool",
        tool: "edit",
        state: { status: "pending", input: { filePath: "x.ts" } },
      },
    ];
    const out = renderParts(parts);
    expect(out).toContain("_called `edit`");
    // no code-block result yet
    expect(out).not.toContain("```\n");
  });

  it("interleaves text and tool parts in order", () => {
    const parts: RenderablePart[] = [
      { type: "text", text: "first." },
      {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "a.ts" }, output: "x" },
      },
      { type: "text", text: "after." },
    ];
    const out = renderParts(parts);
    const idxFirst = out.indexOf("first");
    const idxTool = out.indexOf("called");
    const idxAfter = out.indexOf("after");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxTool).toBeGreaterThan(idxFirst);
    expect(idxAfter).toBeGreaterThan(idxTool);
  });

  it("ignores unknown part types", () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "reasoning", text: "internal monologue" },
    ] as RenderablePart[];
    const out = renderParts(parts);
    expect(out).toBe("hello");
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
