/**
 * Render opencode message parts into a single Telegram MarkdownV2 string.
 *
 * Per Telegram docs (https://core.telegram.org/bots/api#markdownv2-style):
 *   Outside code blocks, escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
 *   Inside `pre` / `code`, escape only ` and \.
 */

const RESERVED_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const CODE_RESERVED_RE = /[\\`]/g;

const TOOL_RESULT_LINE_LIMIT = 50;
const TRUNCATION_NOTICE = "…truncated, full result on opencode web";

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

function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Pick the most informative single field per known tool, else show first key=value.
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
  if (!preferredKey) return "";
  const value = obj[preferredKey];
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function renderTextPart(text: string): string {
  return escapeMarkdownV2(text);
}

function renderToolPart(tool: string, state: ToolState): string {
  const summary = summarizeToolInput(tool, state.input);
  const escapedTool = escapeMarkdownV2(tool);
  const escapedSummary = summary ? ` on ${escapeMarkdownV2(summary)}` : "";
  // Italic via _ ... _; inline code via backticks (which don't need to be escaped
  // inside the surrounding italic since they delimit a code entity in MarkdownV2).
  const header = `_called \`${escapedTool}\`${escapedSummary}_`;

  if (state.status === "error") {
    const errMsg = state.error ?? "tool failed";
    return `${header}\n❌ ${escapeMarkdownV2(errMsg)}`;
  }

  const output = state.output ?? "";
  if (state.status !== "completed" || output.length === 0) {
    return header;
  }

  const lines = output.split("\n");
  const truncated = lines.length > TOOL_RESULT_LINE_LIMIT;
  const body = truncated
    ? `${lines.slice(0, TOOL_RESULT_LINE_LIMIT).join("\n")}\n${TRUNCATION_NOTICE}`
    : output;

  return `${header}\n\`\`\`\n${escapeCode(body)}\n\`\`\``;
}

export function renderParts(parts: readonly RenderablePart[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof (part as { text?: string }).text === "string") {
      segments.push(renderTextPart((part as { text: string }).text));
    } else if (
      part.type === "tool" &&
      typeof (part as { tool?: string }).tool === "string" &&
      (part as { state?: ToolState }).state
    ) {
      const tp = part as { tool: string; state: ToolState };
      segments.push(renderToolPart(tp.tool, tp.state));
    }
    // unknown types: skip
  }
  return segments.join("");
}
