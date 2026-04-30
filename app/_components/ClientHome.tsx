"use client";

import type { ModelMessage } from "ai";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  useClientAgentChat,
  type LiveStep,
  type LiveToolCall,
} from "@/lib/agent/use-client-agent-chat";
import { DEFAULT_WORKSPACE_ACCESS_MODE } from "@/lib/chat-access-mode";

import { AgentInteractiveCard } from "./workflow/AgentInteractiveCard";
import { AgentStepPauseCard } from "./workflow/AgentStepPauseCard";
import { AgentToolApprovalCard } from "./workflow/AgentToolApprovalCard";
import { Eyebrow } from "./Eyebrow";
import {
  WorkspacePicker,
  type WorkspacePickerSubmit,
} from "./WorkspacePicker";

/**
 * 主聊天 client 模式入口。
 *
 * 和 server 模式（`page.tsx` 里的 `Home`）的区别：
 * - 用 `useClientAgentChat` 而不是 `useChat`：每一步 LLM 调用走 SSE，loop 在前端推进
 * - **不接** session 持久化 / resume / compaction（MVP 简化）
 * - 显示 ModelMessage（不是 UIMessage parts），UI 比 server 模式朴素
 *
 * 适合验证 client loop 协议是否 work；想要全功能就把 NEXT_PUBLIC_AGENT_LOOP_MODE
 * 改回 server。
 */
