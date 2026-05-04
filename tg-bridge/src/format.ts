/**
 * Render opencode message parts into Telegram-flavored output.
 *
 * Streaming view (placeholder while the agent works) uses MarkdownV2 — a
 * simpler, fixed character set that avoids nested-escaping headaches when
 * tool inputs are interleaved with running-state markers.
 *
 * Final view (after `session.idle`) uses Telegram HTML, so the agent's
 * CommonMark output (`**bold**`, headers, fenced code, links) renders
 * correctly. See `markdown-to-html.ts` for the conversion.
 *
 * MarkdownV2 escape rules (https://core.telegram.org/bots/api#markdownv2-style):
 *   Outside code blocks, escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
 *   Inside `pre` / `code`, escape only ` and \.
 */

import { commonmarkToTelegramHtml, escapeHtml } from "./markdown-to-html.js";

const RESERVED_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(RESERVED_RE, (c) => `\\${c}`);
}

interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  error?: string;
  // C3: extra fields opencode attaches when a tool finishes. Both are optional
  // so older opencode versions (and tests that don't set them) still render.
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

export type RenderablePart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: ToolState }
  | { type: string; [k: string]: unknown }; // unknown variants ignored

/**
 * Loose shape used by concatenateTextParts to filter user-role parts at
 * render time. Real callers pass IncomingPart / RenderablePart values that
 * structurally satisfy this; tests pass object literals directly.
 *
 * `role` and `messageID` are optional metadata: opencode tags individual
 * parts with neither field directly, but the bridge's per-session
 * message-role tracker enriches its own collector before rendering.
 */
export interface MaybeTextPart {
  type: string;
  text?: string;
  role?: string;
  messageID?: string;
  [k: string]: unknown;
}

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
  const state = tp.state;
  const isError = state.status === "error";
  const isCompleted = state.status === "completed";
  const emoji = isError ? "❌" : toolEmoji(tp.tool);
  // Tool name lives OUTSIDE backticks → escape with the outside-code escaper.
  const escapedTool = escapeMarkdownV2(tp.tool);
  const summary = summarizeToolInput(tp.tool, state.input);

  // C3: build the suffix that follows the inline-code argument, e.g.
  // " · 124 lines · 0.2s" for completed reads, " · failed" for errors.
  // Running/pending tools contribute no suffix — metadata and timing are
  // only meaningful once the tool has finished.
  const suffix: string[] = [];
  if (isError) {
    suffix.push("failed");
  } else if (isCompleted) {
    const md = state.metadata;
    if (md) {
      if (tp.tool === "read" && typeof md.lines === "number") {
        suffix.push(`${md.lines} lines`);
      } else if (
        (tp.tool === "grep" || tp.tool === "glob") &&
        typeof md.matchCount === "number"
      ) {
        suffix.push(`${md.matchCount} ${md.matchCount === 1 ? "match" : "matches"}`);
      } else if (
        tp.tool === "bash" &&
        typeof md.exitCode === "number" &&
        md.exitCode !== 0
      ) {
        suffix.push(`exit ${md.exitCode}`);
      }
    }
    if (
      typeof state.time?.start === "number" &&
      typeof state.time?.end === "number"
    ) {
      suffix.push(formatDuration(state.time.end - state.time.start));
    }
  }
  const suffixStr = suffix.length > 0 ? ` · ${suffix.join(" · ")}` : "";

  if (!summary) return `${emoji} ${escapedTool}${suffixStr}`;
  // Backticks in the input are replaced with single quotes (inline code spans
  // can't contain backticks even when escaped). The remaining content is
  // escaped with escapeMarkdownV2 — Telegram unescapes \X for any X inside
  // code spans, so over-escaping is safe and lets us share one escaper.
  const safeForCode = summary.replace(/`/g, "'");
  const escaped = escapeMarkdownV2(safeForCode);
  return `${emoji} ${escapedTool} \`${escaped}\`${suffixStr}`;
}

