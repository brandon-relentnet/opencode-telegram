import { describe, it, expect } from "vitest";
import { renderParts, escapeMarkdownV2, type RenderablePart } from "../src/format.js";

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
