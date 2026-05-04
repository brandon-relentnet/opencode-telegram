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
    chat_id                       INTEGER PRIMARY KEY,
    project_path                  TEXT,
    session_id                    TEXT,
    model                         TEXT,
    pinned_message_id             INTEGER,
    pin_paused                    INTEGER NOT NULL DEFAULT 0,
    last_user_message_id          INTEGER,
    session_slug                  TEXT,
    branch                        TEXT,
    agent_mode                    TEXT,
    cumulative_tokens_input       INTEGER NOT NULL DEFAULT 0,
    cumulative_tokens_output      INTEGER NOT NULL DEFAULT 0,
    cumulative_tokens_reasoning   INTEGER NOT NULL DEFAULT 0,
    cumulative_tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
    cumulative_tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    cumulative_cost_micros        INTEGER NOT NULL DEFAULT 0,
    context_limit                 INTEGER,
    session_started_at            INTEGER,
    last_activity_at              INTEGER,
    last_deploy_at                INTEGER,
    updated_at                    INTEGER NOT NULL
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
  // Info-density additions:
  if (!colNames.has("session_slug")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN session_slug TEXT");
  }
  if (!colNames.has("branch")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN branch TEXT");
  }
  if (!colNames.has("agent_mode")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN agent_mode TEXT");
  }
  if (!colNames.has("cumulative_tokens_input")) {
    db.exec(
      "ALTER TABLE chat_state ADD COLUMN cumulative_tokens_input INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!colNames.has("cumulative_tokens_output")) {
    db.exec(
      "ALTER TABLE chat_state ADD COLUMN cumulative_tokens_output INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!colNames.has("cumulative_tokens_reasoning")) {
    db.exec(
      "ALTER TABLE chat_state ADD COLUMN cumulative_tokens_reasoning INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!colNames.has("cumulative_tokens_cache_read")) {
    db.exec(
      "ALTER TABLE chat_state ADD COLUMN cumulative_tokens_cache_read INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!colNames.has("cumulative_tokens_cache_write")) {
    db.exec(
      "ALTER TABLE chat_state ADD COLUMN cumulative_tokens_cache_write INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!colNames.has("cumulative_cost_micros")) {
    db.exec(
      "ALTER TABLE chat_state ADD COLUMN cumulative_cost_micros INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!colNames.has("context_limit")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN context_limit INTEGER");
  }
  if (!colNames.has("session_started_at")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN session_started_at INTEGER");
  }
  if (!colNames.has("last_activity_at")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN last_activity_at INTEGER");
  }
  if (!colNames.has("last_deploy_at")) {
    db.exec("ALTER TABLE chat_state ADD COLUMN last_deploy_at INTEGER");
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
  private getSessionSlugStmt: Database.Statement<[number]>;
  private setSessionSlugStmt: Database.Statement;
  private getBranchStmt: Database.Statement<[number]>;
  private setBranchStmt: Database.Statement;
  private getAgentModeStmt: Database.Statement<[number]>;
  private setAgentModeStmt: Database.Statement;
  private getCumulativeStatsStmt: Database.Statement<[number]>;
  private incrementCumulativeStatsStmt: Database.Statement;
  private resetCumulativeStatsStmt: Database.Statement;
  private getContextLimitStmt: Database.Statement<[number]>;
  private setContextLimitStmt: Database.Statement;
  private getSessionStartedAtStmt: Database.Statement<[number]>;
  private setSessionStartedAtStmt: Database.Statement;
  private getLastDeployAtStmt: Database.Statement<[number]>;
  private setLastDeployAtStmt: Database.Statement;
  private getLastActivityAtStmt: Database.Statement<[number]>;
  private setLastActivityAtStmt: Database.Statement;
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
    this.getSessionSlugStmt = db.prepare(
      "SELECT session_slug FROM chat_state WHERE chat_id = ?",
    );
    this.setSessionSlugStmt = db.prepare(
      "UPDATE chat_state SET session_slug = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getBranchStmt = db.prepare(
      "SELECT branch FROM chat_state WHERE chat_id = ?",
    );
    this.setBranchStmt = db.prepare(
      "UPDATE chat_state SET branch = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getAgentModeStmt = db.prepare(
      "SELECT agent_mode FROM chat_state WHERE chat_id = ?",
    );
    this.setAgentModeStmt = db.prepare(
      "UPDATE chat_state SET agent_mode = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getCumulativeStatsStmt = db.prepare(`
      SELECT cumulative_tokens_input, cumulative_tokens_output, cumulative_tokens_reasoning,
             cumulative_tokens_cache_read, cumulative_tokens_cache_write, cumulative_cost_micros
      FROM chat_state WHERE chat_id = ?
    `);
    this.incrementCumulativeStatsStmt = db.prepare(`
      UPDATE chat_state SET
        cumulative_tokens_input       = cumulative_tokens_input + @ti,
        cumulative_tokens_output      = cumulative_tokens_output + @to,
        cumulative_tokens_reasoning   = cumulative_tokens_reasoning + @tr,
        cumulative_tokens_cache_read  = cumulative_tokens_cache_read + @tcr,
        cumulative_tokens_cache_write = cumulative_tokens_cache_write + @tcw,
        cumulative_cost_micros        = cumulative_cost_micros + @cm,
        updated_at                    = @now
      WHERE chat_id = @chatId
    `);
    this.resetCumulativeStatsStmt = db.prepare(`
      UPDATE chat_state SET
        cumulative_tokens_input = 0, cumulative_tokens_output = 0,
        cumulative_tokens_reasoning = 0, cumulative_tokens_cache_read = 0,
        cumulative_tokens_cache_write = 0, cumulative_cost_micros = 0,
        updated_at = ?
      WHERE chat_id = ?
    `);
    this.getContextLimitStmt = db.prepare(
      "SELECT context_limit FROM chat_state WHERE chat_id = ?",
    );
    this.setContextLimitStmt = db.prepare(
      "UPDATE chat_state SET context_limit = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getSessionStartedAtStmt = db.prepare(
      "SELECT session_started_at FROM chat_state WHERE chat_id = ?",
    );
    this.setSessionStartedAtStmt = db.prepare(
      "UPDATE chat_state SET session_started_at = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getLastDeployAtStmt = db.prepare(
      "SELECT last_deploy_at FROM chat_state WHERE chat_id = ?",
    );
    this.setLastDeployAtStmt = db.prepare(
      "UPDATE chat_state SET last_deploy_at = ?, updated_at = ? WHERE chat_id = ?",
    );
    this.getLastActivityAtStmt = db.prepare(
      "SELECT last_activity_at FROM chat_state WHERE chat_id = ?",
    );
    this.setLastActivityAtStmt = db.prepare(
      "UPDATE chat_state SET last_activity_at = ?, updated_at = ? WHERE chat_id = ?",
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
   * opencode-assigned slug for the current session (e.g. "clever-meadow").
   * Used to identify sessions in the UI when raw IDs are too noisy.
   */
  getSessionSlug(chatId: number): string | null {
    const row = this.getSessionSlugStmt.get(chatId) as
      | { session_slug: string | null }
      | undefined;
    return row?.session_slug ?? null;
  }

  setSessionSlug(chatId: number, slug: string | null): void {
    this.ensureRow(chatId);
    this.setSessionSlugStmt.run(slug, Date.now(), chatId);
  }

  /**
   * Current git branch of the chat's project (refreshed on pinned-status
   * flushes). Null when the project is not a git repo or detection fails.
   */
  getBranch(chatId: number): string | null {
    const row = this.getBranchStmt.get(chatId) as
      | { branch: string | null }
      | undefined;
    return row?.branch ?? null;
  }

  setBranch(chatId: number, branch: string | null): void {
    this.ensureRow(chatId);
    this.setBranchStmt.run(branch, Date.now(), chatId);
  }

  /**
   * Last-known opencode agent mode (e.g. "build", "plan", "review") for
   * the current session, captured from message.created events.
   */
  getAgentMode(chatId: number): string | null {
    const row = this.getAgentModeStmt.get(chatId) as
      | { agent_mode: string | null }
      | undefined;
    return row?.agent_mode ?? null;
  }

  setAgentMode(chatId: number, mode: string | null): void {
    this.ensureRow(chatId);
    this.setAgentModeStmt.run(mode, Date.now(), chatId);
  }

  /**
   * Cumulative token + cost counters for the current session. Returned as
   * zeros for chats without a row so callers don't need to null-check.
   */
  getCumulativeStats(chatId: number): {
    tokensInput: number;
    tokensOutput: number;
    tokensReasoning: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    costMicros: number;
  } {
    const row = this.getCumulativeStatsStmt.get(chatId) as
      | {
          cumulative_tokens_input: number;
          cumulative_tokens_output: number;
          cumulative_tokens_reasoning: number;
          cumulative_tokens_cache_read: number;
          cumulative_tokens_cache_write: number;
          cumulative_cost_micros: number;
        }
      | undefined;
    if (!row) {
      return {
        tokensInput: 0,
        tokensOutput: 0,
        tokensReasoning: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        costMicros: 0,
      };
    }
    return {
      tokensInput: row.cumulative_tokens_input,
      tokensOutput: row.cumulative_tokens_output,
      tokensReasoning: row.cumulative_tokens_reasoning,
      tokensCacheRead: row.cumulative_tokens_cache_read,
      tokensCacheWrite: row.cumulative_tokens_cache_write,
      costMicros: row.cumulative_cost_micros,
    };
  }

  /**
   * Atomically add deltas to the cumulative counters. Cost is in 1e-6 USD
   * (micros) so we never have to sum floats.
   */
  incrementCumulativeStats(
    chatId: number,
    delta: {
      tokensInput: number;
      tokensOutput: number;
      tokensReasoning: number;
      tokensCacheRead: number;
      tokensCacheWrite: number;
      costMicros: number;
    },
  ): void {
    this.ensureRow(chatId);
    this.incrementCumulativeStatsStmt.run({
      ti: delta.tokensInput,
      to: delta.tokensOutput,
      tr: delta.tokensReasoning,
      tcr: delta.tokensCacheRead,
      tcw: delta.tokensCacheWrite,
      cm: delta.costMicros,
      now: Date.now(),
      chatId,
    });
  }

  /**
   * Zero out all cumulative counters for this chat. Called on /new and
   * /switch so each session starts with a clean slate.
   */
  resetCumulativeStats(chatId: number): void {
    this.ensureRow(chatId);
    this.resetCumulativeStatsStmt.run(Date.now(), chatId);
  }

  /**
   * Model context-window size (tokens) cached so /info and the pinned
   * header can render % used without re-querying /provider every flush.
   */
  getContextLimit(chatId: number): number | null {
    const row = this.getContextLimitStmt.get(chatId) as
      | { context_limit: number | null }
      | undefined;
    return row?.context_limit ?? null;
  }

  setContextLimit(chatId: number, limit: number | null): void {
    this.ensureRow(chatId);
    this.setContextLimitStmt.run(limit, Date.now(), chatId);
  }

  /** Unix-millis timestamp of when the current session was created. */
  getSessionStartedAt(chatId: number): number | null {
    const row = this.getSessionStartedAtStmt.get(chatId) as
      | { session_started_at: number | null }
      | undefined;
    return row?.session_started_at ?? null;
  }

  setSessionStartedAt(chatId: number, ts: number | null): void {
    this.ensureRow(chatId);
    this.setSessionStartedAtStmt.run(ts, Date.now(), chatId);
  }

  /** Unix-millis timestamp of the last successful /deploy for this chat. */
  getLastDeployAt(chatId: number): number | null {
    const row = this.getLastDeployAtStmt.get(chatId) as
      | { last_deploy_at: number | null }
      | undefined;
    return row?.last_deploy_at ?? null;
  }

  setLastDeployAt(chatId: number, ts: number | null): void {
    this.ensureRow(chatId);
    this.setLastDeployAtStmt.run(ts, Date.now(), chatId);
  }

  /**
   * Unix-millis timestamp of the most recent assistant or system event for
   * this chat. Bumped on every message.created (regardless of role) so the
   * pinned-status / /info "last activity" line always reflects the freshest
   * signal even if the user hasn't actively driven it.
   */
  getLastActivityAt(chatId: number): number | null {
    const row = this.getLastActivityAtStmt.get(chatId) as
      | { last_activity_at: number | null }
      | undefined;
    return row?.last_activity_at ?? null;
  }

  setLastActivityAt(chatId: number, ts: number | null): void {
    this.ensureRow(chatId);
    this.setLastActivityAtStmt.run(ts, Date.now(), chatId);
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
