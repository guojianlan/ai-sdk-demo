import {
  convertToModelMessages,
  generateId as generateIdAi,
  smoothStream,
  type FinishReason,
  type InferUIMessageChunk,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import { getWorkflowMetadata, getWritable } from "workflow";
import { getRun } from "workflow/api";

import type { WorkspaceAccessMode } from "@/lib/chat-access-mode";
import type { CompactionResult } from "@/lib/compaction";
import type { PermissionMode } from "@/lib/permissions";
import type { SkillMetadata } from "@/lib/skills";
import type { ShellApprovalPolicy } from "@/lib/tools/shell-approval";
import {
  hasCompletedToolCalls,
  shouldPauseForToolInteraction,
} from "@/lib/workflow-pause";

/**
 * 这个文件运行在 workflow runtime 里，workflow plugin 会扫描静态 import 链；
 * 链上任何 Node-only 模块（fs/path/os/better-sqlite3 等）都会被拒绝。
 *
 * 所以：用到 env / chat-store / mcp / agent-config 的地方都改成 step 内部
 * `await import()`（参考 open-agents apps/web/app/workflows/chat.ts 的做法）。
 * 顶层只允许保留 ai / workflow 包、纯 type、和无 Node 依赖的本地模块。
 */

export type ChatWorkflowOptions = {
  chatId: string;
  agentMessages: UIMessage[];
  fullMessages: UIMessage[];
  compactionNotice: UIMessage | null;
  workspaceRoot: string;
  workspaceName?: string;
  workspaceAccessMode: WorkspaceAccessMode;
  shellApprovalPolicy: ShellApprovalPolicy | undefined;
  /** 会话级权限模式。default / acceptEdits / bypassPermissions。 */
  permissionMode: PermissionMode;
  /** Plan 模式（codex collaboration mode）。开启后过滤 mutating tool 并注入 PLAN_MODE_PROMPT。 */
  planMode: boolean;
  conversationSummary: string | null;
  /** 当前会话可用 skill 列表（POST handler 调 getSkills() 取得后传入）。 */
  skills: SkillMetadata[];
  /**
   * P9-c：UserPromptSubmit / SessionStart hook 在 POST 入口跑完之后收集到的
   * `additionalContexts` + `systemMessages`。Workflow 原样透传给
   * `createProjectEngineerAgent`，由 builder 注入 system prompt 末尾
   * （`# Hook context` 段）。空数组 = 这次没收到，该段不出现。
   */
  hookContexts: string[];
};

type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

type StepResult = {
  responseMessage: UIMessage | null;
  responseModelMessages: ModelMessage[];
  finishReason: FinishReason | undefined;
  aborted: boolean;
  postToolHookContexts: string[];
};

/**
 * 主聊天 workflow（对齐 open-agents apps/web/app/workflows/chat.ts）。
 *
 * 设计：
 * - 内层 `agent.stream()` 一次只跑 1 步（builder 里固定 stopWhen=1），所以
 *   多步循环必须由这里手写一个 for loop，由 env.outerStepLimit（默认 500）控制上限。
 * - 每步是一个 "use step"——workflow durable 检查点，便于失败 resume。
 * - assistantId 在循环外预生成一次，所有步共用，UI 看到的是同一条 assistant 消息
 *   不断追加内容（而不是冒出 N 条独立消息）。
 * - 循环出口：finishReason !== "tool-calls" / 命中 shouldPauseForToolInteraction（
 *   approval 弹窗 / interactive tool 等待用户回复）/ 触顶 outerStepLimit / 被 abort。
 * - 按步落库：每步完成都调一次 saveMessages，UI 刷新立刻拿到截至本步的状态。
 *   compactionNotice 只插一次（因为它是"本轮压缩"的标记，不重复）。
 */
export async function runAgentWorkflow(options: ChatWorkflowOptions) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  try {
    await runAgentLoop(options, workflowRunId);
  } finally {
    await clearActiveStream(options.chatId, workflowRunId);
    await closeWorkflowStream();
  }
}

