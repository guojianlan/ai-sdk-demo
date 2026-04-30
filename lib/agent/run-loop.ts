import type { ModelMessage } from "ai";

import type {
  AgentSource,
  WorkflowNodeContextInput,
  WorkspaceContextInput,
} from "@/lib/agent/source";
import {
  runStep,
  type StreamedApprovalRequest,
  type StreamedToolCall,
  type StreamedToolError,
  type StreamedToolResult,
} from "@/lib/agent/step-client";

/**
 * 通用客户端 agent loop —— 主聊天 client 模式 + workflow agent 节点共用。
 *
 * 协议：客户端只指定 `source`（chat / workflow-node），服务端按 source 自己拼
 * system prompt + 选 tool 集合。客户端不知道服务端有哪些 tool。
 *
 * 单一服务端原语 `/api/agent/step`（流式 SSE）：
 *   每次调用 = LLM 跑一个 step + 服务端尝试执行该 step 内的所有 tool。
 *   - 普通 tool：执行 → 推 `tool-result` 事件
 *   - approvedTool 且 needsApproval=true：不执行 → 推 `tool-approval-request` 事件
 *   - interactive tool（无 execute）：不执行 → 只推 `tool-call`，没有对应 result
 *
 * 客户端 loop 只关心三种"卡住"场景：
 *   1. 有 approval-request 未响应 → 等用户决定 → 加 ToolApprovalResponse → 再调
 *   2. 有 interactive tool-call 未填 → 等用户填 → 加 ToolResult → 再调
 *   3. 用户开了 stepByStep → 在两 step 间停下等"继续"
 *
 * 自然结束：本步 toolCalls.length === 0（兜底，比仅看 finishReason 更鲁棒，
 * 因为某些 OpenAI-compat gateway 在"text + tool call 同时出"时返 finishReason='stop'）。
 *
 * `maxSteps` 由**服务端**按 source 决定（chat 模式 16；workflow-node 走节点配置），
 * 通过 step finish 事件回传。客户端只在 step 间维护一个安全 hard cap 防 runaway。
 */

const RUNAWAY_HARD_CAP = 64;

export type AgentLoopCallbacks = {
  /** 进入下一 step 时（在调 step API 之前）。 */
  onStepStart?: (stepCount: number, totalSteps: number) => void;
  /** SSE text-delta 增量到达。 */
  onTextDelta?: (stepCount: number, delta: string) => void;
  /** SSE tool-call 事件到达（此时服务端可能还在执行 tool）。 */
  onToolCall?: (stepCount: number, call: StreamedToolCall) => void;
  /** SSE tool-result 事件到达（服务端 tool 执行完成）。 */
  onToolResult?: (stepCount: number, result: StreamedToolResult) => void;
  /** SSE tool-error 事件到达（服务端 tool 执行抛错）。 */
  onToolError?: (stepCount: number, err: StreamedToolError) => void;
  /** SSE tool-approval-request 事件到达（看到时只是通知，处理由 onAwaitingApproval 完成）。 */
  onApprovalRequestReceived?: (
    stepCount: number,
    req: StreamedApprovalRequest,
  ) => void;
  /** 一次 LLM step 完结时通知（finish 事件之后、loop 决定下一步之前）。 */
  onStepFinish?: (
    stepCount: number,
    info: {
      finishReason: string;
      toolCallCount: number;
      toolResultCount: number;
      approvalRequestCount: number;
      maxSteps: number;
    },
  ) => void;
  /**
   * 模型要调用一个 approvedTool 且 bypassPermissions=false。
   * 必须返 Promise<boolean>：true=通过执行，false=拒绝。
   */
  onAwaitingApproval: (
    stepCount: number,
    req: StreamedApprovalRequest,
  ) => Promise<boolean>;
  /**
   * 模型要调用一个 interactive tool（无 execute）。
   * 必须返 Promise<unknown>：用户填的内容。
   */
  onAwaitingInteractive: (
    stepCount: number,
    call: StreamedToolCall,
  ) => Promise<unknown>;
  /**
   * 用户开了"逐步执行"，在两 step 间应该停下等用户点继续。
   * 不传 = 不支持 step-by-step（永远 auto loop）。
   */
  onAwaitingStepPause?: (info: {
    stepCount: number;
    maxSteps: number;
  }) => Promise<void>;
  /** messages 数组每次推进时通知（caller 拿去更新 UI / 持久化）。 */
  onMessagesUpdated?: (messages: ModelMessage[]) => void;
};

export type RunAgentLoopParams = {
  initialMessages: ModelMessage[];
  source: AgentSource;
  workspaceContext: WorkspaceContextInput;
  /** 仅 source.kind === 'workflow-node' 时需要。 */
  nodeContext?: WorkflowNodeContextInput;
  shouldPauseStepByStep?: () => boolean;
  callbacks: AgentLoopCallbacks;
  signal?: AbortSignal;
};

