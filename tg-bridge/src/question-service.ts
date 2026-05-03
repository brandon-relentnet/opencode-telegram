import type { Logger } from "pino";
import { escapeMarkdownV2 } from "./format.js";
import type { OpencodeClient } from "./opencode-client.js";

export interface QuestionBot {
  sendMessage(
    chatId: number,
    text: string,
    opts: {
      parse_mode: "MarkdownV2";
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    },
  ): Promise<{ message_id: number }>;

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: {
      parse_mode: "MarkdownV2";
      reply_markup?: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
    },
  ): Promise<unknown>;

  answerCallbackQuery(id: string, opts?: { text?: string }): Promise<unknown>;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: Array<QuestionOption>;
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<QuestionInfo>;
  tool?: { messageID?: string; callID?: string };
}

export interface QuestionRepliedEvent {
  sessionID: string;
  requestID: string;
  answers: Array<Array<string>>;
}

export interface QuestionRejectedEvent {
  sessionID: string;
  requestID: string;
}

export interface CallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { chat: { id: number }; message_id: number };
}

export interface QuestionServiceOptions {
  /** Auto-reject after this many ms if not all questions answered. Default: 15 minutes. */
  timeoutMs?: number;
  log?: Pick<Logger, "info" | "warn" | "error">;
}

interface PerQuestionState {
  selected: string[];
  customAnswers: string[];
  done: boolean;
  messageId: number | null;
}

interface PendingRequest {
  requestId: string;
  sessionId: string;
  chatId: number;
  questions: QuestionInfo[];
  questionStates: PerQuestionState[];
  timer: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class QuestionService {
  private pending = new Map<string, PendingRequest>();
  // chatId → which (request, question) is awaiting a custom-typed answer
  private awaiting = new Map<number, { requestId: string; questionIdx: number }>();
  private timeoutMs: number;
  private log: Pick<Logger, "info" | "warn" | "error"> | undefined;

  constructor(
    private bot: QuestionBot,
    private client: OpencodeClient,
    options?: QuestionServiceOptions,
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options?.log;
  }

  async sendRequest(chatId: number, req: QuestionRequest): Promise<void> {
    if (req.questions.length === 0) {
      this.log?.warn?.({ requestId: req.id }, "QuestionRequest with empty questions array; submitting immediately");
      await this.client.respondToQuestion(req.id, []);
      return;
    }

    const questionStates: PerQuestionState[] = req.questions.map(() => ({
      selected: [],
      customAnswers: [],
      done: false,
      messageId: null,
    }));

    // Send each question's keyboard message (single-select for V1).
    for (let i = 0; i < req.questions.length; i++) {
      const q = req.questions[i]!;
      const state = questionStates[i]!;
      try {
        const sent = await this.bot.sendMessage(chatId, this.renderQuestionMessage(q, state), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: this.buildKeyboard(req.id, i, q, state) },
        });
        state.messageId = sent.message_id;
      } catch (err) {
        this.log?.warn?.({ err, chatId, requestId: req.id, questionIdx: i }, "failed to send question message");
        // Leave messageId null; this question can't be answered. The request will eventually time out.
      }
    }

    const timer = setTimeout(() => {
      void this.autoReject(req.id);
    }, this.timeoutMs);