async function runAgentLoop(
  options: ChatWorkflowOptions,
  workflowRunId: string,
): Promise<void> {
  const assistantId = await reserveAssistantId();

  // 把现有 UI 消息转成 model messages；后续每步把新的 response model messages 追加进去。
  // 注意：这里用空 toolset 转换是 ok 的——convert 只关心结构，不会去执行 tool。
  let modelMessages: ModelMessage[] = await convertToModelMessages(
    options.agentMessages,
    { ignoreIncompleteToolCalls: true },
  );
  let agentMessagesForStream = options.agentMessages;

  // 预先发一次 start 把"新 assistant message"的开始信号通知给 UI。
  // 后续每步的 toUIMessageStream 都设 sendStart:false / sendFinish:false，
  // 所有步的内容都追加到同一条 assistantId 上。
  await sendStartChunk(assistantId);

  let pendingResponseMessage: UIMessage | null = null;
  let exhaustedSteps = false;
  let finalFinishReason: FinishReason | undefined;
  let conversationSummaryForNextStep = options.conversationSummary;
  const compactionNoticesForPersist = options.compactionNotice
    ? [options.compactionNotice]
    : [];

  const limit = await getOuterStepLimit();

  // workflow 内的 token budget 上限。对齐 codex 的 70% 模型窗口策略。
  // 复用 env.compaction.thresholdTokens（默认 60_000）作为软上限：超了就主动
  // graceful stop，不让 LLM 调用打过去爆 context。
  //
  // 跟 P4-b（per-POST compaction）的关系：
  // - P4-b 在 POST 入口跑一次 LLM 压缩老对话，保证**进入 workflow 时**起点 token
  //   合理（60k 以下）。
  // - 这里是 workflow **每步前**再 check 一次 —— 大库 plan 模式跑十几步 tool
  //   call 后累计 tool 输出可能让 modelMessages 涨到 100k+，此时再调一次 LLM
  //   就 timeout / empty_stream。提前 break，让用户看到 partial 进度而不是错误。
  const tokenBudgetSoftCap = await getTokenBudgetSoftCap();

  let tokenBudgetTripped = false;
  let hookContextsForNextStep = [...options.hookContexts];

  for (let step = 0; step < limit; step++) {
    // 每步前估算下一次 LLM 调用的 input token（modelMessages 累积大小）。
    // 估算用 char count / 3 同 compaction —— 粗但够用做"快爆了"判断。
    const currentTokenEstimate = estimateModelMessageTokens(modelMessages);
    if (currentTokenEstimate > tokenBudgetSoftCap) {
      console.warn(
        `[workflow/chat] chat=${options.chatId} step=${step + 1} token budget tripped (estimated=${currentTokenEstimate} > cap=${tokenBudgetSoftCap}); attempting mid-turn compaction`,
      );
      const visibleAgentMessages = buildVisibleAgentMessagesForWorkflow(
        options.fullMessages,
        pendingResponseMessage,
      );
      const activeMessagesForCompaction = pendingResponseMessage
        ? [...options.agentMessages, pendingResponseMessage]
        : options.agentMessages;
      const midTurnCompaction = await compactWorkflowContext({
        chatId: options.chatId,
        messages: activeMessagesForCompaction,
        previousSummary: conversationSummaryForNextStep,
        sourceMessageCount: visibleAgentMessages.length,
        tokenBudgetSoftCap,
      });

      if (midTurnCompaction.ok) {
        modelMessages = await convertToModelMessages(
          midTurnCompaction.replacementMessages,
          { ignoreIncompleteToolCalls: true },
        );
        conversationSummaryForNextStep = midTurnCompaction.summary;
        agentMessagesForStream = midTurnCompaction.replacementMessages;
        compactionNoticesForPersist.push(midTurnCompaction.notice);
        const compactedEstimate =
          estimateModelMessageTokens(modelMessages) +
          Math.ceil(midTurnCompaction.summary.length / 3);
        console.log(
          `[workflow/chat] chat=${options.chatId} mid-turn compaction strategy=${midTurnCompaction.strategy} estimated=${currentTokenEstimate}→${compactedEstimate}`,
        );
        if (compactedEstimate > tokenBudgetSoftCap) {
          console.warn(
            `[workflow/chat] chat=${options.chatId} mid-turn compaction still over budget (estimated=${compactedEstimate} > cap=${tokenBudgetSoftCap})`,
          );
          const budgetText =
            `当前对话的 active context 压缩后仍超过预算（估算 ${compactedEstimate} tokens，` +
            `上限 ${tokenBudgetSoftCap}）。我已经停止本轮继续调用模型，避免再次把超大历史送进 workflow；` +
            "请发起下一条消息，我会先使用已保存的压缩上下文继续。";
          pendingResponseMessage = await appendBudgetStopText({
            chatId: options.chatId,
            fullMessages: options.fullMessages,
            compactionNotices: compactionNoticesForPersist,
            assistantId,
            existingMessage: pendingResponseMessage,
            text: budgetText,
          });
          finalFinishReason = "stop";
          tokenBudgetTripped = true;
          break;
        }
      } else {
        console.warn(
          `[workflow/chat] chat=${options.chatId} mid-turn compaction failed: ${midTurnCompaction.error}`,
        );
        const budgetText =
          `当前对话的 active context 已超过预算（估算 ${currentTokenEstimate} tokens，` +
          `上限 ${tokenBudgetSoftCap}），并且本轮自动压缩失败：${midTurnCompaction.error}。` +
          "我已经停止继续调用模型，避免再次把超大历史送进 workflow。";
        pendingResponseMessage = await appendBudgetStopText({
          chatId: options.chatId,
          fullMessages: options.fullMessages,
          compactionNotices: compactionNoticesForPersist,
          assistantId,
          existingMessage: pendingResponseMessage,
          text: budgetText,
        });
        finalFinishReason = "stop";
        tokenBudgetTripped = true;
        break;
      }
    }

    const currentTokenEstimateAfterCompaction =
      estimateModelMessageTokens(modelMessages);
    if (currentTokenEstimateAfterCompaction > tokenBudgetSoftCap) {
      const budgetText =
        `当前对话的 active context 已超过预算（估算 ${currentTokenEstimateAfterCompaction} tokens，` +
        `上限 ${tokenBudgetSoftCap}）。我已经停止本轮继续调用模型，避免再次把超大历史送进 workflow；` +
        "请发起下一条消息，我会先使用已保存的压缩上下文继续。";
      pendingResponseMessage = await appendBudgetStopText({
        chatId: options.chatId,
        fullMessages: options.fullMessages,
        compactionNotices: compactionNoticesForPersist,
        assistantId,
        existingMessage: pendingResponseMessage,
        text: budgetText,
      });
      finalFinishReason = "stop";
      tokenBudgetTripped = true;
      break;
    }

    // toUIMessageStream 的 originalMessages 用于 message id 基准：
    // - step 0：用 options.agentMessages（用户消息历史）
    // - step >0：用上一轮的 pendingResponseMessage，让 stream 继续追加到同一条 assistant 消息
    const originalMessagesForStep: UIMessage[] = pendingResponseMessage
      ? [pendingResponseMessage]
      : agentMessagesForStream;

    const result = await runAgentStep(
      options,
      workflowRunId,
      modelMessages,
      originalMessagesForStep,
      assistantId,
      step,
      hookContextsForNextStep,
      conversationSummaryForNextStep,
    );

    if (result.responseModelMessages.length > 0) {
      modelMessages = [...modelMessages, ...result.responseModelMessages];
    }

    if (result.postToolHookContexts.length > 0) {
      hookContextsForNextStep = [
        ...hookContextsForNextStep,
        ...result.postToolHookContexts,
      ];
    }

    if (result.responseMessage) {
      pendingResponseMessage = result.responseMessage;
      // 同一个 assistantId 的快照：每步都是这条消息的"截至本步"完整版，
      // 累积保存只需要最新这一份。
      const allMessages = buildPersistedMessages(
        options.fullMessages,
        compactionNoticesForPersist,
        pendingResponseMessage,
      );
      await persistAssistantSnapshot(options.chatId, allMessages);
    }

    finalFinishReason = result.finishReason;

    // outer loop 是否继续？两条路：
    // 1. AI SDK 报 finishReason="tool-calls"（模型还没说完，需要 tool 结果继续）
    // 2. 或者 message 里已经有跑完的 tool call (output-available 等)，但模型本步
    //    finish=stop——这是 AI SDK 在 stopWhen=stepCountIs(1) 下的常见情况：
    //    模型本步只发了一个 tool call、AI SDK 执行了它就到了 step 上限，模型没看
    //    到结果就停了。这种情况外层必须再跑一步，让模型看到 tool 结果。
    //    现在这个续跑只允许在后端 loop 里发生；前端不会再用通用
    //    lastAssistantMessageIsCompleteWithToolCalls 把 server tool output 开成新 workflow。
    const responseParts = result.responseMessage?.parts ?? [];
    const isToolCallContinuation =
      result.finishReason === "tool-calls" || hasCompletedToolCalls(responseParts);
    const needsPause = shouldPauseForToolInteraction(responseParts);

    console.log(
      `[workflow/chat] chat=${options.chatId} step=${step + 1}/${limit} finishReason=${result.finishReason ?? "?"} pause=${needsPause} aborted=${result.aborted} continue=${isToolCallContinuation}`,
    );

    if (result.aborted) break;
    if (!isToolCallContinuation) {
      const stopContexts = await runStopHooksForStep(
        options,
        result.finishReason,
        result.responseMessage,
        step + 1,
      );
      if (stopContexts.length > 0 && step + 1 < limit) {
        hookContextsForNextStep = [...hookContextsForNextStep, ...stopContexts];
        finalFinishReason = undefined;
        continue;
      }
      break;
    }
    if (needsPause) break;

    if (step + 1 >= limit) {
      exhaustedSteps = true;
      break;
    }
  }

  if (exhaustedSteps) {
    console.warn(
      `[workflow/chat] chat=${options.chatId} hit OUTER_STEP_LIMIT=${limit}; loop terminated`,
    );
  }

  if (tokenBudgetTripped) {
    console.warn(
      `[workflow/chat] chat=${options.chatId} stopped due to token budget; user should start a new chat for follow-up`,
    );
  }

  // 不管以什么原因退出循环，都要发一个 finish 关掉这条 assistant 消息——
  // 否则 UI 会一直显示 streaming 状态。
  await sendFinishChunk(finalFinishReason ?? "stop");
}

