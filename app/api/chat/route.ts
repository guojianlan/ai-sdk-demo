import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  type InferUIMessageChunk,
  type UIMessage,
} from "ai";

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
  loadActiveContext,
  loadMessages,
  loadSummary,
  saveActiveContext,
  saveMessages,
  upsertThread,
} from "@/lib/persistence";
import {
  buildCommandHookRegistryFromProjectSettings,
  buildHookRegistryFromSettings,
  copyHooksInto,
  defaultHookRegistry,
  HookRegistry,
  runHooks,
} from "@/lib/hooks";
import { loadProjectSettings, loadSettings } from "@/lib/permissions";
import {
  buildCompactionNotice,
  compactMessages,
  compactMessagesDeterministically,
  type CompactionResult,
  estimateTokens,
} from "@/lib/compaction";
import { lastAssistantMessageHasCompletedClientContinuationTool } from "@/lib/chat/auto-submit";
import {
  createActiveChatRunReadable,
  getActiveChatRun,
  registerActiveChatRun,
} from "@/lib/chat-agent/active-runs";
import { runChatAgentLoop } from "@/lib/chat-agent/run-loop";
import { env, requireGatewayApiKey } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import { runPhase1ForThread } from "@/lib/memory";
import { truncateToolPartsForTransport } from "@/lib/output-truncation";
import { getSkills } from "@/lib/skills";
import {
  createCancelableReadableStream,
  dropReasoningChunks,
  orderStatefulUIMessageChunks,
} from "@/lib/chat-agent/stream-utils";

type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

const ACTIVE_STREAM_RECONCILIATION_MAX_ATTEMPTS = 3;

