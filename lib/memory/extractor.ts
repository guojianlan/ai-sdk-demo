import { promises as fs } from "node:fs";
import path from "node:path";

import type { UIMessage } from "ai";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

import { env } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import { instrumentModel } from "@/lib/devtools";
import {
  isMemoryEnabled,
  loadSettings,
} from "@/lib/permissions";
import { loadMessages } from "@/lib/persistence/messages";
import { getThread } from "@/lib/persistence/store";

import { runPhase2Consolidation } from "./consolidator";
import { PHASE1_EXTRACTOR_PROMPT } from "./extractor-prompt";
import {
  getRawMemoriesPath,
  getRolloutSummariesDir,
  getRolloutSummaryPath,
} from "./paths";
import {
  EXTRACTION_RETRY_CAP,
  getExtractionState,
  recordExtractionFailure,
  recordExtractionSuccess,
} from "./state";

/**
 * A2 Phase 1 抽取器。
 *
 * 流程（per-thread）：
 *   1. 读 settings → memoryEnabled=false 直接 return（不浪费 LLM 调用）
 *   2. 读 thread 元数据（拿 workspaceRoot）
 *   3. 从 SQLite `loadMessages` 拿 deduped 完整快照；只取 `last_offset` 之后的新消息
 *   4. 没新消息 / 没 user|assistant 消息 → 推进 cursor 但不调 LLM
 *   5. 调 LLM（默认主模型，env MEMORY_EXTRACTOR_MODEL 可换便宜的）→ 解 JSON
 *   6. 写 raw_memories.md（追加）+ rollout_summaries/<id>-<slug>.md（覆盖；最新版本胜）
 *   7. 推进 last_offset 到 `messages.length`
 *
 * 为什么从 SQLite 读不读 jsonl：
 * - `saveMessages` 把整段 deduped 历史每次都 append 到 jsonl（messages.ts:113-130），
 *   jsonl 设计上允许同 id 多次出现（"消费者按 id 取最后一次"），但 Phase 1 用 line
 *   offset 没法做 cross-call dedup —— 上一轮的 user msg 在这一轮的 jsonl 尾部又
 *   作为重复行出现，extractor 再抽一次。从 SQLite 读直接拿规范化的 UIMessage[]，
 *   按 message position 当 cursor，每条消息只会被处理一次。
 *
 * 错误处理：任何步骤失败一律 warn + recordExtractionFailure（retry_count++）。
 * 触顶 EXTRACTION_RETRY_CAP（默认 3）后这条 thread 暂时摆烂，不再尝试。
 *
 * 调用方式：fire-and-forget 形态。chat route 在 POST 入口 `void runPhase1ForThread(...)`
 * 不 await；主对话不被它阻塞。Playwright 多 POST 串行场景下 cursor 单调递增，
 * 不会出现 race（极端并发理论上仍可能，但生产 chat 都是顺序 POST）。
 */

const phase1OutputSchema = z.object({
  rollout_summary: z.string().max(2000),
  rollout_slug: z.string().max(80),
  raw_memory: z.string().max(8000),
});

export type Phase1Result = {
  /** 是否真的写了东西到 raw_memories.md（rollout summary 总是写）。 */
  wroteRawMemory: boolean;
  /** 是否真的写了 rollout summary（no-op 时不写）。 */
  wroteSummary: boolean;
  /** 实际处理了多少条 message（≥1 才会调 LLM）。 */
  newLinesProcessed: number;
  /** 失败时塞错误信息（success 时为 null）。 */
  error: string | null;
};

/**
 * 跑一次 Phase 1 抽取。返回结果但**不抛错**——失败也走 success path 但 `error`
 * 字段非 null，调用方根据需要 log。
 *
 * 入参 cwd 可选，用于读 settings 决定是否启用 memory。不传 → 用 process.cwd（dev
 * server 的进程目录，跟主对话 workspaceRoot 不一定一致）。建议调用方传当前
 * thread 的 workspaceRoot。
 */
