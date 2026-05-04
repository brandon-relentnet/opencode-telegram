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