async function runStopHooksForStep(
  options: ChatWorkflowOptions,
  finishReason: FinishReason | undefined,
  lastAssistantMessage: UIMessage | null,
  step: number,
): Promise<string[]> {
  "use step";

  const { loadProjectSettings, loadSettings } = await import("@/lib/permissions");
  const {
    buildCommandHookRegistryFromProjectSettings,
    buildHookRegistryFromSettings,
    copyHooksInto,
    defaultHookRegistry,
    HookRegistry,
    runHooks,
  } = await import("@/lib/hooks");

  const registry = new HookRegistry();
  copyHooksInto(registry, defaultHookRegistry);
  copyHooksInto(registry, buildHookRegistryFromSettings(loadSettings(options.workspaceRoot)));
  copyHooksInto(
    registry,
    buildCommandHookRegistryFromProjectSettings(
      loadProjectSettings(options.workspaceRoot),
      { cwd: options.workspaceRoot },
    ),
  );

  const stop = await runHooks(
    registry,
    "Stop",
    {
      event: "Stop",
      sessionId: options.chatId,
      finishReason: finishReason ?? "stop",
      step,
      lastAssistantMessage,
    },
    { sessionId: options.chatId },
  );

  if (stop.decision !== "deny") return [];
  return [
    stop.reason
      ? `Stop hook blocked completion: ${stop.reason}`
      : "Stop hook blocked completion.",
    ...stop.additionalContexts,
    ...stop.systemMessages,
  ];
}

