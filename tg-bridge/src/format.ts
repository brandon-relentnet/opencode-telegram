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
import { isPromptEcho } from "./prompt-echo.js";

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
  /**
   * If provided, replaces the thinking placeholder entirely with a
   * rate-limit notice: "⏳ <message> · attempt N · retry in Ns_".
   *
   * opencode emits this via `session.status` with `type: "retry"` when
   * the provider returns a retryable error (typically 429). `next` is a
   * unix-ms timestamp of when the retry will be attempted; the bridge
   * computes "retry in Ns" relative to `now`.
   *
   * When set, hides the thinking + elapsed line so the user sees the
   * rate-limit reason explicitly instead of the generic "thinking" state.
   */
  retryStatus?: {
    attempt: number;
    message: string;
    /** Unix milliseconds until next retry. */
    next: number;
    /** Override Date.now() for tests. */
    now?: number;
  };
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
  const tail = renderTailLine(options);
  lines.push(tail);
  return lines.join("\n");
}

/**
 * Build the bottom line of the streaming view. Priority:
 *   1. retryStatus → rate-limit banner
 *   2. elapsedSeconds → heartbeat-elapsed line
 *   3. static "_thinking…_"
 */
function renderTailLine(options: StreamingViewOptions): string {
  if (options.retryStatus) {
    const { attempt, message, next } = options.retryStatus;
    const now = options.retryStatus.now ?? Date.now();
    const remainingSec = Math.max(0, Math.round((next - now) / 1000));
    const truncated = message.length > 80 ? `${message.slice(0, 77)}…` : message;
    const escapedMsg = escapeMarkdownV2(truncated);
    const remainingLabel =
      remainingSec === 0 ? "retrying now" : `retry in ${formatDurationFromSeconds(remainingSec)}`;
    return `_⏳ ${escapedMsg} · attempt ${attempt} · ${remainingLabel}_`;
  }
  if (options.elapsedSeconds != null) {
    return `_thinking · ${formatDurationFromSeconds(options.elapsedSeconds)} elapsed_`;
  }
  return THINKING_MARKER;
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

/**
 * Options for the transparent-mode renderer.
 */
export interface TransparentViewOptions {
  /** Set of message IDs known to be from the user; their parts are filtered. */
  userMessageIds?: Set<string>;
  /**
   * The most recent user prompt. Used by isPromptEcho to filter assistant
   * text that just restates the user's question.
   */
  lastUserPrompt?: string | null;
  /**
   * When true, append a terminal marker so the user sees the turn has
   * fully wrapped (vs still streaming).
   */
  final?: boolean;
  /**
   * When `final` is true, controls which terminal marker is rendered.
   *
   *   - undefined / "idle" → "─ done ─" (clean opencode session.idle)
   *   - "watchdog"        → "⚠️ stalled — no events for N min..."
   *
   * Set by the watchdog path so the user can distinguish a real
   * agent-completed turn from a bridge-gave-up turn (e.g. when opencode
   * crashed or SSE dropped mid-turn). See Turn.finalize for context.
   */
  finalReason?: "idle" | "watchdog";
  /**
   * If provided, replaces the static thinking placeholder when the agent
   * is still working (`final` is false). Used by Turn's heartbeat.
   */
  elapsedSeconds?: number;
  /**
   * Rate-limit retry banner. Same shape as StreamingViewOptions.retryStatus.
   */
  retryStatus?: {
    attempt: number;
    message: string;
    next: number;
    now?: number;
  };
}

const DONE_MARKER = "<i>─ done ─</i>";

/**
 * Render the session's parts as a continuous transparent stream:
 * narration, tool activity, reasoning, and prose all in arrival order,
 * with activity dimmed (italic) and prose normal.
 *
 * This replaces the prior split between `renderStreamingView` (curated
 * tool list + thinking) and `renderFinalView` (summary header +
 * concatenated text) so the user sees what the agent is actually doing
 * the whole time, like opencode's TUI but in Telegram.
 *
 * Output is HTML (Telegram parse_mode: "HTML"). Per-part text is run
 * through `commonmarkToTelegramHtml` so the agent's `**bold**` etc.
 * render correctly. User-role text is filtered. Assistant text matching
 * the user's last prompt heuristically (see prompt-echo.ts) is filtered.
 */
export function renderTransparentView(
  parts: readonly RenderablePart[],
  options: TransparentViewOptions = {},
): string {
  const userIds = options.userMessageIds;
  const segments: string[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      const text = (p as { text?: string }).text;
      const role = (p as { role?: string }).role;
      const messageID = (p as { messageID?: string }).messageID;
      if (typeof text !== "string") continue;
      if (text.trim().length === 0) continue;
      if (typeof role === "string" && role.toLowerCase() === "user") continue;
      if (userIds && typeof messageID === "string" && userIds.has(messageID)) continue;
      // Filter assistant prompt-echoes when we have a recent prompt to compare against.
      if (options.lastUserPrompt && isPromptEcho(text, options.lastUserPrompt)) continue;
      segments.push(commonmarkToTelegramHtml(text));
    } else if (p.type === "reasoning") {
      // Render reasoning dimmed (italic, smaller-feel via blockquote on
      // Telegram). Reasoning is freeform agent thought; show it as
      // metadata-flavored text without parsing markdown (it's often
      // streaming, partial, and prone to broken markdown).
      const text = (p as { text?: string }).text;
      if (typeof text !== "string" || text.trim().length === 0) continue;
      segments.push(`<blockquote expandable><i>${escapeHtml(text)}</i></blockquote>`);
    } else if (p.type === "tool") {
      // Render tool calls as a dimmed italic single line. Reuses the
      // existing renderToolLine which produces MarkdownV2; we strip the
      // MarkdownV2 escapes and re-escape for HTML to avoid double-escaping.
      const md = renderToolLine(p);
      if (md.length === 0) continue;
      // renderToolLine output is `<emoji> <toolName> <code>arg</code> · meta`.
      // For HTML mode, we re-build the line directly to avoid the two-pass
      // escape dance.
      segments.push(`<i>${renderToolLineAsHtml(p)}</i>`);
    }
  }

  // Tail line:
  //   - retryStatus: rate-limit banner
  //   - final: ─ done ─, OR a "no parts received" notice if there's
  //     nothing else to render (watchdog fired before any part arrived,
  //     or SSE missed the whole turn). The notice is more useful than a
  //     bare "─ done ─" floating in the chat with no context.
  //   - elapsedSeconds: thinking · Ns elapsed
  //   - else: thinking…
  let tail: string;
  if (options.final) {
    if (options.finalReason === "watchdog") {
      // Watchdog timer fired — opencode never sent session.idle, likely
      // because the server crashed (OOM-kill is common on small VPS
      // memory) or SSE was severed mid-turn. Tell the user explicitly
      // so they don't mistake this for a clean finish.
      tail = "<i>⚠️ stalled — no events for 5 min. opencode may have crashed or the connection dropped. Check the web UI to see the agent's actual final state.</i>";
    } else if (segments.length === 0) {
      tail = "<i>(no agent activity captured — opencode may still be working; check the web UI)</i>";
    } else {
      tail = DONE_MARKER;
    }
  } else {
    tail = renderTransparentTail(options);
  }
  if (tail.length > 0) segments.push(tail);

  return segments.join("\n\n");
}

