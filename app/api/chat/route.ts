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
  loadMessages,
  loadSummary,
  saveMessages,
  saveSummary,
  upsertThread,
} from "@/lib/persistence";
import {
  buildHookRegistryFromSettings,
  copyHooksInto,
  defaultHookRegistry,
  HookRegistry,
  runHooks,
} from "@/lib/hooks";
import { loadSettings } from "@/lib/permissions";
import {
  buildCompactionNotice,
  compactMessages,
  estimateTokens,
} from "@/lib/compaction";
import { env, requireGatewayApiKey } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import { runPhase1ForThread } from "@/lib/memory";
import { truncateToolPartsForTransport } from "@/lib/output-truncation";
import { getSkills } from "@/lib/skills";
import {
  createCancelableReadableStream,
  dropReasoningChunks,
  orderStatefulUIMessageChunks,
} from "@/lib/workflow-readable";

type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

const ACTIVE_STREAM_RECONCILIATION_MAX_ATTEMPTS = 3;

// 每个 tool input/output 字符串字段进 workflow queue 前的硬上限。
// 1.5 MiB queue cap / ~100 可能的 tool part ≈ 15 KB 安全预算；取 12 KB 留点余地。
const WORKFLOW_TRANSPORT_MAX_STRING_BYTES = 12_000;

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

  // --- P9-c: UserPromptSubmit + SessionStart hook ----------------------
  //
  // 在 saveMessages 之前判断"是不是 chat 的第一条 user 消息"——一旦 saveMessages
  // 跑完，DB 里就有了，无法回头判定。SessionStart 触发条件 = DB 此前为空 + 本轮
  // 至少有一条 user 消息（典型首条请求）。
  //
  // 跑 hook 用一个**组合 registry**：defaultHookRegistry（日志）+ settings-derived
  // （声明式 hook 如 dotenv-blocklist）。这跟 workflow 内 wrap-toolset 用的是同
  // 一套组合策略，保证"工具层"与"prompt 层"行为口径一致。
  const priorMessages = loadMessages(chatId);
  const isFirstUserTurn =
    priorMessages.length === 0 &&
    fullSanitized.some((m) => m.role === "user");

  const settings = loadSettings(workspaceRoot);
  const promptHookRegistry = new HookRegistry();
  copyHooksInto(promptHookRegistry, defaultHookRegistry);
  copyHooksInto(
    promptHookRegistry,
    buildHookRegistryFromSettings(settings),
  );

  const hookContexts: string[] = [];

  if (isFirstUserTurn) {
    const sessionStartResult = await runHooks(
      promptHookRegistry,
      "SessionStart",
      { event: "SessionStart", sessionId: chatId },
      { sessionId: chatId },
    );
    if (sessionStartResult.decision === "deny") {
      // deny 在 SessionStart 上语义比较强 —— 直接拒绝整条会话起步。
      return new Response(
        `Session denied by hook "${sessionStartResult.deniedBy}": ${
          sessionStartResult.reason ?? "no reason given"
        }`,
        { status: 403 },
      );
    }
    hookContexts.push(...sessionStartResult.additionalContexts);
    hookContexts.push(...sessionStartResult.systemMessages);
  }

  // UserPromptSubmit：取最末一条 user 消息的纯文本喂 hook。
  const latestUserText = extractLatestUserText(fullSanitized);
  if (latestUserText !== null) {
    const promptResult = await runHooks(
      promptHookRegistry,
      "UserPromptSubmit",
      {
        event: "UserPromptSubmit",
        prompt: latestUserText,
        sessionId: chatId,
      },
      { sessionId: chatId },
    );
    if (promptResult.decision === "deny") {
      return new Response(
        `Prompt denied by hook "${promptResult.deniedBy}": ${
          promptResult.reason ?? "no reason given"
        }`,
        { status: 403 },
      );
    }
    hookContexts.push(...promptResult.additionalContexts);
    hookContexts.push(...promptResult.systemMessages);
  }
  // ---------------------------------------------------------------------

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

  // A2 Phase 1 fire-and-forget：每次 POST 入口触发一次（不 await）。
  //
  // 关键设计：
  // - extractor 读 SQLite（`loadMessages`）而不是 jsonl —— jsonl 上 saveMessages
  //   每次都把整段 deduped 历史 append 一遍（messages.ts:113-130），用 line offset
  //   作 cursor 会跨 POST 重复抽。SQLite 是规范化快照，cursor = 已处理 message 数。
  // - **POST 1 抽到 user 单边消息**：那时还没 asst 回复，extractor 只看到 user，
  //   可以抽出身份/偏好类（自表达不依赖回复）。POST 2 抽新增 [asst1, user2]，
  //   POST 3 抽 [asst2]，……每个 POST 增量推进 cursor，不重叠。
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
      console.warn(
        `[memory/phase1] chat=${chatId} unexpected throw:`,
        error instanceof Error ? error.message : error,
      );
    });

  // Skill discovery 进程内缓存：每次请求拿一份最新 metadata 列表（body 不在这里读）。
  // 这调用很轻——首次扫盘后 cached，后续就是 Map 命中。
  const skills = await getSkills();

  // 传输层硬截断：workflow queue（world-local 实现）单条消息体上限 1.5 MiB，
  // 超了就抛 `SyntaxError: Unterminated string in JSON at position 1572864`。
  // compaction 在大输入下自己也会 LLM 超时 fallback，救不了场。这里在 start()
  // 之前把每个 tool-like part 的 input/output 字符串截到 ~12KB，结构保留，
  // 保证不管历史多脏都能进队列。
  const agentMessagesForWorkflow = truncateToolPartsForTransport(
    agentMessages,
    WORKFLOW_TRANSPORT_MAX_STRING_BYTES,
  );
  const fullMessagesForWorkflow = truncateToolPartsForTransport(
    fullSanitized,
    WORKFLOW_TRANSPORT_MAX_STRING_BYTES,
  );

  const run = await start(runAgentWorkflow, [
    {
      chatId,
      agentMessages: agentMessagesForWorkflow,
      fullMessages: fullMessagesForWorkflow,
      compactionNotice,
      workspaceRoot,
      workspaceName: body.workspaceName,
      workspaceAccessMode,
      shellApprovalPolicy: body.shellApprovalPolicy,
      permissionMode,
      planMode,
      conversationSummary: agentSummary,
      skills,
      hookContexts,
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

/**
 * 从 sanitize 过的 UI messages 里找最末一条 user 消息，拼出它的纯文本。
 * UIMessage.parts 里只取 `type: "text"`，其它 part（tool / file / etc）忽略。
 * 没有 user 消息 / 没有 text part → 返回 null。
 */
function extractLatestUserText(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = (m.parts ?? [])
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          (p as { type: unknown }).type === "text" &&
          typeof (p as { text: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
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
