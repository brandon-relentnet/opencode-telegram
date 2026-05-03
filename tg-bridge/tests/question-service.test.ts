import { describe, it, expect, vi, beforeEach } from "vitest";
import { QuestionService, type QuestionRequest, type QuestionBot } from "../src/question-service.js";
import type { OpencodeClient } from "../src/opencode-client.js";

function makeBot(): QuestionBot & {
  _sentMessages: Array<{ chatId: number; text: string; opts: unknown }>;
  _editedMessages: Array<{ chatId: number; messageId: number; text: string; opts: unknown }>;
} {
  const sentMessages: Array<{ chatId: number; text: string; opts: unknown }> = [];
  const editedMessages: Array<{ chatId: number; messageId: number; text: string; opts: unknown }> = [];
  let nextMsgId = 1000;
  return {
    _sentMessages: sentMessages,
    _editedMessages: editedMessages,
    sendMessage: vi.fn(async (chatId: number, text: string, opts: unknown) => {
      const id = nextMsgId++;
      sentMessages.push({ chatId, text, opts });
      return { message_id: id };
    }),
    editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, opts: unknown) => {
      editedMessages.push({ chatId, messageId, text, opts });
      return undefined;
    }),
    answerCallbackQuery: vi.fn(async () => undefined),
  };
}

function makeClient(): OpencodeClient & {
  _replies: Array<{ requestId: string; answers: Array<Array<string>> }>;
  _rejects: Array<string>;
} {
  const replies: Array<{ requestId: string; answers: Array<Array<string>> }> = [];
  const rejects: Array<string> = [];
  return {
    _replies: replies,
    _rejects: rejects,
    respondToQuestion: vi.fn(async (requestId: string, answers: Array<Array<string>>) => {
      replies.push({ requestId, answers });
      return true;
    }),
    rejectQuestion: vi.fn(async (requestId: string) => {
      rejects.push(requestId);
      return true;
    }),
    // Stubs for unused methods — type-narrowed so TS doesn't complain
    createSession: vi.fn(),
    abortSession: vi.fn(),
    listSessions: vi.fn(),
    prompt: vi.fn(),
    listProjects: vi.fn(),
    listProviders: vi.fn(),
    respondToPermission: vi.fn(),
    subscribeToEvents: vi.fn(),
  } as never;
}

