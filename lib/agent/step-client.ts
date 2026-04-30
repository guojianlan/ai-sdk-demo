import type { ModelMessage } from "ai";

import type {
  AgentSource,
  WorkflowNodeContextInput,
  WorkspaceContextInput,
} from "@/lib/agent/source";
import type { ToolCallMeta } from "@/lib/agent/tool-utils";

/**
 * `/api/agent/step` 客户端消费器。
 *
 * 协议见路由文件注释。这里只做"拿到一个 fetch Response → 把 SSE 帧拆开 → 调用
 * callbacks"。不绑定任何 React state——React 用法在 `lib/agent/run-loop.ts`。
 *
 * 客户端**不再传 toolNames / system**——只指定 `source`（chat / workflow-node），
 * 服务端按 source 自己 lookup 出 tool 集合 + 拼出 system prompt。这样客户端就
 * 不知道服务端内部有哪些 tool。
 *
 * 事件类型：
 * - `text-delta`             → onTextDelta(delta)
 * - `tool-call`              → onToolCall({ toolCallId, toolName, input, meta })
 * - `tool-result`            → onToolResult({ toolCallId, toolName, output })
 * - `tool-error`             → onToolError({ toolCallId, toolName, error })
 * - `tool-approval-request`  → onApprovalRequest({ approvalId, toolCallId, ... })
 * - `finish`                 → resolve(StepResult) 并退出
 * - `error`                  → reject 异常并退出
 */

export type StreamedToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  meta: ToolCallMeta;
};

export type StreamedToolResult = {
  toolCallId: string;
  toolName: string;
  /** AI SDK 的 ToolResultOutput 形态（type: 'json' | 'text' | 'execution-denied' | ...）。 */
  output: unknown;
};

export type StreamedToolError = {
  toolCallId: string;
  toolName: string;
  error: string;
};

export type StreamedApprovalRequest = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type StepResult = {
  finishReason: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  responseMessages: ModelMessage[];
  /** 服务端按 source 解析出的 maxSteps（chat 走默认 16；workflow-node 走节点配置）。 */
  maxSteps: number;
  /** 本步内 LLM 产出的全部 tool calls（无论是否在服务端被执行）。 */
  toolCalls: StreamedToolCall[];
  /** 本步内服务端已执行的 tool 结果。 */
  toolResults: StreamedToolResult[];
  /** 本步内服务端 tool 执行抛出的错误。 */
  toolErrors: StreamedToolError[];
  /** 本步内 AI SDK 卡在 approval 上的请求。 */
  approvalRequests: StreamedApprovalRequest[];
};

export type StepStreamHandlers = {
  onTextDelta?: (delta: string) => void;
  onToolCall?: (call: StreamedToolCall) => void;
  onToolResult?: (result: StreamedToolResult) => void;
  onToolError?: (err: StreamedToolError) => void;
  onApprovalRequest?: (req: StreamedApprovalRequest) => void;
};

/**
 * 一行行读 SSE，按 `event: X\n data: Y\n\n` 拆。
 *
 * fetch 的 stream 返回的是 byte chunks，可能在一个 chunk 内有半个事件——必须 buffer。
 */
async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (!frame.trim() || frame.startsWith(":")) continue; // SSE 注释

        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (dataLines.length === 0) continue;
        yield { event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type RunStepInit = {
  messages: ModelMessage[];
  source: AgentSource;
  workspaceContext: WorkspaceContextInput;
  nodeContext?: WorkflowNodeContextInput;
};

export async function runStep(
  init: RunStepInit,
  handlers: StepStreamHandlers = {},
  signal?: AbortSignal,
): Promise<StepResult> {
  const res = await fetch("/api/agent/step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(init),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`/api/agent/step HTTP ${res.status}: ${text}`);
  }
  if (!res.body) {
    throw new Error("/api/agent/step: response has no body");
  }

  const toolCalls: StreamedToolCall[] = [];
  const toolResults: StreamedToolResult[] = [];
  const toolErrors: StreamedToolError[] = [];
  const approvalRequests: StreamedApprovalRequest[] = [];
  let finishPayload:
    | Pick<StepResult, "finishReason" | "usage" | "responseMessages" | "maxSteps">
    | null = null;
  let lastError: string | null = null;

  for await (const { event, data } of parseSseFrames(res.body)) {
    switch (event) {
      case "text-delta": {
        const parsed = JSON.parse(data) as { delta?: string };
        if (parsed.delta) handlers.onTextDelta?.(parsed.delta);
        break;
      }
      case "tool-call": {
        const tc = JSON.parse(data) as StreamedToolCall;
        toolCalls.push(tc);
        handlers.onToolCall?.(tc);
        break;
      }
      case "tool-result": {
        const tr = JSON.parse(data) as StreamedToolResult;
        toolResults.push(tr);
        handlers.onToolResult?.(tr);
        break;
      }
      case "tool-error": {
        const te = JSON.parse(data) as StreamedToolError;
        toolErrors.push(te);
        handlers.onToolError?.(te);
        break;
      }
      case "tool-approval-request": {
        const ar = JSON.parse(data) as StreamedApprovalRequest;
        approvalRequests.push(ar);
        handlers.onApprovalRequest?.(ar);
        break;
      }
      case "finish": {
        finishPayload = JSON.parse(data) as Pick<
          StepResult,
          "finishReason" | "usage" | "responseMessages" | "maxSteps"
        >;
        break;
      }
      case "error": {
        const parsed = JSON.parse(data) as { error?: string };
        lastError = parsed.error ?? "unknown stream error";
        break;
      }
      default:
        // 未知事件：忽略，向前兼容
        break;
    }
  }

  if (lastError) throw new Error(lastError);
  if (!finishPayload)
    throw new Error("/api/agent/step ended without finish event");

  return {
    ...finishPayload,
    toolCalls,
    toolResults,
    toolErrors,
    approvalRequests,
  };
}
