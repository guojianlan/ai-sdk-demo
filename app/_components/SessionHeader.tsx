"use client";

import type { ChatStatus } from "ai";

import {
  WORKSPACE_ACCESS_MODE_LABELS,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import type { ChatSession } from "@/app/_lib/chat-session";

/**
 * 聊天区顶部那一条紧凑状态栏：
 * 标题 + workspace chip + mode chip + bypass 警告 + 状态点 + 停止按钮。
 *
 * 一行搞定，信息密度高，不占消息区空间。完整工作区路径藏在标题的
 * `title` 属性里作为 tooltip，需要时悬停看。
 */
export function SessionHeader({
  activeSession,
  activeAccessMode,
  status,
  statusLabel,
  onStop,
}: {
  activeSession: ChatSession | undefined;
  activeAccessMode: WorkspaceAccessMode;
  status: ChatStatus;
  statusLabel: string;
  onStop: () => void;
}) {
  const isStreaming = status === "streaming" || status === "submitted";

  return (
    <header className="mb-4 flex shrink-0 items-center gap-3 border-b border-slate-200 pb-4">
      <h2
        className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-slate-900"
        title={
          activeSession?.workspaceRoot
            ? `${activeSession.title} · ${activeSession.workspaceRoot}`
            : activeSession?.title
        }
      >
        {activeSession?.title ?? "新对话"}
      </h2>

      <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
        <span className="inline-flex items-center rounded-sm border border-slate-300 bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">
          {activeSession?.workspaceName || "no-workspace"}
        </span>
        <span
          className={[
            "inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
            activeAccessMode === "workspace-tools"
              ? "border-sky-400 bg-sky-50 text-sky-700"
              : "border-slate-300 bg-white text-slate-600",
          ].join(" ")}
        >
          {WORKSPACE_ACCESS_MODE_LABELS[activeAccessMode]}
        </span>
        {activeSession?.bypassPermissions && (
          <span
            className="inline-flex items-center gap-1 rounded-sm border border-amber-500 bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700"
            title="已开启 bypass permissions：所有写入会自动执行，不再弹确认卡"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            bypass
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
          <span
            className={[
              "h-1.5 w-1.5 rounded-full",
              isStreaming
                ? "animate-pulse bg-sky-500"
                : status === "error"
                  ? "bg-rose-500"
                  : "bg-emerald-500",
            ].join(" ")}
            aria-hidden="true"
          />
          {statusLabel}
        </span>
        {isStreaming && (
          <button
            type="button"
            onClick={onStop}
            aria-label="停止"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-900 bg-white px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-slate-900 transition-colors duration-200 hover:bg-slate-900 hover:text-white"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-2.5 w-2.5"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="6" y="6" width="12" height="12" />
            </svg>
            停止
          </button>
        )}
      </div>
    </header>
  );
}
