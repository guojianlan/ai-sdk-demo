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
};

type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

type StepResult = {
  responseMessage: UIMessage | null;
  responseModelMessages: ModelMessage[];
  finishReason: FinishReason | undefined;
  aborted: boolean;
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

  // 预先发一次 start 把"新 assistant message"的开始信号通知给 UI。
  // 后续每步的 toUIMessageStream 都设 sendStart:false / sendFinish:false，
  // 所有步的内容都追加到同一条 assistantId 上。
  await sendStartChunk(assistantId);

  let pendingResponseMessage: UIMessage | null = null;
  let exhaustedSteps = false;
  let finalFinishReason: FinishReason | undefined;

  const limit = await getOuterStepLimit();

  for (let step = 0; step < limit; step++) {
    // toUIMessageStream 的 originalMessages 用于 message id 基准：
    // - step 0：用 options.agentMessages（用户消息历史）
    // - step >0：用上一轮的 pendingResponseMessage，让 stream 继续追加到同一条 assistant 消息
    const originalMessagesForStep: UIMessage[] = pendingResponseMessage
      ? [pendingResponseMessage]
      : options.agentMessages;

    const result = await runAgentStep(
      options,
      workflowRunId,
      modelMessages,
      originalMessagesForStep,
      assistantId,
      step,
    );

    if (result.responseModelMessages.length > 0) {
      modelMessages = [...modelMessages, ...result.responseModelMessages];
    }

    if (result.responseMessage) {
      pendingResponseMessage = result.responseMessage;
      // 同一个 assistantId 的快照：每步都是这条消息的"截至本步"完整版，
      // 累积保存只需要最新这一份。
      const allMessages: UIMessage[] = [...options.fullMessages];
      if (options.compactionNotice) {
        allMessages.push(options.compactionNotice);
      }
      allMessages.push(pendingResponseMessage);
      await persistAssistantSnapshot(options.chatId, allMessages);
    }

    finalFinishReason = result.finishReason;

    // outer loop 是否继续？两条路：
    // 1. AI SDK 报 finishReason="tool-calls"（模型还没说完，需要 tool 结果继续）
    // 2. 或者 message 里已经有跑完的 tool call (output-available 等)，但模型本步
    //    finish=stop——这是 AI SDK 在 stopWhen=stepCountIs(1) 下的常见情况：
    //    模型本步只发了一个 tool call、AI SDK 执行了它就到了 step 上限，模型没看
    //    到结果就停了。这种情况外层必须再跑一步，让模型看到 tool 结果。
    //    如果不这么处理，client 端 lastAssistantMessageIsCompleteWithToolCalls
    //    会自动 resubmit，导致每个 tool call 起一次新 workflow / 新 assistantId
    //    / UI 多冒一个 ENGINEER 气泡。
    const responseParts = result.responseMessage?.parts ?? [];
    const isToolCallContinuation =
      result.finishReason === "tool-calls" || hasCompletedToolCalls(responseParts);
    const needsPause = shouldPauseForToolInteraction(responseParts);

    console.log(
      `[workflow/chat] chat=${options.chatId} step=${step + 1}/${limit} finishReason=${result.finishReason ?? "?"} pause=${needsPause} aborted=${result.aborted} continue=${isToolCallContinuation}`,
    );

    if (result.aborted) break;
    if (!isToolCallContinuation) break;
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

  // 不管以什么原因退出循环，都要发一个 finish 关掉这条 assistant 消息——
  // 否则 UI 会一直显示 streaming 状态。
  await sendFinishChunk(finalFinishReason ?? "stop");
}

async function runAgentStep(
  options: ChatWorkflowOptions,
  workflowRunId: string,
  modelMessages: ModelMessage[],
  originalMessagesForStep: UIMessage[],
  assistantId: string,
  stepIndex: number,
): Promise<StepResult> {
  "use step";

  const hasWorkspaceTools = options.workspaceAccessMode === "workspace-tools";

  let mcpTools: ToolSet = {};
  let closeMcp: (() => Promise<void>) | null = null;
  if (hasWorkspaceTools) {
    try {
      const { createWeatherMCPClient } = await import("@/lib/mcp/weather-client");
      const mcp = await createWeatherMCPClient();
      mcpTools = await mcp.tools();
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
  const { isMemoryEnabled, loadSettings } = await import("@/lib/permissions");
  const settings = loadSettings(options.workspaceRoot);
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

  const agent = createProjectEngineerAgent({
    tools,
    conversationSummary: options.conversationSummary,
    skills: options.skills,
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
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        responseMessage,
        responseModelMessages: [],
        finishReason: "stop",
        aborted: true,
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

async function sendStartChunk(messageId: string): Promise<void> {
  "use step";
  const writer = getWritable<ChatUIMessageChunk>().getWriter();
  try {
    await writer.write({ type: "start", messageId } as ChatUIMessageChunk);
  } finally {
    writer.releaseLock();
  }
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
