"use client";

import { useEffect, useState } from "react";

import { renderToolInput } from "./input-views";
import type { LooseToolPart } from "./types";

/**
 * `spawn_agent` 工具在 `input-available` 状态的专属渲染。
 *
 * 解决的问题：spawn_agent 一跑就是 30s-3min，UI 看着像卡死。这张卡显示：
 *   - 实时 elapsed 计时器
 *   - 子任务 message 摘要（前 200 字）
 *   - "subagent 没 UI 反馈"的解释（让用户知道这是设计而不是 bug）
 *
 * elapsed 计时：mount 时记录 startTime，每秒 setInterval 更新 displaySeconds。
 * AI SDK 的 part 对象本身不带 timestamp，所以前端自己开始数。
 *
 * 等到 part 转成 `output-available` 状态时，外层 ToolPartCard 走默认折叠卡分支，
 * 这个组件就不再渲染了——计时器自然停。
 */
export function SpawnAgentRunningCard({ part }: { part: LooseToolPart }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    // 立即渲染 0s 然后每秒 +1。setInterval 在 unmount 时清掉。
    const start = Date.now();
    const id = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const input = part.input as { message?: string; fork_context?: boolean };
  const messagePreview = (input.message ?? "").slice(0, 200);
  const truncated = (input.message ?? "").length > 200;

  // 提示信息：让用户知道为什么 UI 安静（不是 bug）+ 长跑时给点信心
  const hint =
    seconds < 10
      ? "子 agent 在自己的 context 里跑工具调用 —— 工具步骤不进主对话历史，所以这里"
      : seconds < 60
        ? "子 agent 还在干活；通常 30-90s 完成"
        : seconds < 180
          ? "子 agent 跑得有点久了；任务可能涉及大量文件 / shell 命令"
          : "子 agent 跑了超过 3 分钟，要不要停掉重新拆任务？";

  return (
    <div className="rounded-md border border-violet-300 bg-violet-50/40 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-700">
          spawn_agent · running
        </span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-violet-700">
          {formatDuration(seconds)}
        </span>
      </div>

      {messagePreview && (
        <div className="mb-3 rounded-sm border-l-2 border-violet-300 bg-white/70 px-3 py-2 text-[13px] leading-6 text-slate-700">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
            task
          </span>
          {messagePreview}
          {truncated && <span className="text-slate-400"> ...</span>}
        </div>
      )}

      <div className="font-mono text-[11px] leading-5 text-slate-500">
        {hint}
        {seconds < 10 ? <span> 没有实时 step 流</span> : ""}
      </div>

      {/* 完整 input 折叠藏起来，避免视觉过吵 */}
      {input.fork_context !== undefined && (
        <details className="mt-2 group">
          <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
            <span className="group-open:hidden">show input ›</span>
            <span className="hidden group-open:inline">hide input ‹</span>
          </summary>
          <div className="mt-2">
            {renderToolInput("spawn_agent", part.input, "approved")}
          </div>
        </details>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