describe("QuestionService — single-select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one Telegram message per question with a single-select keyboard", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick a color",
          header: "Color",
          options: [
            { label: "Red", description: "warm" },
            { label: "Blue", description: "cool" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    expect(bot._sentMessages).toHaveLength(1);
    const sent = bot._sentMessages[0]!;
    expect(sent.chatId).toBe(42);
    expect(sent.text).toContain("Color"); // header
    expect(sent.text).toContain("Pick a color"); // question text
    // Verify keyboard structure
    const opts = sent.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    const buttons = opts.reply_markup.inline_keyboard.flat();
    const labels = buttons.map((b) => b.text);
    expect(labels).toContain("Red");
    expect(labels).toContain("Blue");
    // "Type your own" should be present (custom defaults to true)
    expect(labels.some((l) => l.toLowerCase().includes("type your own"))).toBe(true);
    // Callback data uses qst:<requestID>:<qIdx>:pick:<optIdx>
    const redBtn = buttons.find((b) => b.text === "Red");
    expect(redBtn?.callback_data).toBe("qst:qst_1:0:pick:0");
  });

  it("omits 'Type your own' when custom is false", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_2",
      sessionID: "ses_1",
      questions: [
        {
          question: "Yes or no?",
          header: "Confirm",
          custom: false,
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    const opts = bot._sentMessages[0]!.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    const buttons = opts.reply_markup.inline_keyboard.flat();
    const labels = buttons.map((b) => b.text);
    expect(labels.some((l) => l.toLowerCase().includes("type your own"))).toBe(false);
  });

  it("on pick callback, edits message to show selected answer and submits when all done", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_3",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick one",
          header: "H",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(99, req);
    const claimed = await service.handleCallback({
      id: "cb1",
      data: "qst:qst_3:0:pick:0",
      message: { chat: { id: 99 }, message_id: 1000 },
    });
    expect(claimed).toBe(true);
    // Should have edited the message and submitted to opencode
    expect(bot._editedMessages.length).toBeGreaterThanOrEqual(1);
    const lastEdit = bot._editedMessages[bot._editedMessages.length - 1]!;
    expect(lastEdit.text).toContain("A"); // selected label appears in final state
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_3", answers: [["A"]] });
  });

  it("with multiple questions, waits for all to be answered before submitting", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_4",
      sessionID: "ses_1",
      questions: [
        {
          question: "Q1",
          header: "H1",
          options: [{ label: "A", description: "" }, { label: "B", description: "" }],
        },
        {
          question: "Q2",
          header: "H2",
          options: [{ label: "X", description: "" }, { label: "Y", description: "" }],
        },
      ],
    };
    await service.sendRequest(99, req);
    expect(bot._sentMessages).toHaveLength(2);
    // Answer Q2 first
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_4:1:pick:1",
      message: { chat: { id: 99 }, message_id: 1001 },
    });
    expect(client._replies).toHaveLength(0); // not all done
    // Then Q1
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_4:0:pick:0",
      message: { chat: { id: 99 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_4", answers: [["A"], ["Y"]] });
  });

  it("returns false from handleCallback for non-qst: prefixes", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const claimed = await service.handleCallback({ id: "cb1", data: "perm:xyz:once" });
    expect(claimed).toBe(false);
  });

  it("answers stale callback with 'Already responded' when request is unknown", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const claimed = await service.handleCallback({
      id: "cb1",
      data: "qst:qst_unknown:0:pick:0",
    });
    expect(claimed).toBe(true);
    expect(bot.answerCallbackQuery).toHaveBeenCalledWith("cb1", expect.objectContaining({ text: expect.stringMatching(/already|expired/i) }));
  });

  it("ignores malformed callback data with non-integer qIdx", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_g1",
      sessionID: "ses_1",
      questions: [
        { question: "Q", header: "H", options: [{ label: "A", description: "" }] },
      ],
    };
    await service.sendRequest(99, req);
    // Malformed: "abc" instead of integer
    const claimed = await service.handleCallback({
      id: "cb1",
      data: "qst:qst_g1:abc:pick:0",
      message: { chat: { id: 99 }, message_id: 1000 },
    });
    expect(claimed).toBe(true);
    // Should NOT have submitted
    expect(client._replies).toHaveLength(0);
  });

  it("calls rejectQuestion when respondToQuestion fails, to unblock opencode", async () => {
    const bot = makeBot();
    const client = makeClient();
    // Make respondToQuestion throw
    client.respondToQuestion = vi.fn(async () => {
      throw new Error("opencode 500");
    });
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_failsubmit",
      sessionID: "ses_1",
      questions: [
        { question: "Q", header: "H", options: [{ label: "A", description: "" }] },
      ],
    };
    await service.sendRequest(99, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_failsubmit:0:pick:0",
      message: { chat: { id: 99 }, message_id: 1000 },
    });
    // submit failed → reject was called as compensation
    expect(client._rejects).toContain("qst_failsubmit");
  });

  it("immediately submits empty answers when req.questions is empty", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_empty",
      sessionID: "ses_1",
      questions: [],
    };
    await service.sendRequest(42, req);
    expect(bot._sentMessages).toHaveLength(0);
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_empty", answers: [] });
  });
});

