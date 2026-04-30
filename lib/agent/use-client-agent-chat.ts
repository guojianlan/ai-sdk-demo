"use client";

import type { ModelMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

import { runAgentLoop } from "@/lib/agent/run-loop";
import type { WorkspaceAccessMode } from "@/lib/chat-access-mode";

/**
 * 主聊天 **client 模式** hook。
 *
 * 取代 `useChat`：当 `NEXT_PUBLIC_AGENT_LOOP_MODE=client` 时，主聊天 UI 走纯前端
 * 驱动的 single-step + streaming loop（实现见 `lib/agent/run-loop.ts`）。
 *
 * 增量 UI 关键设计：维护一个 `liveStep` —— 反映"当前正在跑的 step"的进度，
 * 包括 partial text + 已知 tool calls 及它们的 status（calling / done / error /
 * awaiting-approval / awaiting-interactive）。SSE 每个事件实时 reflect 到这里，
 * UI 在 `messages` 之外额外渲染 `liveStep`，做到"tool 一调用立刻显示卡片"。
 *
 * MVP 简化：
 * - 不接 chat-store / SQLite 持久化
 * - 不接 resume / chatId
 * - 不接 compaction / MCP
 */

export type ClientChatStatus = "idle" | "streaming" | "awaiting-input" | "error";

export type LiveToolCallStatus =
  | "calling"
  | "done"
  | "error"
  | "awaiting-approval"
  | "awaiting-interactive";

export type LiveToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  isInteractive: boolean;
  isApprovalRequired: boolean;
  status: LiveToolCallStatus;
  output?: unknown;
  errorMessage?: string;
  /** 仅 awaiting-approval 时有值（来自 SSE tool-approval-request）。 */
  approvalId?: string;
};

export type LiveStep = {
  stepCount: number;
  partialText: string;
  toolCalls: LiveToolCall[];
};

export type ClientChatAwaiting =
  | { kind: "approval"; toolCallId: string; approvalId: string; toolName: string; input: unknown; stepCount: number }
  | { kind: "interactive"; toolCallId: string; toolName: string; input: unknown; stepCount: number }
  | { kind: "step-pause"; stepCount: number; maxSteps: number };

export type UseClientAgentChatOptions = {
  workspaceRoot: string;
  workspaceName: string;
  workspaceAccessMode: WorkspaceAccessMode;
  bypassPermissions: boolean;
};

type Deferred<T> = { resolve: (v: T) => void; reject: (e: unknown) => void };

