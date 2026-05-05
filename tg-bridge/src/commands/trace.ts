import type { Context } from "grammy";
import type { Logger } from "pino";
import { describeError } from "../errors.js";
import { escapeHtml } from "../markdown-to-html.js";
import type { TraceBuffer } from "../trace-buffer.js";

export interface TraceDeps {
  trace: TraceBuffer;
  log?: Pick<Logger, "warn" | "error">;
}

/**
 * `/trace [N]` — render the last N events from this chat's trace buffer.
 *
 * Output is HTML with one `<code>` line per event:
 *
 *   12:34:56.789  evt.name  {key:val, key:val}
 *
 * Default N is 30 (fits comfortably in one Telegram message). Pass an
 * argument to override (e.g. `/trace 80`). Capped at the buffer size.
 */
export async function handleTrace(ctx: Context, deps: TraceDeps): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") return;
    const arg = ((ctx.match as string | undefined) ?? "").trim();
    const requested = arg.length > 0 ? Number.parseInt(arg, 10) : 30;
    const limit = Number.isFinite(requested) && requested > 0 ? requested : 30;

    const events = deps.trace.read(chatId, limit);
    if (events.length === 0) {
      await ctx.reply("<i>No trace events recorded for this chat yet.</i>", {
        parse_mode: "HTML",
      });
      return;
    }

    const lines: string[] = [
      `<b>Trace</b> (last ${events.length} events for chat ${chatId})`,
      "",
    ];
    for (const e of events) {
      const ts = new Date(e.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
      const dataStr = formatData(e.data);
      lines.push(
        `<code>${escapeHtml(ts)}  ${escapeHtml(e.evt)}${dataStr ? `  ${escapeHtml(dataStr)}` : ""}</code>`,
      );
    }

    let out = lines.join("\n");
    if (out.length > 3800) {
      // Telegram caps at 4096; leave headroom. Truncate from the FRONT
      // since recent events are most useful.
      out = `<i>(truncated; showing tail)</i>\n${out.slice(out.length - 3800)}`;
    }

    await ctx.reply(out, { parse_mode: "HTML" });
  } catch (err) {
    deps.log?.warn?.({ err: describeError(err) }, "/trace failed");
    await ctx.reply(`/trace failed: ${describeError(err)}`).catch(() => undefined);
  }
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return parts.length > 0 ? `{${parts.join(", ")}}` : "";
}
