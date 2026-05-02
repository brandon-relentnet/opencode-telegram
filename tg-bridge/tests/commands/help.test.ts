import { describe, it, expect } from "vitest";
import { handleHelp, HELP_TEXT } from "../../src/commands/help.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";

describe("handleHelp", () => {
  it("replies with the help text in MarkdownV2", async () => {
    const ctx = makeFakeCtx();
    await handleHelp(ctx as never);
    expect(ctx.reply).toHaveBeenCalledOnce();
    const [text, opts] = ctx.reply.mock.calls[0]!;
    expect(text).toBe(HELP_TEXT);
    expect(opts).toEqual({ parse_mode: "MarkdownV2" });
  });

  it("HELP_TEXT lists all the commands the bridge supports", () => {
    for (const cmd of ["/new", "/projects", "/switch", "/abort", "/status", "/model", "/help"]) {
      expect(HELP_TEXT).toContain(cmd);
    }
  });
});
