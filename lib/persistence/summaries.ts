import { getDb } from "./db";

/**
 * Compaction summary 持久化 —— 移植自原 chat-store。
 *
 * 每个 thread 至多一条 summary。schema 里 `compacted_count` 记录这段摘要对应
 * 原 history 的前多少条，方便 debug "哪些老消息被吃掉了"。
 */

export type ThreadSummary = {
  summary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
};

type SummaryRow = {
  summary: string;
  compacted_count: number;
  tokens_before: number;
  tokens_after: number;
};

export function loadSummary(threadId: string): ThreadSummary | null {
  const row = getDb()
    .prepare<[string], SummaryRow>(
      `SELECT summary, compacted_count, tokens_before, tokens_after
         FROM thread_summaries
        WHERE thread_id = ?`,
    )
    .get(threadId);
  if (!row) return null;
  return {
    summary: row.summary,
    compactedCount: row.compacted_count,
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
  };
}

export function saveSummary(threadId: string, summary: ThreadSummary): void {
  getDb()
    .prepare(
      `INSERT INTO thread_summaries
         (thread_id, summary, compacted_count, tokens_before, tokens_after, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         summary         = excluded.summary,
         compacted_count = excluded.compacted_count,
         tokens_before   = excluded.tokens_before,
         tokens_after    = excluded.tokens_after,
         updated_at      = excluded.updated_at`,
    )
    .run(
      threadId,
      summary.summary,
      summary.compactedCount,
      summary.tokensBefore,
      summary.tokensAfter,
      Date.now(),
    );
}

export function deleteSummary(threadId: string): void {
  getDb()
    .prepare(`DELETE FROM thread_summaries WHERE thread_id = ?`)
    .run(threadId);
}
