import fs from "node:fs/promises";

import { env } from "@/lib/env";

import { getMemoryIndexPath } from "./paths";

/**
 * 加载 `~/.local-agent/memory/MEMORY.md` —— 跨对话长期记忆索引。
 *
 * 行为：
 * - 文件不存在 → 返回 null（A1 阶段 memory 系统未启用 / consolidator 还没跑过都正常）
 * - 文件为空 / 全空白 → 返回 null（视作未启用）
 * - 文件存在但读不动（权限 / IO） → warn + null（绝不让 chat 因 memory 加载失败而挂）
 * - 字符数 > `env.memoryMaxChars` → 截断头部，末尾加 `[truncated]` 标记
 *
 * 调用时机：每次 chat 请求 prepareCall 时调一次。fs read ~5ms，cost 可忽略。
 * **不缓存**：用户随时可能手动改 MEMORY.md（或 consolidator 写入），即时生效更重要。
 */

const TRUNCATION_NOTICE = "\n\n[... memory truncated for token budget ...]";

export type LoadedMemory = {
  /** 注入 system prompt 的最终文本（已 trim，可能截断）。 */
  content: string;
  /** 原文件字节数（debug / metric 用）。 */
  byteSize: number;
  /** 是否被截断。 */
  truncated: boolean;
  /** 来源文件路径（debug 用，UI 显示"memory loaded from X"）。 */
  source: string;
};

export async function loadGlobalMemory(): Promise<LoadedMemory | null> {
  const memoryPath = getMemoryIndexPath();

  let raw: string;
  try {
    raw = await fs.readFile(memoryPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null; // 文件 / 目录不存在 → 静默；不算错误
    }
    console.warn(
      `[memory] cannot read ${memoryPath}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) return null;

  const max = env.memoryMaxChars;
  if (trimmed.length <= max) {
    return {
      content: trimmed,
      byteSize: trimmed.length,
      truncated: false,
      source: memoryPath,
    };
  }

  return {
    content: trimmed.slice(0, max).trim() + TRUNCATION_NOTICE,
    byteSize: trimmed.length,
    truncated: true,
    source: memoryPath,
  };
}
