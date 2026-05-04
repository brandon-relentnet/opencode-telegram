import { Marked, type RendererObject, type Tokens } from "marked";

/**
 * Telegram HTML mode supports a strict subset of HTML:
 *   <b> <i> <u> <s> <code> <pre> <a href> <blockquote> <span class="tg-spoiler">
 * No <ul>/<ol>/<li>, no <h1>-<h6>, no <p>, no tables.
 * We render Markdown into that subset.
 *
 * marked v14 renderer overrides receive token objects and have access to
 * `this.parser.parseInline(tokens)` for rendering children. Block-level
 * overrides return their final string. Returning the empty string from
 * non-text nodes (image/html/table) drops them safely.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const renderer: RendererObject = {
  paragraph({ tokens }: Tokens.Paragraph): string {
    return this.parser.parseInline(tokens) + "\n\n";
  },
  heading({ tokens }: Tokens.Heading): string {
    return `<b>${this.parser.parseInline(tokens)}</b>\n`;
  },
  strong({ tokens }: Tokens.Strong): string {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  },
  em({ tokens }: Tokens.Em): string {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  },
  del({ tokens }: Tokens.Del): string {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  },
  codespan({ text }: Tokens.Codespan): string {
    // marked already escapes &, <, > inside code via &amp;/&lt;/&gt; entities
    // when escaped:true. text here is the raw source content; escape it
    // ourselves to be sure (handles backticks like `` ` `` correctly).
    return `<code>${escapeHtml(text)}</code>`;
  },
  code({ text, lang }: Tokens.Code): string {
    const cls = lang ? ` class="language-${lang.replace(/"/g, "")}"` : "";
    return `<pre><code${cls}>${escapeHtml(text)}\n</code></pre>`;
  },
  link({ href, tokens }: Tokens.Link): string {
    const safeHref = href.replace(/"/g, "&quot;");
    return `<a href="${safeHref}">${this.parser.parseInline(tokens)}</a>`;
  },
  blockquote({ tokens }: Tokens.Blockquote): string {
    // tokens are block-level inside a blockquote; parse them then strip
    // trailing whitespace so the wrapping tag hugs the content.
    const inner = this.parser.parse(tokens).trim();
    return `<blockquote>${inner}</blockquote>`;
  },
  list(token: Tokens.List): string {
    const ordered = token.ordered;
    const items = token.items;
    const lines: string[] = [];
    let n = (typeof token.start === "number" ? token.start : 1) - 1;
    for (const item of items) {
      // Each list item's tokens are typically a single paragraph wrapping
      // the inline content. Parse them, then strip the trailing paragraph
      // newlines we add so list items render as single lines.
      const rendered = this.parser.parse(item.tokens).trimEnd();
      // Strip leading bullet markers that nested lists or item children
      // might have already added.
      const cleaned = rendered.replace(/^[-•]\s*/, "");
      if (ordered) {
        n++;
        lines.push(`${n}. ${cleaned}`);
      } else {
        lines.push(cleaned.startsWith("•") ? cleaned : `• ${cleaned}`);
      }
    }
    return lines.join("\n") + "\n";
  },
  listitem(item: Tokens.ListItem): string {
    return this.parser.parse(item.tokens);
  },
  br(): string {
    return "\n";
  },
  hr(): string {
    return "\n———\n";
  },
  // No <table>, <image>, raw HTML support — drop them.
  table(): string {
    return "";
  },
  image(): string {
    return "";
  },
  html(): string {
    return "";
  },
  text(token: Tokens.Text | Tokens.Escape | Tokens.Tag): string {
    // marked v14 already escapes &, <, > in text tokens that came from
    // plain markdown text; passing through verbatim keeps `&amp;` from
    // becoming `&amp;amp;`. Tag tokens (inline HTML) carry raw markup —
    // route them through the html() override (which returns ""). The
    // type union here covers all three cases via shared `text` field.
    if (token.type === "html") return "";
    return token.text;
  },
};

const marked = new Marked({
  renderer,
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
