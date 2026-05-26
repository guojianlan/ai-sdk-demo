import type { UIMessage } from "ai";

import type { CompactionStrategy } from "@/lib/compaction";

import { getDb } from "./db";

export type ThreadActiveContext = {
  summary: string;
  replacementMessages: UIMessage[];
  compactedCount: number;
  sourceMessageCount: number;
  tokensBefore: number;
  tokensAfter: number;
  strategy: CompactionStrategy;
};

type ActiveContextRow = {
  summary: string;
  replacement_messages: string;
  compacted_count: number;
  source_message_count: number;
  tokens_before: number;
  tokens_after: number;
  strategy: string;
};

function normalizeStrategy(value: string): CompactionStrategy {
  return value === "deterministic-fallback" ? value : "llm";
}

export function loadActiveContext(
  threadId: string,
): ThreadActiveContext | null {
  const row = getDb()
    .prepare<[string], ActiveContextRow>(
      `SELECT summary,
              replacement_messages,
              compacted_count,
              source_message_count,
              tokens_before,
              tokens_after,
              strategy
         FROM thread_active_context
        WHERE thread_id = ?`,
    )
    .get(threadId);
  if (!row) return null;

  return {
    summary: row.summary,
    replacementMessages: JSON.parse(row.replacement_messages) as UIMessage[],
    compactedCount: row.compacted_count,
    sourceMessageCount: row.source_message_count,
    tokensBefore: row.tokens_before,
    tokensAfter: row.tokens_after,
    strategy: normalizeStrategy(row.strategy),
  };
}

export function saveActiveContext(
  threadId: string,
  context: ThreadActiveContext,
): void {
  getDb()
    .prepare(
      `INSERT INTO thread_active_context
         (thread_id,
          summary,
          replacement_messages,
          compacted_count,
          source_message_count,
          tokens_before,
          tokens_after,
          strategy,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         summary              = excluded.summary,
         replacement_messages = excluded.replacement_messages,
         compacted_count      = excluded.compacted_count,
         source_message_count = excluded.source_message_count,
         tokens_before        = excluded.tokens_before,
         tokens_after         = excluded.tokens_after,
         strategy             = excluded.strategy,
         updated_at           = excluded.updated_at`,
    )
    .run(
      threadId,
      context.summary,
      JSON.stringify(context.replacementMessages),
      context.compactedCount,
      context.sourceMessageCount,
      context.tokensBefore,
      context.tokensAfter,
      context.strategy,
      Date.now(),
    );
}

export function deleteActiveContext(threadId: string): void {
  getDb()
    .prepare(`DELETE FROM thread_active_context WHERE thread_id = ?`)
    .run(threadId);
}
