import fs from "node:fs/promises";
import path from "node:path";

import { getMemoryDir, getMemoryIndexPath } from "./paths";

/**
 * Memory 写入器 —— A4 `memory_write` 工具的引擎。
 *
 * 写两件事，原子性弱（不在事务里）：
 *   1. `~/.local-agent/memory/<topic>.md` 主题文件（含 frontmatter）
 *   2. `~/.local-agent/memory/MEMORY.md` 索引（追加 / 更新一行）
 *
 * 顺序很重要：先写主题文件再更新索引。如果主题文件写失败，索引保持不变；
 * 如果主题文件写成功但索引失败，下次 A3 整合器跑会从主题文件重建索引（最终一致）。
 *
 * Slug 校验：调用方已经在 zod schema 里限制了 `[a-z0-9][a-z0-9-]*`，这里再做一道
 * `path.basename` 防御以防别处绕过 schema 直接调。
 */

export type MemoryType = "user" | "feedback" | "project" | "reference";

export type WriteMemoryArgs = {
  topic: string;
  type: MemoryType;
  content: string;
  /** ≤150 字符的索引摘要（MEMORY.md 那一行用）。 */
  oneLineSummary: string;
  /** 当前会话 thread id，写到 frontmatter sources 字段。可省。 */
  sourceThreadId?: string;
};

export type WriteMemoryResult = {
  /** 绝对路径。 */
  filePath: string;
  /** 主题相对于 memory dir 的文件名（含 .md）。 */
  fileName: string;
  /** 文件之前是否存在（updated vs created）。 */
  operation: "created" | "updated";
  /** MEMORY.md 是否更新成功。失败时打 warn 但不抛——让 agent 知道写过了，索引留给整合器修复。 */
  indexUpdated: boolean;
};

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 主题写入入口。新建 memory dir（如果不存在）→ 写 topic.md → 同步更新 MEMORY.md。
 */
export async function writeMemoryTopic(
  args: WriteMemoryArgs,
): Promise<WriteMemoryResult> {
  if (!SLUG_REGEX.test(args.topic)) {
    throw new Error(
      `Invalid topic slug "${args.topic}". Must match [a-z0-9][a-z0-9-]*.`,
    );
  }

  const dir = getMemoryDir();
  await fs.mkdir(dir, { recursive: true });

  const fileName = `${args.topic}.md`;
  const filePath = path.join(dir, fileName);

  // 看看文件是否已存在：决定 created / updated 语义 + 决定 frontmatter 的 created 时间
  let prevContent: string | null = null;
  try {
    prevContent = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // 别的 IO 错误：往上抛，A4 tool execute 会变成 toolErr
      throw error;
    }
  }

  const nowIso = new Date().toISOString();
  // frontmatter 里 created 字段：如果文件存在就保留旧 created；不存在就 now
  const createdAt = extractCreatedFromFrontmatter(prevContent) ?? nowIso;

  const newFileContent = renderTopicFile({
    type: args.type,
    topic: args.topic,
    createdAt,
    updatedAt: nowIso,
    sourceThreadId: args.sourceThreadId,
    content: args.content,
  });

  await fs.writeFile(filePath, newFileContent, "utf-8");

  // 索引同步：失败不抛，只 warn —— A3 整合器后续会修
  let indexUpdated = false;
  try {
    await upsertMemoryIndex({
      topic: args.topic,
      fileName,
      summary: args.oneLineSummary,
    });
    indexUpdated = true;
  } catch (error) {
    console.warn(
      "[memory] failed to update MEMORY.md index (topic file written OK):",
      error instanceof Error ? error.message : error,
    );
  }

  return {
    filePath,
    fileName,
    operation: prevContent === null ? "created" : "updated",
    indexUpdated,
  };
}

function renderTopicFile(args: {
  type: MemoryType;
  topic: string;
  createdAt: string;
  updatedAt: string;
  sourceThreadId?: string;
  content: string;
}): string {
  const sourceLine = args.sourceThreadId
    ? `source: ${args.sourceThreadId}\n`
    : "";
  return [
    "---",
    `type: ${args.type}`,
    `topic: ${args.topic}`,
    `created: ${args.createdAt}`,
    `updated: ${args.updatedAt}`,
    sourceLine.trimEnd(),
    "---",
    "",
    args.content.trim(),
    "",
  ]
    .filter((line, idx, arr) => {
      // 把刚才 sourceLine 为空时留下的空字符串过滤掉，避免 frontmatter 里出空行
      if (idx === 4 && line === "") return false;
      // 但保留 frontmatter 关闭后的空行
      void arr;
      return true;
    })
    .join("\n");
}

/**
 * 从 markdown 头部 frontmatter 抽 `created: ...` 字段。没有 frontmatter / 没有
 * created 字段都返回 null（调用方 fallback 到 now）。
 */
function extractCreatedFromFrontmatter(content: string | null): string | null {
  if (!content) return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const body = match[1];
  const line = body
    .split("\n")
    .find((l) => /^created\s*:\s*/i.test(l));
  if (!line) return null;
  return line.replace(/^created\s*:\s*/i, "").trim() || null;
}

/**
 * MEMORY.md 索引 upsert：
 * - 文件不存在 → 新建 + 一行
 * - 文件存在但没这条 topic → 追加一行
 * - 文件存在且有这条 topic → 替换那一行的 summary
 *
 * 索引行格式（跟 A1 注入预期一致）：
 *   - [<topic>](<topic>.md) — <summary>
 */
async function upsertMemoryIndex(args: {
  topic: string;
  fileName: string;
  summary: string;
}): Promise<void> {
  const indexPath = getMemoryIndexPath();
  const newLine = `- [${args.topic}](${args.fileName}) — ${args.summary.trim()}`;

  let existing: string;
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 全新：写一份带文件级标题的 MEMORY.md
      const fresh = ["# Memory index", "", newLine, ""].join("\n");
      await fs.writeFile(indexPath, fresh, "utf-8");
      return;
    }
    throw error;
  }

  const lines = existing.split("\n");
  // 找已有的 topic 行：以 `- [<topic>]` 开头
  const linkPrefix = `- [${args.topic}](`;
  const idx = lines.findIndex((line) => line.startsWith(linkPrefix));
  if (idx === -1) {
    // 追加 —— 末尾如果不是空行就先加一个空行
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(newLine);
  } else {
    lines[idx] = newLine;
  }

  // 末尾保证一个 newline
  let next = lines.join("\n");
  if (!next.endsWith("\n")) next += "\n";
  await fs.writeFile(indexPath, next, "utf-8");
}