export type RunAgentLoopResult = {
  messages: ModelMessage[];
  stepsUsed: number;
  finishReason: string;
};

/** 把 ToolApprovalResponse part 包进 ToolModelMessage。 */
function buildApprovalResponseMessage(
  approvalId: string,
  approved: boolean,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-approval-response",
        approvalId,
        approved,
        ...(approved ? {} : { reason: "user denied" }),
      },
    ],
  };
}

/** 把用户填的 interactive tool 输出包进 ToolModelMessage。 */
function buildInteractiveResultMessage(
  toolCallId: string,
  toolName: string,
  output: unknown,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "json", value: output as never },
      },
    ],
  };
}

export async function runAgentLoop(
  params: RunAgentLoopParams,
): Promise<RunAgentLoopResult> {
  const {
    initialMessages,
    source,
    workspaceContext,
    nodeContext,
    shouldPauseStepByStep,
    callbacks,
    signal,
  } = params;

  const messages: ModelMessage[] = [...initialMessages];
  let stepCount = 0;
  let lastFinishReason = "unknown";
  // 服务端在每次 finish 事件里回传 maxSteps（按 source 决定）。
  // 第一步还不知道，先用一个保守占位。
  let serverMaxSteps = 16;

  callbacks.onMessagesUpdated?.(messages);

  while (stepCount < RUNAWAY_HARD_CAP) {
    if (signal?.aborted) throw new Error("aborted");

    if (
      shouldPauseStepByStep?.() &&
      stepCount > 0 &&
      callbacks.onAwaitingStepPause
    ) {
      await callbacks.onAwaitingStepPause({
        stepCount,
        maxSteps: serverMaxSteps,
      });
      if (signal?.aborted) throw new Error("aborted");
    }

    callbacks.onStepStart?.(stepCount, serverMaxSteps);

    const stepResult = await runStep(
      {
        messages,
        source,
        workspaceContext,
        nodeContext,
      },
      {
        onTextDelta: (delta) => callbacks.onTextDelta?.(stepCount, delta),
        onToolCall: (call) => callbacks.onToolCall?.(stepCount, call),
        onToolResult: (r) => callbacks.onToolResult?.(stepCount, r),
        onToolError: (e) => callbacks.onToolError?.(stepCount, e),
        onApprovalRequest: (req) =>
          callbacks.onApprovalRequestReceived?.(stepCount, req),
      },
      signal,
    );

    serverMaxSteps = stepResult.maxSteps;

    messages.push(...stepResult.responseMessages);
    callbacks.onMessagesUpdated?.(messages);
    lastFinishReason = stepResult.finishReason;

    callbacks.onStepFinish?.(stepCount, {
      finishReason: stepResult.finishReason,
      toolCallCount: stepResult.toolCalls.length,
      toolResultCount: stepResult.toolResults.length,
      approvalRequestCount: stepResult.approvalRequests.length,
      maxSteps: serverMaxSteps,
    });

    stepCount++;

    // 服务端按 source 决定的上限——按它停。
    if (stepCount >= serverMaxSteps) {
      throw new Error(
        `Agent loop exceeded source-defined maxSteps (${serverMaxSteps})`,
      );
    }

    // ---- 处理本步内"卡住"项 ----

    // 1. 待审批
    if (stepResult.approvalRequests.length > 0) {
      for (const ar of stepResult.approvalRequests) {
        if (signal?.aborted) throw new Error("aborted");
        const approved = await callbacks.onAwaitingApproval(stepCount, ar);
        messages.push(buildApprovalResponseMessage(ar.approvalId, approved));
        callbacks.onMessagesUpdated?.(messages);
      }
      continue;
    }

    // 2. interactive tool-call（无对应 tool-result）
    const seenResults = new Set(
      stepResult.toolResults.map((r) => r.toolCallId),
    );
    const interactiveCalls = stepResult.toolCalls.filter(
      (tc) => tc.meta.isInteractive && !seenResults.has(tc.toolCallId),
    );
    if (interactiveCalls.length > 0) {
      for (const tc of interactiveCalls) {
        if (signal?.aborted) throw new Error("aborted");
        const userOutput = await callbacks.onAwaitingInteractive(stepCount, tc);
        messages.push(
          buildInteractiveResultMessage(tc.toolCallId, tc.toolName, userOutput),
        );
        callbacks.onMessagesUpdated?.(messages);
      }
      continue;
    }

    // 3. 没有"卡住"项 + 本步没产 tool call → 自然结束
    if (stepResult.toolCalls.length === 0) {
      return {
        messages,
        stepsUsed: stepCount,
        finishReason: lastFinishReason,
      };
    }

    // 4. 有 tool call 但都已执行完 → 继续 loop 让 LLM 看到 result 后接话
  }

  throw new Error(`Agent loop hit runaway hard cap (${RUNAWAY_HARD_CAP})`);
}