export async function runPhase1ForThread(args: {
  threadId: string;
  /** 用于 settings 查找的目录。一般 = thread.workspaceRoot。 */
  cwd?: string;
}): Promise<Phase1Result> {
  const result: Phase1Result = {
    wroteRawMemory: false,
    wroteSummary: false,
    newLinesProcessed: 0,
    error: null,
  };

  // 1. memoryEnabled 闸门
  const settings = loadSettings(args.cwd ?? process.cwd());
  if (!isMemoryEnabled(settings)) {
    return result; // 全局 / 项目级关掉了，不抽
  }

  // 2. retry 上限保护
  const state = getExtractionState(args.threadId);
  if (state.retryCount >= EXTRACTION_RETRY_CAP) {
    result.error = `retry cap reached (${state.retryCount}); skipping until manual reset`;
    return result;
  }

  // 3. thread 元数据
  const thread = getThread(args.threadId);
  if (!thread) {
    result.error = "thread not found";
    return result;
  }

  // 4. 从 SQLite 拿当前消息快照（规范化、按 position 升序、按 id dedup）
  const allMessages = loadMessages(args.threadId);
  if (allMessages.length <= state.lastOffset) {
    // 没新消息可以抽
    return result;
  }
  const newMessages = allMessages.slice(state.lastOffset);
  result.newLinesProcessed = newMessages.length;

  // 只有 system 通知（compaction notice 这种）→ 没真材料可抽，直接推进 cursor。
  const hasUserOrAssistant = newMessages.some(
    (m) => m.role === "user" || m.role === "assistant",
  );
  if (!hasUserOrAssistant) {
    recordExtractionSuccess(args.threadId, allMessages.length);
    return result;
  }

  // 5. 渲染 transcript prompt + 调 LLM
  let transcript: string;
  try {
    transcript = renderTranscript(newMessages, {
      threadId: args.threadId,
      workspaceRoot: thread.workspaceRoot,
      workspaceName: thread.workspaceName ?? "",
    });
  } catch (error) {
    result.error = `transcript rendering failed: ${error instanceof Error ? error.message : error}`;
    recordExtractionFailure(args.threadId);
    return result;
  }

  let parsed: z.infer<typeof phase1OutputSchema>;
  try {
    const model = chooseExtractorModel();
    const llmResult = await generateObject({
      model,
      schema: phase1OutputSchema,
      system: PHASE1_EXTRACTOR_PROMPT,
      prompt: transcript,
    });
    parsed = llmResult.object;
  } catch (error) {
    result.error = `LLM extraction failed: ${error instanceof Error ? error.message : error}`;
    recordExtractionFailure(args.threadId);
    return result;
  }

  // 6. 写盘
  try {
    if (parsed.rollout_summary.trim().length > 0) {
      const summaryPath = getRolloutSummaryPath(
        args.threadId,
        parsed.rollout_slug.trim() || null,
      );
      await fs.mkdir(getRolloutSummariesDir(), { recursive: true });
      const summaryFile = renderRolloutSummaryFile({
        threadId: args.threadId,
        slug: parsed.rollout_slug,
        summary: parsed.rollout_summary,
        workspaceRoot: thread.workspaceRoot,
      });
      await fs.writeFile(summaryPath, summaryFile, "utf-8");
      result.wroteSummary = true;
    }

    if (parsed.raw_memory.trim().length > 0) {
      await appendToRawMemories({
        threadId: args.threadId,
        workspaceRoot: thread.workspaceRoot,
        rawMemory: parsed.raw_memory,
      });
      result.wroteRawMemory = true;
    }
  } catch (error) {
    result.error = `memory write failed: ${error instanceof Error ? error.message : error}`;
    recordExtractionFailure(args.threadId);
    return result;
  }

  // 7. 推进游标到当前 message 总数
  recordExtractionSuccess(args.threadId, allMessages.length);

  // 8. 写了 raw memory → fire-and-forget 触发 Phase 2 整合
  //    Phase 2 内部会做 hash 检查，如果 raw_memories.md 实际内容没变（极少见
  //    但理论上 LLM 可能输出空 raw_memory 我们却走了 wroteRawMemory 路径——
  //    保险起见让 Phase 2 自己 hash skip）
  if (result.wroteRawMemory) {
    void runPhase2Consolidation({ cwd: thread.workspaceRoot })
      .then((p2) => {
        if (p2.error) {
          console.warn(`[memory/phase2] error: ${p2.error}`);
        } else if (p2.wroteMemoryIndex) {
          console.log(`[memory/phase2] MEMORY.md updated (full re-consolidate)`);
        } else if (p2.skipped) {
          console.log(`[memory/phase2] skipped (${p2.skippedReason})`);
        }
      })
      .catch((error) => {
        console.warn(
          `[memory/phase2] unexpected throw:`,
          error instanceof Error ? error.message : error,
        );
      });
  }

  return result;
}