/**
 * Format a millisecond duration as a compact human-readable string:
 *   < 1s        → "0.Xs" (one decimal place)
 *   1s – 59s    → "Ns"   (rounded to the nearest second)
 *   ≥ 1m       → "Mm Ss"
 *
 * Used by renderToolLine to annotate completed tool calls with their
 * elapsed time.
 */
export function formatDuration(ms: number): string {
  // Sub-second: round to the nearest 100 ms so 150 ms → "0.2s" (the plan's
  // golden test expects 150 → 0.2, which means half-up rounding rather than
  // raw toFixed(1) — the latter would give "0.1" because 0.15 is binary
  // 0.14999…).
  if (ms < 1000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

const STREAMING_VIEW_CAP = 30;
const THINKING_MARKER = "_thinking…_";

/**
 * Format an elapsed-second count for the streaming-view "thinking" line.
 * Distinct from `formatDuration(ms)` because the heartbeat (C1) gives us
 * whole-second integers — going through ms would round-trip lossy on the
 * sub-second branch.
 */
function formatDurationFromSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/**
 * Inline-keyboard reply_markup for the streaming-view placeholder. One
 * button labelled "⏹ Cancel" with callback_data `cancel:<sessionId>`.
 *
 * Attached by Turn.editNow on every streaming edit (and heartbeat tick),
 * removed automatically on finalize() because the final-view edit goes
 * through safeEdit without a replyMarkup argument — Telegram strips the
 * keyboard when an edit omits reply_markup.
 *
 * The session ID is embedded directly in the callback_data so the index.ts
 * router can look up the active Turn without consulting chat-state. Tested
 * shape lives in format.test.ts.
 */
export function buildCancelKeyboard(sessionId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [[{ text: "⏹ Cancel", callback_data: `cancel:${sessionId}` }]],
  };
}

export interface StreamingViewOptions {
  /**
   * If provided, replaces the static "_thinking…_" placeholder with
   * "_thinking · <Ns or Mm Ss> elapsed_". Used by the Turn heartbeat (C1)
   * to signal liveness while the agent works.
   */
  elapsedSeconds?: number;
}

/**
 * Render the placeholder content while the agent is working.
 *
 * Filters to tool parts only (text parts are hidden during streaming to
 * avoid partial-MarkdownV2 rendering bugs). Each tool becomes one line via
 * renderToolLine. If more than STREAMING_VIEW_CAP tools are present, the
 * oldest are collapsed into a single italic summary line. A trailing
 * "_thinking…_" line indicates work in progress (or "_thinking · Ns
 * elapsed_" when `options.elapsedSeconds` is provided by the heartbeat).
 *
 * The output uses only: inline code (single backticks), italic
 * (underscores), emoji, newlines. NO fenced code blocks. Structurally
 * cannot produce unbalanced fences.
 */
export function renderStreamingView(
  parts: readonly RenderablePart[],
  options: StreamingViewOptions = {},
): string {
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
  const thinking =
    options.elapsedSeconds != null
      ? `_thinking · ${formatDurationFromSeconds(options.elapsedSeconds)} elapsed_`
      : THINKING_MARKER;
  lines.push(thinking);
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
 * Options for concatenateTextParts / renderFinalView.
 *
 * `userMessageIds` is the set of opencode message IDs known to be user-role
 * messages. opencode's `promptAsync` creates a user message containing the
 * prompt text BEFORE emitting events for the assistant's response, so the
 * bridge's part collector accumulates user parts alongside assistant parts.
 * Filtering by messageID at render time strips those user echoes from the
 * final view.
 */
export interface ConcatTextOptions {
  userMessageIds?: Set<string>;
}

/**
 * Concatenate all text parts in order, joined by "\n\n", with each part
 * escaped via escapeMarkdownV2. Empty / whitespace-only text parts are
 * skipped. Tool parts are ignored.
 *
 * Defense-in-depth filter for user-role parts (so the agent's reply doesn't
 * echo the user's prompt back at them):
 *   1. If a part has a `role` field equal to "user" (case-insensitive), skip.
 *   2. If `options.userMessageIds` is supplied AND the part's `messageID` is
 *      in the set, skip.
 * Either path is sufficient. Both are needed because opencode's part shape
 * doesn't always carry a role discriminator on individual parts; the
 * messageID lookup is the reliable path, the role check is the safety net
 * for object-literal callers (tests, future code paths).
 */
export function concatenateTextParts(
  parts: readonly MaybeTextPart[],
  options: ConcatTextOptions = {},
): string {
  const userIds = options.userMessageIds;
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type !== "text") continue;
    if (typeof p.text !== "string") continue;
    if (p.text.trim().length === 0) continue;
    if (typeof p.role === "string" && p.role.toLowerCase() === "user") continue;
    if (userIds && typeof p.messageID === "string" && userIds.has(p.messageID)) continue;
    texts.push(escapeMarkdownV2(p.text));
  }
  return texts.join("\n\n");
}