export function ClientHome() {
  const [workspaces, setWorkspaces] = useState<
    Array<{ root: string; name: string; description: string; isCurrentProject: boolean }>
  >([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeWorkspace, setActiveWorkspace] = useState<{
    root: string;
    name: string;
    accessMode: "workspace-tools" | "no-tools";
    bypassPermissions: boolean;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledAwayRef = useRef(false);

  // 拉 workspace 列表
  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setWorkspaces(data.workspaces ?? []);
        setWorkspacesLoading(false);
      })
      .catch(() => {
        if (!cancelled) setWorkspacesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 没选 workspace 时自动展示 picker：用派生值（render-time），不通过 effect 调
  // setPickerOpen，避免触发 react-hooks/set-state-in-effect。
  const showPicker = pickerOpen || (!activeWorkspace && !workspacesLoading);

  const chat = useClientAgentChat({
    workspaceRoot: activeWorkspace?.root ?? "",
    workspaceName: activeWorkspace?.name ?? "",
    workspaceAccessMode:
      activeWorkspace?.accessMode ?? DEFAULT_WORKSPACE_ACCESS_MODE,
    bypassPermissions: activeWorkspace?.bypassPermissions ?? false,
  });

  // auto scroll
  useEffect(() => {
    if (userScrolledAwayRef.current) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.liveStep, chat.awaiting]);

  function handlePickerSubmit(s: WorkspacePickerSubmit) {
    setActiveWorkspace({
      root: s.workspace.root,
      name: s.workspace.name,
      accessMode: s.workspaceAccessMode,
      bypassPermissions: s.bypassPermissions,
    });
    setPickerOpen(false);
    chat.clear();
  }

  const canSend =
    !!activeWorkspace?.root &&
    draft.trim().length > 0 &&
    chat.status === "idle";

  function send() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");
    void chat.sendMessage(text);
  }

  return (
    <main className="bg-blueprint h-screen overflow-hidden px-4 py-6 text-slate-900 sm:px-6 sm:py-8">
      <div className="mx-auto flex h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white">
        {/* header */}
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <Eyebrow>Client mode · single-step + streaming</Eyebrow>
            <span className="font-mono text-[11px] text-slate-500">
              {activeWorkspace?.name ?? "no workspace"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/workflow/bug-fix"
              className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500 hover:text-slate-900"
            >
              workflow →
            </Link>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={chat.stepByStep}
                onChange={(e) => chat.setStepByStep(e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-slate-900"
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-700">
                逐步执行
              </span>
            </label>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="cursor-pointer rounded border border-slate-300 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-700 hover:border-slate-900 hover:text-slate-900"
            >
              换 workspace
            </button>
            {chat.status !== "idle" && (
              <button
                type="button"
                onClick={chat.stop}
                className="cursor-pointer rounded border border-rose-400 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-rose-700 hover:bg-rose-50"
              >
                停止
              </button>
            )}
          </div>
        </header>

        {/* messages */}
        <div
          ref={messagesContainerRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const nearBottom =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            userScrolledAwayRef.current = !nearBottom;
          }}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-6"
        >
          {chat.messages.length === 0 && (
            <EmptyClientChat
              hasWorkspace={!!activeWorkspace}
              onOpenPicker={() => setPickerOpen(true)}
            />
          )}

          {chat.messages.map((msg, idx) => (
            <ModelMessageView key={idx} message={msg} />
          ))}

          {/* 当前 step 的实时增量：partial text + tool 卡片 */}
          {chat.liveStep && <LiveStepView step={chat.liveStep} />}

          {/* 需要用户操作的卡片 */}
          {chat.awaiting?.kind === "approval" && (
            <AgentToolApprovalCard
              toolCallId={chat.awaiting.toolCallId}
              toolName={chat.awaiting.toolName}
              input={chat.awaiting.input}
              stepCount={chat.awaiting.stepCount}
              onDecide={chat.submitToolApproval}
            />
          )}
          {chat.awaiting?.kind === "interactive" && (
            <AgentInteractiveCard
              toolCallId={chat.awaiting.toolCallId}
              toolName={chat.awaiting.toolName}
              input={chat.awaiting.input}
              stepCount={chat.awaiting.stepCount}
              onSubmit={chat.submitToolResult}
            />
          )}
          {chat.awaiting?.kind === "step-pause" && (
            <AgentStepPauseCard
              stepCount={chat.awaiting.stepCount}
              maxSteps={chat.awaiting.maxSteps}
              lastText={chat.liveStep?.partialText ?? ""}
              onResume={chat.resumeStep}
            />
          )}

          {chat.error && (
            <div className="rounded border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-700">
              <strong>失败：</strong> {chat.error}
            </div>
          )}
        </div>

        {/* input */}
        <div className="shrink-0 border-t border-slate-200 px-6 py-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            disabled={chat.status === "streaming"}
            rows={2}
            placeholder={
              activeWorkspace
                ? "向 agent 提问，Enter 发送 / Shift+Enter 换行..."
                : "先选一个工作区"
            }
            className="w-full resize-none rounded border border-slate-300 bg-white p-3 text-[14px] focus:border-slate-900 focus:outline-none disabled:bg-slate-50"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-slate-500">
              status: {chat.status}
              {chat.status === "awaiting-input" && chat.awaiting
                ? ` (${chat.awaiting.kind})`
                : ""}
            </span>
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              className="cursor-pointer rounded-md border border-slate-900 bg-slate-900 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              发送
            </button>
          </div>
        </div>
      </div>

      {showPicker && (
        <WorkspacePicker
          workspaces={workspaces}
          onClose={() => setPickerOpen(false)}
          onSubmit={handlePickerSubmit}
        />
      )}
    </main>
  );
}

/**
 * In-progress step 的实时视图：
 * - partial text（流式增长）
 * - 当前 step 调用过的 tool 卡片（status 跟着 SSE 事件流转）
 *
 * 当一步 LLM 完成后，hook 会把 liveStep 清空，已完成内容会出现在 messages 列表里。
 */
function LiveStepView({ step }: { step: LiveStep }) {
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50/50 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-blue-700">
          step {step.stepCount + 1} · streaming
        </span>
        <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-blue-500" />
      </div>

      {step.partialText && (
        <pre className="mb-3 whitespace-pre-wrap font-sans text-[14px] leading-7 text-slate-800">
          {step.partialText}
        </pre>
      )}

      {step.toolCalls.length > 0 && (
        <div className="space-y-2">
          {step.toolCalls.map((tc) => (
            <LiveToolCallChip key={tc.toolCallId} call={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<LiveToolCall["status"], string> = {
  calling: "调用中...",
  done: "完成",
  error: "失败",
  "awaiting-approval": "等你审批",
  "awaiting-interactive": "等你回答",
};

const STATUS_BORDER: Record<LiveToolCall["status"], string> = {
  calling: "border-amber-300 bg-amber-50",
  done: "border-emerald-300 bg-emerald-50",
  error: "border-rose-300 bg-rose-50",
  "awaiting-approval": "border-amber-400 bg-amber-100",
  "awaiting-interactive": "border-sky-400 bg-sky-50",
};

function LiveToolCallChip({ call }: { call: LiveToolCall }) {
  return (
    <details
      className={`rounded border px-3 py-2 text-[12px] ${STATUS_BORDER[call.status]}`}
    >
      <summary className="cursor-pointer font-mono text-slate-800">
        → {call.toolName}{" "}
        <span className="text-slate-500">— {STATUS_LABEL[call.status]}</span>
      </summary>
      <div className="mt-2 space-y-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            input
          </div>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-700">
            {JSON.stringify(call.input, null, 2)}
          </pre>
        </div>
        {call.status === "done" && call.output !== undefined && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-700">
              output
            </div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-700">
              {JSON.stringify(call.output, null, 2)}
            </pre>
          </div>
        )}
        {call.status === "error" && call.errorMessage && (
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700">
              error
            </div>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-rose-700">
              {call.errorMessage}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function EmptyClientChat({
  hasWorkspace,
  onOpenPicker,
}: {
  hasWorkspace: boolean;
  onOpenPicker: () => void;
}) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-8">
      <Eyebrow>Ready · client loop</Eyebrow>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900">
        前端驱动 single-step + streaming
      </h2>
      <p className="mt-3 text-[14px] leading-7 text-slate-600">
        每一步 LLM 调用都通过 SSE 流式推回，tool 调用 / 审批 / 交互式提问全部
        在前端控制。可以在右上角勾选&quot;逐步执行&quot;让 agent 在每个 step
        之间停下，等你点继续。
      </p>
      {!hasWorkspace ? (
        <button
          type="button"
          onClick={onOpenPicker}
          className="mt-5 cursor-pointer rounded-md border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          先选一个工作区
        </button>
      ) : (
        <p className="mt-5 font-mono text-[12px] text-slate-500">
          下方输入框直接提问，按 Enter 发送。
        </p>
      )}
    </div>
  );
}

/**
 * 简化的 ModelMessage 渲染。
 *
 * - user → 灰色右对齐文本
 * - assistant text → markdown-ish 但不解析（朴素 pre），tool-call parts 折叠展示
 * - tool message → 折叠展示 tool result
 */
function ModelMessageView({ message }: { message: ModelMessage }) {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("");
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-md bg-slate-100 px-4 py-2.5 text-[14px] leading-7 text-slate-900">
          {text}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    if (typeof message.content === "string") {
      return (
        <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-[14px] leading-7 text-slate-800">
          <pre className="whitespace-pre-wrap font-sans">{message.content}</pre>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {message.content.map((part, idx) => {
          if (part.type === "text") {
            return (
              <div
                key={idx}
                className="rounded-md border border-slate-200 bg-white px-4 py-3 text-[14px] leading-7 text-slate-800"
              >
                <pre className="whitespace-pre-wrap font-sans">{part.text}</pre>
              </div>
            );
          }
          if (part.type === "tool-call") {
            return (
              <details
                key={idx}
                className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px]"
              >
                <summary className="cursor-pointer font-mono text-amber-800">
                  → tool call: {part.toolName}
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-700">
                  {JSON.stringify(part.input, null, 2)}
                </pre>
              </details>
            );
          }
          return null;
        })}
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="space-y-2">
        {message.content.map((part, idx) => {
          if (part.type !== "tool-result") return null;
          const out = part.output;
          const denied = out.type === "execution-denied";
          return (
            <details
              key={idx}
              className={`rounded border px-3 py-2 text-[12px] ${
                denied
                  ? "border-rose-200 bg-rose-50"
                  : "border-emerald-200 bg-emerald-50"
              }`}
            >
              <summary
                className={`cursor-pointer font-mono ${
                  denied ? "text-rose-800" : "text-emerald-800"
                }`}
              >
                ← tool result: {part.toolName} {denied ? "(denied)" : ""}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-700">
                {JSON.stringify(out, null, 2)}
              </pre>
            </details>
          );
        })}
      </div>
    );
  }

  return null;
}
