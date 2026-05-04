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
    chat_id              INTEGER PRIMARY KEY,
    project_path         TEXT,
    session_id           TEXT,
    model                TEXT,
    pinned_message_id    INTEGER,
    pin_paused           INTEGER NOT NULL DEFAULT 0,
    last_user_message_id INTEGER,
    updated_at           INTEGER NOT NULL
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

/**
 * Idempotent ALTER TABLE migration so DBs that pre-date the pinned-status
 * columns get them added on next boot. Each ALTER is guarded by a
 * PRAGMA table_info check so re-running this is a no-op.
 */
function migrateSchema(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(chat_state)")
    .all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("pinned_message_id")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN pinned_message_id INTEGER");
  }
  if (!colNames.has("pin_paused")) {
    db.exec(
      "ALTER TABLE chat_state ADD COLUMN pin_paused INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!colNames.has("last_user_message_id")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN last_user_message_id INTEGER");
  }
}

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
  private getPinnedStmt: Database.Statement<[number]>;
  private setPinnedStmt: Database.Statement;
  private getPausedStmt: Database.Statement<[number]>;
  private setPausedStmt: Database.Statement;
  private getLastUserStmt: Database.Statement<[number]>;
  private setLastUserStmt: Database.Statement;
  private ensureRowStmt: Database.Statement;

  constructor(private db: Database.Database) {
    db.exec(SCHEMA);
    migrateSchema(db);
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
    this.getPinnedStmt = db.prepare(
      "SELECT pinned_message_id FROM chat_state WHERE chat_id = ?",
    );
    this.setPinnedStmt = db.prepare(
      "UPDATE chat_state SET pinned_message_id = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getPausedStmt = db.prepare(
      "SELECT pin_paused FROM chat_state WHERE chat_id = ?",
    );
    this.setPausedStmt = db.prepare(
      "UPDATE chat_state SET pin_paused = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getLastUserStmt = db.prepare(
      "SELECT last_user_message_id FROM chat_state WHERE chat_id = ?",
    );
    this.setLastUserStmt = db.prepare(
      "UPDATE chat_state SET last_user_message_id = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.ensureRowStmt = db.prepare(
      "INSERT OR IGNORE INTO chat_state (chat_id, updated_at) VALUES (?, ?)",
    );
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

  /**
   * Telegram message_id of the bot's pinned status message for this chat,
   * or null if none exists yet.
   */
  getPinnedMessageId(chatId: number): number | null {
    const row = this.getPinnedStmt.get(chatId) as
      | { pinned_message_id: number | null }
      | undefined;
    return row?.pinned_message_id ?? null;
  }

  /**
   * Persist the message_id of the pinned status message. Pass null to
   * clear it (e.g. after the message has been deleted).
   */
  setPinnedMessageId(chatId: number, messageId: number | null): void {
    this.ensureRow(chatId);
    this.setPinnedStmt.run(messageId, Date.now(), chatId);
  }

  /**
   * Whether automatic pin updates are paused for this chat (e.g. after
   * /unpin or after a sendMessage/pin failure).
   */
  getPinPaused(chatId: number): boolean {
    const row = this.getPausedStmt.get(chatId) as
      | { pin_paused: number }
      | undefined;
    return Boolean(row?.pin_paused);
  }

  setPinPaused(chatId: number, paused: boolean): void {
    this.ensureRow(chatId);
    this.setPausedStmt.run(paused ? 1 : 0, Date.now(), chatId);
  }

  /**
   * Telegram message_id of the most recent user-sent message for this chat,
   * used to scope reactions and follow-up edits.
   */
  getLastUserMessageId(chatId: number): number | null {
    const row = this.getLastUserStmt.get(chatId) as
      | { last_user_message_id: number | null }
      | undefined;
    return row?.last_user_message_id ?? null;
  }

  setLastUserMessageId(chatId: number, messageId: number): void {
    this.ensureRow(chatId);
    this.setLastUserStmt.run(messageId, Date.now(), chatId);
  }

  /**
   * Insert an empty row for chatId if none exists, so subsequent UPDATE
   * statements have a row to hit. Idempotent via INSERT OR IGNORE.
   */
  private ensureRow(chatId: number): void {
    this.ensureRowStmt.run(chatId, Date.now());
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
