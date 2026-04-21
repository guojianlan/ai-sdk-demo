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
  getDb().prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
}
