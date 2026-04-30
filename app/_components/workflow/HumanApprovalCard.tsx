"use client";

import { useState } from "react";

import type { AwaitingInputPayload } from "@/lib/workflow/types";

type HumanApprovalPayload = Extract<
  AwaitingInputPayload,
  { kind: "human-approval" }
>;

/**
 * Human approval 节点的审批 UI。
 *
 * payload 形态来自 `runHumanNode`：`{ kind: "human-approval", uiKind, prompt, context }`。
 * MVP 只支持 uiKind === "approval"（通过 / 拒绝 + 可选评论）。
 * 后续要做 text-input / multi-choice 在这里 switch uiKind 加分支。
 */
export function HumanApprovalCard({
  payload,
  onSubmit,
}: {
  payload: HumanApprovalPayload;
  onSubmit: (response: { approved: boolean; comment?: string }) => void;
}) {
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submit = (approved: boolean) => {
    if (submitted) return;
    setSubmitted(true);
    onSubmit({ approved, comment: comment.trim() || undefined });
  };

  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-700">
        Awaiting your decision
      </div>

      <div className="mt-3 max-h-80 overflow-auto rounded bg-white p-3 text-[13px] leading-6 text-slate-800">
        <pre className="whitespace-pre-wrap wrap-break-word font-sans">
          {payload.prompt}
        </pre>
        {Object.keys(payload.context).length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12px] text-slate-500 hover:text-slate-700">
              附加上下文（点击展开）
            </summary>
            <pre className="mt-2 whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-slate-600">
              {JSON.stringify(payload.context, null, 2)}
            </pre>
          </details>
        )}
      </div>

      <div className="mt-3">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
            评论（可选）
          </span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={submitted}
            rows={2}
            placeholder="附上评论，agent 后续节点能看到..."
            className="mt-1 w-full rounded border border-slate-300 bg-white p-2 text-[13px] focus:border-slate-900 focus:outline-none disabled:bg-slate-50"
          />
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={submitted}
          className="cursor-pointer rounded-md border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ✓ 通过
        </button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={submitted}
          className="cursor-pointer rounded-md border border-rose-600 bg-white px-4 py-2 text-sm font-medium text-rose-700 transition-colors duration-200 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ✕ 拒绝
        </button>
        {submitted && (
          <span className="self-center text-[12px] text-slate-500">
            已提交，正在执行下一步...
          </span>
        )}
      </div>
    </div>
  );
}
