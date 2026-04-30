import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import type { UIMessage } from "ai";

/**
 * P3-b 持久化层：按 sessionId 存每条消息。
 *
 * 设计选择：
 * - SQLite via better-sqlite3（同步 API，零额外服务，文件落 `.data/chat.db`）
 * - 一行一条消息，position 排序；save 时整段 replace（transactional）
 *   → 简单，且 UIMessage 的 parts 在流式过程中会变化，整段覆盖最直观
 * - 只存消息；session 元数据（title/workspace/审批）继续在 localStorage，
 *   没必要现在就把 session 列表也搬来
 */

const DB_DIR = path.resolve(process.cwd(), ".data");
const DB_PATH = path.join(DB_DIR, "chat.db");

let dbSingleton: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbSingleton) return dbSingleton;
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      position   INTEGER NOT NULL,
      role       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_position
      ON messages(session_id, position);

    -- P4-b: 每个 session 至多一行 summary。schema 里 compacted_count 记录
    -- 这段摘要对应原 history 的前多少条，方便 debug "哪些老消息被吃掉了"。
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id      TEXT PRIMARY KEY,
      summary         TEXT NOT NULL,
      compacted_count INTEGER NOT NULL,
      tokens_before   INTEGER NOT NULL,
      tokens_after    INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    -- Workflow runtime state is intentionally separate from messages. The
    -- active stream id points at the durable workflow run that can be resumed
    -- or cancelled after the original POST request is gone.
    CREATE TABLE IF NOT EXISTS chat_runtime_state (
      session_id       TEXT PRIMARY KEY,
      active_stream_id TEXT,
      updated_at       INTEGER NOT NULL
    );
  `);
  dbSingleton = db;
  return db;
}

export function loadMessages(sessionId: string): UIMessage[] {
  const rows = getDb()
    .prepare<[string], { payload: string }>(
      "SELECT payload FROM messages WHERE session_id = ? ORDER BY position ASC",
    )
    .all(sessionId);
  return rows.map((row) => JSON.parse(row.payload) as UIMessage);
}

export function saveMessages(sessionId: string, messages: UIMessage[]): void {
  const db = getDb();
  const del = db.prepare("DELETE FROM messages WHERE session_id = ?");
  const ins = db.prepare(
    `INSERT INTO messages (session_id, message_id, position, role, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  const tx = db.transaction((list: UIMessage[]) => {
    del.run(sessionId);
    list.forEach((message, index) => {
      ins.run(
        sessionId,
        message.id,
        index,
        message.role,
        JSON.stringify(message),
        now,
      );
    });
  });
  tx(messages);
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(
      sessionId,
    );
    db.prepare("DELETE FROM chat_runtime_state WHERE session_id = ?").run(
      sessionId,
    );
  })();
}

// --- P4-b summary persistence ------------------------------------------

export type SessionSummary = {
  summary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
};

export function loadSummary(sessionId: string): SessionSummary | null {
  const row = getDb()
    .prepare<
      [string],
      {
        summary: string;
        compacted_count: number;
        tokens_before: number;
        tokens_after: number;
      }
    >(
      `SELECT summary, compacted_count, tokens_before, tokens_after
         FROM session_summaries
        WHERE session_id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  return {
    summary: row.summary,
    compactedCount: row.compacted_count,
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
  };
}

export function saveSummary(
  sessionId: string,
  summary: SessionSummary,
): void {
  getDb()
    .prepare(
      `INSERT INTO session_summaries
         (session_id, summary, compacted_count, tokens_before, tokens_after, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         summary         = excluded.summary,
         compacted_count = excluded.compacted_count,
         tokens_before   = excluded.tokens_before,
         tokens_after    = excluded.tokens_after,
         updated_at      = excluded.updated_at`,
    )
    .run(
      sessionId,
      summary.summary,
      summary.compactedCount,
      summary.tokensBefore,
      summary.tokensAfter,
      Date.now(),
    );
}

// --- Workflow active stream persistence --------------------------------

export function getActiveStreamId(sessionId: string): string | null {
  const row = getDb()
    .prepare<[string], { active_stream_id: string | null }>(
      `SELECT active_stream_id
         FROM chat_runtime_state
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return row?.active_stream_id ?? null;
}

export function setActiveStreamId(
  sessionId: string,
  activeStreamId: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO chat_runtime_state
         (session_id, active_stream_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         active_stream_id = excluded.active_stream_id,
         updated_at       = excluded.updated_at`,
    )
    .run(sessionId, activeStreamId, Date.now());
}

export function compareAndSetActiveStreamId(
  sessionId: string,
  expectedStreamId: string | null,
  nextStreamId: string | null,
): boolean {
  const db = getDb();
  const now = Date.now();

  if (expectedStreamId === null) {
    const result = db
      .prepare(
        `INSERT INTO chat_runtime_state
           (session_id, active_stream_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           active_stream_id = excluded.active_stream_id,
           updated_at       = excluded.updated_at
         WHERE chat_runtime_state.active_stream_id IS NULL`,
      )
      .run(sessionId, nextStreamId, now);
    return result.changes > 0;
  }

  const result = db
    .prepare(
      `UPDATE chat_runtime_state
          SET active_stream_id = ?,
              updated_at       = ?
        WHERE session_id = ?
          AND active_stream_id = ?`,
    )
    .run(nextStreamId, now, sessionId, expectedStreamId);

  return result.changes > 0;
}
