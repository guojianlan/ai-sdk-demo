import { promises as fs } from "node:fs";

import type { UIMessage } from "ai";

import { getDb } from "./db";
import { appendJsonlLine, type SessionMetaPayload } from "./jsonl";
import { deleteMessages, loadMessages } from "./messages";
import { getSessionFilePath } from "./paths";
import { deleteRuntimeState } from "./runtime";
import { deleteSummary } from "./summaries";

/**
 * Thread 元数据 + 完整生命周期（create / load / list / archive / delete）。
 *
 * 三层存储分工：
 * - `threads` 表 (SQLite)        ：会话元数据，list 用
 * - `messages` 表 (SQLite)        ：当前消息快照，load 用（行存、整段 replace）
 * - `<thread-id>.jsonl` (文件)    ：append-only 事件日志，给 memory 管线消费
 * - `thread_summaries` (SQLite)   ：compaction 摘要
 * - `thread_runtime_state` (SQLite)：workflow active stream
 *
 * 设计原则：caller 持有 thread.id（= 前端 chatId），所有 API 用 id 做 key。
 */

export type Thread = {
  id: string;
  workspaceRoot: string;
  workspaceName: string | null;
  workspaceAccessMode: string | null;
  shellApprovalPolicy: string | null;
  title: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

type ThreadRow = {
  id: string;
  workspace_root: string;
  workspace_name: string | null;
  workspace_access_mode: string | null;
  shell_approval_policy: string | null;
  title: string | null;
  message_count: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    workspaceName: row.workspace_name,
    workspaceAccessMode: row.workspace_access_mode,
    shellApprovalPolicy: row.shell_approval_policy,
    title: row.title,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/**
 * Upsert thread —— 已存在就返回老的（不动 workspace / title），不存在就建。
 *
 * 用 caller 提供的 `id`（典型是前端生成的 chatId）—— 这样前端那个 chatId 直接
 * 等于后端 thread.id，不用维护映射表。
 *
 * 顺序：先 SQLite，再写 jsonl 第一行 session_meta。jsonl 失败不撤销 SQLite——
 * 退一步是"DB 里有 thread，jsonl 文件空"，下次写消息时 jsonl 还会被创建，
 * 用户视角只是丢了 session_meta 那一行，影响小。
 */
export async function upsertThread(opts: {
  id: string;
  workspaceRoot: string;
  workspaceName?: string;
  workspaceAccessMode?: string;
  shellApprovalPolicy?: string;
  title?: string;
  model?: string;
}): Promise<Thread> {
  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM threads WHERE id = ?`)
    .get(opts.id) as ThreadRow | undefined;

  if (existing) {
    return rowToThread(existing);
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO threads
       (id, workspace_root, workspace_name, workspace_access_mode,
        shell_approval_policy, title, message_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    opts.id,
    opts.workspaceRoot,
    opts.workspaceName ?? null,
    opts.workspaceAccessMode ?? null,
    opts.shellApprovalPolicy ?? null,
    opts.title ?? null,
    now,
    now,
  );

  const meta: SessionMetaPayload = {
    threadId: opts.id,
    workspaceRoot: opts.workspaceRoot,
    workspaceName: opts.workspaceName,
    model: opts.model,
    createdAt: now,
  };
  try {
    await appendJsonlLine(getSessionFilePath(opts.id, now), {
      timestamp: new Date(now).toISOString(),
      type: "session_meta",
      payload: meta,
    });
  } catch (error) {
    console.warn(
      `[persistence] failed to write session_meta for ${opts.id}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return {
    id: opts.id,
    workspaceRoot: opts.workspaceRoot,
    workspaceName: opts.workspaceName ?? null,
    workspaceAccessMode: opts.workspaceAccessMode ?? null,
    shellApprovalPolicy: opts.shellApprovalPolicy ?? null,
    title: opts.title ?? null,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

/** 拿单个 thread 元数据（不含 messages）。不存在 → null。 */
export function getThread(threadId: string): Thread | null {
  const row = getDb()
    .prepare<[string], ThreadRow>(`SELECT * FROM threads WHERE id = ?`)
    .get(threadId);
  return row ? rowToThread(row) : null;
}

/**
 * 拿 thread 元数据 + 当前消息快照（从 SQLite 读，是当前态）。
 * 不存在 → null。
 *
 * 注：JSONL 是事件日志（含同一 message_id 的多次写入），SQLite messages 表是
 * 当前快照（每次 saveMessages 整段 replace）。**load 走 SQLite**，因为这是
 * agent 看到的"现状"；JSONL 给 memory 管线那种"我要全量历史"的场景。
 */
export function loadThread(
  threadId: string,
): { thread: Thread; messages: UIMessage[] } | null {
  const thread = getThread(threadId);
  if (!thread) return null;
  return { thread, messages: loadMessages(threadId) };
}

/**
 * 列出 thread 元数据，按 updated_at 倒排。
 * - workspaceRoot 给定 → 只返回那个工作区的会话
 * - includeArchived 默认 false（不显示已归档）
 */
export function listThreads(
  opts: { workspaceRoot?: string; includeArchived?: boolean } = {},
): Thread[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.workspaceRoot) {
    where.push(`workspace_root = ?`);
    params.push(opts.workspaceRoot);
  }
  if (!opts.includeArchived) {
    where.push(`archived_at IS NULL`);
  }

  const sql = `SELECT * FROM threads ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY updated_at DESC`;

  const rows = db.prepare(sql).all(...params) as ThreadRow[];
  return rows.map(rowToThread);
}

/**
 * 标记 archive。**不**删除 jsonl 或 messages——保留源真相，list 默认筛掉就够了。
 * 用户事后想恢复，把 archived_at 清回 null（unarchiveThread）。
 */
export function archiveThread(threadId: string): void {
  getDb()
    .prepare(`UPDATE threads SET archived_at = ? WHERE id = ?`)
    .run(Date.now(), threadId);
}

export function unarchiveThread(threadId: string): void {
  getDb()
    .prepare(`UPDATE threads SET archived_at = NULL WHERE id = ?`)
    .run(threadId);
}

/** 改 title（手动重命名）。 */
export function updateThreadTitle(threadId: string, title: string): void {
  getDb()
    .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, Date.now(), threadId);
}

/**
 * **永久删除** —— 跟 archive 不同：这个会清掉所有相关 SQLite 行 + jsonl 文件。
 *
 * 顺序：先 jsonl 再 SQLite，因为：
 * - 万一 jsonl 删失败但 SQLite 删了 → 留一个孤儿 jsonl（不痛）
 * - 反过来 → 用户从 list 上看到 thread 还在，但 load 报错（更糟）
 *
 * 不存在的 thread → no-op（幂等）。
 */
export async function deleteThread(threadId: string): Promise<void> {
  const thread = getThread(threadId);
  if (!thread) return;

  // jsonl
  try {
    await fs.unlink(getSessionFilePath(threadId, thread.createdAt));
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      console.warn(
        `[persistence] failed to delete jsonl for ${threadId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // SQLite：四张表全清
  deleteMessages(threadId);
  deleteSummary(threadId);
  deleteRuntimeState(threadId);
  getDb().prepare(`DELETE FROM threads WHERE id = ?`).run(threadId);
}
