"use client";

import { SUGGESTIONS } from "@/app/_lib/chat-session";

import { Eyebrow } from "./Eyebrow";

/**
 * 空对话状态下的"引导卡"：说明当前 access mode 的语义 + 给几个 suggested prompts。
 * 一旦 messages.length > 0，这个组件就不再出现。
 */
export function EmptyState({
  hasWorkspace,
  accessMode,
  onOpenPicker,
  onSendSuggestion,
}: {
  hasWorkspace: boolean;
  accessMode: "workspace-tools" | "no-tools";
  onOpenPicker: () => void;
  onSendSuggestion: (text: string) => void;
}) {
  return (
    <div className="corner-bracket relative text-slate-900">
      <span aria-hidden="true" />
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50/50 p-8 sm:p-10">
        <div className="max-w-3xl">
          <div className="flex items-center gap-3">
            <Eyebrow>Ready · Blueprint</Eyebrow>
            <span className="h-px w-10 bg-slate-300" />
          </div>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px]">
            让 Agent 先理解你的项目
          </h3>
          <p className="mt-4 max-w-2xl text-[14px] leading-7 text-slate-600">
            {accessMode === "workspace-tools"
              ? "这个聊天助手会以「开发工程师」的角色来分析你选中的工作区。它会先用工具查看目录、搜索代码、读取文件，再给出基于项目事实的解释。"
              : "这个聊天助手会以「开发工程师」的角色回答问题，但当前会话不会读取工作区内容。它只能基于你给出的描述和通用知识作答。"}
          </p>
        </div>

        {!hasWorkspace && (
          <button
            type="button"
            onClick={onOpenPicker}
            className="mt-8 inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-5 py-3 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-700"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            先选择工作区
          </button>
        )}

        {hasWorkspace && (
          <>
            <div className="mt-8 flex items-center gap-2">
              <Eyebrow>Suggested prompts</Eyebrow>
              <span className="h-px flex-1 bg-slate-200" />
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              {SUGGESTIONS.map((suggestion, idx) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onSendSuggestion(suggestion)}
                  className="group cursor-pointer rounded-md border border-slate-300 bg-white p-4 text-left transition-colors duration-200 hover:border-slate-900 hover:bg-slate-50"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5 text-slate-400 transition-colors duration-200 group-hover:text-slate-900"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </div>
                  <p className="text-[13px] leading-6 text-slate-700">{suggestion}</p>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
