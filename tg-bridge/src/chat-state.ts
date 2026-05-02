import { createRequire } from "node:module";
import type Database from "better-sqlite3";

export interface ChatState {
  chatId: number;
  projectPath: string | null;
  sessionId: string | null;
  model: string | null;
  updatedAt: number;
}

interface Row {
  chat_id: number;
  project_path: string | null;
  session_id: string | null;
  model: string | null;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_state (
    chat_id      INTEGER PRIMARY KEY,
    project_path TEXT,
    session_id   TEXT,
    model        TEXT,
    updated_at   INTEGER NOT NULL
  );
`;

function rowToState(row: Row): ChatState {
  return {
    chatId: row.chat_id,
    projectPath: row.project_path,
    sessionId: row.session_id,
    model: row.model,
    updatedAt: row.updated_at,
  };
}

export class ChatStateRepo {
  private getStmt: Database.Statement<[number]>;
  private upsertProjectStmt: Database.Statement;
  private upsertSessionStmt: Database.Statement;
  private upsertModelStmt: Database.Statement;
  private deleteStmt: Database.Statement<[number]>;

  constructor(private db: Database.Database) {
    db.exec(SCHEMA);
    this.getStmt = db.prepare("SELECT * FROM chat_state WHERE chat_id = ?");
    this.upsertProjectStmt = db.prepare(`
      INSERT INTO chat_state (chat_id, project_path, session_id, updated_at)
      VALUES (@chatId, @projectPath, @sessionId, @now)
      ON CONFLICT(chat_id) DO UPDATE SET
        project_path = excluded.project_path,
        session_id   = excluded.session_id,
        updated_at   = excluded.updated_at
    `);
    this.upsertSessionStmt = db.prepare(`
      INSERT INTO chat_state (chat_id, session_id, updated_at)
      VALUES (@chatId, @sessionId, @now)
      ON CONFLICT(chat_id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `);
    this.upsertModelStmt = db.prepare(`
      INSERT INTO chat_state (chat_id, model, updated_at)
      VALUES (@chatId, @model, @now)
      ON CONFLICT(chat_id) DO UPDATE SET
        model      = excluded.model,
        updated_at = excluded.updated_at
    `);
    this.deleteStmt = db.prepare("DELETE FROM chat_state WHERE chat_id = ?");
  }

  get(chatId: number): ChatState | null {
    const row = this.getStmt.get(chatId) as Row | undefined;
    return row ? rowToState(row) : null;
  }

  setProject(chatId: number, projectPath: string, sessionId: string): void {
    this.upsertProjectStmt.run({ chatId, projectPath, sessionId, now: Date.now() });
  }

  setSession(chatId: number, sessionId: string): void {
    this.upsertSessionStmt.run({ chatId, sessionId, now: Date.now() });
  }

  setModel(chatId: number, model: string): void {
    this.upsertModelStmt.run({ chatId, model, now: Date.now() });
  }

  clear(chatId: number): void {
    this.deleteStmt.run(chatId);
  }
}

export function openChatStateDb(filename: string): Database.Database {
  const require = createRequire(import.meta.url);
  const DatabaseCtor = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new DatabaseCtor(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