/**
 * HTML version of renderToolSummary for the final view (which uses
 * Telegram HTML, not MarkdownV2). Returns "" if no tools are present.
 *
 * Tool names are lowercase ASCII identifiers from opencode, but we run
 * them through escapeHtml defensively in case a future tool name contains
 * one of `& < >`.
 */
export function renderToolSummaryHtml(parts: readonly RenderablePart[]): string {
  const toolParts = parts.filter((p) => p.type === "tool") as Array<{
    type: "tool";
    tool: string;
    state: ToolState;
  }>;
  if (toolParts.length === 0) return "";

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
  const inner = `used ${segments.join(" · ")}`;
  return `<i>${escapeHtml(inner)}</i>`;
}

/**
 * HTML version of concatenateTextParts. Each text part is converted from
 * CommonMark to Telegram HTML via `marked` (so `**bold**`, fenced code,
 * lists, links, etc. render correctly), then joined by blank lines.
 *
 * The user-role filter (role check + messageID set) is identical to the
 * MarkdownV2 version — see that function's doc comment for the rationale.
 */
export function concatenateTextPartsHtml(
  parts: readonly MaybeTextPart[],
  options: ConcatTextOptions = {},
): string {
  const userIds = options.userMessageIds;
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type !== "text") continue;
    if (typeof p.text !== "string") continue;
    if (p.text.trim().length === 0) continue;
    if (typeof p.role === "string" && p.role.toLowerCase() === "user") continue;
    if (userIds && typeof p.messageID === "string" && userIds.has(p.messageID)) continue;
    const html = commonmarkToTelegramHtml(p.text);
    if (html.length > 0) texts.push(html);
  }
  return texts.join("\n\n");
}

/**
 * Render the final reply as Telegram HTML: muted summary header (if any
 * tools used) + body composed from CommonMark-to-HTML-converted text parts.
 *
 * Streaming view stays MarkdownV2 — only the final view uses HTML, so the
 * agent's CommonMark formatting (bold, headers, fences, links) renders
 * correctly while in-flight rendering retains its simpler escape rules.
 *
 * Edge cases:
 *   - No tools, with text: just the body
 *   - No tools, no text: "<i>(no response)</i>"
 *   - Tools used, no text: header + "<i>(no response text)</i>"
 *   - Tools used, with text: header + body
 */
export function renderFinalView(
  parts: readonly RenderablePart[],
  options: ConcatTextOptions = {},
): string {
  const summary = renderToolSummaryHtml(parts);
  const body = concatenateTextPartsHtml(parts, options);

  if (summary === "" && body === "") return `<i>${escapeHtml("(no response)")}</i>`;
  if (summary === "") return body;
  if (body === "") return `${summary}\n\n<i>${escapeHtml("(no response text)")}</i>`;
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


