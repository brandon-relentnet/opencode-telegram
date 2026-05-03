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
  CREATE TABLE IF NOT EXISTS coolify_app (
    chat_id      INTEGER NOT NULL,
    project_path TEXT NOT NULL,
    app_uuid     TEXT NOT NULL,
    fqdn         TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (chat_id, project_path)
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
  private distinctPathsStmt: Database.Statement;
  private upsertProjectStmt: Database.Statement;
  private upsertSessionStmt: Database.Statement;
  private upsertModelStmt: Database.Statement;
  private deleteStmt: Database.Statement<[number]>;
  private getCoolifyAppStmt: Database.Statement<[number, string]>;
  private upsertCoolifyAppStmt: Database.Statement;
  private deleteCoolifyAppStmt: Database.Statement<[number, string]>;

  constructor(private db: Database.Database) {
    db.exec(SCHEMA);
    this.getStmt = db.prepare("SELECT * FROM chat_state WHERE chat_id = ?");
    this.distinctPathsStmt = db.prepare(
      "SELECT DISTINCT project_path FROM chat_state WHERE project_path IS NOT NULL ORDER BY project_path",
    );
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
    this.getCoolifyAppStmt = db.prepare(
      "SELECT app_uuid, fqdn FROM coolify_app WHERE chat_id = ? AND project_path = ?",
    );
    this.deleteCoolifyAppStmt = db.prepare(
      "DELETE FROM coolify_app WHERE chat_id = ? AND project_path = ?",
    );
    this.upsertCoolifyAppStmt = db.prepare(`
      INSERT INTO coolify_app (chat_id, project_path, app_uuid, fqdn, updated_at)
      VALUES (@chatId, @projectPath, @appUuid, @fqdn, @now)
      ON CONFLICT(chat_id, project_path) DO UPDATE SET
        app_uuid   = excluded.app_uuid,
        fqdn       = excluded.fqdn,
        updated_at = excluded.updated_at
    `);
  }

  get(chatId: number): ChatState | null {
    const row = this.getStmt.get(chatId) as Row | undefined;
    return row ? rowToState(row) : null;
  }

  /**
   * Return every distinct, non-null project_path the bridge has ever seen.
   * Used at boot to seed EventRouter SSE subscriptions for known projects so
   * resumed chats start receiving session events immediately.
   */
  getDistinctProjectPaths(): string[] {
    const rows = this.distinctPathsStmt.all() as Array<{ project_path: string }>;
    return rows.map((r) => r.project_path);
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

  /**
   * Look up the Coolify application UUID + FQDN previously set for this
   * (chat, project) pair. Returns null if /deploy has never been run for
   * this combination.
   */
  getCoolifyApp(chatId: number, projectPath: string): { uuid: string; fqdn: string } | null {
    const row = this.getCoolifyAppStmt.get(chatId, projectPath) as
      | { app_uuid: string; fqdn: string }
      | undefined;
    return row ? { uuid: row.app_uuid, fqdn: row.fqdn } : null;
  }

  /**
   * Persist the Coolify app UUID + FQDN for this (chat, project) pair.
   * Used by /deploy after first-deploy succeeds. Idempotent on re-run
   * via UPSERT.
   */
  setCoolifyApp(chatId: number, projectPath: string, appUuid: string, fqdn: string): void {
    this.upsertCoolifyAppStmt.run({
      chatId,
      projectPath,
      appUuid,
      fqdn,
      now: Date.now(),
    });
  }

  /**
   * Remove the cached Coolify app reference for this (chat, project) pair.
   * Used when /deploy detects the cached app no longer exists in Coolify
   * (e.g. user deleted it via the Coolify UI). Subsequent /deploy will
   * re-create the app via the first-deploy path.
   */
  clearCoolifyApp(chatId: number, projectPath: string): void {
    this.deleteCoolifyAppStmt.run(chatId, projectPath);
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
