"use client";

import { Eyebrow } from "@/app/_components/Eyebrow";
import type {
  AwaitingInputPayload,
  NodeDefinition,
  NodeState,
} from "@/lib/workflow/types";

import { AgentInteractiveCard } from "./AgentInteractiveCard";
import { AgentStepPauseCard } from "./AgentStepPauseCard";
import { AgentToolApprovalCard } from "./AgentToolApprovalCard";
import { HumanApprovalCard } from "./HumanApprovalCard";

const STATUS_LABEL: Record<NodeState["status"], string> = {
  pending: "等待",
  running: "执行中",
  "awaiting-input": "等你操作",
  done: "完成",
  error: "失败",
};

const STATUS_DOT: Record<NodeState["status"], string> = {
  pending: "bg-slate-300",
  running: "bg-blue-500 animate-pulse",
  "awaiting-input": "bg-amber-500",
  done: "bg-emerald-500",
  error: "bg-rose-500",
};

const KIND_LABEL: Record<NodeDefinition["kind"], string> = {
  agent: "Agent",
  structured: "Structured",
  tool: "Tool",
  human: "Human",
};

/**
 * 通用节点卡片。状态分发：
 * - pending          → 占位
 * - running          → 通用提示 + agent 节点附 step 进度条
 * - awaiting-input   → 按 payload.kind 分发到具体卡片：
 *     human-approval        → HumanApprovalCard
 *     agent-tool-approval   → AgentToolApprovalCard（agent 在调写入工具）
 *     agent-interactive     → AgentInteractiveCard（agent 在调 ask_question 等）
 *     agent-step-pause      → AgentStepPauseCard（用户开了"逐步执行"）
 * - done             → 输出折叠展示
 * - error            → 红色错误框
 */
export function NodeCard({
  node,
  state,
  index,
  onSubmitHumanResponse,
  onSubmitToolApproval,
  onSubmitToolResult,
  onResumeStep,
}: {
  node: NodeDefinition;
  state: NodeState;
  index: number;
  onSubmitHumanResponse: (response: unknown) => void;
  onSubmitToolApproval: (toolCallId: string, approved: boolean) => void;
  onSubmitToolResult: (toolCallId: string, output: unknown) => void;
  onResumeStep: () => void;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <Eyebrow>
              {String(index + 1).padStart(2, "0")} · {KIND_LABEL[node.kind]}
            </Eyebrow>
            <span className="h-px flex-1 bg-slate-200" />
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${STATUS_DOT[state.status]}`}
                aria-hidden="true"
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
                {STATUS_LABEL[state.status]}
              </span>
            </div>
          </div>
          <h3 className="mt-2 text-base font-semibold text-slate-900">
            {node.label}
          </h3>
          {node.description && (
            <p className="mt-1 text-[13px] leading-6 text-slate-600">
              {node.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4">
        {state.status === "pending" && (
          <p className="text-[13px] text-slate-400">⌛ 等待上游节点完成</p>
        )}

        {state.status === "running" && (
          <div className="text-[13px] text-blue-600">
            ⚡ 正在执行...
            {state.agentLoop && (
              <span className="ml-2 font-mono text-[12px] text-slate-500">
                step {state.agentLoop.stepCount} / {state.agentLoop.maxSteps}
              </span>
            )}
            {state.agentLoop?.lastText && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[12px] text-slate-500 hover:text-slate-700">
                  当前步骤的文字输出（点击展开）
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-sans text-[12px] text-slate-700">
                  {state.agentLoop.lastText}
                </pre>
              </details>
            )}
          </div>
        )}

        {state.status === "awaiting-input" && (
          <AwaitingInputDispatcher
            payload={state.payload}
            onSubmitHumanResponse={onSubmitHumanResponse}
            onSubmitToolApproval={onSubmitToolApproval}
            onSubmitToolResult={onSubmitToolResult}
            onResumeStep={onResumeStep}
          />
        )}

        {state.status === "done" && (
          <NodeOutputDisplay
            output={state.output}
            durationMs={state.durationMs}
            stepsUsed={state.stepsUsed}
          />
        )}

        {state.status === "error" && (
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-700">
            <strong>失败：</strong> {state.error}
          </div>
        )}
      </div>
    </div>
  );
}

function AwaitingInputDispatcher({
  payload,
  onSubmitHumanResponse,
  onSubmitToolApproval,
  onSubmitToolResult,
  onResumeStep,
}: {
  payload: AwaitingInputPayload;
  onSubmitHumanResponse: (response: unknown) => void;
  onSubmitToolApproval: (toolCallId: string, approved: boolean) => void;
  onSubmitToolResult: (toolCallId: string, output: unknown) => void;
  onResumeStep: () => void;
}) {
  switch (payload.kind) {
    case "human-approval":
      return (
        <HumanApprovalCard
          payload={payload}
          onSubmit={onSubmitHumanResponse}
        />
      );
    case "agent-tool-approval":
      return (
        <AgentToolApprovalCard
          toolCallId={payload.toolCallId}
          toolName={payload.toolName}
          input={payload.input}
          stepCount={payload.stepCount}
          onDecide={onSubmitToolApproval}
        />
      );
    case "agent-interactive":
      return (
        <AgentInteractiveCard
          toolCallId={payload.toolCallId}
          toolName={payload.toolName}
          input={payload.input}
          stepCount={payload.stepCount}
          onSubmit={onSubmitToolResult}
        />
      );
    case "agent-step-pause":
      return (
        <AgentStepPauseCard
          stepCount={payload.stepCount}
          maxSteps={payload.maxSteps}
          lastText={payload.lastText}
          onResume={onResumeStep}
        />
      );
  }
}

function NodeOutputDisplay({
  output,
  durationMs,
  stepsUsed,
}: {
  output: unknown;
  durationMs: number;
  stepsUsed?: number;
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-[13px] text-emerald-700 hover:text-emerald-900">
        ✓ 输出（{(durationMs / 1000).toFixed(1)}s
        {stepsUsed !== undefined ? ` · ${stepsUsed} steps` : ""}）— 点击展开
      </summary>
      <div className="mt-3 max-h-96 overflow-auto rounded bg-slate-50 p-3 font-mono text-[12px] leading-5 text-slate-800">
        <pre className="whitespace-pre-wrap wrap-break-word">
          {typeof output === "string"
            ? output
            : JSON.stringify(output, null, 2)}
        </pre>
      </div>
    </details>
  );
}
