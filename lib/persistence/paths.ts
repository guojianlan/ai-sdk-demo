import path from "node:path";

import { env } from "@/lib/env";

/**
 * 持久化层的路径计算 —— 全部派生自 `env.storageDir`，方便集中切换存储位置。
 *
 * 目录约定（codex / claude-code 同型）：
 *   <storageDir>/
 *   ├── agent.db                            SQLite 元数据索引
 *   └── sessions/YYYY/MM/DD/
 *       └── <thread-id>.jsonl               会话源真相
 *
 * 按"创建日期"分层目录是为了避免 `sessions/` 下文件爆炸——单目录上万文件
 * 在某些 fs 上 readdir / ls 会变慢。每天一个子目录是 codex 的实测做法。
 */

export function getStorageDir(): string {
  return env.storageDir;
}

export function getDbPath(): string {
  return path.join(env.storageDir, "agent.db");
}

/**
 * 用 thread 的创建时间（毫秒 epoch）算出 jsonl 文件路径。
 * 同一个 thread 永远落到同一个 YYYY/MM/DD 目录里，重启/重连都能找回——
 * 不能用 "now" 算，否则每次调用得到不同路径。
 */
export function getSessionFilePath(
  threadId: string,
  createdAtMs: number,
): string {
  const date = new Date(createdAtMs);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return path.join(
    env.storageDir,
    "sessions",
    yyyy,
    mm,
    dd,
    `${threadId}.jsonl`,
  );
}
