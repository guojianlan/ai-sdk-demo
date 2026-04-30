"use client";

import { useState } from "react";

/**
 * agent loop 中模型要调用一个 approvedTool（如 write_file / edit_file / run_lint）
 * 且节点未开 bypassPermissions —— 渲染审批卡，等用户决定。
 *
 * 通过 → runner 调 /api/agent/tool 真正执行；
 * 拒绝 → tool result 标 execution-denied，agent 看到后自行选择下一步。
 */
export function AgentToolApprovalCard({
  toolCallId,
  toolName,
  input,
  stepCount,
  onDecide,
}: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  stepCount: number;
  onDecide: (toolCallId: string, approved: boolean) => void;
}) {
  const [decided, setDecided] = useState(false);

  const handle = (approved: boolean) => {
    if (decided) return;
    setDecided(true);
    onDecide(toolCallId, approved);
  };

  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-700">
          Approval needed · step {stepCount}
        </div>
        <code className="rounded bg-amber-100 px-2 py-0.5 font-mono text-[11px] text-amber-900">
          {toolName}
        </code>
      </div>

      <p className="mt-2 text-[13px] text-slate-700">
        Agent 想调用 <strong>{toolName}</strong>，下面是它打算传的参数：
      </p>

      <div className="mt-3 max-h-80 overflow-auto rounded bg-white p-3 font-mono text-[12px] leading-5 text-slate-800">
        <pre className="whitespace-pre-wrap wrap-break-word">
          {JSON.stringify(input, null, 2)}
        </pre>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => handle(true)}
          disabled={decided}
          className="cursor-pointer rounded-md border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ✓ 通过并执行
        </button>
        <button
          type="button"
          onClick={() => handle(false)}
          disabled={decided}
          className="cursor-pointer rounded-md border border-rose-600 bg-white px-4 py-2 text-sm font-medium text-rose-700 transition-colors duration-200 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ✕ 拒绝
        </button>
        {decided && (
          <span className="self-center text-[12px] text-slate-500">
            已提交，正在继续...
          </span>
        )}
      </div>

      <p className="mt-2 font-mono text-[10px] text-slate-500">
        toolCallId: {toolCallId}
      </p>
    </div>
  );
}
