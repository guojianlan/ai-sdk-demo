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
import { sanitizeChatUIMessages } from "@/lib/chat/sanitize-messages";
import {
  compareAndSetActiveStreamId,
  getActiveStreamId,
  loadSummary,
  saveMessages,
  saveSummary,
} from "@/lib/chat-store";
import {
  buildCompactionNotice,
  compactMessages,
  estimateTokens,
} from "@/lib/compaction";
import { env, requireGatewayApiKey } from "@/lib/env";
import { gateway } from "@/lib/gateway";
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
    bypassPermissions?: boolean;
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
  saveMessages(chatId, fullSanitized);

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

  const run = await start(runAgentWorkflow, [
    {
      chatId,
      agentMessages,
      fullMessages: fullSanitized,
      compactionNotice,
      workspaceRoot,
      workspaceName: body.workspaceName,
      workspaceAccessMode,
      bypassPermissions: body.bypassPermissions === true,
      conversationSummary: agentSummary,
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
