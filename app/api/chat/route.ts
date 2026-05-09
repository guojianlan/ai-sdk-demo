import {
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
  type UIMessage,
} from "ai";
import { getRun, start } from "workflow/api";

import { runAgentWorkflow } from "@/app/workflows/chat";
import {
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import {
  normalizePermissionMode,
  type PermissionMode,
} from "@/lib/permissions";
import type { ShellApprovalPolicy } from "@/lib/tools";
import { sanitizeChatUIMessages } from "@/lib/chat/sanitize-messages";
import {
  compareAndSetActiveStreamId,
  getActiveStreamId,
  loadSummary,
  saveMessages,
  saveSummary,
  upsertThread,
} from "@/lib/persistence";
import {
  buildCompactionNotice,
  compactMessages,
  estimateTokens,
} from "@/lib/compaction";
import { env, requireGatewayApiKey } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import { runPhase1ForThread } from "@/lib/memory";
import { getSkills } from "@/lib/skills";
import {
  createCancelableReadableStream,
  dropReasoningChunks,
  orderStatefulUIMessageChunks,
} from "@/lib/workflow-readable";

type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

const ACTIVE_STREAM_RECONCILIATION_MAX_ATTEMPTS = 3;

export async function POST(request: Request) {
  try {
    requireGatewayApiKey();
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Missing gateway API key",
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    messages?: unknown[];
    chatId?: string;
    workspaceRoot?: string;
    workspaceName?: string;
    workspaceAccessMode?: WorkspaceAccessMode;
    shellApprovalPolicy?: ShellApprovalPolicy;
    permissionMode?: PermissionMode;
    planMode?: boolean;
  };

  const workspaceRoot = body.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return new Response("Please select a workspace before sending a message.", {
      status: 400,
    });
  }

  // chatId 一定要有：持久化和 resume 都靠它做 key。
  const chatId = body.chatId?.trim();
  if (!chatId) {
    return new Response("missing chatId", { status: 400 });
  }

  const workspaceAccessMode = normalizeWorkspaceAccessMode(
    body.workspaceAccessMode,
  );
  const permissionMode = normalizePermissionMode(body.permissionMode);
  const planMode = body.planMode === true;

  // Upsert thread on every POST —— 兜底：如果前端没显式 POST /api/sessions
  // 创建（旧客户端 / 直接 API 调用），第一次发消息这里会补建 thread 元数据。
  // 已存在 → no-op 返回老的，不覆盖字段。
  await upsertThread({
    id: chatId,
    workspaceRoot,
    workspaceName: body.workspaceName,
    workspaceAccessMode,
    shellApprovalPolicy: body.shellApprovalPolicy,
    permissionMode,
    planMode,
    model: env.gateway.modelId,
  });

  const activeStreamId = getActiveStreamId(chatId);
  if (activeStreamId) {
    const existingStream = await reconcileExistingActiveStream(
      chatId,
      activeStreamId,
    );
    if (existingStream.action === "resume") {
      return createUIMessageStreamResponse({
        stream: existingStream.stream,
        headers: { "x-workflow-run-id": existingStream.runId },
      });
    }
    if (existingStream.action === "conflict") {
      return Response.json(
        { error: "Another workflow is already running for this chat." },
        { status: 409 },
      );
    }
  }

  const fullSanitized = sanitizeChatUIMessages(body.messages ?? []);
  await saveMessages(chatId, fullSanitized);

  // --- P4-b context compaction 决策 ------------------------------------
  //
  // 约定：
  // - DB 保留全量历史（包括 system-role 的 compaction 通知），UI 能看完整
  // - **Agent 视角只看 non-system 消息**：system-role UI message 是我们自己造的
  //   UI 标记（compaction 通知），不应该被喂进 LLM 的 system prompt
  // - `session_summaries.compacted_count` 记录"agent 视角下前 N 条已被摘要代表"
  //
  // 每次请求：
  //   1. fullSanitized 里过滤 role=system 得到 agent 视角的消息
  //   2. 从 DB 读 existing summary，按 compacted_count 切出 agent 实际要看的 tail
  //   3. tail 的 token 估算 > 阈值 → 再压一次；新 summary 叠加在 existing 上
  //
  // 链式压缩：summary 永远是"截至现在所有老消息"的最新版，而不是每次都从头压。
  const existingSummary = loadSummary(chatId);
  const compactedCountSoFar = existingSummary?.compactedCount ?? 0;

  const agentViewMessages = fullSanitized.filter(
    (message) => message.role !== "system",
  );

  let agentMessages = agentViewMessages.slice(compactedCountSoFar);
  let agentSummary = existingSummary?.summary ?? null;
  // 本轮压缩产生的通知消息；onFinish 时插入到保存链里给下次 UI 看到。
  let compactionNotice: UIMessage | null = null;

  const currentTokens = estimateTokens(agentMessages);
  // 每次 POST 都打一行"现在多少 token / 阈值多少 / 会不会触发"——这是 compaction
  // 唯一可观察的信号，放在终端最显眼的位置方便 debug。
  const willCompact = currentTokens > env.compaction.thresholdTokens;
  console.log(
    `[compaction] chat=${chatId} tokens=${currentTokens} threshold=${env.compaction.thresholdTokens} trigger=${willCompact}`,
  );
  if (willCompact) {
    // 用和主 agent 同一个 gateway model 做摘要。没必要走 instrumentModel——
    // compaction 走单独一次调用，和主对话 stream 不混在同一条 devtools run 里。
    const summarizerModel = gateway.chatModel(env.gateway.modelId);
    try {
      const result = await compactMessages({
        messages: agentMessages,
        model: summarizerModel,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: agentSummary,
      });

      if (result.compactedCount > 0 && result.summary) {
        const newCompactedCount = compactedCountSoFar + result.compactedCount;
        saveSummary(chatId, {
          summary: result.summary,
          compactedCount: newCompactedCount,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        });
        agentMessages = result.keptMessages;
        agentSummary = result.summary;
        // 产生一条 role=system 的通知，给前端显示（onFinish 时持久化进 DB）。
        compactionNotice = buildCompactionNotice(result);
        console.log(
          `[compaction] chat=${chatId} ${result.tokensBefore}→${result.tokensAfter} tokens, compacted ${result.compactedCount} messages`,
        );
      }
    } catch (error) {
      // compaction 失败不应阻塞主对话：降级继续用原消息喂 agent（可能超 context，
      // 但至少能跑），并打日志。
      console.warn(
        `[compaction] failed for chat=${chatId}, continuing without compaction:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  // ---------------------------------------------------------------------

  // A2 Phase 1 fire-and-forget：在主 workflow 启动**之前**触发上一段未处理的
  // jsonl 抽取。
  //
  // 关键设计（对齐 codex）：
  // - **不 await**：完全后台跑，主对话延时 0 影响
  // - **抽的是上一轮**：当前请求的 user message 这时候还没写进 jsonl（fullSanitized
  //   是这次刚 sanitize 的，写盘发生在 saveMessages 之后），extractor 看到的是
  //   上一次 turn 的完整 transcript（user→assistant→tool→...→assistant）
  // - **memoryEnabled=false 内部检查**：extractor 自己判，不在这里判，方便配置
  //   未热加载时也能正确跳过
  // - **错误静默**：runPhase1ForThread 自身不抛，所有失败都收进 result.error
  void runPhase1ForThread({
    threadId: chatId,
    cwd: workspaceRoot,
  })
    .then((result) => {
      if (result.error) {
        console.warn(`[memory/phase1] chat=${chatId}: ${result.error}`);
      } else if (result.wroteRawMemory || result.wroteSummary) {
        console.log(
          `[memory/phase1] chat=${chatId} processed=${result.newLinesProcessed} ` +
            `wroteSummary=${result.wroteSummary} wroteRawMemory=${result.wroteRawMemory}`,
        );
      }
    })
    .catch((error) => {
      // 理论上不会进这里（extractor 内部已 try/catch），保险再兜一层
      console.warn(
        `[memory/phase1] chat=${chatId} unexpected throw:`,
        error instanceof Error ? error.message : error,
      );
    });

  // Skill discovery 进程内缓存：每次请求拿一份最新 metadata 列表（body 不在这里读）。
  // 这调用很轻——首次扫盘后 cached，后续就是 Map 命中。
  const skills = await getSkills();

  const run = await start(runAgentWorkflow, [
    {
      chatId,
      agentMessages,
      fullMessages: fullSanitized,
      compactionNotice,
      workspaceRoot,
      workspaceName: body.workspaceName,
      workspaceAccessMode,
      shellApprovalPolicy: body.shellApprovalPolicy,
      permissionMode,
      planMode,
      conversationSummary: agentSummary,
      skills,
    },
  ]);

  const claimed = compareAndSetActiveStreamId(chatId, null, run.runId);
  if (!claimed) {
    await run.cancel().catch(() => undefined);
    return Response.json(
      { error: "Another workflow is already running for this chat." },
      { status: 409 },
    );
  }

  return createUIMessageStreamResponse({
    stream: createCancelableReadableStream(
      orderStatefulUIMessageChunks(
        dropReasoningChunks(run.getReadable<ChatUIMessageChunk>()),
      ),
    ),
    headers: { "x-workflow-run-id": run.runId },
  });
}

type ExistingActiveStreamResolution =
  | {
      action: "resume";
      runId: string;
      stream: ReadableStream<ChatUIMessageChunk>;
    }
  | { action: "ready" }
  | { action: "conflict" };

async function reconcileExistingActiveStream(
  chatId: string,
  activeStreamId: string,
): Promise<ExistingActiveStreamResolution> {
  let currentStreamId: string | null = activeStreamId;

  for (
    let attempt = 1;
    currentStreamId && attempt <= ACTIVE_STREAM_RECONCILIATION_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      const run = getRun(currentStreamId);
      const status = await run.status;
      if (status === "running" || status === "pending") {
        return {
          action: "resume",
          runId: currentStreamId,
          stream: createCancelableReadableStream(
            orderStatefulUIMessageChunks(
              dropReasoningChunks(run.getReadable<ChatUIMessageChunk>()),
            ),
          ),
        };
      }
    } catch {
      // Run not found, inaccessible, or already collected. Try clearing below.
    }

    const cleared = compareAndSetActiveStreamId(chatId, currentStreamId, null);
    if (cleared) {
      return { action: "ready" };
    }

    currentStreamId = getActiveStreamId(chatId);
  }

  return currentStreamId ? { action: "conflict" } : { action: "ready" };
}