// 每个 tool input/output 字符串字段进入下一次 model context 前的硬上限。
// 保留这个防线，即使移除了 Workflow DevKit，也避免旧历史里的超大 tool 输出拖垮请求。
const MODEL_CONTEXT_MAX_STRING_BYTES = 12_000;

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
        headers: { "x-chat-run-id": existingStream.runId },
      });
    }
    if (existingStream.action === "conflict") {
      return Response.json(
        { error: "Another chat run is already running for this chat." },
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
  // （声明式 hook 如 dotenv-blocklist）。这跟 chat loop 内 wrap-toolset 用的是同
  // 一套组合策略，保证"工具层"与"prompt 层"行为口径一致。
  const priorMessages = loadMessages(chatId);
  const isFirstUserTurn =
    priorMessages.length === 0 &&
    fullSanitized.some((m) => m.role === "user");

  const settings = loadSettings(workspaceRoot);
  const projectSettings = loadProjectSettings(workspaceRoot);
  const promptHookRegistry = new HookRegistry();
  copyHooksInto(promptHookRegistry, defaultHookRegistry);
  copyHooksInto(
    promptHookRegistry,
    buildHookRegistryFromSettings(settings),
  );
  copyHooksInto(
    promptHookRegistry,
    buildCommandHookRegistryFromProjectSettings(projectSettings, {
      cwd: workspaceRoot,
    }),
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

  // --- Codex-style active context compaction ---------------------------
  //
  // DB 的 messages 表继续保存完整 UI transcript；agent 输入改走独立的
  // active replacement history。这样被污染成 `user + assistant + assistant...`
  // 的可见历史不会再因为 compacted_count 切片失败而直接灌进 model context。
  const agentViewMessages = fullSanitized.filter(
    (message) => message.role !== "system",
  );

  const activeContext = loadActiveContext(chatId);
  const legacySummary = activeContext ? null : loadSummary(chatId);

  let agentMessages = buildAgentMessagesFromActiveContext(
    activeContext,
    agentViewMessages,
  );
  let agentSummary = activeContext?.summary ?? legacySummary?.summary ?? null;
  // 本轮压缩产生的通知消息；onFinish 时插入到保存链里给下次 UI 看到。
  let compactionNotice: UIMessage | null = null;

  const currentTokens = estimateActiveContextTokens(agentMessages, agentSummary);
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
    let result: CompactionResult<UIMessage>;
    try {
      result = await compactMessages({
        messages: agentMessages,
        model: summarizerModel,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: agentSummary,
      });
    } catch (error) {
      console.warn(
        `[compaction] llm failed for chat=${chatId}, falling back deterministically:`,
        error instanceof Error ? error.message : error,
      );
      result = compactMessagesDeterministically({
        messages: agentMessages,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: agentSummary,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (!result.summary || result.tokensAfter > env.compaction.thresholdTokens) {
      result = compactMessagesDeterministically({
        messages: agentMessages,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: agentSummary,
        reason: !result.summary
          ? "LLM compaction returned an empty summary."
          : `LLM compaction stayed over budget (${result.tokensAfter} > ${env.compaction.thresholdTokens}).`,
      });
    }

    if (result.tokensAfter > env.compaction.thresholdTokens) {
      return Response.json(
        {
          error:
            "Conversation is still over the active-context budget after deterministic compaction.",
          tokensAfter: result.tokensAfter,
          threshold: env.compaction.thresholdTokens,
        },
        { status: 413 },
      );
    }

    const totalCompactedCount =
      (activeContext?.compactedCount ?? 0) + result.compactedCount;
    saveActiveContext(chatId, {
      summary: result.summary,
      replacementMessages: result.replacementMessages,
      compactedCount: totalCompactedCount,
      sourceMessageCount: agentViewMessages.length,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      strategy: result.strategy,
    });
    agentMessages = result.replacementMessages;
    agentSummary = result.summary;
    compactionNotice = buildCompactionNotice({
      ...result,
      compactedCount: totalCompactedCount,
    });
    console.log(
      `[compaction] chat=${chatId} strategy=${result.strategy} ${result.tokensBefore}→${result.tokensAfter} tokens, compacted=${totalCompactedCount}`,
    );
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

  // 进入 chat run 前把每个 tool-like part 的 input/output 字符串截到 ~12KB，
  // 结构保留。旧 DB 里可能存着 pre-truncation 时代留下的大块 stdout/file content。
  const agentMessagesForRun = truncateToolPartsForTransport(
    agentMessages,
    MODEL_CONTEXT_MAX_STRING_BYTES,
  );
  const fullMessagesForRun = truncateToolPartsForTransport(
    fullSanitized,
    MODEL_CONTEXT_MAX_STRING_BYTES,
  );

  const runId = generateId();
  const claimed = compareAndSetActiveStreamId(chatId, null, runId);
  if (!claimed) {
    return Response.json(
      { error: "Another chat run is already running for this chat." },
      { status: 409 },
    );
  }

  const abortController = new AbortController();
  const source = createUIMessageStream<UIMessage>({
    async execute({ writer }) {
      try {
        await runChatAgentLoop({
          runId,
          writer,
          abortSignal: abortController.signal,
          options: {
            chatId,
            agentMessages: agentMessagesForRun,
            fullMessages: fullMessagesForRun,
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
        });
      } finally {
        compareAndSetActiveStreamId(chatId, runId, null);
      }
    },
    onError: (error) =>
      error instanceof Error ? error.message : "Unknown chat run error",
  });
  const run = registerActiveChatRun({
    id: runId,
    chatId,
    controller: abortController,
    source,
  });

  return createUIMessageStreamResponse({
    stream: createCancelableReadableStream(
      orderStatefulUIMessageChunks(
        dropReasoningChunks(createActiveChatRunReadable(run)),
      ),
    ),
    headers: { "x-chat-run-id": runId },
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

function buildAgentMessagesFromActiveContext(
  activeContext: ReturnType<typeof loadActiveContext>,
  agentViewMessages: UIMessage[],
): UIMessage[] {
  if (!activeContext) return agentViewMessages;

  const sourceIndex = Math.min(
    Math.max(activeContext.sourceMessageCount, 0),
    agentViewMessages.length,
  );
  const tailMessages = agentViewMessages.slice(sourceIndex);
  const nextMessages = [...activeContext.replacementMessages, ...tailMessages];

  // Human answers to client-side tools mutate the latest assistant message
  // instead of appending a new user message. If the active context cursor has
  // already advanced past that assistant message, append that completed
  // interaction so convertToModelMessages can see the tool output.
  if (
    tailMessages.length === 0 &&
    lastAssistantMessageHasCompletedClientContinuationTool({
      messages: agentViewMessages,
    })
  ) {
    const lastMessage = agentViewMessages.at(-1);
    if (lastMessage) {
      nextMessages.push(lastMessage);
    }
  }

  const deduped = new Map<string, UIMessage>();
  for (const message of nextMessages) {
    deduped.set(message.id, message);
  }
  return Array.from(deduped.values());
}

function estimateActiveContextTokens(
  messages: UIMessage[],
  summary: string | null,
): number {
  return estimateTokens(messages) + Math.ceil((summary?.length ?? 0) / 3);
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
      const run = getActiveChatRun(currentStreamId);
      if (run?.status === "running") {
        return {
          action: "resume",
          runId: currentStreamId,
          stream: createCancelableReadableStream(
            orderStatefulUIMessageChunks(
              dropReasoningChunks(createActiveChatRunReadable(run)),
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