    this.pending.set(req.id, {
      requestId: req.id,
      sessionId: req.sessionID,
      chatId,
      questions: req.questions,
      questionStates,
      timer,
      resolved: false,
    });
  }

  async handleCallback(cb: CallbackQuery): Promise<boolean> {
    const data = cb.data ?? "";
    if (!data.startsWith("qst:")) return false;

    // Format: qst:<requestID>:<qIdx>:<action>[:<argIdx>]
    // Assumes requestID contains no ':' (opencode emits qst_<24-hex>).
    const parts = data.split(":", 5);
    if (parts.length < 4) {
      this.log?.warn?.({ data }, "qst callback data malformed");
      return true;
    }
    const [, requestId, qIdxStr, action, argIdxStr] = parts as [string, string, string, string, string | undefined];
    const qIdx = Number.parseInt(qIdxStr, 10);
    const argIdx = argIdxStr !== undefined ? Number.parseInt(argIdxStr, 10) : undefined;

    const entry = this.pending.get(requestId);
    if (!entry || entry.resolved) {
      await this.bot
        .answerCallbackQuery(cb.id, { text: "Already responded or expired" })
        .catch((err) => this.log?.warn?.({ err }, "answerCallbackQuery failed"));
      return true;
    }

    if (!Number.isInteger(qIdx) || qIdx < 0 || qIdx >= entry.questions.length) {
      this.log?.warn?.({ requestId, qIdx: qIdxStr }, "qst callback question index invalid");
      return true;
    }
    const q = entry.questions[qIdx]!;
    const state = entry.questionStates[qIdx]!;

    // For V1: only `pick` action is implemented; `tgl`, `custom`, `done` come in later tasks.
    if (action === "pick") {
      if (state.done) {
        await this.bot
          .answerCallbackQuery(cb.id, { text: "Already answered" })
          .catch(() => undefined);
        return true;
      }
      if (argIdx === undefined || !Number.isInteger(argIdx) || argIdx < 0 || argIdx >= q.options.length) {
        this.log?.warn?.({ requestId, qIdx, argIdx }, "qst pick option index invalid");
        return true;
      }
      const option = q.options[argIdx]!;
      state.selected = [option.label];
      state.done = true;
      // Edit message: show the picked answer, remove keyboard
      if (state.messageId !== null) {
        await this.bot
          .editMessageText(
            entry.chatId,
            state.messageId,
            this.renderAnsweredMessage(q, state),
            { parse_mode: "MarkdownV2" },
          )
          .catch((err) => this.log?.warn?.({ err }, "editMessageText (pick) failed"));
      }
      await this.bot.answerCallbackQuery(cb.id).catch(() => undefined);
      // If all questions are done, submit to opencode
      const allDone = entry.questionStates.every((s) => s.done);
      if (allDone) await this.submitAll(entry);
      return true;
    }

    // Unknown action — log and ignore. (Future tasks add tgl/custom/done.)
    this.log?.warn?.({ action }, "unknown qst callback action; ignoring");
    return true;
  }

  private async submitAll(entry: PendingRequest): Promise<void> {
    if (entry.resolved) return;
    entry.resolved = true;
    clearTimeout(entry.timer);
    const answers: Array<Array<string>> = entry.questionStates.map((s) => [
      ...s.selected,
      ...s.customAnswers,
    ]);
    try {
      await this.client.respondToQuestion(entry.requestId, answers);
      this.log?.info?.({ requestId: entry.requestId }, "submitted question answers to opencode");
    } catch (err) {
      this.log?.error?.({ requestId: entry.requestId, err }, "respondToQuestion failed");
      // Annotate each question's message with a failure note
      for (let i = 0; i < entry.questions.length; i++) {
        const state = entry.questionStates[i]!;
        if (state.messageId === null) continue;
        const q = entry.questions[i]!;
        const failureText =
          this.renderAnsweredMessage(q, state) +
          "\n\n_" +
          escapeMarkdownV2("⚠️ Failed to submit to opencode") +
          "_";
        await this.bot
          .editMessageText(entry.chatId, state.messageId, failureText, {
            parse_mode: "MarkdownV2",
          })
          .catch(() => undefined);
      }
      // Unblock opencode so its question tool doesn't hang waiting for an answer
      // we can no longer deliver.
      try {
        await this.client.rejectQuestion(entry.requestId);
      } catch (rejectErr) {
        this.log?.warn?.(
          { requestId: entry.requestId, err: rejectErr },
          "rejectQuestion failed during submit-failure recovery",
        );
      }
    } finally {
      this.pending.delete(entry.requestId);
      if (this.awaiting.get(entry.chatId)?.requestId === entry.requestId) {
        this.awaiting.delete(entry.chatId);
      }
    }
  }

  private async autoReject(requestId: string): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.resolved) return;
    entry.resolved = true;
    try {
      await this.client.rejectQuestion(requestId);
    } catch (err) {
      this.log?.warn?.({ requestId, err }, "rejectQuestion failed during autoReject");
    }
    // Edit each question's message to show timeout
    for (let i = 0; i < entry.questions.length; i++) {
      const state = entry.questionStates[i]!;
      if (state.messageId === null) continue;
      const q = entry.questions[i]!;
      await this.bot
        .editMessageText(
          entry.chatId,
          state.messageId,
          `*${escapeMarkdownV2(q.header)}*\n_${escapeMarkdownV2("⏱ Timed out")}_`,
          { parse_mode: "MarkdownV2" },
        )
        .catch(() => undefined);
    }
    this.pending.delete(requestId);
    // Clear any awaiting custom-answer state for this chat
    if (this.awaiting.get(entry.chatId)?.requestId === requestId) {
      this.awaiting.delete(entry.chatId);
    }
  }

  private renderQuestionMessage(q: QuestionInfo, _state: PerQuestionState): string {
    // V1: just the header + question text. Multi-select state markers
    // will be rendered into this in Task 5 once `tgl` action is added.
    return `*${escapeMarkdownV2(q.header)}*\n${escapeMarkdownV2(q.question)}`;
  }

  private renderAnsweredMessage(q: QuestionInfo, state: PerQuestionState): string {
    const allSelected = [...state.selected, ...state.customAnswers.map((c) => `"${c}"`)];
    const summary = allSelected.length > 0 ? allSelected.join(", ") : "(no answer)";
    return `✓ *${escapeMarkdownV2(q.header)}*: ${escapeMarkdownV2(summary)}`;
  }

  private buildKeyboard(
    requestId: string,
    qIdx: number,
    q: QuestionInfo,
    _state: PerQuestionState,
  ): Array<Array<{ text: string; callback_data: string }>> {
    // V1: single-select only. Multi-select buttons (tgl + Done) come in Task 5;
    // custom-answer button comes in Task 6.
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i]!;
      rows.push([
        { text: opt.label, callback_data: `qst:${requestId}:${qIdx}:pick:${i}` },
      ]);
    }
    if (q.custom !== false) {
      rows.push([
        { text: "✏️ Type your own", callback_data: `qst:${requestId}:${qIdx}:custom` },
      ]);
    }
    return rows;
  }
}
