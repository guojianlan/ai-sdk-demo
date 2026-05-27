import type { UIMessage } from "ai";

import { getDb } from "./db";
import { appendJsonlLines, type SessionLine } from "./jsonl";
import { getSessionFilePath } from "./paths";

/**
 * UIMessage 持久化 —— SQLite 主存（行存储 / 整段 replace）+ JSONL 镜像（append-only）。
 *
 * 为什么双写：
 * - SQLite 给"恢复 chat"用：`loadMessages(threadId)` 拿到当前完整快照，UI 立刻能显示
 * - JSONL 给"事件回溯 / memory 管线"用：append-only chronological log，给将来 codex
 *   风格的 Phase 1 抽 raw_memory 喂模型。SQLite 的 row replace 拿不到时间序列。
 *
 * 两份不矛盾：JSONL 里同一 message_id 多次出现是允许的（assistant 流式过程中
 * 会被多次保存），消费者按 message_id 取**最后一次**出现即等价于 SQLite 当前态。
 *
 * 性能：双写每次 saveMessages 多一次 fs append，单次 IO 量小（<10KB），可接受。
 * 大对话场景下若成 jank，再考虑只在 onFinish 时写 JSONL（per-step 只写 SQLite）。
 */

type MessageRow = {
  payload: string;
};

type ThreadRow = {
  created_at: number;
};

/**
 * 加载某个 thread 的全部 UIMessage，按 position 升序。
 * 不存在的 thread → 空数组（调用方决定是不是要 createThread）。
 */
export function loadMessages(threadId: string): UIMessage[] {
  const rows = getDb()
    .prepare<[string], MessageRow>(
      `SELECT payload FROM messages WHERE thread_id = ? ORDER BY position ASC`,
    )
    .all(threadId);
  return rows.map((row) => JSON.parse(row.payload) as UIMessage);
}

/**
 * 整段 replace：DELETE all + INSERT all。事务内执行。
 *
 * 调用时机（per chat loop step）：每个 LLM 输出步完成后，把当前快照存盘。
 * 这样 UI 在任何时刻刷新，都能拿到截至最近一次 step 的完整对话。
 *
 * **副作用**：同时把每条 message 追加到 JSONL（thread 必须先 createThread 过，
 * 不然找不到 created_at 算路径）。如果 jsonl 写失败（fs 错误等）—— 报 warn 不阻塞，
 * 因为 SQLite 还在，对话功能不受影响。
 */
export async function saveMessages(
  threadId: string,
  messages: UIMessage[],
): Promise<void> {
  const db = getDb();

  // 拿 thread 的 created_at 算 jsonl 路径
  const threadRow = db
    .prepare<[string], ThreadRow>(
      `SELECT created_at FROM threads WHERE id = ?`,
    )
    .get(threadId);

  // SQLite 整段 replace（事务）
  const del = db.prepare(`DELETE FROM messages WHERE thread_id = ?`);
  const ins = db.prepare(
    `INSERT INTO messages (thread_id, message_id, position, role, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateThread = db.prepare(
    `UPDATE threads SET message_count = ?, updated_at = ? WHERE id = ?`,
  );
  // Dedupe by message.id —— PRIMARY KEY (thread_id, message_id) 不允许同 id 重复，
  // 真撞上时 SQLITE_CONSTRAINT_PRIMARYKEY 会让整个 step 失败。
  // 防御性地用 Map 收口（later wins —— 同 id 后到的版本通常包含更完整的 parts，
  // 比如同一条 assistant 消息流式过程中的多个快照）。dedupe 真触发时打 warn，
  // 方便定位上游谁送了重复。
  const dedupedMap = new Map<string, UIMessage>();
  const duplicates: string[] = [];
  for (const message of messages) {
    if (dedupedMap.has(message.id)) {
      duplicates.push(message.id);
    }
    dedupedMap.set(message.id, message);
  }
  if (duplicates.length > 0) {
    console.warn(
      `[persistence] saveMessages thread=${threadId} dropped ${duplicates.length} duplicate message id(s): ${duplicates.slice(0, 5).join(", ")}${duplicates.length > 5 ? " …" : ""}`,
    );
  }
  const deduped = Array.from(dedupedMap.values());

  const now = Date.now();
  db.transaction((list: UIMessage[]) => {
    del.run(threadId);
    list.forEach((message, index) => {
      ins.run(
        threadId,
        message.id,
        index,
        message.role,
        JSON.stringify(message),
        now,
      );
    });
    if (threadRow) {
      updateThread.run(list.length, now, threadId);
    }
  })(deduped);

  // JSONL 镜像写入（best-effort，一次 syscall 写完整批）
  if (threadRow) {
    const filePath = getSessionFilePath(threadId, threadRow.created_at);
    const isoNow = new Date(now).toISOString();
    const lines: SessionLine[] = deduped.map((message) => ({
      timestamp: isoNow,
      type: "message" as const,
      payload: message,
    }));
    try {
      await appendJsonlLines(filePath, lines);
    } catch (error) {
      console.warn(
        `[persistence] jsonl mirror failed for thread=${threadId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * 删除某个 thread 的所有消息（不删 thread 元数据 / summary / runtime —— 那些由
 * `archiveThread` 或专门 cleanup 处理）。
 */
export function deleteMessages(threadId: string): void {
  getDb().prepare(`DELETE FROM messages WHERE thread_id = ?`).run(threadId);
}
