/**
 * 渲染单个 tool part 的核心状态机。
 *
 * AI SDK v6 的 tool part 有 6 个主要状态，对应完全不同的 UI 意图：
 * - input-streaming       → "工具参数还在流式拼装"（占位）
 * - input-available       → "参数齐全，正在执行"（运行中）
 * - approval-requested    → "需要用户点同意"（蓝色 diff + 两个按钮）
 * - approval-responded    → "用户已响应，等服务端 execute"（过渡态）
 * - output-available      → "执行完成，给结果"（绿色折叠卡片）
 * - output-error          → "执行报错"（红色错误文本）
 *
 * 每个分支返回完全不同的 JSX；不抽公共布局是故意的——这些状态视觉语言差别很大，
 * 强行共用一个 shell 会让每一个分支都塞很多 `if` 判断，反而更难读。
 */

import { renderToolInput } from "./input-views";
import { renderToolOutput, summarizeToolOutput } from "./output-views";
import {
  getToolName,
  type ApprovalHandler,
  type LooseToolPart,
} from "./types";

export function ToolPartCard({
  part,
  onApproval,
}: {
  part: LooseToolPart;
  onApproval: ApprovalHandler;
}) {
  const toolName = getToolName(part);
  const state = part.state ?? "input-streaming";

  if (state === "input-streaming") {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">
          tool · {toolName} · preparing…
        </div>
      </div>
    );
  }

  if (state === "input-available") {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-3">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">
          tool · {toolName} · running…
        </div>
        {renderToolInput(toolName, part.input, "approved")}
      </div>
    );
  }

  if (state === "approval-requested") {
    const approvalId = part.approval?.id;
    const canRespond = Boolean(approvalId);

    return (
      <div className="corner-bracket relative text-sky-600">
        <span aria-hidden="true" />
        <div className="rounded-md border border-sky-400 bg-sky-50/40 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">
              approval requested · {toolName}
            </span>
          </div>
          <div className="text-slate-900">
            {renderToolInput(toolName, part.input, "pending")}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-sky-200 pt-3">
            <button
              type="button"
              disabled={!canRespond}
              onClick={() =>
                canRespond && onApproval({ id: approvalId!, approved: true })
              }
              className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
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
                <path d="M5 12l5 5 9-11" />
              </svg>
              同意执行
            </button>
            <button
              type="button"
              disabled={!canRespond}
              onClick={() =>
                canRespond &&
                onApproval({
                  id: approvalId!,
                  approved: false,
                  reason: "用户在 UI 上拒绝了这次写入。",
                })
              }
              className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-slate-700 transition-colors duration-200 hover:border-rose-400 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
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
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
              拒绝
            </button>
            <span className="ml-auto font-mono text-[10px] text-slate-500">
              id · {approvalId?.slice(0, 8) ?? "--"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (state === "approval-responded") {
    const approved = part.approval?.approved ?? false;

    return (
      <div
        className={[
          "rounded-md border p-3",
          approved
            ? "border-slate-300 bg-slate-50"
            : "border-rose-300 bg-rose-50/60",
        ].join(" ")}
      >
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">
          tool · {toolName} ·{" "}
          {approved ? "approved, awaiting execution…" : "rejected"}
        </div>
        {renderToolInput(toolName, part.input, approved ? "approved" : "pending")}
        {!approved && part.approval?.reason && (
          <div className="mt-2 font-mono text-[11px] text-rose-700">
            reason · {part.approval.reason}
          </div>
        )}
      </div>
    );
  }

  if (state === "output-available") {
    const output = part.output as
      | { ok?: boolean; path?: string; operation?: string; error?: string }
      | undefined;
    const ok = output?.ok !== false;
    const summary = summarizeToolOutput(toolName, output);

    return (
      <details
        className={[
          "group rounded-md border",
          ok
            ? "border-emerald-300 bg-emerald-50/60"
            : "border-rose-300 bg-rose-50/60",
        ].join(" ")}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-rose-500"}`}
            aria-hidden="true"
          />
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-600">
            tool · {toolName} · {ok ? "done" : "failed"}
          </span>
          {summary && (
            <span className="min-w-0 truncate font-mono text-[11px] text-slate-600">
              · {summary}
            </span>
          )}
          <svg
            viewBox="0 0 24 24"
            className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform duration-200 group-open:rotate-90"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </summary>
        <div className="border-t border-slate-200">
          {renderToolOutput(toolName, output)}
        </div>
      </details>
    );
  }

  if (state === "output-error") {
    return (
      <div className="rounded-md border border-rose-300 bg-rose-50/60 p-3">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-rose-700">
          tool · {toolName} · error
        </div>
        <div className="text-[13px] leading-6 text-rose-800">
          {part.errorText ?? "Unknown tool error."}
        </div>
      </div>
    );
  }

  return null;
}
