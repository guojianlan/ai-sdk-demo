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

/**
 * 启动时一次性清掉所有 active_stream_id —— 因为 local chat run id 是进程内的，
 * **dev server 一重启就全失效**。残留下来会让 `reconcileExistingActiveStream`
 * 去等待一个不存在的本地 run，表现就是新 chat 请求挂死。
 * 表现就是新 chat 请求挂死。
 *
 * 在 dev 形态下这是必需的清扫；production 形态下如果将来用持久化 run
 * runtime（重启后能恢复 run），这里要改成"按 process id 比对再清"。
 *
 * 调用点：`db.ts` 在 `applyMigrations` 之后调一次，即每个进程生命周期一次。
 */
export function clearStaleRuntimeOnBoot(): void {
  try {
    const result = getDb()
      .prepare(
        `UPDATE thread_runtime_state SET active_stream_id = NULL
         WHERE active_stream_id IS NOT NULL`,
      )
      .run();
    if (result.changes > 0) {
      console.log(
        `[persistence] cleared ${result.changes} stale active_stream_id rows on boot`,
      );
    }
  } catch (error) {
    console.warn(
      "[persistence] clearStaleRuntimeOnBoot failed (non-fatal):",
      error instanceof Error ? error.message : error,
    );
  }
}
