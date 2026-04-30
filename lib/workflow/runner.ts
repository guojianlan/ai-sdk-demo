"use client";

import type { ModelMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

import { runAgentLoop } from "@/lib/agent/run-loop";
import type {
  NodeDefinition,
  NodeState,
  RunNodeResponse,
  WorkflowDefinition,
} from "@/lib/workflow/types";

/**
 * 前端工作流 runner —— "前端驱动 single-step + streaming" 实现。
 *
 * 节点分两种执行路径：
 *
 * 1. **agent kind** —— 客户端 loop（通过通用 `runAgentLoop`）：
 *    - 调 `/api/agent/step-stream`（唯一服务端原语），SSE 流式返回所有事件
 *    - 服务端在 step 内自动执行普通 tool（推 `tool-result`）；approvedTool 待审批
 *      或 interactive tool 不执行（推 `tool-call` / `tool-approval-request` 给前端）
 *    - 客户端只在 approval / interactive / step-pause 时暂停，否则一直转
 *
 * 2. **structured / tool / human kind** —— 单次后端调用：
 *    - `POST /api/workflow/[id]/node/[nodeId]/run`
 *    - 服务端在 `lib/workflow/node-executors.ts` 执行
 *
 * 暂停 / 回包 都用 deferred promise（refs 持有）：主 loop 在等用户时 `await`，
 * 公开方法（submitToolResult / submitToolApproval / resumeStep / submitHumanResponse）
 * 调对应 deferred.resolve() 把值传回 loop。
 *
 * 状态机（runner 整体）：
 *   idle → running → awaiting-input → running → done / rejected / error
 *                  ↑________________________________|
 */

export type WorkflowRunnerStatus =
  | "idle"
  | "running"
  | "awaiting-input"
  | "done"
  | "error"
  | "rejected";

export type WorkflowRunnerState = {
  status: WorkflowRunnerStatus;
  cursor: number;
  nodeStates: Record<string, NodeState>;
  outputs: Record<string, { output: unknown }>;
  workflowInput: Record<string, unknown> | null;
  error: string | null;
  /** 是否启用"逐步执行"模式（agent 节点在每个 step 间暂停）。 */
  stepByStep: boolean;
};

const initialState = (workflow: WorkflowDefinition): WorkflowRunnerState => ({
  status: "idle",
  cursor: 0,
  nodeStates: Object.fromEntries(
    workflow.nodes.map((n) => [n.id, { status: "pending" } satisfies NodeState]),
  ),
  outputs: {},
  workflowInput: null,
  error: null,
  stepByStep: false,
});

type Deferred<T> = { resolve: (v: T) => void; reject: (e: unknown) => void };

type UseWorkflowRunnerOptions = {
  workflow: WorkflowDefinition;
  workspaceRoot: string;
  workspaceName?: string;
};

export function useWorkflowRunner({
  workflow,
  workspaceRoot,
  workspaceName,
}: UseWorkflowRunnerOptions) {
  const [state, setState] = useState<WorkflowRunnerState>(() =>
    initialState(workflow),
  );

  const runIdRef = useRef<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef(false);

  // ---------- 暂停 / 回包 用的 deferred 注册表 ----------
  // toolCallId → 用户填的 interactive output
  const interactiveDeferredsRef = useRef(new Map<string, Deferred<unknown>>());
  // toolCallId → 用户审批结果（true=通过，false=拒绝）
  const approvalDeferredsRef = useRef(new Map<string, Deferred<boolean>>());
  // 当前 agent 在 step-pause 时的 deferred（最多一个）
  const stepPauseDeferredRef = useRef<Deferred<void> | null>(null);
  // human 节点：response 来自 submitHumanResponse 调用
  const humanDeferredRef = useRef<Deferred<unknown> | null>(null);

  // stepByStep 当前值（runtime 取，避免 closure 抓旧值）
  const stepByStepRef = useRef(false);

  // ---------- agent kind 节点：客户端 loop（用通用 runAgentLoop） ----------

  async function runAgentNodeOnClient(
    node: NodeDefinition,
    workflowInput: Record<string, unknown>,
    upstreamOutputs: Record<string, { output: unknown }>,
    signal: AbortSignal,
  ): Promise<RunNodeResponse> {
    if (node.kind !== "agent") {
      throw new Error("runAgentNodeOnClient called for non-agent node");
    }
    const startedAt = Date.now();

    // **不在客户端组装 system / 解析 inputs / 选 tool**——只把 source 标识 +
    // nodeContext 传给服务端，让 source resolver 自己 lookup 节点定义、
    // resolveInputs、renderTemplate、选 tools。
    // 客户端唯一需要做的：把 user "begin" message 推进去触发 agent，并维护
    // approval / interactive / step-pause 的 UI 暂停。
    const initialMessages: ModelMessage[] = [
      {
        role: "user",
        content:
          "Begin executing the task described in your system instructions. Use the available tools as needed.",
      },
    ];

    setState((prev) => ({
      ...prev,
      status: "running",
      nodeStates: {
        ...prev.nodeStates,
        [node.id]: {
          status: "running",
          startedAt,
          // maxSteps 第一步未知，先占 0；onStepFinish 拿到 server-side maxSteps 后会覆盖
          agentLoop: { stepCount: 0, maxSteps: 0, lastText: "" },
        },
      },
    }));

    // 闭包级累积文本：onTextDelta 写、onAwaitingStepPause 读，避免再造 ref。
    let accumulatedText = "";
    let serverMaxSteps = 0;

    const result = await runAgentLoop({
      initialMessages,
      source: {
        kind: "workflow-node",
        workflowId: workflow.id,
        nodeId: node.id,
      },
      workspaceContext: {
        workspaceRoot,
        workspaceName: workspaceName ?? workspaceRoot,
      },
      nodeContext: {
        workflowInput,
        upstreamOutputs,
      },
      shouldPauseStepByStep: () => stepByStepRef.current,
      signal,
      callbacks: {
        onStepStart: (stepCount, totalSteps) => {
          accumulatedText = "";
          if (totalSteps > 0) serverMaxSteps = totalSteps;
          setState((prev) => ({
            ...prev,
            nodeStates: {
              ...prev.nodeStates,
              [node.id]: {
                status: "running",
                startedAt,
                agentLoop: {
                  stepCount,
                  maxSteps: serverMaxSteps,
                  lastText: "",
                },
              },
            },
          }));
        },
        onTextDelta: (stepCount, delta) => {
          accumulatedText += delta;
          const snapshot = accumulatedText;
          setState((prev) => {
            const cur = prev.nodeStates[node.id];
            if (cur?.status !== "running") return prev;
            return {
              ...prev,
              nodeStates: {
                ...prev.nodeStates,
                [node.id]: {
                  status: "running",
                  startedAt,
                  agentLoop: {
                    stepCount,
                    maxSteps: serverMaxSteps,
                    lastText: snapshot,
                  },
                },
              },
            };
          });
        },
        onStepFinish: (_stepCount, info) => {
          serverMaxSteps = info.maxSteps;
        },
        onAwaitingApproval: (stepCount, call) =>
          waitForApproval(
            node.id,
            call.toolCallId,
            call.toolName,
            call.input,
            stepCount,
          ),
        onAwaitingInteractive: (stepCount, call) =>
          waitForInteractive(
            node.id,
            call.toolCallId,
            call.toolName,
            call.input,
            stepCount,
          ),
        onAwaitingStepPause: ({ stepCount, maxSteps: max }) =>
          pauseForStepByStep(node.id, stepCount, max, accumulatedText),
      },
    });

    // accumulatedText 在 onTextDelta 里同步累积；onStepStart 会重置（保留**最后一步**的纯文本）。
    // 对 bug-fix 工作流的 agent 节点（diagnose / apply-patch / verify / report）来说，
    // 最后一步通常就是 LLM 收尾发的总结文本，正合适当作 output.text。
    return {
      status: "done",
      output: { text: accumulatedText.trim() },
      durationMs: Date.now() - startedAt,
      stepsUsed: result.stepsUsed,
    };
  }

  // ---------- 暂停辅助 ----------

  function pauseForStepByStep(
    nodeId: string,
    stepCount: number,
    maxSteps: number,
    lastText: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      stepPauseDeferredRef.current = { resolve, reject };
      setState((prev) => ({
        ...prev,
        status: "awaiting-input",
        nodeStates: {
          ...prev.nodeStates,
          [nodeId]: {
            status: "awaiting-input",
            payload: {
              kind: "agent-step-pause",
              stepCount,
              maxSteps,
              lastText,
            },
            awaitingSince: Date.now(),
          },
        },
      }));
    });
  }

  function waitForInteractive(
    nodeId: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    stepCount: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      interactiveDeferredsRef.current.set(toolCallId, { resolve, reject });
      setState((prev) => ({
        ...prev,
        status: "awaiting-input",
        nodeStates: {
          ...prev.nodeStates,
          [nodeId]: {
            status: "awaiting-input",
            payload: {
              kind: "agent-interactive",
              toolCallId,
              toolName,
              input,
              stepCount,
            },
            awaitingSince: Date.now(),
          },
        },
      }));
    });
  }

  function waitForApproval(
    nodeId: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
    stepCount: number,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      approvalDeferredsRef.current.set(toolCallId, { resolve, reject });
      setState((prev) => ({
        ...prev,
        status: "awaiting-input",
        nodeStates: {
          ...prev.nodeStates,
          [nodeId]: {
            status: "awaiting-input",
            payload: {
              kind: "agent-tool-approval",
              toolCallId,
              toolName,
              input,
              stepCount,
            },
            awaitingSince: Date.now(),
          },
        },
      }));
    });
  }

  // ---------- 其它 kind 节点：服务端 /api/workflow/.../run ----------

  async function runServerNode(
    node: NodeDefinition,
    workflowInput: Record<string, unknown>,
    upstreamOutputs: Record<string, { output: unknown }>,
    humanResponse: unknown,
    signal: AbortSignal,
  ): Promise<RunNodeResponse> {
    const res = await fetch(
      `/api/workflow/${workflow.id}/node/${node.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          runId: runIdRef.current,
          workflowInput,
          upstreamOutputs,
          workspaceRoot,
          workspaceName,
          humanResponse,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as RunNodeResponse;
  }

  // ---------- 节点执行调度（统一入口） ----------

  const runOneNode = useCallback(
    async (
      cursor: number,
      currentInput: Record<string, unknown>,
      currentOutputs: Record<string, { output: unknown }>,
    ) => {
      if (cursor >= workflow.nodes.length) return;
      const node = workflow.nodes[cursor];
      inflightRef.current = true;

      setState((prev) => ({
        ...prev,
        status: "running",
        nodeStates: {
          ...prev.nodeStates,
          [node.id]: { status: "running", startedAt: Date.now() },
        },
      }));

      const abortController = new AbortController();
      abortRef.current = abortController;
      const startedAt = Date.now();

      let response: RunNodeResponse;
      try {
        if (node.kind === "agent") {
          response = await runAgentNodeOnClient(
            node,
            currentInput,
            currentOutputs,
            abortController.signal,
          );
        } else if (node.kind === "human") {
          // human 节点的两阶段在 server 路由实现；这里发起第一次请求拿 awaiting-input，
          // 然后等用户回包再发第二次。
          const first = await runServerNode(
            node,
            currentInput,
            currentOutputs,
            undefined,
            abortController.signal,
          );
          if (first.status !== "awaiting-input") {
            response = first;
          } else {
            // 把 awaiting-input 反映到 UI
            setState((prev) => ({
              ...prev,
              status: "awaiting-input",
              nodeStates: {
                ...prev.nodeStates,
                [node.id]: {
                  status: "awaiting-input",
                  payload: first.payload as never,
                  awaitingSince: Date.now(),
                },
              },
            }));
            // 等用户回包
            const userResponse = await new Promise<unknown>((resolve, reject) => {
              humanDeferredRef.current = { resolve, reject };
            });
            // 标回 running
            setState((prev) => ({
              ...prev,
              status: "running",
              nodeStates: {
                ...prev.nodeStates,
                [node.id]: { status: "running", startedAt },
              },
            }));
            response = await runServerNode(
              node,
              currentInput,
              currentOutputs,
              userResponse,
              abortController.signal,
            );
          }
        } else {
          // structured / tool 节点：一次请求搞定
          response = await runServerNode(
            node,
            currentInput,
            currentOutputs,
            undefined,
            abortController.signal,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setState((prev) => ({
          ...prev,
          status: "error",
          error: message,
          nodeStates: {
            ...prev.nodeStates,
            [node.id]: {
              status: "error",
              error: message,
              failedAt: Date.now(),
            },
          },
        }));
        inflightRef.current = false;
        return;
      } finally {
        if (abortRef.current === abortController) {
          abortRef.current = null;
        }
      }

      // ---- 处理响应 ----

      if (response.status === "error") {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: response.error,
          nodeStates: {
            ...prev.nodeStates,
            [node.id]: {
              status: "error",
              error: response.error,
              failedAt: Date.now(),
            },
          },
        }));
        inflightRef.current = false;
        return;
      }

      if (response.status === "awaiting-input") {
        // 服务端节点（非 agent）返了 awaiting-input 但不是 human：协议错。
        // human 节点已经在上面消费过这个状态了。
        setState((prev) => ({
          ...prev,
          status: "error",
          error: `Node '${node.id}' returned awaiting-input but client cannot handle it`,
          nodeStates: {
            ...prev.nodeStates,
            [node.id]: {
              status: "error",
              error: "Unexpected awaiting-input",
              failedAt: Date.now(),
            },
          },
        }));
        inflightRef.current = false;
        return;
      }

      // status === "done"
      const newOutputs = {
        ...currentOutputs,
        [node.id]: { output: response.output },
      };

      // human-approval 拒绝特例：直接结束工作流为 rejected
      const approvedFlag =
        node.kind === "human" &&
        typeof response.output === "object" &&
        response.output !== null &&
        "approved" in response.output
          ? (response.output as { approved: unknown }).approved
          : true;

      if (approvedFlag === false) {
        setState((prev) => ({
          ...prev,
          status: "rejected",
          outputs: newOutputs,
          nodeStates: {
            ...prev.nodeStates,
            [node.id]: {
              status: "done",
              output: response.output,
              durationMs: response.durationMs,
              stepsUsed: response.stepsUsed,
            },
          },
        }));
        inflightRef.current = false;
        return;
      }

      const nextCursor = cursor + 1;
      setState((prev) => ({
        ...prev,
        cursor: nextCursor,
        outputs: newOutputs,
        nodeStates: {
          ...prev.nodeStates,
          [node.id]: {
            status: "done",
            output: response.output,
            durationMs: response.durationMs,
            stepsUsed: response.stepsUsed,
          },
        },
        status: nextCursor >= workflow.nodes.length ? "done" : "running",
      }));
      inflightRef.current = false;

      if (nextCursor < workflow.nodes.length) {
        setTimeout(() => {
          void runOneNode(nextCursor, currentInput, newOutputs);
        }, 0);
      }
    },
    // runOneNode 体内直接读 ref/setState，依赖只锁定真正稳定输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workflow, workspaceRoot, workspaceName],
  );

  // ---------- 公开 API ----------

  const start = useCallback(
    (workflowInput: Record<string, unknown>) => {
      if (inflightRef.current) return;
      runIdRef.current = crypto.randomUUID();
      const fresh = initialState(workflow);
      fresh.workflowInput = workflowInput;
      fresh.status = "running";
      fresh.stepByStep = stepByStepRef.current;
      setState(fresh);
      void runOneNode(0, workflowInput, {});
    },
    [workflow, runOneNode],
  );

  const submitHumanResponse = useCallback((humanResponse: unknown) => {
    const deferred = humanDeferredRef.current;
    if (deferred) {
      deferred.resolve(humanResponse);
      humanDeferredRef.current = null;
    }
  }, []);

  const submitToolResult = useCallback(
    (toolCallId: string, output: unknown) => {
      const deferred = interactiveDeferredsRef.current.get(toolCallId);
      if (deferred) {
        deferred.resolve(output);
        interactiveDeferredsRef.current.delete(toolCallId);
      }
    },
    [],
  );

  const submitToolApproval = useCallback(
    (toolCallId: string, approved: boolean) => {
      const deferred = approvalDeferredsRef.current.get(toolCallId);
      if (deferred) {
        deferred.resolve(approved);
        approvalDeferredsRef.current.delete(toolCallId);
      }
    },
    [],
  );

  const resumeStep = useCallback(() => {
    const deferred = stepPauseDeferredRef.current;
    if (deferred) {
      deferred.resolve();
      stepPauseDeferredRef.current = null;
    }
  }, []);

  const setStepByStep = useCallback((enabled: boolean) => {
    stepByStepRef.current = enabled;
    setState((prev) => ({ ...prev, stepByStep: enabled }));
    // 关掉时，如果当前正卡在 step-pause，立即放行
    if (!enabled && stepPauseDeferredRef.current) {
      stepPauseDeferredRef.current.resolve();
      stepPauseDeferredRef.current = null;
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    inflightRef.current = false;
    // 把所有挂起的 deferred reject 掉
    for (const d of interactiveDeferredsRef.current.values()) {
      d.reject(new Error("aborted"));
    }
    interactiveDeferredsRef.current.clear();
    for (const d of approvalDeferredsRef.current.values()) {
      d.reject(new Error("aborted"));
    }
    approvalDeferredsRef.current.clear();
    if (stepPauseDeferredRef.current) {
      stepPauseDeferredRef.current.reject(new Error("aborted"));
      stepPauseDeferredRef.current = null;
    }
    if (humanDeferredRef.current) {
      humanDeferredRef.current.reject(new Error("aborted"));
      humanDeferredRef.current = null;
    }
  }, []);

  // 卸载清理
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
    state,
    start,
    submitHumanResponse,
    submitToolResult,
    submitToolApproval,
    resumeStep,
    setStepByStep,
    abort,
  };
}