describe("QuestionService — multi-select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders ☐ buttons + Done button for multi-select questions", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick features",
          header: "Features",
          multiple: true,
          options: [
            { label: "Dark mode", description: "" },
            { label: "Animations", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    const opts = bot._sentMessages[0]!.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
    const flat = opts.reply_markup.inline_keyboard.flat();
    const labels = flat.map((b) => b.text);
    // Each option prefixed with ☐
    expect(labels.some((l) => l === "☐ Dark mode")).toBe(true);
    expect(labels.some((l) => l === "☐ Animations")).toBe(true);
    // Done button present
    expect(labels.some((l) => l === "✅ Done")).toBe(true);
    // Type your own present (custom defaults to true)
    expect(labels.some((l) => l.toLowerCase().includes("type your own"))).toBe(true);
    // tgl callback for options
    const dmBtn = flat.find((b) => b.text === "☐ Dark mode");
    expect(dmBtn?.callback_data).toBe("qst:qst_m1:0:tgl:0");
    const doneBtn = flat.find((b) => b.text === "✅ Done");
    expect(doneBtn?.callback_data).toBe("qst:qst_m1:0:done");
  });

  it("on tgl callback, edits keyboard to show ☑ for toggled option, does not submit", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m2",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m2:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(0); // not submitted
    const lastEdit = bot._editedMessages[bot._editedMessages.length - 1]!;
    const opts = lastEdit.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } };
    const labels = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l === "☑ A")).toBe(true);
    expect(labels.some((l) => l === "☐ B")).toBe(true);
  });

  it("on tgl callback for already-selected option, untoggles it (☑ → ☐)", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m3",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    // Toggle A on
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m3:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    // Toggle A off
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_m3:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    const lastEdit = bot._editedMessages[bot._editedMessages.length - 1]!;
    const opts = lastEdit.opts as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } };
    const labels = opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l === "☐ A")).toBe(true);
  });

  it("on done callback, marks question done with current selections and submits if all done", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m4",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
            { label: "C", description: "" },
          ],
        },
      ],
    };
    await service.sendRequest(42, req);
    // Toggle A and C
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m4:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_m4:0:tgl:2",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(0);
    // Done
    await service.handleCallback({
      id: "cb3",
      data: "qst:qst_m4:0:done",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_m4", answers: [["A", "C"]] });
  });

  it("done with no selections submits an empty answer for that question", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_m5",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_m5:0:done",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_m5", answers: [[]] });
  });
});

describe("QuestionService — custom answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("on custom callback, sets awaiting state and toasts the user", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_c1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    expect(service.isAwaitingCustomAnswer(42)).toBe(false);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_c1:0:custom",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(service.isAwaitingCustomAnswer(42)).toBe(true);
    expect(bot.answerCallbackQuery).toHaveBeenCalledWith(
      "cb1",
      expect.objectContaining({ text: expect.stringMatching(/type|custom/i) }),
    );
  });

  it("handleCustomAnswer in single-select replaces selected, marks done, submits", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_c2",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_c2:0:custom",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    await service.handleCustomAnswer(42, "I want X instead");
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_c2", answers: [["I want X instead"]] });
    // Awaiting cleared
    expect(service.isAwaitingCustomAnswer(42)).toBe(false);
  });

  it("handleCustomAnswer in multi-select appends to customAnswers, leaves question pending", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    const req: QuestionRequest = {
      id: "qst_c3",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick",
          header: "H",
          multiple: true,
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    await service.sendRequest(42, req);
    // Toggle A
    await service.handleCallback({
      id: "cb1",
      data: "qst:qst_c3:0:tgl:0",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    // Custom answer
    await service.handleCallback({
      id: "cb2",
      data: "qst:qst_c3:0:custom",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    await service.handleCustomAnswer(42, "Custom thing");
    // Not yet submitted
    expect(client._replies).toHaveLength(0);
    expect(service.isAwaitingCustomAnswer(42)).toBe(false);
    // Done
    await service.handleCallback({
      id: "cb3",
      data: "qst:qst_c3:0:done",
      message: { chat: { id: 42 }, message_id: 1000 },
    });
    expect(client._replies).toHaveLength(1);
    expect(client._replies[0]).toEqual({ requestId: "qst_c3", answers: [["A", "Custom thing"]] });
  });

  it("handleCustomAnswer when not awaiting is a no-op", async () => {
    const bot = makeBot();
    const client = makeClient();
    const service = new QuestionService(bot, client);
    await service.handleCustomAnswer(42, "should be ignored");
    expect(client._replies).toHaveLength(0);
  });
});