/**
 * 选 Phase 1 用的 model。env 配了就用配的，否则落回主模型。
 *
 * 跟主对话用同一个 gateway（OpenAI-compatible），都走 instrumentModel
 * 确保 devtools 抓得到。
 */
function chooseExtractorModel(): LanguageModel {
  const modelId = env.memoryExtractorModel ?? env.gateway.modelId;
  return instrumentModel(gateway.chatModel(modelId));
}

/**
 * 把 UIMessage 列表渲染成 LLM 看得懂的 transcript 段落。
 *
 * UIMessage 的 parts 数组包含 text / tool / reasoning 等 part；这里降维成纯文本
 * transcript，让 LLM 不被 schema 干扰。tool input/output 简化成 1 行 preview，省 token。
 */
function renderTranscript(
  messages: UIMessage[],
  meta: { threadId: string; workspaceRoot: string; workspaceName: string },
): string {
  const head = [
    `threadId: ${meta.threadId}`,
    `workspaceRoot: ${meta.workspaceRoot}`,
    `workspaceName: ${meta.workspaceName}`,
    "",
    "---",
    "",
    "Transcript (chronological order):",
    "",
  ].join("\n");

  const body: string[] = [];
  for (const m of messages) {
    if (!m.role || !Array.isArray(m.parts)) continue;
    body.push(`### ${m.role}`);
    for (const p of m.parts as Array<{
      type?: string;
      text?: string;
      input?: unknown;
      output?: unknown;
    }>) {
      if (p.type === "text" && typeof p.text === "string") {
        body.push(p.text.slice(0, 4000)); // 单条 text 上限
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const toolName = p.type.slice("tool-".length);
        const inputPreview = JSON.stringify(p.input ?? null).slice(0, 200);
        const outputPreview = JSON.stringify(p.output ?? null).slice(0, 200);
        body.push(
          `(tool ${toolName}) input=${inputPreview} output=${outputPreview}`,
        );
      }
      // 其它 part type（reasoning / data-* 等）跳过
    }
    body.push("");
  }

  return head + body.join("\n");
}

/** 渲染一个 rollout summary 文件（含 frontmatter）。 */
function renderRolloutSummaryFile(args: {
  threadId: string;
  slug: string;
  summary: string;
  workspaceRoot: string;
}): string {
  return [
    "---",
    `thread_id: ${args.threadId}`,
    args.slug.trim() ? `slug: ${args.slug.trim()}` : "",
    `workspace_root: ${args.workspaceRoot}`,
    `summarized_at: ${new Date().toISOString()}`,
    "---",
    "",
    args.summary.trim(),
    "",
  ]
    .filter((l, i, arr) => {
      // 第二行 slug 为空时跳过那行
      void arr;
      if (i === 2 && !l) return false;
      return true;
    })
    .join("\n");
}

/**
 * 追加 raw_memory 到 raw_memories.md。
 *
 * 格式：每条 thread 一个段落，前面带分隔线 + frontmatter-style 元数据头。
 * Phase 2 整合器读这个文件 → 解析所有段落 → 重写 MEMORY.md。
 */
async function appendToRawMemories(args: {
  threadId: string;
  workspaceRoot: string;
  rawMemory: string;
}): Promise<void> {
  const filePath = getRawMemoriesPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const block = [
    "",
    "---",
    `<!-- thread_id: ${args.threadId} -->`,
    `<!-- workspace_root: ${args.workspaceRoot} -->`,
    `<!-- recorded_at: ${new Date().toISOString()} -->`,
    "",
    args.rawMemory.trim(),
    "",
  ].join("\n");

  // 文件可能不存在，appendFile 会建
  await fs.appendFile(filePath, block, "utf-8");
}
