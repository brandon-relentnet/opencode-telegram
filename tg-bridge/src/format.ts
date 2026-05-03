/**
 * Render opencode message parts into a single Telegram MarkdownV2 string.
 *
 * Per Telegram docs (https://core.telegram.org/bots/api#markdownv2-style):
 *   Outside code blocks, escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
 *   Inside `pre` / `code`, escape only ` and \.
 */

const RESERVED_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const CODE_RESERVED_RE = /[\\`]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(RESERVED_RE, (c) => `\\${c}`);
}

function escapeCode(text: string): string {
  return text.replace(CODE_RESERVED_RE, (c) => `\\${c}`);
}

interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  error?: string;
}

export type RenderablePart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: ToolState }
  | { type: string; [k: string]: unknown }; // unknown variants ignored

const TOOL_EMOJI: Record<string, string> = {
  read: "📄",
  write: "📄",
  edit: "📄",
  grep: "🔍",
  glob: "🔍",
  bash: "⚡",
  webfetch: "🌐",
};

export function toolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] ?? "🔧";
}

/**
 * Render a tool part as a single line: "<emoji> <name> `<arg>`".
 * Used by renderStreamingView; also reusable for the live "while-running" state.
 *
 * - status "error" prefixes ❌ instead of the tool emoji.
 * - Backticks in the input are replaced with single quotes so the inline-code
 *   span remains balanced. Lossy but safe.
 * - If input has no preferred field, falls back to JSON.stringify(input) truncated to 80 chars.
 * - Empty-object input → just `<emoji> <name>` (no code span).
 * - Non-tool parts return "" — callers should pre-filter, but this guards type safety.
 */
export function renderToolLine(part: RenderablePart): string {
  if (part.type !== "tool") return "";
  // The cast is load-bearing: RenderablePart's third arm has an index signature
  // (`[k: string]: unknown`), so narrowing on `type === "tool"` does NOT make
  // `tool` and `state` typed — they remain `unknown`. The narrow type asserts
  // the runtime shape we know holds in the "tool" arm.
  const tp = part as { type: "tool"; tool: string; state: ToolState };
  const isError = tp.state.status === "error";
  const emoji = isError ? "❌" : toolEmoji(tp.tool);
  // Tool name lives OUTSIDE backticks → escape with the outside-code escaper.
  const escapedTool = escapeMarkdownV2(tp.tool);
  const summary = summarizeToolInput(tp.tool, tp.state.input);
  if (!summary) return `${emoji} ${escapedTool}`;
  // Backticks in the input are replaced with single quotes (inline code spans
  // can't contain backticks even when escaped). The remaining content goes
  // through escapeCode, which escapes only \ and ` per MarkdownV2.
  const safeForCode = summary.replace(/`/g, "'");
  const escaped = escapeCode(safeForCode);
  return `${emoji} ${escapedTool} \`${escaped}\``;
}

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
  // Tool names are lowercase ASCII identifiers from opencode, so no escaping
  // is needed for the static template content.
  const inner = `used ${segments.join(" · ")}`;
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

function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Map of well-known tools to their most informative input field.
  // Unknown tools fall through to a full JSON.stringify of the input — picking
  // an arbitrary first key would drop the field-name context that callers
  // (e.g. /help on a custom tool) need to understand what was invoked.
  const preferredKey = {
    read: "filePath",
    write: "filePath",
    edit: "filePath",
    bash: "command",
    grep: "pattern",
    glob: "pattern",
    webfetch: "url",
  }[toolName];
  if (preferredKey) {
    const value = obj[preferredKey];
    if (value !== undefined) {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      if (str.length > 0) return str.length > 80 ? `${str.slice(0, 80)}…` : str;
    }
  }
  // Empty object → no useful summary at all; let the caller render just the tool name.
  if (Object.keys(obj).length === 0) return "";
  // Fall back: stringify the entire input, truncated at 80 chars.
  const json = JSON.stringify(obj);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}


