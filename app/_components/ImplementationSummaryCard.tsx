"use client";

import { useState } from "react";

import { AssistantMarkdown } from "./AssistantMarkdown";

/**
 * `<implementation_summary>` 块的渲染卡 —— default 模式下 agent 完成多文件改动
 * 后输出的总结。配合 `app/api/chat/agent-config.ts` 的 IMPLEMENTATION SUMMARY
 * 提示规则使用。
 *
 * 设计平行于 `ProposedPlanCard`，但配色用 emerald（"完成"语义），按钮换成
 * 「复制」+「创建 commit」（plan 卡是「采用」+「复制」）。
 *
 * Commit 按钮：发一条 user message 让 agent 帮忙跑 `git status` + `git add` +
 * `git commit -m`。具体 commit message 由 agent 根据 summary 浓缩——不需要前端
 * 强制规定格式。shell 工具有 shellApprovalPolicy 守门，写死动作仍受审批控制。
 */

export type ImplementationSummaryCardProps = {
  /** `<implementation_summary>...</implementation_summary>` 标签里 trim 后的 markdown 内容。 */
  content: string;
  /** 用户点"创建 commit"时回调；父组件负责 sendMessage。 */
  onCreateCommit: (summary: string) => void;
};

export function ImplementationSummaryCard({
  content,
  onCreateCommit,
}: ImplementationSummaryCardProps) {
  const [copied, setCopied] = useState(false);
  const [commitTriggered, setCommitTriggered] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 不安全 origin / 老浏览器；忽略，让用户从卡里框选复制兜底
    }
  }

  function handleCommit() {
    if (commitTriggered) return;
    setCommitTriggered(true);
    onCreateCommit(content);
  }

  return (
    <div className="corner-bracket relative text-emerald-600">
      <span aria-hidden="true" />
      <div className="rounded-md border border-emerald-400 bg-emerald-50/40 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-700">
            implementation summary
          </span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-slate-500">
            {content.split("\n").length} lines
          </span>
        </div>

        <div className="rounded-sm bg-white/80 p-4 ring-1 ring-emerald-200">
          <AssistantMarkdown text={content} />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCommit}
            disabled={commitTriggered}
            className={[
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors duration-150",
              "disabled:cursor-not-allowed disabled:opacity-60",
              commitTriggered
                ? "border-emerald-300 bg-emerald-100 text-emerald-500"
                : "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
            ].join(" ")}
          >
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
              <circle cx="12" cy="12" r="4" />
              <line x1="1.05" y1="12" x2="7" y2="12" />
              <line x1="17" y1="12" x2="22.95" y2="12" />
            </svg>
            {commitTriggered ? "已请求创建" : "创建 commit"}
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-slate-700 transition-colors hover:bg-slate-50"
          >
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
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
}
