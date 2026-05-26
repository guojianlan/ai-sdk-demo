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

const THREAD_ACTIVE_CONTEXT_SQL = `
  CREATE TABLE IF NOT EXISTS thread_active_context (
    thread_id            TEXT PRIMARY KEY,
    summary              TEXT NOT NULL,
    replacement_messages TEXT NOT NULL,
    compacted_count      INTEGER NOT NULL,
    source_message_count INTEGER NOT NULL,
    tokens_before        INTEGER NOT NULL,
    tokens_after         INTEGER NOT NULL,
    strategy             TEXT NOT NULL,
    updated_at           INTEGER NOT NULL
  );
`;

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
  // B1：会话级 PermissionMode（default / acceptEdits / bypassPermissions）。
  // 字段允许 NULL —— 老 thread 升级后默认值为 NULL，应用层读到 NULL 一律按
  // DEFAULT_PERMISSION_MODE = "default" 处理。新 INSERT 都会写入有效值。
  {
    version: 2,
    name: "add-permission-mode",
    sql: `ALTER TABLE threads ADD COLUMN permission_mode TEXT;`,
  },
  // P1：会话级 plan mode（codex 风格 collaboration mode）。布尔语义：
  // 0 = 关 / NULL = 关 / 1 = 开。NOT NULL DEFAULT 0 让老 thread 自动获得"关"。
  {
    version: 3,
    name: "add-plan-mode",
    sql: `ALTER TABLE threads ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;`,
  },
  // A2 Phase 1：跟踪每个 thread 的 jsonl 抽取游标 + 最后一次 Phase 1 时间。
  // - last_offset：jsonl 已抽到第几行，下次从 offset+1 开始
  // - last_phase1_at：方便 debug "上次跑过没"
  // - retry_count：连续失败计数（warn-only retry，超 3 次跳过避免死循环）
  {
    version: 4,
    name: "add-memory-extraction-state",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_extraction_state (
        thread_id      TEXT PRIMARY KEY,
        last_offset    INTEGER NOT NULL DEFAULT 0,
        last_phase1_at INTEGER,
        retry_count    INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL
      );
    `,
  },
  // A3 Phase 2：单行表（id=1）跟踪整合器状态。
  // - last_raw_hash：上次成功整合时 raw_memories.md 的 SHA256；hash 没变直接跳过 LLM 调用
  // - last_phase2_at：上次成功整合的时间戳
  // - retry_count：失败重试计数；触顶就摆烂等手动重试 / hash 自然变化
  {
    version: 5,
    name: "add-memory-consolidation-state",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_consolidation_state (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        last_raw_hash  TEXT,
        last_phase2_at INTEGER,
        retry_count    INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL
      );
    `,
  },
  // P4-c：Codex-style active model context。UI 全量 messages 仍保留在 messages 表；
  // agent 输入从这张表里的 replacement_messages 继续，避免用 compacted_count
  // 对可见 transcript 做脆弱切片。
  {
    version: 6,
    name: "add-thread-active-context",
    sql: THREAD_ACTIVE_CONTEXT_SQL,
  },
];

/** 启动时跑：把 user_version 推到 latest，途中遇到失败抛错。 */
export function applyMigrations(db: DatabaseType): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const targetVersion = MIGRATIONS.at(-1)?.version ?? 0;

  if (currentVersion >= targetVersion) {
    ensureSchemaInvariants(db);
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

  ensureSchemaInvariants(db);
}

/**
 * Dev hot reload or older experimental DBs can leave `user_version` ahead of
 * the actual schema. Keep invariants idempotent so a missing table is repaired
 * even when no numbered migration is considered pending.
 */
function ensureSchemaInvariants(db: DatabaseType): void {
  db.exec(THREAD_ACTIVE_CONTEXT_SQL);
}
