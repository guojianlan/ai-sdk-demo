import { getDb } from "./db";

/**
 * Chat runtime 状态 —— 移植自原 chat-store。
 *
 * `active_stream_id` 指向当前正在跑的 local chat run id；用于：
 * - 断流恢复：客户端 reconnect 时 server 检查这个值，能 resume 已有 run
 * - 并发冲突：第二个 POST 进来时检查，已有 run 在跑就拒绝
 *
 * 用 compare-and-set 保证多请求并发下的原子性（不依赖外部锁）。
 */

type RuntimeRow = {
  active_stream_id: string | null;
};

export type ChatRunStatus =
  | "running"
  | "finished"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ChatRunRecord = {
  id: string;
  threadId: string;
  status: ChatRunStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

type ChatRunRow = {
  id: string;
  thread_id: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

function rowToChatRun(row: ChatRunRow): ChatRunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: normalizeChatRunStatus(row.status),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function getActiveStreamId(threadId: string): string | null {
  const row = getDb()
    .prepare<[string], RuntimeRow>(
      `SELECT active_stream_id
         FROM thread_runtime_state
        WHERE thread_id = ?`,
    )
    .get(threadId);
  return row?.active_stream_id ?? null;
}

export function setActiveStreamId(
  threadId: string,
  activeStreamId: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO thread_runtime_state
         (thread_id, active_stream_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         active_stream_id = excluded.active_stream_id,
         updated_at       = excluded.updated_at`,
    )
    .run(threadId, activeStreamId, Date.now());
}

/**
 * Compare-and-set：仅当当前值 == expectedStreamId 时更新成 nextStreamId。
 * 返回是否真的改了。`expectedStreamId === null` 时还要处理"行不存在"的情况
 * （插入新行也算成功）。
 */
export function compareAndSetActiveStreamId(
  threadId: string,
  expectedStreamId: string | null,
  nextStreamId: string | null,
): boolean {
  const db = getDb();
  const now = Date.now();

  if (expectedStreamId === null) {
    const result = db
      .prepare(
        `INSERT INTO thread_runtime_state
           (thread_id, active_stream_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           active_stream_id = excluded.active_stream_id,
           updated_at       = excluded.updated_at
         WHERE thread_runtime_state.active_stream_id IS NULL`,
      )
      .run(threadId, nextStreamId, now);
    return result.changes > 0;
  }

  const result = db
    .prepare(
      `UPDATE thread_runtime_state
          SET active_stream_id = ?,
              updated_at       = ?
        WHERE thread_id = ?
          AND active_stream_id = ?`,
    )
    .run(nextStreamId, now, threadId, expectedStreamId);

  return result.changes > 0;
}

export function deleteRuntimeState(threadId: string): void {
  getDb()
    .prepare(`DELETE FROM thread_runtime_state WHERE thread_id = ?`)
    .run(threadId);
}

export function createChatRunRecord(opts: {
  id: string;
  threadId: string;
  status?: ChatRunStatus;
}): ChatRunRecord {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO chat_runs
         (id, thread_id, status, error, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         thread_id = excluded.thread_id,
         status = excluded.status,
         error = NULL,
         updated_at = excluded.updated_at,
         finished_at = NULL`,
    )
    .run(opts.id, opts.threadId, opts.status ?? "running", now, now);
  return getChatRunRecord(opts.id);
}

export function getChatRunRecord(runId: string): ChatRunRecord {
  const row = getDb()
    .prepare<[string], ChatRunRow>(`SELECT * FROM chat_runs WHERE id = ?`)
    .get(runId);
  if (!row) throw new Error("Chat run not found.");
  return rowToChatRun(row);
}

export function listChatRunRecords(threadId: string): ChatRunRecord[] {
  const rows = getDb()
    .prepare<[string], ChatRunRow>(
      `SELECT * FROM chat_runs
        WHERE thread_id = ?
        ORDER BY created_at DESC`,
    )
    .all(threadId);
  return rows.map(rowToChatRun);
}

export function finishChatRunRecord(opts: {
  id: string;
  status: Exclude<ChatRunStatus, "running">;
  error?: string | null;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE chat_runs
          SET status = ?,
              error = ?,
              updated_at = ?,
              finished_at = ?
        WHERE id = ?`,
    )
    .run(opts.status, opts.error ?? null, now, now, opts.id);
}

/**
 * 启动时一次性中断所有未完成 chat run 并清掉 active_stream_id。
 * live stream reader/subscriber 仍是进程内资源，dev server 一重启就全失效；
 * SQLite 负责保留 run metadata，让历史上"为什么没法继续 live replay"有证据。
 *
 * 在 dev 形态下这是必需的清扫；production 形态下如果将来用持久化 run
 * runtime（重启后能恢复 run），这里要改成"按 process id 比对再清"。
 *
 * 调用点：`db.ts` 在 `applyMigrations` 之后调一次，即每个进程生命周期一次。
 */
export function clearStaleRuntimeOnBoot(): void {
  try {
    const db = getDb();
    const now = Date.now();
    const interrupted = db
      .prepare(
        `UPDATE chat_runs
            SET status = 'interrupted',
                error = COALESCE(error, 'Process restarted before the local stream finished.'),
                updated_at = ?,
                finished_at = ?
          WHERE status = 'running'`,
      )
      .run(now, now);
    const cleared = db
      .prepare(
        `UPDATE thread_runtime_state SET active_stream_id = NULL
         WHERE active_stream_id IS NOT NULL`,
      )
      .run();
    if (cleared.changes > 0 || interrupted.changes > 0) {
      console.log(
        `[persistence] interrupted ${interrupted.changes} stale chat run(s) and cleared ${cleared.changes} active_stream_id row(s) on boot`,
      );
    }
  } catch (error) {
    console.warn(
      "[persistence] clearStaleRuntimeOnBoot failed (non-fatal):",
      error instanceof Error ? error.message : error,
    );
  }
}

function normalizeChatRunStatus(status: string): ChatRunStatus {
  return status === "finished" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
    ? status
    : "running";
}