export function useClientAgentChat(opts: UseClientAgentChatOptions) {
  const {
    workspaceRoot,
    workspaceName,
    workspaceAccessMode,
    bypassPermissions,
  } = opts;

  const [messages, setMessages] = useState<ModelMessage[]>([]);
  const [liveStep, setLiveStep] = useState<LiveStep | null>(null);
  const [status, setStatus] = useState<ClientChatStatus>("idle");
  const [awaiting, setAwaiting] = useState<ClientChatAwaiting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepByStep, setStepByStepState] = useState(false);

  const stepByStepRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef(false);

  const approvalDeferredsRef = useRef(new Map<string, Deferred<boolean>>());
  const interactiveDeferredsRef = useRef(new Map<string, Deferred<unknown>>());
  const stepPauseDeferredRef = useRef<Deferred<void> | null>(null);

  // ---------- liveStep 增量更新 helpers ----------

  function patchToolCall(
    toolCallId: string,
    patch: Partial<LiveToolCall>,
  ): void {
    setLiveStep((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        toolCalls: prev.toolCalls.map((tc) =>
          tc.toolCallId === toolCallId ? { ...tc, ...patch } : tc,
        ),
      };
    });
  }

  // ---------- sendMessage：启动一轮 turn ----------

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || inflightRef.current) return;

      const userMessage: ModelMessage = { role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMessage]);
      setStatus("streaming");
      setAwaiting(null);
      setError(null);
      setLiveStep(null);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      inflightRef.current = true;

      try {
        const initial: ModelMessage[] = [...messages, userMessage];

        await runAgentLoop({
          initialMessages: initial,
          // 客户端不知道服务端的 system prompt / tool 集合：只标识"我是 chat 调用方"，
          // 服务端按 source + accessMode 自己 lookup。
          source: { kind: "chat", accessMode: workspaceAccessMode },
          workspaceContext: {
            workspaceRoot,
            workspaceName,
            bypassPermissions,
          },
          shouldPauseStepByStep: () => stepByStepRef.current,
          signal: ctrl.signal,
          callbacks: {
            onStepStart: (stepCount) => {
              setStatus("streaming");
              setLiveStep({ stepCount, partialText: "", toolCalls: [] });
            },
            onTextDelta: (_step, delta) => {
              setLiveStep((prev) =>
                prev ? { ...prev, partialText: prev.partialText + delta } : prev,
              );
            },
            onToolCall: (_step, call) => {
              setLiveStep((prev) => {
                if (!prev) return prev;
                // 防重复（理论上不会，但稳妥）
                if (prev.toolCalls.some((t) => t.toolCallId === call.toolCallId))
                  return prev;
                return {
                  ...prev,
                  toolCalls: [
                    ...prev.toolCalls,
                    {
                      toolCallId: call.toolCallId,
                      toolName: call.toolName,
                      input: call.input,
                      isInteractive: call.meta.isInteractive,
                      isApprovalRequired: call.meta.isApprovalRequired,
                      status: "calling",
                    },
                  ],
                };
              });
            },
            onToolResult: (_step, result) => {
              patchToolCall(result.toolCallId, {
                status: "done",
                output: result.output,
              });
            },
            onToolError: (_step, err) => {
              patchToolCall(err.toolCallId, {
                status: "error",
                errorMessage: err.error,
              });
            },
            onApprovalRequestReceived: (_step, req) => {
              patchToolCall(req.toolCallId, {
                status: "awaiting-approval",
                approvalId: req.approvalId,
              });
            },
            onAwaitingApproval: (stepCount, req) => {
              setAwaiting({
                kind: "approval",
                toolCallId: req.toolCallId,
                approvalId: req.approvalId,
                toolName: req.toolName,
                input: req.input,
                stepCount,
              });
              setStatus("awaiting-input");
              return new Promise<boolean>((resolve, reject) => {
                approvalDeferredsRef.current.set(req.toolCallId, {
                  resolve: (approved) => {
                    setAwaiting(null);
                    setStatus("streaming");
                    resolve(approved);
                  },
                  reject,
                });
              });
            },
            onAwaitingInteractive: (stepCount, call) => {
              patchToolCall(call.toolCallId, { status: "awaiting-interactive" });
              setAwaiting({
                kind: "interactive",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
                stepCount,
              });
              setStatus("awaiting-input");
              return new Promise<unknown>((resolve, reject) => {
                interactiveDeferredsRef.current.set(call.toolCallId, {
                  resolve: (output) => {
                    patchToolCall(call.toolCallId, {
                      status: "done",
                      output,
                    });
                    setAwaiting(null);
                    setStatus("streaming");
                    resolve(output);
                  },
                  reject,
                });
              });
            },
            onAwaitingStepPause: ({ stepCount, maxSteps: max }) => {
              setAwaiting({ kind: "step-pause", stepCount, maxSteps: max });
              setStatus("awaiting-input");
              return new Promise<void>((resolve, reject) => {
                stepPauseDeferredRef.current = {
                  resolve: () => {
                    setAwaiting(null);
                    setStatus("streaming");
                    resolve();
                  },
                  reject,
                };
              });
            },
            onStepFinish: () => {
              // step 结束：这一步的 responseMessages 已经被 onMessagesUpdated 推到
              // messages 里了；liveStep 失效，清掉避免重复展示。
              setLiveStep(null);
            },
            onMessagesUpdated: (next) => {
              setMessages([...next]);
            },
          },
        });

        setStatus("idle");
        setAwaiting(null);
        setLiveStep(null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown agent loop error";
        if (message !== "aborted") {
          setError(message);
          setStatus("error");
        } else {
          setStatus("idle");
        }
        setLiveStep(null);
      } finally {
        inflightRef.current = false;
        abortRef.current = null;
      }
    },
    [
      workspaceRoot,
      workspaceName,
      workspaceAccessMode,
      bypassPermissions,
      messages,
    ],
  );

  // ---------- 回包 / 中断 ----------

  const submitToolApproval = useCallback(
    (toolCallId: string, approved: boolean) => {
      const d = approvalDeferredsRef.current.get(toolCallId);
      if (d) {
        d.resolve(approved);
        approvalDeferredsRef.current.delete(toolCallId);
      }
    },
    [],
  );

  const submitToolResult = useCallback(
    (toolCallId: string, output: unknown) => {
      const d = interactiveDeferredsRef.current.get(toolCallId);
      if (d) {
        d.resolve(output);
        interactiveDeferredsRef.current.delete(toolCallId);
      }
    },
    [],
  );

  const resumeStep = useCallback(() => {
    const d = stepPauseDeferredRef.current;
    if (d) {
      d.resolve();
      stepPauseDeferredRef.current = null;
    }
  }, []);

  const setStepByStep = useCallback((enabled: boolean) => {
    stepByStepRef.current = enabled;
    setStepByStepState(enabled);
    if (!enabled && stepPauseDeferredRef.current) {
      stepPauseDeferredRef.current.resolve();
      stepPauseDeferredRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    inflightRef.current = false;
    for (const d of approvalDeferredsRef.current.values())
      d.reject(new Error("aborted"));
    approvalDeferredsRef.current.clear();
    for (const d of interactiveDeferredsRef.current.values())
      d.reject(new Error("aborted"));
    interactiveDeferredsRef.current.clear();
    if (stepPauseDeferredRef.current) {
      stepPauseDeferredRef.current.reject(new Error("aborted"));
      stepPauseDeferredRef.current = null;
    }
    setStatus("idle");
    setAwaiting(null);
    setLiveStep(null);
  }, []);

  const clear = useCallback(() => {
    if (inflightRef.current) {
      stop();
    }
    setMessages([]);
    setLiveStep(null);
    setError(null);
    setStatus("idle");
    setAwaiting(null);
  }, [stop]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
    messages,
    liveStep,
    status,
    awaiting,
    error,
    stepByStep,
    sendMessage,
    submitToolApproval,
    submitToolResult,
    resumeStep,
    setStepByStep,
    stop,
    clear,
  };
}
