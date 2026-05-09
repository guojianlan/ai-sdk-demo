import { getDb } from "@/lib/persistence/db";

/**
 * Memory 抽取游标的 DB 操作 —— Phase 1 用。
 *
 * 表结构详见 `lib/persistence/migrations.ts` v4：
 *   memory_extraction_state(thread_id, last_offset, last_phase1_at, retry_count, updated_at)
 *
 * 语义：
 * - last_offset：jsonl 已抽到第几行；下次从这之后开始读
 * - retry_count：连续失败计数；上限触顶后该 thread 跳过抽取（避免死循环）
 *   成功一次就 reset 为 0
 * - last_phase1_at：上次成功 Phase 1 的时间（unix ms），debug 用
 *
 * 为什么用 SQLite 不用文件：游标读写是高频小数据，DB 比 fs read/write 快也更原子。
 */

export const EXTRACTION_RETRY_CAP = 3;

type ExtractionRow = {
  thread_id: string;
  last_offset: number;
  last_phase1_at: number | null;
  retry_count: number;
  updated_at: number;
};

export type ExtractionState = {
  threadId: string;
  lastOffset: number;
  lastPhase1At: number | null;
  retryCount: number;
};

function rowToState(row: ExtractionRow): ExtractionState {
  return {
    threadId: row.thread_id,
    lastOffset: row.last_offset,
    lastPhase1At: row.last_phase1_at,
    retryCount: row.retry_count,
  };
}

/**
 * 读取某 thread 的抽取游标。没有就返回默认（offset=0, retry=0）—— 表示还没跑过 Phase 1。
 */
export function getExtractionState(threadId: string): ExtractionState {
  const row = getDb()
    .prepare<[string], ExtractionRow>(
      `SELECT * FROM memory_extraction_state WHERE thread_id = ?`,
    )
    .get(threadId);
  if (row) return rowToState(row);
  return {
    threadId,
    lastOffset: 0,
    lastPhase1At: null,
    retryCount: 0,
  };
}

/**
 * Phase 1 成功后调：推进游标 + 重置 retry。
 *
 * 用 UPSERT 让"thread 第一次跑"的 case 一行 SQL 搞定。
 */
export function recordExtractionSuccess(
  threadId: string,
  newOffset: number,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO memory_extraction_state
         (thread_id, last_offset, last_phase1_at, retry_count, updated_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         last_offset    = excluded.last_offset,
         last_phase1_at = excluded.last_phase1_at,
         retry_count    = 0,
         updated_at     = excluded.updated_at`,
    )
    .run(threadId, newOffset, now, now);
}

/**
 * Phase 1 失败后调：retry_count + 1，offset 不动（下次重试同一段输入）。
 *
 * 调用方应该先看 retry_count 是不是已经达 EXTRACTION_RETRY_CAP，达到的话直接
 * 跳过抽取（这条 thread 暂时摆烂，避免每次都浪费 LLM 调用）。
 */
export function recordExtractionFailure(threadId: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO memory_extraction_state
         (thread_id, last_offset, last_phase1_at, retry_count, updated_at)
       VALUES (?, 0, NULL, 1, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         retry_count = retry_count + 1,
         updated_at  = excluded.updated_at`,
    )
    .run(threadId, now);
}

/** 测试用：手动重置某 thread 的状态（删除整行）。 */
export function deleteExtractionState(threadId: string): void {
  getDb()
    .prepare(`DELETE FROM memory_extraction_state WHERE thread_id = ?`)
    .run(threadId);
}

// ============================================================
// A3 Phase 2 整合器状态（单行表 id=1）
// ============================================================

export const CONSOLIDATION_RETRY_CAP = 3;

type ConsolidationRow = {
  id: number;
  last_raw_hash: string | null;
  last_phase2_at: number | null;
  retry_count: number;
  updated_at: number;
};

export type ConsolidationState = {
  lastRawHash: string | null;
  lastPhase2At: number | null;
  retryCount: number;
};

/** 读取整合器状态。表里没行（首次 Phase 2 之前）→ 返回默认值。 */
export function getConsolidationState(): ConsolidationState {
  const row = getDb()
    .prepare<[], ConsolidationRow>(
      `SELECT * FROM memory_consolidation_state WHERE id = 1`,
    )
    .get();
  if (row) {
    return {
      lastRawHash: row.last_raw_hash,
      lastPhase2At: row.last_phase2_at,
      retryCount: row.retry_count,
    };
  }
  return { lastRawHash: null, lastPhase2At: null, retryCount: 0 };
}

/**
 * Phase 2 成功后调：写入新的 raw hash + 重置 retry。
 *
 * UPSERT 让"第一次"的 case 一行 SQL 搞定（id=1 主键）。
 */
export function recordConsolidationSuccess(rawHash: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO memory_consolidation_state
         (id, last_raw_hash, last_phase2_at, retry_count, updated_at)
       VALUES (1, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_raw_hash  = excluded.last_raw_hash,
         last_phase2_at = excluded.last_phase2_at,
         retry_count    = 0,
         updated_at     = excluded.updated_at`,
    )
    .run(rawHash, now, now);
}

/** Phase 2 失败后调：retry_count++。 */
export function recordConsolidationFailure(): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO memory_consolidation_state
         (id, last_raw_hash, last_phase2_at, retry_count, updated_at)
       VALUES (1, NULL, NULL, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         retry_count = retry_count + 1,
         updated_at  = excluded.updated_at`,
    )
    .run(now);
}

/** 测试 / 手动重置整合器状态（删整行 → 下次 Phase 2 当首次跑）。 */
export function deleteConsolidationState(): void {
  getDb()
    .prepare(`DELETE FROM memory_consolidation_state WHERE id = 1`)
    .run();
}