function renderTransparentTail(options: TransparentViewOptions): string {
  if (options.retryStatus) {
    const { attempt, message, next } = options.retryStatus;
    const now = options.retryStatus.now ?? Date.now();
    const remainingSec = Math.max(0, Math.round((next - now) / 1000));
    const truncated = message.length > 80 ? `${message.slice(0, 77)}…` : message;
    const remainingLabel =
      remainingSec === 0
        ? "retrying now"
        : `retry in ${formatDurationFromSecondsHtml(remainingSec)}`;
    return `<i>⏳ ${escapeHtml(truncated)} · attempt ${attempt} · ${remainingLabel}</i>`;
  }
  if (options.elapsedSeconds != null) {
    return `<i>thinking · ${formatDurationFromSecondsHtml(options.elapsedSeconds)} elapsed</i>`;
  }
  return "<i>thinking…</i>";
}

/** HTML version of formatDurationFromSeconds (which is private). */
function formatDurationFromSecondsHtml(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Render a tool part as HTML directly (vs renderToolLine which outputs
 * MarkdownV2). Mirrors the same content shape — emoji + tool + arg + meta.
 */
function renderToolLineAsHtml(part: RenderablePart): string {
  if (part.type !== "tool") return "";
  const tp = part as { type: "tool"; tool: string; state: ToolState };
  const isError = tp.state.status === "error";
  const emoji = isError ? "❌" : toolEmoji(tp.tool);
  const summary = summarizeToolInput(tp.tool, tp.state.input);
  const meta = formatToolMeta(tp);
  const head = `${emoji} ${escapeHtml(tp.tool)}`;
  if (!summary) return meta ? `${head} · ${meta}` : head;
  const safeForCode = summary.replace(/`/g, "'");
  const arg = `<code>${escapeHtml(safeForCode)}</code>`;
  return meta ? `${head} ${arg} · ${meta}` : `${head} ${arg}`;
}

/** Compose the trailing meta string ("124 lines", "0.2s", etc) without MarkdownV2 escapes. */
function formatToolMeta(part: { tool: string; state: ToolState }): string {
  const md = part.state.metadata as { lines?: number; matchCount?: number; exitCode?: number } | undefined;
  const time = part.state.time as { start?: number; end?: number } | undefined;
  const bits: string[] = [];
  if (md && typeof md.lines === "number") bits.push(`${md.lines} lines`);
  if (md && typeof md.matchCount === "number") bits.push(`${md.matchCount} matches`);
  if (md && typeof md.exitCode === "number" && md.exitCode !== 0) bits.push(`exit ${md.exitCode}`);
  if (time && typeof time.start === "number" && typeof time.end === "number") {
    bits.push(formatDuration(time.end - time.start));
  }
  return bits.join(" · ");
}

/**
 * State consumed by `renderPinnedStatus` to produce the 5-line HTML status
 * block that lives in the chat's pinned message.
 *
 * All optional fields render as `—` when null/undefined so the layout stays
 * stable across "we know nothing yet" and "fully populated" states.
 *
 * Lines 1 and 2 always render. Line 3 (Coolify) only when `coolifyFqdn` is
 * present. Line 4 (git) only when `ahead > 0` OR `dirty > 0`.
 */
export interface PinnedStatusState {
  /** Project basename, e.g. "bltft-gold". HTML-escaped on render. */
  projectName: string;
  /** Current branch from `git branch --show-current`; null for non-git dirs. */
  branch?: string | null;
  /** Active agent mode ("build" | "plan" | "review" | …); null when unknown. */
  agentMode?: string | null;
  /** Full provider/model id; rendered with provider + "claude-" prefixes stripped. */
  modelId?: string | null;
  /** Cumulative tokens used (whatever sum the caller deems meaningful). */
  tokensUsed?: number | null;
  /** Model context limit from the opencode `/provider` API. */
  contextLimit?: number | null;
  /** Cumulative cost as integer micros (1e-6 USD). 420_000 → "$0.42". */
  costMicros?: number | null;
  /** Coolify FQDN; line 3 omitted entirely when absent. */
  coolifyFqdn?: string | null;
  /** Pre-formatted "12m ago" relative timestamp for the last deploy. */
  lastDeployAgo?: string | null;
  /** Commits ahead of origin (`git rev-list --count @{u}..HEAD`). */
  ahead?: number | null;
  /** Number of modified+untracked files; only shown on the git line when > 0. */
  dirty?: number | null;
}

/**
 * State consumed by `renderStreamingHeader` to produce the single-line
 * MarkdownV2 header above the streaming view's tool list.
 *
 * Returns "" when `tokensCumulative` is null — on the very first turn, before
 * any assistant message has completed, the header would be all em-dashes and
 * adds noise instead of signal. Letting the streaming view render unchanged
 * for the first turn matches the spec.
 */
export interface StreamingHeaderState {
  modelId?: string | null;
  agentMode?: string | null;
  /** Cumulative session tokens; header is suppressed when null. */
  tokensCumulative?: number | null;
  /** Cost contributed by the in-flight turn, in micros. */
  costThisTurnMicros?: number | null;
}

/** "—" placeholder for unknown fields in the pinned + header surfaces. */
const EMDASH = "—";

/**
 * Format a token count for the compact pinned/streaming surfaces:
 *   < 1_000           → exact integer ("847")
 *   < 10_000          → one decimal place ("2.4k")
 *   ≥ 10_000          → integer thousands ("23k", "200k")
 *
 * Round-half-up to match the user-facing "23.5k" example in the plan.
 */
function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) {
    // 2_350 → "2.4k" (round-half-up via Math.round on 1-decimal scale).
    const tenths = Math.round(n / 100) / 10;
    return `${tenths.toFixed(1)}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

/** Format integer micros as "$0.42". Always two decimal places. */
function formatCostMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * Strip the `provider/` prefix and an optional leading `claude-` from a model
 * id so it fits into the 5-line pinned status without dominating the line:
 *
 *   anthropic/claude-sonnet-4-5  → sonnet-4-5
 *   openai/gpt-4o                → gpt-4o
 *   gpt-4o                       → gpt-4o
 */
function shortenModelId(modelId: string): string {
  const slashIdx = modelId.indexOf("/");
  const tail = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;
  return tail.startsWith("claude-") ? tail.slice("claude-".length) : tail;
}

/**
 * Render the 5-line pinned-status HTML block. See PinnedStatusState for the
 * input contract; see the design spec (Surface 1) for the exact mockup.
 *
 * Layout:
 *   🟢 <b>{project}</b> · {branch} · {mode}
 *   {model} · {tokens}/{limit} ctx · {cost}
 *   ✅ <a href="https://{fqdn}">{fqdn}</a> ({age})    [conditional]
 *   🔀 {ahead} ahead of origin                        [conditional]
 *
 * User-controlled fields (project, branch, fqdn) are HTML-escaped to keep
 * Telegram's parser happy when names contain `<`, `&`, or `>`.
 */
export function renderPinnedStatus(state: PinnedStatusState): string {
  const lines: string[] = [];

  // Line 1: project · branch · mode (always).
  const projectHtml = `<b>${escapeHtml(state.projectName)}</b>`;
  const branchHtml = state.branch ? escapeHtml(state.branch) : EMDASH;
  const modeHtml = state.agentMode ? escapeHtml(state.agentMode) : EMDASH;
  lines.push(`🟢 ${projectHtml} · ${branchHtml} · ${modeHtml}`);

  // Line 2: model · tokens/limit ctx · cost (always).
  const modelStr = state.modelId ? escapeHtml(shortenModelId(state.modelId)) : EMDASH;
  const tokensStr =
    typeof state.tokensUsed === "number" ? formatTokensCompact(state.tokensUsed) : EMDASH;
  const limitStr =
    typeof state.contextLimit === "number" ? formatTokensCompact(state.contextLimit) : EMDASH;
  const costStr =
    typeof state.costMicros === "number" ? formatCostMicros(state.costMicros) : EMDASH;
  lines.push(`${modelStr} · ${tokensStr}/${limitStr} ctx · ${costStr}`);

  // Line 3: Coolify (only when fqdn present).
  if (state.coolifyFqdn) {
    const fqdnHtml = escapeHtml(state.coolifyFqdn);
    const age = state.lastDeployAgo ? ` (${escapeHtml(state.lastDeployAgo)})` : "";
    lines.push(`✅ <a href="https://${fqdnHtml}">${fqdnHtml}</a>${age}`);
  }

  // Line 4: git ahead/dirty (only when at least one is > 0).
  const ahead = typeof state.ahead === "number" ? state.ahead : 0;
  const dirty = typeof state.dirty === "number" ? state.dirty : 0;
  if (ahead > 0 || dirty > 0) {
    if (ahead > 0 && dirty > 0) {
      lines.push(`🔀 ${ahead} ahead · ${dirty} dirty`);
    } else if (ahead > 0) {
      lines.push(`🔀 ${ahead} ahead of origin`);
    } else {
      lines.push(`🔀 ${dirty} dirty`);
    }
  }

  return lines.join("\n");
}

/**
 * Render the single-line MarkdownV2 header for the streaming view, plus a
 * "─────" separator on the next line. Returns "" when no token info is
 * available so the streaming view renders unchanged on the first turn.
 *
 * Layout:
 *   {model} · {mode} · {tokens} tokens · {cost} this turn
 *   ─────
 *
 * MarkdownV2-escaped so it can be concatenated into the existing streaming
 * view (which is also MarkdownV2). The separator characters (`─`) are not
 * MarkdownV2-reserved.
 */
export function renderStreamingHeader(state: StreamingHeaderState): string {
  if (typeof state.tokensCumulative !== "number") return "";

  const model = state.modelId ? shortenModelId(state.modelId) : EMDASH;
  const mode = state.agentMode ?? EMDASH;
  const tokens = formatTokensCompact(state.tokensCumulative);
  const cost =
    typeof state.costThisTurnMicros === "number"
      ? formatCostMicros(state.costThisTurnMicros)
      : EMDASH;

  // Build the line, then escape for MarkdownV2. The middot (·) and em-dash
  // (—) are not in MarkdownV2's reserved set so they pass through unchanged.
  const line = `${model} · ${mode} · ${tokens} tokens · ${cost} this turn`;
  return `${escapeMarkdownV2(line)}\n─────`;
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


