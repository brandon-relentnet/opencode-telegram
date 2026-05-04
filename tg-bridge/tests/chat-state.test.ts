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

  describe("getDistinctProjectPaths", () => {
    it("returns an empty array when no chats have a project set", () => {
      expect(repo.getDistinctProjectPaths()).toEqual([]);
    });

    it("returns each unique project_path exactly once, sorted", () => {
      repo.setProject(1, "/workspace/zeta", "ses_1");
      repo.setProject(2, "/workspace/alpha", "ses_2");
      repo.setProject(3, "/workspace/zeta", "ses_3"); // duplicate path, different chat
      repo.setProject(4, "/workspace/beta", "ses_4");
      expect(repo.getDistinctProjectPaths()).toEqual([
        "/workspace/alpha",
        "/workspace/beta",
        "/workspace/zeta",
      ]);
    });

    it("excludes rows whose project_path is null (e.g. setSession-only chats)", () => {
      repo.setProject(1, "/workspace/a", "ses_1");
      repo.setSession(2, "ses_b"); // creates a row with null project_path
      expect(repo.getDistinctProjectPaths()).toEqual(["/workspace/a"]);
    });
  });
});

describe("ChatStateRepo coolify_app", () => {
  it("returns null when no coolify app set for (chat, project)", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getCoolifyApp(1, "/workspace/x")).toBeNull();
  });

  it("setCoolifyApp + getCoolifyApp roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setCoolifyApp(1, "/workspace/site", "abc-123", "site.example.com");
    expect(repo.getCoolifyApp(1, "/workspace/site")).toEqual({
      uuid: "abc-123",
      fqdn: "site.example.com",
    });
  });

  it("setCoolifyApp upserts on duplicate (chat, project)", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setCoolifyApp(1, "/workspace/site", "old-uuid", "old.example.com");
    repo.setCoolifyApp(1, "/workspace/site", "new-uuid", "new.example.com");
    expect(repo.getCoolifyApp(1, "/workspace/site")).toEqual({
      uuid: "new-uuid",
      fqdn: "new.example.com",
    });
  });

  it("isolates state across (chat, project) tuples", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    repo.setCoolifyApp(1, "/workspace/a", "uuid-a", "a.example.com");
    repo.setCoolifyApp(1, "/workspace/b", "uuid-b", "b.example.com");
    repo.setCoolifyApp(2, "/workspace/a", "uuid-c", "c.example.com");
    expect(repo.getCoolifyApp(1, "/workspace/a")).toEqual({ uuid: "uuid-a", fqdn: "a.example.com" });
    expect(repo.getCoolifyApp(1, "/workspace/b")).toEqual({ uuid: "uuid-b", fqdn: "b.example.com" });
    expect(repo.getCoolifyApp(2, "/workspace/a")).toEqual({ uuid: "uuid-c", fqdn: "c.example.com" });
  });

  it("creates the coolify_app table on construction (idempotent)", () => {
    const db = new Database(":memory:");
    new ChatStateRepo(db);
    new ChatStateRepo(db); // second construction must not throw
    const cols = db.prepare("PRAGMA table_info(coolify_app)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("chat_id")).toBe(true);
    expect(names.has("project_path")).toBe(true);
    expect(names.has("app_uuid")).toBe(true);
    expect(names.has("fqdn")).toBe(true);
  });
});

describe("ChatStateRepo pinned-status fields", () => {
  it("setPinnedMessageId + getPinnedMessageId roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getPinnedMessageId(1)).toBeNull();
    repo.setPinnedMessageId(1, 1234);
    expect(repo.getPinnedMessageId(1)).toBe(1234);
  });

  it("setPinPaused + getPinPaused roundtrip (default false)", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getPinPaused(1)).toBe(false);
    repo.setPinPaused(1, true);
    expect(repo.getPinPaused(1)).toBe(true);
    repo.setPinPaused(1, false);
    expect(repo.getPinPaused(1)).toBe(false);
  });

  it("setLastUserMessageId + getLastUserMessageId roundtrip", () => {
    const db = new Database(":memory:");
    const repo = new ChatStateRepo(db);
    expect(repo.getLastUserMessageId(1)).toBeNull();
    repo.setLastUserMessageId(1, 999);
    expect(repo.getLastUserMessageId(1)).toBe(999);
  });

  it("creates the new columns on construction (idempotent)", () => {
    const db = new Database(":memory:");
    new ChatStateRepo(db);
    new ChatStateRepo(db);
    const cols = db.prepare("PRAGMA table_info(chat_state)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("pinned_message_id")).toBe(true);
    expect(names.has("pin_paused")).toBe(true);
    expect(names.has("last_user_message_id")).toBe(true);
  });

  it("migrates existing rows: NULL pinned_message_id, FALSE pin_paused", () => {
    const db = new Database(":memory:");
    // Set up an OLD-style schema row first
    db.exec(
      `CREATE TABLE chat_state (chat_id INTEGER PRIMARY KEY, project_path TEXT, session_id TEXT, model TEXT, updated_at INTEGER NOT NULL);`,
    );
    db.prepare(
      "INSERT INTO chat_state (chat_id, project_path, session_id, updated_at) VALUES (?, ?, ?, ?)",
    ).run(1, "/x", "ses_y", Date.now());
    // Construct repo — should ALTER TABLE add new columns
    const repo = new ChatStateRepo(db);
    expect(repo.getPinnedMessageId(1)).toBeNull();
    expect(repo.getPinPaused(1)).toBe(false);
    expect(repo.getLastUserMessageId(1)).toBeNull();
  });
});
