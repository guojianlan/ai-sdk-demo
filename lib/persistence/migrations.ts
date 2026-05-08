import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Schema migration —— 用 SQLite `PRAGMA user_version` 做版本号，启动时按序补缺。
 *
 * 设计参考 codex 的 state DB / claude-code 的 migrations/。每条 migration 一旦
 * **发布出去就不能再动**——已经在用户机器上 apply 过的版本号回不去了。新 schema
 * 改动一律往下加新版本，老版本只读。
 *
 * 用法：
 *   1. 改 schema → 加一条 `{ version: N+1, name: '...', sql: 'ALTER TABLE ...' }`
 *   2. 用户下次启动 → 自动 apply，user_version 推到 N+1
 *   3. 已经在 N+1 的库 → IF (m.version > current) 跳过，幂等
 *
 * 注意：每条 migration 在事务里跑，失败回滚 + 不推进 user_version。但 SQLite 的
 * 一些 DDL（`ALTER TABLE ADD COLUMN`、`CREATE INDEX`）在事务里也是合法的。
 */

type Migration = {
  version: number;
  name: string;
  sql: string;
};

/**
 * 历史 migrations。**只追加，不修改**。
 *
 * 当前 schema：threads + messages + thread_summaries + thread_runtime_state，
 * threads 含完整的 9 列（workspace_*  / shell_approval_policy / title / ...）。
 *
 * v1 是"全新 fresh schema"——把所有当前结构一次性建出来。在 Phase 2/Phase 3
 * 的开发期我们删过几次 DB（schema 演化太快），用户机器上要么没库、要么早期
 * dev 残留。统一用 v1 收口，后面再加增量。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        workspace_name TEXT,
        workspace_access_mode TEXT,
        shell_approval_policy TEXT,
        title TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_threads_workspace ON threads(workspace_root);
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(archived_at);

      CREATE TABLE IF NOT EXISTS messages (
        thread_id  TEXT NOT NULL,
        message_id TEXT NOT NULL,
        position   INTEGER NOT NULL,
        role       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread_position
        ON messages(thread_id, position);

      CREATE TABLE IF NOT EXISTS thread_summaries (
        thread_id       TEXT PRIMARY KEY,
        summary         TEXT NOT NULL,
        compacted_count INTEGER NOT NULL,
        tokens_before   INTEGER NOT NULL,
        tokens_after    INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_runtime_state (
        thread_id        TEXT PRIMARY KEY,
        active_stream_id TEXT,
        updated_at       INTEGER NOT NULL
      );
    `,
  },
  // 下一条 migration 在这里追加，比如：
  // {
  //   version: 2,
  //   name: "add-thread-tags",
  //   sql: `ALTER TABLE threads ADD COLUMN tags TEXT;`,
  // },
];

/** 启动时跑：把 user_version 推到 latest，途中遇到失败抛错。 */
export function applyMigrations(db: DatabaseType): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const targetVersion = MIGRATIONS.at(-1)?.version ?? 0;

  if (currentVersion >= targetVersion) {
    return;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    try {
      // 事务里 exec + 推 version。失败 → 回滚 + 抛。
      // 注意 PRAGMA user_version 不是普通 SQL，better-sqlite3 用 `db.pragma()` 接口。
      const tx = db.transaction(() => {
        db.exec(migration.sql);
        db.pragma(`user_version = ${migration.version}`);
      });
      tx();
      console.log(
        `[persistence] migrated to v${migration.version} (${migration.name})`,
      );
    } catch (error) {
      throw new Error(
        `Migration v${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
