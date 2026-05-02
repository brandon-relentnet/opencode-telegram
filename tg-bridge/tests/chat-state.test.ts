import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ChatStateRepo, type ChatState } from "../src/chat-state.js";

describe("ChatStateRepo", () => {
  let repo: ChatStateRepo;

  beforeEach(() => {
    const db = new Database(":memory:");
    repo = new ChatStateRepo(db);
  });

  it("get returns null for unknown chat", () => {
    expect(repo.get(999)).toBeNull();
  });

  it("setProject creates a row with project and session, no model", () => {
    repo.setProject(1, "/workspace/myapp", "ses_1");
    const state = repo.get(1);
    expect(state).toMatchObject<Partial<ChatState>>({
      chatId: 1,
      projectPath: "/workspace/myapp",
      sessionId: "ses_1",
      model: null,
    });
    expect(state!.updatedAt).toBeGreaterThan(0);
  });

  it("setProject updates existing row and bumps updated_at", async () => {
    repo.setProject(1, "/workspace/a", "ses_a");
    const first = repo.get(1)!;
    await new Promise((r) => setTimeout(r, 5));
    repo.setProject(1, "/workspace/b", "ses_b");
    const second = repo.get(1)!;
    expect(second.projectPath).toBe("/workspace/b");
    expect(second.sessionId).toBe("ses_b");
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("setSession updates only the session id, leaving project and model intact", () => {
    repo.setProject(1, "/workspace/a", "ses_old");
    repo.setModel(1, "anthropic/claude-sonnet-4-5");
    repo.setSession(1, "ses_new");
    const s = repo.get(1)!;
    expect(s.projectPath).toBe("/workspace/a");
    expect(s.sessionId).toBe("ses_new");
    expect(s.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("setSession on a missing row creates the row with null project", () => {
    repo.setSession(7, "ses_only");
    const s = repo.get(7)!;
    expect(s.projectPath).toBeNull();
    expect(s.sessionId).toBe("ses_only");
  });

  it("setModel updates only the model", () => {
    repo.setProject(1, "/workspace/a", "ses_a");
    repo.setModel(1, "openai/gpt-5");
    const s = repo.get(1)!;
    expect(s.model).toBe("openai/gpt-5");
    expect(s.sessionId).toBe("ses_a");
  });

  it("clear deletes the row", () => {
    repo.setProject(1, "/workspace/a", "ses_a");
    repo.clear(1);
    expect(repo.get(1)).toBeNull();
  });

  it("findByChatId is independent across chat ids", () => {
    repo.setProject(1, "/workspace/a", "ses_1");
    repo.setProject(2, "/workspace/b", "ses_2");
    expect(repo.get(1)!.projectPath).toBe("/workspace/a");
    expect(repo.get(2)!.projectPath).toBe("/workspace/b");
  });
});
