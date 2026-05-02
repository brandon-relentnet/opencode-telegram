/**
 * Chunker for Telegram message text.
 *
 * Telegram allows up to 4096 characters per text message. We use a safe
 * maximum slightly below that to leave room for fence-balancing insertions
 * when splitting a long code block across chunks.
 */

export const MAX_TELEGRAM_LENGTH = 4000;

const FENCE_RE = /^```(\w*)\s*$/;

interface BufferState {
  text: string;
  inFence: boolean;
  fenceLang: string;
}

function emptyBuffer(): BufferState {
  return { text: "", inFence: false, fenceLang: "" };
}

function appendLine(buf: BufferState, line: string): BufferState {
  const text = buf.text.length === 0 ? line : `${buf.text}\n${line}`;
  const m = line.match(FENCE_RE);
  if (m) {
    if (buf.inFence) {
      return { text, inFence: false, fenceLang: "" };
    }
    return { text, inFence: true, fenceLang: m[1] ?? "" };
  }
  return { ...buf, text };
}

function closeIfNeeded(buf: BufferState): string {
  return buf.inFence ? `${buf.text}\n\`\`\`` : buf.text;
}

function projectLength(buf: BufferState, line: string): number {
  const join = buf.text.length === 0 ? 0 : 1; // newline
  const fenceClose = buf.inFence ? 4 : 0; // "\n```" if we'd flush now
  return buf.text.length + join + line.length + fenceClose;
}

function hardSplit(line: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += max) {
    out.push(line.slice(i, i + max));
  }
  return out;
}

export function chunkForTelegram(input: string, max: number = MAX_TELEGRAM_LENGTH): string[] {
  if (input.length === 0) return [];
  if (input.length <= max) return [input];

  const chunks: string[] = [];
  let buf = emptyBuffer();
  const rawLines = input.split("\n");

  // Pre-pass: hard-split any single line that on its own exceeds max.
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length > max) {
      lines.push(...hardSplit(line, max));
    } else {
      lines.push(line);
    }
  }

  for (const line of lines) {
    if (projectLength(buf, line) > max && buf.text.length > 0) {
      // Flush buffer (closing fence if needed)
      chunks.push(closeIfNeeded(buf));
      // If we were in a fence, start the next buffer with a reopened fence
      if (buf.inFence) {
        const reopen = buf.fenceLang ? `\`\`\`${buf.fenceLang}` : "```";
        buf = { text: reopen, inFence: true, fenceLang: buf.fenceLang };
      } else {
        buf = emptyBuffer();
      }
    }
    buf = appendLine(buf, line);
  }

  if (buf.text.length > 0) {
    chunks.push(closeIfNeeded(buf));
  }

  return chunks;
}
