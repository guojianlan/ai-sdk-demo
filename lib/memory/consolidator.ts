import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

import { instrumentModel } from "@/lib/devtools";
import { env } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import {
  isMemoryEnabled,
  loadSettings,
} from "@/lib/permissions";

import { PHASE2_CONSOLIDATOR_PROMPT } from "./consolidator-prompt";
import {
  getMemoryDir,
  getMemoryIndexPath,
  getRawMemoriesPath,
  getRolloutSummariesDir,
} from "./paths";
import {
  CONSOLIDATION_RETRY_CAP,
  getConsolidationState,
  recordConsolidationFailure,
  recordConsolidationSuccess,
} from "./state";

/**
 * A3 Phase 2 整合器。
 *
 * 流程：
 *   1. 读 settings → memoryEnabled=false 直接 return
 *   2. retry_count >= cap → 跳过
 *   3. 读 raw_memories.md → 算 SHA256
 *   4. hash 跟 last_raw_hash 一样 → 跳过 LLM 调用（核心省钱机制）
 *   5. 读 现有 MEMORY.md（如果有）+ 最近 ≤10 个 rollout_summaries
 *   6. 拼成 LLM input → 调 LLM → 拿新 markdown
 *   7. 写 MEMORY.md（覆盖）+ 推进 last_raw_hash
 *
 * 错误处理：跟 Phase 1 一致 —— 静默 retry，不抛错。
 *
 * 调用方式：fire-and-forget，主对话不等。Phase 1 写完 raw_memory 后触发。
 */

const phase2OutputSchema = z.object({
  markdown: z.string().min(1).max(20000),
});

export type Phase2Result = {
  /** Hash 没变 / disabled / 没 raw 内容时为 true（不调 LLM）。 */
  skipped: boolean;
  skippedReason: "disabled" | "retry-cap" | "hash-unchanged" | "empty-raw" | null;
  /** 新 MEMORY.md 是否真写盘了。 */
  wroteMemoryIndex: boolean;
  /** 失败时塞错误信息（success 时为 null）。 */
  error: string | null;
};

/**
 * 跑一次 Phase 2 整合。失败一律静默 retry，不抛。
 *
 * @param cwd 用于 settings 查找。一般 = thread.workspaceRoot，否则用 process.cwd
 */
export async function runPhase2Consolidation(args: {
  cwd?: string;
}): Promise<Phase2Result> {
  const result: Phase2Result = {
    skipped: false,
    skippedReason: null,
    wroteMemoryIndex: false,
    error: null,
  };

  // 1. memoryEnabled 闸门
  const settings = loadSettings(args.cwd ?? process.cwd());
  if (!isMemoryEnabled(settings)) {
    result.skipped = true;
    result.skippedReason = "disabled";
    return result;
  }

  // 2. retry cap
  const state = getConsolidationState();
  if (state.retryCount >= CONSOLIDATION_RETRY_CAP) {
    result.error = `retry cap reached (${state.retryCount}); skipping until manual reset / hash change`;
    return result;
  }

  // 3. 读 raw_memories.md + 算 hash
  const rawPath = getRawMemoriesPath();
  let rawContent: string;
  try {
    rawContent = await fs.readFile(rawPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 还没有 raw 文件：还没跑过 Phase 1 / Phase 1 全是 no-op。无事可整合。
      result.skipped = true;
      result.skippedReason = "empty-raw";
      return result;
    }
    result.error = `cannot read raw_memories: ${error instanceof Error ? error.message : error}`;
    recordConsolidationFailure();
    return result;
  }

  if (rawContent.trim().length === 0) {
    result.skipped = true;
    result.skippedReason = "empty-raw";
    return result;
  }

  const currentHash = sha256(rawContent);

  // 4. hash 没变 → 跳过（**核心省钱机制**）
  if (state.lastRawHash === currentHash) {
    result.skipped = true;
    result.skippedReason = "hash-unchanged";
    return result;
  }

  // 5. 读 existing MEMORY.md + 最近 rollout summaries
  let existingIndex = "";
  try {
    existingIndex = await fs.readFile(getMemoryIndexPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // 别的 IO 错误就 warn 但不阻塞整合（当作没有现存索引）
      console.warn(
        `[memory/phase2] cannot read existing MEMORY.md (treating as empty):`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  let recentSummaries = "";
  try {
    recentSummaries = await readRecentRolloutSummaries(10);
  } catch (error) {
    // 没文件夹 / 没 summary → 空字符串，不 warn 也不阻塞
    void error;
  }

  // 6. 拼 LLM input
  const userMessage = [
    "# Existing MEMORY.md",
    existingIndex.trim() || "_(empty / first run)_",
    "",
    "---",
    "",
    "# Raw memories (Phase 1 accumulated)",
    rawContent.trim(),
    "",
    "---",
    "",
    "# Recent rollout summaries",
    recentSummaries.trim() || "_(none)_",
  ].join("\n");

  let parsed: z.infer<typeof phase2OutputSchema>;
  try {
    const model = chooseConsolidatorModel();
    const llmResult = await generateObject({
      model,
      schema: phase2OutputSchema,
      system: PHASE2_CONSOLIDATOR_PROMPT,
      prompt: userMessage,
    });
    parsed = llmResult.object;
  } catch (error) {
    result.error = `LLM consolidation failed: ${error instanceof Error ? error.message : error}`;
    recordConsolidationFailure();
    return result;
  }

  // 7. 写 MEMORY.md + 推进 hash
  try {
    await fs.mkdir(getMemoryDir(), { recursive: true });
    await fs.writeFile(getMemoryIndexPath(), parsed.markdown, "utf-8");
    result.wroteMemoryIndex = true;
  } catch (error) {
    result.error = `cannot write MEMORY.md: ${error instanceof Error ? error.message : error}`;
    recordConsolidationFailure();
    return result;
  }

  recordConsolidationSuccess(currentHash);
  return result;
}

/**
 * 选 Phase 2 用的 model。复用 Phase 1 的 env（`MEMORY_EXTRACTOR_MODEL`）作 fallback
 * 路径，再不行才落回主模型。codex 那边 Phase 2 用更强模型，我们简化成单档共享，
 * 真要分开未来加 `MEMORY_CONSOLIDATOR_MODEL` env。
 */
function chooseConsolidatorModel(): LanguageModel {
  const modelId = env.memoryExtractorModel ?? env.gateway.modelId;
  return instrumentModel(gateway.chatModel(modelId));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * 读最近 N 个 rollout summary 文件（按 mtime 倒排）。每个截断到 ≤500 字符。
 * 总长度上限 ~5KB（10 × 500 chars），避免 prompt 失控。
 */
async function readRecentRolloutSummaries(limit: number): Promise<string> {
  const dir = getRolloutSummariesDir();

  let entries: string[];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }

  if (entries.length === 0) return "";

  // 按 mtime 倒排
  const stats = await Promise.all(
    entries.map(async (name) => {
      const full = path.join(dir, name);
      const st = await fs.stat(full);
      return { name, full, mtime: st.mtimeMs };
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);

  const top = stats.slice(0, limit);
  const blocks = await Promise.all(
    top.map(async (s) => {
      const content = await fs.readFile(s.full, "utf-8");
      const truncated = content.slice(0, 500);
      return `## ${s.name}\n\n${truncated}\n`;
    }),
  );
  return blocks.join("\n");
}
