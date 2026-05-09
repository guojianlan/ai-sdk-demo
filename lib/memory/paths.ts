import path from "node:path";

import { env } from "@/lib/env";

/**
 * Memory 持久化层的路径计算 —— 全部派生自 `env.storageDir`，跟 lib/persistence
 * 用一套 storage 根目录（`~/.local-agent/`）。
 *
 * 目录约定（A2 Phase 1 上来后扩展）：
 *   <storageDir>/
 *   └── memory/
 *       ├── MEMORY.md                          ← Phase 2 整合的索引（A1 只读它）
 *       ├── raw_memories.md                    ← Phase 1 抽出的原始事实，按时间追加
 *       ├── <topic-slug>.md                    ← A4 memory_write 主动写的主题文件
 *       └── rollout_summaries/
 *           └── <thread-id>-<slug>.md          ← Phase 1 每个 session 一个总结
 *
 * 命名跟 codex 一致（`rollout_summaries/` / `raw_memories.md` / `MEMORY.md`），
 * 跨工具的 memory 数据格式有机会未来互通。
 */

export function getMemoryDir(): string {
  return path.join(env.storageDir, "memory");
}

/** 索引文件路径。Phase 2 整合器写、A1 注入 system prompt 时读。 */
export function getMemoryIndexPath(): string {
  return path.join(getMemoryDir(), "MEMORY.md");
}

/** Phase 1 输出汇总文件，按时间追加。Phase 2 读这个做整合。 */
export function getRawMemoriesPath(): string {
  return path.join(getMemoryDir(), "raw_memories.md");
}

/** Per-session 总结文件目录。每个 thread 一个 `<thread-id>-<slug>.md`。 */
export function getRolloutSummariesDir(): string {
  return path.join(getMemoryDir(), "rollout_summaries");
}

/**
 * 给定 thread id + 可选 slug，算出该 session 的 summary 文件路径。
 * Slug 由 LLM 给（rollout_slug 字段），缺省时只用 thread id。
 */
export function getRolloutSummaryPath(
  threadId: string,
  slug: string | null,
): string {
  const safeSlug = slug ? sanitizeSlug(slug) : "";
  const fileName = safeSlug ? `${threadId}-${safeSlug}.md` : `${threadId}.md`;
  return path.join(getRolloutSummariesDir(), fileName);
}

function sanitizeSlug(raw: string): string {
  // 跟 memory_write 的 slug 校验风格一致：小写、`-`、限长
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
