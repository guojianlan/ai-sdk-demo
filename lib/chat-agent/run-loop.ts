import {
  convertToModelMessages,
  generateId as generateIdAi,
  smoothStream,
  type FinishReason,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";

import type { WorkspaceAccessMode } from "@/lib/chat-access-mode";
import type { CompactionResult } from "@/lib/compaction";
import {
  buildCompactionNotice,
  compactMessages,
  compactMessagesDeterministically,
} from "@/lib/compaction";
import { env } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import {
  buildCommandHookRegistryFromProjectSettings,
  buildHookRegistryFromSettings,
  copyHooksInto,
  defaultHookRegistry,
  HookRegistry,
  runHooks,
  wrapToolsetWithHooks,
} from "@/lib/hooks";
import { createWeatherMCPClient } from "@/lib/mcp/weather-client";
import {
  isMemoryEnabled,
  loadProjectSettings,
  loadSettings,
  type PermissionMode,
} from "@/lib/permissions";
import {
  loadActiveContext,
  saveActiveContext,
  saveMessages,
} from "@/lib/persistence";
import type { SkillMetadata } from "@/lib/skills";
import {
  interactiveToolset,
  type ShellApprovalPolicy,
} from "@/lib/tools";
import {
  createProjectEngineerAgent,
  projectEngineerStaticToolset,
} from "@/app/api/chat/agent-config";

import type { ChatUIMessageChunk } from "./active-runs";
import {
  hasCompletedToolCalls,
  shouldPauseForToolInteraction,
} from "./pause";

export type ChatRunOptions = {
  chatId: string;
  agentMessages: UIMessage[];
  fullMessages: UIMessage[];
  compactionNotice: UIMessage | null;
  workspaceRoot: string;
  workspaceName?: string;
  workspaceAccessMode: WorkspaceAccessMode;
  shellApprovalPolicy: ShellApprovalPolicy | undefined;
  permissionMode: PermissionMode;
  planMode: boolean;
  autoApproveTools?: boolean;
  conversationSummary: string | null;
  skills: SkillMetadata[];
  hookContexts: string[];
};

type ChatChunkWriter = {
  write(part: ChatUIMessageChunk): void;
};

type StepResult = {
  responseMessage: UIMessage | null;
  responseModelMessages: ModelMessage[];
  finishReason: FinishReason | undefined;
  aborted: boolean;
  postToolHookContexts: string[];
};

export async function runChatAgentLoop(params: {
  options: ChatRunOptions;
  runId: string;
  writer: ChatChunkWriter;
  abortSignal: AbortSignal;
}): Promise<void> {
  const { options, runId, writer, abortSignal } = params;
  const assistantId = generateIdAi();

  let modelMessages: ModelMessage[] = await convertToModelMessages(
    options.agentMessages,
    { ignoreIncompleteToolCalls: true },
  );
  let agentMessagesForStream = options.agentMessages;
  let pendingResponseMessage: UIMessage | null = null;
  let exhaustedSteps = false;
  let finalFinishReason: FinishReason | undefined;
  let conversationSummaryForNextStep = options.conversationSummary;
  const compactionNoticesForPersist = options.compactionNotice
    ? [options.compactionNotice]
    : [];
  const limit = env.outerStepLimit;
  const tokenBudgetSoftCap = env.compaction.thresholdTokens;
  let tokenBudgetTripped = false;
  let hookContextsForNextStep = [...options.hookContexts];

  sendStartChunk(writer, assistantId);

  for (let step = 0; step < limit; step++) {
    if (abortSignal.aborted) {
      finalFinishReason = "stop";
      break;
    }

    const currentTokenEstimate = estimateModelMessageTokens(modelMessages);
    if (currentTokenEstimate > tokenBudgetSoftCap) {
      console.warn(
        `[chat/run] chat=${options.chatId} step=${step + 1} token budget tripped (estimated=${currentTokenEstimate} > cap=${tokenBudgetSoftCap}); attempting mid-turn compaction`,
      );
      const visibleAgentMessages = buildVisibleAgentMessagesForRun(
        options.fullMessages,
        pendingResponseMessage,
      );
      const activeMessagesForCompaction = pendingResponseMessage
        ? [...options.agentMessages, pendingResponseMessage]
        : options.agentMessages;
      const midTurnCompaction = await compactRunContext({
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
          `[chat/run] chat=${options.chatId} mid-turn compaction strategy=${midTurnCompaction.strategy} estimated=${currentTokenEstimate}->${compactedEstimate}`,
        );
        if (compactedEstimate > tokenBudgetSoftCap) {
          const budgetText =
            `当前对话的 active context 压缩后仍超过预算（估算 ${compactedEstimate} tokens，` +
            `上限 ${tokenBudgetSoftCap}）。我已经停止本轮继续调用模型，避免再次把超大历史送进 chat run；` +
            "请发起下一条消息，我会先使用已保存的压缩上下文继续。";
          pendingResponseMessage = await appendBudgetStopText({
            writer,
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
        const budgetText =
          `当前对话的 active context 已超过预算（估算 ${currentTokenEstimate} tokens，` +
          `上限 ${tokenBudgetSoftCap}），并且本轮自动压缩失败：${midTurnCompaction.error}。` +
          "我已经停止继续调用模型，避免再次把超大历史送进 chat run。";
        pendingResponseMessage = await appendBudgetStopText({
          writer,
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
        `上限 ${tokenBudgetSoftCap}）。我已经停止本轮继续调用模型，避免再次把超大历史送进 chat run；` +
        "请发起下一条消息，我会先使用已保存的压缩上下文继续。";
      pendingResponseMessage = await appendBudgetStopText({
        writer,
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

    const originalMessagesForStep: UIMessage[] = pendingResponseMessage
      ? [pendingResponseMessage]
      : agentMessagesForStream;

    const result = await runAgentStep({
      options,
      runId,
      writer,
      modelMessages,
      originalMessagesForStep,
      assistantId,
      stepIndex: step,
      hookContexts: hookContextsForNextStep,
      conversationSummary: conversationSummaryForNextStep,
      abortSignal,
    });

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
      const allMessages = buildPersistedMessages(
        options.fullMessages,
        compactionNoticesForPersist,
        pendingResponseMessage,
      );
      await saveMessages(options.chatId, allMessages);
    }

    finalFinishReason = result.finishReason;
    const responseParts = result.responseMessage?.parts ?? [];
    const isToolCallContinuation =
      result.finishReason === "tool-calls" || hasCompletedToolCalls(responseParts);
    const needsPause = shouldPauseForToolInteraction(responseParts);

    console.log(
      `[chat/run] chat=${options.chatId} run=${runId} step=${step + 1}/${limit} finishReason=${result.finishReason ?? "?"} pause=${needsPause} aborted=${result.aborted} continue=${isToolCallContinuation}`,
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
      `[chat/run] chat=${options.chatId} hit OUTER_STEP_LIMIT=${limit}; loop terminated`,
    );
  }
  if (tokenBudgetTripped) {
    console.warn(
      `[chat/run] chat=${options.chatId} stopped due to token budget; user should start a new chat for follow-up`,
    );
  }

  sendFinishChunk(writer, finalFinishReason ?? "stop");
}

async function runStopHooksForStep(
  options: ChatRunOptions,
  finishReason: FinishReason | undefined,
  lastAssistantMessage: UIMessage | null,
  step: number,
): Promise<string[]> {
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

async function runAgentStep(params: {
  options: ChatRunOptions;
  runId: string;
  writer: ChatChunkWriter;
  modelMessages: ModelMessage[];
  originalMessagesForStep: UIMessage[];
  assistantId: string;
  stepIndex: number;
  hookContexts: string[];
  conversationSummary: string | null;
  abortSignal: AbortSignal;
}): Promise<StepResult> {
  const { options } = params;
  const hasWorkspaceTools = options.workspaceAccessMode === "workspace-tools";

  let mcpTools: ToolSet = {};
  let closeMcp: (() => Promise<void>) | null = null;
  if (hasWorkspaceTools) {
    try {
      const mcp = await createWeatherMCPClient();
      mcpTools = (await mcp.tools()) as ToolSet;
      closeMcp = () => mcp.close();
    } catch (error) {
      console.warn(
        "[chat/run] weather MCP init failed, continuing without it:",
        error instanceof Error ? error.message : error,
      );
    }
  }

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
    conversationSummary: params.conversationSummary,
    skills: options.skills,
    hookContexts: params.hookContexts,
  });

  let responseMessage: UIMessage | null = null;

  try {
    const result = await agent.stream({
      messages: params.modelMessages,
      options: {
        workspaceRoot: options.workspaceRoot,
        workspaceName: options.workspaceName,
        workspaceAccessMode: options.workspaceAccessMode,
        shellApprovalPolicy: options.shellApprovalPolicy ?? "untrusted",
        permissionMode: options.permissionMode,
        planMode: options.planMode,
        autoApproveTools: options.autoApproveTools === true,
        chatId: options.chatId,
      },
      abortSignal: params.abortSignal,
      experimental_transform: smoothStream({
        chunking: new Intl.Segmenter("zh-CN", { granularity: "grapheme" }),
        delayInMs: 18,
      }),
    });

    for await (const part of result.toUIMessageStream<UIMessage>({
      originalMessages: params.originalMessagesForStep,
      generateMessageId: () => params.assistantId,
      sendStart: false,
      sendFinish: false,
      sendReasoning: false,
      onFinish: ({ responseMessage: finished }) => {
        responseMessage = finished;
      },
      onError: (error) =>
        error instanceof Error ? error.message : "Unknown agent error",
    })) {
      params.writer.write(part as ChatUIMessageChunk);
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
      console.warn(
        `[chat/run] step ${params.stepIndex} produced no output; treating as stop`,
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
    await closeMcp?.();
  }
}

type RunCompactionResult =
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

async function compactRunContext(params: {
  chatId: string;
  messages: UIMessage[];
  previousSummary: string | null;
  sourceMessageCount: number;
  tokenBudgetSoftCap: number;
}): Promise<RunCompactionResult> {
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
          ? "Chat run mid-turn LLM compaction returned an empty summary."
          : `Chat run mid-turn LLM compaction stayed over budget (${result.tokensAfter} > ${params.tokenBudgetSoftCap}).`,
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

function sendStartChunk(writer: ChatChunkWriter, messageId: string): void {
  writer.write({ type: "start", messageId } as ChatUIMessageChunk);
}

async function appendBudgetStopText(params: {
  writer: ChatChunkWriter;
  chatId: string;
  fullMessages: UIMessage[];
  compactionNotices: UIMessage[];
  assistantId: string;
  existingMessage: UIMessage | null;
  text: string;
}): Promise<UIMessage> {
  const textPartId = "budget-stop";
  params.writer.write({ type: "text-start", id: textPartId } as ChatUIMessageChunk);
  params.writer.write({
    type: "text-delta",
    id: textPartId,
    delta: params.text,
  } as ChatUIMessageChunk);
  params.writer.write({ type: "text-end", id: textPartId } as ChatUIMessageChunk);

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

function buildVisibleAgentMessagesForRun(
  fullMessages: UIMessage[],
  responseMessage: UIMessage | null,
): UIMessage[] {
  const messages = fullMessages.filter((message) => message.role !== "system");
  if (responseMessage) {
    messages.push(responseMessage);
  }
  return messages;
}

function sendFinishChunk(
  writer: ChatChunkWriter,
  finishReason: FinishReason,
): void {
  writer.write({ type: "finish", finishReason } as ChatUIMessageChunk);
}

function estimateModelMessageTokens(messages: ReadonlyArray<unknown>): number {
  if (messages.length === 0) return 0;
  try {
    return Math.ceil(JSON.stringify(messages).length / 3);
  } catch {
    return 0;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      (typeof error.message === "string" &&
        error.message.toLowerCase().includes("abort")))
  );
}

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
    /failed after \d+ attempts?/i.test(msg)
  );
}
