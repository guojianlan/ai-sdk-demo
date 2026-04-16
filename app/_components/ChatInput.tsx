"use client";

import { FormEvent, KeyboardEvent } from "react";
import type { ChatStatus } from "ai";

import { Eyebrow } from "./Eyebrow";

/**
 * 底部输入框 + 发送按钮 + Plan Mode 开关。
 *
 * Plan Mode 是一个 toggle：
 * - OFF（默认）：发送 → 直接进 chat
 * - ON：发送 → 先生成结构化 plan → 用户 review/编辑/勾选 → 再执行
 *
 * 不再有两个按钮（"发送" + "先出 plan"）—— 只有一个发送按钮，行为由 toggle 决定。
 */
export function ChatInput({
  draft,
  onDraftChange,
  onSubmit,
  canSend,
  status,
  hasWorkspace,
  planMode,
  onPlanModeChange,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  /** 按发送时调用。上层根据 planMode 决定是走 chat 还是走 plan。 */
  onSubmit: () => void;
  canSend: boolean;
  status: ChatStatus;
  hasWorkspace: boolean;
  planMode: boolean;
  onPlanModeChange: (enabled: boolean) => void;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  const isStreaming = status === "streaming" || status === "submitted";

  return (
    <form
      onSubmit={handleSubmit}
      className="shrink-0 rounded-md border border-slate-300 bg-white focus-within:border-slate-900"
    >
      <div className="flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
          <Eyebrow>Prompt · Input</Eyebrow>
          <span className="font-mono text-[10px] text-slate-500">
            ↵ 发送 · ⇧ + ↵ 换行
          </span>
        </div>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            hasWorkspace ? "例如：这个项目的入口在哪里？" : "请先为这个会话选择工作区"
          }
          rows={3}
          disabled={!hasWorkspace}
          className="w-full resize-none border-0 bg-white px-4 py-3 text-[15px] leading-7 text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50"
        />

        <div className="flex items-center gap-3 border-t border-slate-200 px-4 py-2.5">
          {/* Plan Mode toggle */}
          <label
            className={[
              "flex cursor-pointer select-none items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors duration-200",
              planMode
                ? "border-sky-500 bg-sky-50 text-sky-700"
                : "border-slate-200 bg-white text-slate-500 hover:border-slate-400",
            ].join(" ")}
          >
            <input
              type="checkbox"
              checked={planMode}
              onChange={(e) => onPlanModeChange(e.currentTarget.checked)}
              className="sr-only"
            />
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
            <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
              Plan
            </span>
          </label>

          <span className="flex-1" />

          <button
            type="submit"
            disabled={!canSend}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
          >
            {isStreaming ? (
              <>
                <svg
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5 animate-spin"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" strokeDasharray="42 14" />
                </svg>
                分析中
              </>
            ) : (
              <>
                {planMode ? "生成 Plan" : "发送"}
                <svg
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
