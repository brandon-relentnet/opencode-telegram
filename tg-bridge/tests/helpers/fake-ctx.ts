import { vi } from "vitest";

export interface FakeCtxInit {
  chatId?: number;
  fromId?: number;
  text?: string;
  match?: string; // grammy populates ctx.match for /command <args>
}

export interface FakeCtx {
  chat: { id: number; type: "private" };
  from: { id: number; is_bot: false; first_name: string };
  message: { text: string };
  match: string;
  reply: ReturnType<typeof vi.fn>;
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
  };
}

export function makeFakeCtx(init: FakeCtxInit = {}): FakeCtx {
  const reply = vi.fn(async () => ({ message_id: 1 }));
  return {
    chat: { id: init.chatId ?? 1, type: "private" },
    from: { id: init.fromId ?? 111, is_bot: false, first_name: "test" },
    message: { text: init.text ?? "" },
    match: init.match ?? "",
    reply,
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 2 })),
      editMessageText: vi.fn(async () => true),
    },
  };
}
