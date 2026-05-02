import { describe, it, expect, beforeEach, vi } from "vitest";
import { PermissionService, type PermissionBot } from "../src/permissions.js";
import type { OpencodeClient } from "../src/opencode-client.js";

function makeBot(): PermissionBot & {
  calls: { sends: unknown[][]; edits: unknown[][]; answers: unknown[][] };
} {
  const calls = { sends: [] as unknown[][], edits: [] as unknown[][], answers: [] as unknown[][] };
  return {
    calls,
    async sendMessage(chatId, text, opts) {
      calls.sends.push([chatId, text, opts]);
      return { message_id: 700 + calls.sends.length };
    },
    async editMessageText(chatId, messageId, text, opts) {
      calls.edits.push([chatId, messageId, text, opts]);
    },
    async answerCallbackQuery(id, opts) {
      calls.answers.push([id, opts]);
    },
  };
}

function makeClient(): OpencodeClient {
  return {
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    prompt: vi.fn(),
    listProjects: vi.fn(async () => []),
    listProviders: vi.fn(async () => ({ providers: [], default: {} })),
    respondToPermission: vi.fn(async () => true),
    subscribeToEvents: vi.fn(() => (async function* () {})()),
  } as OpencodeClient;
}

describe("PermissionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sendRequest sends a Telegram message with three inline buttons", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_x",
      sessionID: "ses_1",
      title: "Allow bash command?",
      type: "bash",
      input: { command: "ls" },
    });
    expect(bot.calls.sends).toHaveLength(1);
    const [chatId, text, opts] = bot.calls.sends[0]!;
    expect(chatId).toBe(42);
    expect(text).toMatch(/Allow bash command/);
    const kb = (opts as { reply_markup?: { inline_keyboard?: unknown[][] } }).reply_markup;
    expect(kb?.inline_keyboard?.[0]).toHaveLength(3);
    const buttons = kb!.inline_keyboard![0]!.map(
      (b) => (b as { text: string; callback_data: string }).callback_data,
    );
    expect(buttons).toEqual(["perm:perm_x:once", "perm:perm_x:always", "perm:perm_x:deny"]);
  });

  it("handleCallback (once) calls respondToPermission(allow, false) and edits the message", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_x",
      sessionID: "ses_1",
      title: "Allow?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb1",
      data: "perm:perm_x:once",
      message: { chat: { id: 42 }, message_id: 701 },
    });
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_x", "allow", false);
    expect(bot.calls.answers).toHaveLength(1);
    expect(bot.calls.edits.length).toBeGreaterThan(0);
  });

  it("handleCallback (always) calls respondToPermission(allow, true)", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_y",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb2",
      data: "perm:perm_y:always",
      message: { chat: { id: 42 }, message_id: 702 },
    });
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_y", "allow", true);
  });

  it("handleCallback (deny) calls respondToPermission(deny, false)", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_z",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb3",
      data: "perm:perm_z:deny",
      message: { chat: { id: 42 }, message_id: 703 },
    });
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_z", "deny", false);
  });

  it("auto-denies after timeout if no button is pressed", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_t",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(client.respondToPermission).toHaveBeenCalledWith("ses_1", "perm_t", "deny", false);
  });

  it("ignores callbacks whose data does not match the perm: prefix", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.handleCallback({
      id: "cb_other",
      data: "other:thing",
      message: { chat: { id: 42 }, message_id: 1 },
    });
    expect(client.respondToPermission).not.toHaveBeenCalled();
  });

  it("ignores duplicate callbacks for the same permission id", async () => {
    const bot = makeBot();
    const client = makeClient();
    const svc = new PermissionService(bot, client, { timeoutMs: 60_000 });
    await svc.sendRequest(42, "ses_1", {
      id: "perm_dup",
      sessionID: "ses_1",
      title: "?",
      type: "bash",
      input: {},
    });
    await svc.handleCallback({
      id: "cb1",
      data: "perm:perm_dup:once",
      message: { chat: { id: 42 }, message_id: 700 },
    });
    await svc.handleCallback({
      id: "cb2",
      data: "perm:perm_dup:deny",
      message: { chat: { id: 42 }, message_id: 700 },
    });
    expect(client.respondToPermission).toHaveBeenCalledTimes(1);
  });
});
