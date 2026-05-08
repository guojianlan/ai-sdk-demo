import fs from "node:fs";
import path from "node:path";

import Database, { type Database as DatabaseType } from "better-sqlite3";

import { applyMigrations } from "./migrations";
import { getDbPath, getStorageDir } from "./paths";

/**
 * 单例 better-sqlite3 实例。Next.js dev 下 module 偶尔会 hot-reload，
 * 这里靠 `globalThis` 做 leak-safe 的复用——多次 import 拿到同一个 DB 句柄，
 * 否则会出现"两个连接互相看不到对方写入"的 WAL 怪现象。
 *
 * 库选 better-sqlite3 的理由：同步 API（不污染 async 链）、Node-API prebuild、
 * claude-code 自己也用它。代价是 ESM 下 Next.js 必须把它放进
 * `serverExternalPackages`（next.config.ts 已配）。
 *
 * Schema 演化：所有 schema 改动走 `migrations.ts` 的版本化 migration，**不要**
 * 在这里写 CREATE TABLE。新加列 → 加一条 ALTER TABLE migration，启动时自动 apply。
 */

const GLOBAL_KEY = "__local_agent_sqlite__";
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: DatabaseType };

/**
 * 拿到 DB 句柄。第一次调用时会：
 *   1. 确保 storageDir 存在
 *   2. 打开 SQLite 文件
 *   3. 开 WAL 模式（多进程读 + 单进程写时崩溃恢复友好）
 *   4. 跑增量 migrations（按 user_version 推进）
 */
export function getDb(): DatabaseType {
  const g = globalThis as GlobalWithDb;
  if (g[GLOBAL_KEY]) {
    return g[GLOBAL_KEY];
  }

  fs.mkdirSync(getStorageDir(), { recursive: true });
  const dbPath = getDbPath();
  // 父目录已经在上面 mkdir 过；better-sqlite3 自己会建文件
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);

  // 启动时清掉 stale active_stream_id —— workflow run id 是进程内的，重启全失效。
  // 残留会让新 chat 请求在 reconcileExistingActiveStream 里 await 一个永远不存在的
  // run.status，表现成"chat 接口挂死"。详见 runtime.ts:clearStaleRuntimeOnBoot 注释。
  try {
    const result = db
      .prepare(
        `UPDATE thread_runtime_state SET active_stream_id = NULL
         WHERE active_stream_id IS NOT NULL`,
      )
      .run();
    if (result.changes > 0) {
      console.log(
        `[persistence] cleared ${result.changes} stale active_stream_id row(s) on boot`,
      );
    }
  } catch {
    // 表可能还不存在（极早期 migration 故障）；忽略不阻塞应用启动
  }

  g[GLOBAL_KEY] = db;
  return db;
}
