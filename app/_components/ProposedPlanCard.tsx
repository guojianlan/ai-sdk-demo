"use client";

import { useState } from "react";

import { AssistantMarkdown } from "./AssistantMarkdown";

/**
 * Plan 模式 finalize 时 agent 输出 `<proposed_plan>...</proposed_plan>` 块的
 * 专属渲染卡片，对齐 codex TUI 的 plan-implementation popup 体验。
 *
 * 来源：codex `collaboration-mode-templates/templates/plan.md` finalization 段
 * 要求 agent 把最终 plan 包在 `<proposed_plan>` XML 标签里，TUI 就此 parse 出
 * 来渲染特殊卡。我们移植了完整 plan.md prompt，自然要补上前端解析。
 *
 * 三个动作：
 * - **采用此方案**：toggle 出 plan 模式 + 自动发一条 user message 让 agent
 *   按 plan 实施（plan 文本已在对话历史里，不必重发）
 * - **复制**：把 markdown 内容拷到剪贴板
 * - 没有"继续完善"按钮 —— 用户直接在输入框打追问就是 refine，不需要专门入口
 */

export type ProposedPlanCardProps = {
  /** `<proposed_plan>...</proposed_plan>` 标签里 trim 后的 markdown 内容。 */
  content: string;
  /** 用户点"采用此方案"时回调。父组件负责切 plan 模式 + sendMessage。 */
  onAdopt: (content: string) => void;
};

export function ProposedPlanCard({ content, onAdopt }: ProposedPlanCardProps) {
  const [copied, setCopied] = useState(false);
  const [adopted, setAdopted] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard 在不安全 origin / 老浏览器会拒绝；忽略，不弹错——用户能从
      // 卡里直接框选复制兜底。
    }
  }

  function handleAdopt() {
    if (adopted) return;
    setAdopted(true);
    onAdopt(content);
  }

  return (
    <div className="corner-bracket relative text-violet-600">
      <span aria-hidden="true" />
      <div className="rounded-md border border-violet-400 bg-violet-50/40 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-700">
            proposed plan
          </span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-slate-500">
            {content.split("\n").length} lines
          </span>
        </div>

        {/* markdown body —— 复用 assistant markdown 样式以保持一致 */}
        <div className="rounded-sm bg-white/80 p-4 ring-1 ring-violet-200">
          <AssistantMarkdown text={content} />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleAdopt}
            disabled={adopted}
            className={[
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors duration-150",
              "disabled:cursor-not-allowed disabled:opacity-60",
              adopted
                ? "border-violet-300 bg-violet-100 text-violet-500"
                : "border-violet-600 bg-violet-600 text-white hover:bg-violet-700",
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
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {adopted ? "已采用" : "采用此方案"}
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
          <span className="ml-auto font-mono text-[10px] text-slate-500">
            或在输入框继续追问完善
          </span>
        </div>
      </div>
    </div>
  );
}

// 注：之前这里有个 splitOnProposedPlan，已经迁到 ./assistant-blocks.ts 的
// splitOnBlocks（同时支持 <implementation_summary>）。这个文件只负责单卡渲染。