async function runAgentStep(
  options: ChatWorkflowOptions,
  workflowRunId: string,
  modelMessages: ModelMessage[],
  originalMessagesForStep: UIMessage[],
  assistantId: string,
  stepIndex: number,
  hookContexts: string[],
  conversationSummary: string | null,
): Promise<StepResult> {
  "use step";

  const hasWorkspaceTools = options.workspaceAccessMode === "workspace-tools";

  let mcpTools: ToolSet = {};
  let closeMcp: (() => Promise<void>) | null = null;
  if (hasWorkspaceTools) {
    try {
      const { createWeatherMCPClient } = await import("@/lib/mcp/weather-client");
      const mcp = await createWeatherMCPClient();
      mcpTools = (await mcp.tools()) as ToolSet;
      closeMcp = () => mcp.close();
    } catch (error) {
      console.warn(
        "[workflow/chat] weather MCP init failed, continuing without it:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const { createProjectEngineerAgent, projectEngineerStaticToolset } =
    await import("@/app/api/chat/agent-config");
  // interactiveToolset 也通过 dynamic import 进 step——`lib/tools` barrel 透传到
  // 含 node:fs 的 skill tool，静态 import 会被 workflow plugin 拒（"node-js module
  // in workflow"）。
  const { interactiveToolset } = await import("@/lib/tools");

  // Toolset 过滤：plan 模式 + 项目级 memoryEnabled 开关都在这一步生效。
  // - plan 模式：过滤 update_plan / write / edit（agent 看不见就不会调，比 codex
  //   handler runtime 报错更直接）。shell 不过滤（plan.md 自己约束）
  // - memoryEnabled=false：过滤 memory_write
  // 两个条件可叠加。settings 通过 dynamic import 取 —— chat.ts 在 workflow 插件
  // 上下文里跑，barrel 静态 import 含 node:fs 的模块会被拒。
  const { isMemoryEnabled, loadProjectSettings, loadSettings } =
    await import("@/lib/permissions");
  const settings = loadSettings(options.workspaceRoot);
  const projectSettings = loadProjectSettings(options.workspaceRoot);
  const memoryEnabled = isMemoryEnabled(settings);

  const baseTools: ToolSet = hasWorkspaceTools
    ? { ...projectEngineerStaticToolset, ...mcpTools }
    : { ...interactiveToolset };

  const filterKeys = new Set<string>();
  if (options.planMode) {
    filterKeys.add("update_plan");
    filterKeys.add("write");
    filterKeys.add("edit");
  }
  if (!memoryEnabled) {
    filterKeys.add("memory_write");
  }
  const tools: ToolSet =
    filterKeys.size === 0
      ? baseTools
      : Object.fromEntries(
          Object.entries(baseTools).filter(([key]) => !filterKeys.has(key)),
        );

  // P9-b/c：tool execute 上挂 PreToolUse / PostToolUse hook。
  // 走 dynamic import 是因为 hooks barrel 会拉 `lib/workspaces`（含 node:path），
  // workflow plugin 静态扫到 node module 就拒，跟 settings / mcp 那套同样处理。
  //
  // 每步现场拼一个组合 registry：
  //   1. defaultHookRegistry（含 toolLogging，进程级单例）
  //   2. 从 settings.hooks 还原的声明式 hook（如 dotenv-blocklist 开关）
  // 两者按事件 concat 注入新 registry，不动全局 default。
  const {
    buildCommandHookRegistryFromProjectSettings,
    buildHookRegistryFromSettings,
    copyHooksInto,
    defaultHookRegistry,
    HookRegistry,
    wrapToolsetWithHooks,
  } = await import("@/lib/hooks");
  const combinedRegistry = new HookRegistry();
  copyHooksInto(combinedRegistry, defaultHookRegistry);
  copyHooksInto(combinedRegistry, buildHookRegistryFromSettings(settings));
  copyHooksInto(
    combinedRegistry,
    buildCommandHookRegistryFromProjectSettings(projectSettings, {
      cwd: options.workspaceRoot,
    }),
  );
  const postToolHookContexts: string[] = [];
  const hookedTools = wrapToolsetWithHooks(tools, combinedRegistry, {
    sessionId: options.chatId,
    onPostToolUseResult: (post) => {
      postToolHookContexts.push(...post.additionalContexts, ...post.systemMessages);
    },
  });

  const agent = createProjectEngineerAgent({
    tools: hookedTools,
    conversationSummary,
    skills: options.skills,
    hookContexts,
  });

  const abortController = new AbortController();
  const stopMonitor = startStopMonitor(workflowRunId, abortController);
  let responseMessage: UIMessage | null = null;

  try {
    const result = await agent.stream({
      messages: modelMessages,
      options: {
        workspaceRoot: options.workspaceRoot,
        workspaceName: options.workspaceName,
        workspaceAccessMode: options.workspaceAccessMode,
        shellApprovalPolicy: options.shellApprovalPolicy ?? "untrusted",
        permissionMode: options.permissionMode,
        planMode: options.planMode,
        chatId: options.chatId,
      },
      abortSignal: abortController.signal,
      experimental_transform: smoothStream({
        chunking: new Intl.Segmenter("zh-CN", { granularity: "grapheme" }),
        delayInMs: 18,
      }),
    });

    const writer = getWritable<ChatUIMessageChunk>().getWriter();
    try {
      for await (const part of result.toUIMessageStream<UIMessage>({
        originalMessages: originalMessagesForStep,
        generateMessageId: () => assistantId,
        // 每步都不发 start/finish——start 在 workflow loop 开头发一次，
        // finish 在 loop 结束统一发一次，这样 UI 看到的是连贯的一条 assistant 消息。
        sendStart: false,
        sendFinish: false,
        // Workflow 流可被 reconnect/auto-submit 重读。AI SDK reasoning chunk 是有状态的
        // (`reasoning-start` 必须在 delta 之前)，目前先稳一点只发 visible text + tool state。
        sendReasoning: false,
        onFinish: ({ responseMessage: finished }) => {
          responseMessage = finished;
        },
        onError: (error) =>
          error instanceof Error ? error.message : "Unknown agent error",
      })) {
        await writer.write(part);
      }
    } finally {
      writer.releaseLock();
    }

    const [finishReason, response] = await Promise.all([
      result.finishReason,
      result.response,
    ]);

    return {
      responseMessage,
      responseModelMessages: response?.messages ?? [],
      finishReason,
      aborted: false,
      postToolHookContexts,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        responseMessage,
        responseModelMessages: [],
        finishReason: "stop",
        aborted: true,
        postToolHookContexts,
      };
    }
    if (isNoOutputError(error)) {
      // 模型这一步产生 0 个 chunk —— 常见原因：reasoning-only 输出被我们
      // `sendReasoning:false` 过滤掉，或本地 gateway 偶发空响应。AI SDK 的
      // smoothStream 在 flush 时会抛 AI_NoOutputGeneratedError；不处理就把
      // 整个 workflow 干挂。这里降级为"本步无内容、stop 收尾"，外层 loop
      // 会自然 break，UI 看到 assistant 消息结束。
      console.warn(
        `[workflow/chat] step ${stepIndex} produced no output; treating as stop`,
      );
      return {
        responseMessage,
        responseModelMessages: [],
        finishReason: "stop",
        aborted: false,
        postToolHookContexts,
      };
    }
    throw error;
  } finally {
    // stepIndex 留在签名里方便日志/调试；当前没真用上。
    void stepIndex;
    stopMonitor.stop();
    await stopMonitor.done;
    await closeMcp?.();
  }
}

async function reserveAssistantId(): Promise<string> {
  "use step";
  return generateIdAi();
}

type WorkflowCompactionResult =
  | {
      ok: true;
      summary: string;
      replacementMessages: UIMessage[];
      strategy: "llm" | "deterministic-fallback";
      notice: UIMessage;
    }
  | {
      ok: false;
      error: string;
    };

async function compactWorkflowContext(params: {
  chatId: string;
  messages: UIMessage[];
  previousSummary: string | null;
  sourceMessageCount: number;
  tokenBudgetSoftCap: number;
}): Promise<WorkflowCompactionResult> {
  "use step";

  const {
    buildCompactionNotice,
    compactMessages,
    compactMessagesDeterministically,
  } = await import("@/lib/compaction");
  const { env } = await import("@/lib/env");
  const { gateway } = await import("@/lib/gateway");
  const { loadActiveContext, saveActiveContext } = await import("@/lib/persistence");

  try {
    const summarizerModel = gateway.chatModel(env.gateway.modelId);
    let result: CompactionResult<UIMessage>;
    try {
      result = await compactMessages({
        messages: params.messages,
        model: summarizerModel,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: params.previousSummary,
      });
    } catch (error) {
      result = compactMessagesDeterministically({
        messages: params.messages,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: params.previousSummary,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (!result.summary || result.tokensAfter > params.tokenBudgetSoftCap) {
      result = compactMessagesDeterministically({
        messages: params.messages,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: params.previousSummary,
        reason: !result.summary
          ? "Workflow mid-turn LLM compaction returned an empty summary."
          : `Workflow mid-turn LLM compaction stayed over budget (${result.tokensAfter} > ${params.tokenBudgetSoftCap}).`,
      });
    }

    if (result.tokensAfter > params.tokenBudgetSoftCap) {
      return {
        ok: false,
        error: `compacted context still exceeds budget (${result.tokensAfter} > ${params.tokenBudgetSoftCap})`,
      };
    }

    const previousActiveContext = loadActiveContext(params.chatId);
    saveActiveContext(params.chatId, {
      summary: result.summary,
      replacementMessages: result.replacementMessages,
      compactedCount:
        (previousActiveContext?.compactedCount ?? 0) + result.compactedCount,
      sourceMessageCount: params.sourceMessageCount,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      strategy: result.strategy,
    });

    return {
      ok: true,
      summary: result.summary,
      replacementMessages: result.replacementMessages,
      strategy: result.strategy,
      notice: buildCompactionNotice(result),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendStartChunk(messageId: string): Promise<void> {
  "use step";
  const writer = getWritable<ChatUIMessageChunk>().getWriter();
  try {
    await writer.write({ type: "start", messageId } as ChatUIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

async function appendBudgetStopText(params: {
  chatId: string;
  fullMessages: UIMessage[];
  compactionNotices: UIMessage[];
  assistantId: string;
  existingMessage: UIMessage | null;
  text: string;
}): Promise<UIMessage> {
  "use step";

  const textPartId = "budget-stop";
  const writer = getWritable<ChatUIMessageChunk>().getWriter();
  try {
    await writer.write({ type: "text-start", id: textPartId } as ChatUIMessageChunk);
    await writer.write({
      type: "text-delta",
      id: textPartId,
      delta: params.text,
    } as ChatUIMessageChunk);
    await writer.write({ type: "text-end", id: textPartId } as ChatUIMessageChunk);
  } finally {
    writer.releaseLock();
  }

  const responseMessage: UIMessage = params.existingMessage
    ? {
        ...params.existingMessage,
        parts: [...params.existingMessage.parts, { type: "text", text: params.text }],
      }
    : {
        id: params.assistantId,
        role: "assistant",
        parts: [{ type: "text", text: params.text }],
      };

  const { saveMessages } = await import("@/lib/persistence");
  const allMessages = buildPersistedMessages(
    params.fullMessages,
    params.compactionNotices,
    responseMessage,
  );
  await saveMessages(params.chatId, allMessages);

  return responseMessage;
}

function buildPersistedMessages(
  fullMessages: UIMessage[],
  compactionNotices: UIMessage[],
  responseMessage: UIMessage,
): UIMessage[] {
  return [...fullMessages, ...compactionNotices, responseMessage];
}

function buildVisibleAgentMessagesForWorkflow(
  fullMessages: UIMessage[],
  responseMessage: UIMessage | null,
): UIMessage[] {
  const messages = fullMessages.filter((message) => message.role !== "system");
  if (responseMessage) {
    messages.push(responseMessage);
  }
  return messages;
}

async function sendFinishChunk(finishReason: FinishReason): Promise<void> {
  "use step";
  const writer = getWritable<ChatUIMessageChunk>().getWriter();
  try {
    await writer.write({ type: "finish", finishReason } as ChatUIMessageChunk);
  } finally {
    writer.releaseLock();
  }
}

async function clearActiveStream(chatId: string, workflowRunId: string) {
  "use step";
  const { compareAndSetActiveStreamId } = await import("@/lib/persistence");
  compareAndSetActiveStreamId(chatId, workflowRunId, null);
}

async function getOuterStepLimit(): Promise<number> {
  "use step";
  const { env } = await import("@/lib/env");
  return env.outerStepLimit;
}

/**
 * Workflow 内 token 软上限。复用 env.compaction.thresholdTokens（同一个
 * 60_000 默认值）—— 既是 P4-b compaction 触发线，也是 workflow loop 的 stop
 * 线。语义统一：超过这个数 = "对话 context 太大了"。
 *
 * 为啥不另设 env：双阈值会让人混乱（"啥时候压缩、啥时候 stop"）。一个值控
 * 制两件事最清楚：进 POST 时超了就压缩；workflow 内动态涨上去再超了就 stop。
 */
async function getTokenBudgetSoftCap(): Promise<number> {
  "use step";
  const { env } = await import("@/lib/env");
  return env.compaction.thresholdTokens;
}

/**
 * 粗估 ModelMessage[] 的 token 数。
 *
 * 跟 lib/compaction.ts 的 estimateTokens 同思路（char count / 3），但作用于
 * ModelMessage 而不是 UIMessage（workflow 内部的格式不同）。
 *
 * 精度：±30%，但用来做"快爆了"判断够用 —— 真要精确等以后接 tiktoken。
 */
function estimateModelMessageTokens(messages: ReadonlyArray<unknown>): number {
  if (messages.length === 0) return 0;
  // JSON.stringify 全部 message 然后 / 3。简单粗暴但稳定。
  // 复杂 content（multimodal / tool 输出 base64 等）通过 JSON 长度自然反映。
  try {
    return Math.ceil(JSON.stringify(messages).length / 3);
  } catch {
    // 极端情况 stringify 失败（含 circular ref 等）—— 返 0 让 loop 继续，
    // 否则会把每次请求都强制截断
    return 0;
  }
}

async function persistAssistantSnapshot(
  chatId: string,
  messages: UIMessage[],
): Promise<void> {
  "use step";
  const { saveMessages } = await import("@/lib/persistence");
  await saveMessages(chatId, messages);
}

async function closeWorkflowStream() {
  "use step";

  await getWritable<ChatUIMessageChunk>().close();
}

function startStopMonitor(runId: string, abortController: AbortController) {
  let shouldStop = false;

  const done = (async () => {
    const run = getRun(runId);

    while (!shouldStop && !abortController.signal.aborted) {
      try {
        if ((await run.status) === "cancelled") {
          abortController.abort();
          return;
        }
      } catch {
        // The run can be briefly invisible while local workflow bookkeeping
        // catches up. Keep polling; cancellation is best-effort.
      }
      await delay(150);
    }
  })();

  return {
    stop() {
      shouldStop = true;
    },
    done,
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (typeof error.message === "string" &&
        error.message.toLowerCase().includes("abort")))
  );
}

/**
 * 上游 LLM 调用的"非致命错误"集合 —— step 产生 0 chunk 或上游连接异常断开。
 *
 * 三类场景都按相同方式处理（graceful stop，让 outer loop break）：
 *
 * 1. **AI_NoOutputGeneratedError**：smoothStream 在 flush 阶段抛。常见原因：
 *    - 模型只输出 reasoning（被 sendReasoning:false 过滤掉）
 *    - 本地 gateway 偶发空响应
 *    - 模型决定不再说话直接停（罕见但合法）
 *
 * 2. **empty_stream / upstream closed**：gateway 客户端**自己重试 N 次**仍然失败
 *    抛 "Failed after 3 attempts. Last error: empty_stream: upstream stream
 *    closed before first payload"。这时候已经重试过了，再让 workflow 重试只
 *    是再多浪费几次 LLM 调用。
 *
 * 3. **stream cancelled / ECONNRESET / ETIMEDOUT 等明显断连**：同样降级 stop。
 *
 * 跟 isAbortError 区分：abort 是用户主动停（点"停止"按钮），这里是被动断流。
 * 都走 "stop" finishReason，但 abort 走 `aborted: true` 分支。
 */
function isNoOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AI_NoOutputGeneratedError") return true;
  const msg = typeof error.message === "string" ? error.message : "";
  return (
    /no output generated/i.test(msg) ||
    /empty_stream/i.test(msg) ||
    /upstream stream closed/i.test(msg) ||
    /econnreset/i.test(msg) ||
    /etimedout/i.test(msg) ||
    // gateway 客户端的"我自己重试都失败了"统一标志：
    /failed after \d+ attempts?/i.test(msg)
  );
}
