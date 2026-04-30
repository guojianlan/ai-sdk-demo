"use client";

import Link from "next/link";

import { WORKSPACE_ACCESS_MODE_LABELS } from "@/lib/chat-access-mode";
import {
  formatTimestamp,
  type ChatSession,
  type WorkspaceOption,
} from "@/app/_lib/chat-session";

import { Eyebrow } from "./Eyebrow";

/**
 * 左侧的会话列表 + 工作区统计。
 *
 * 所有交互以回调形式暴露给 Home：`onNewSession` / `onSelectSession`。
 * 自身不持有 state，是一个纯展示 + 事件转发组件。
 */
export function SessionSidebar({
  sessions,
  activeChatId,
  workspaces,
  workspacesLoading,
  workspacesError,
  onNewSession,
  onSelectSession,
}: {
  sessions: ChatSession[];
  activeChatId: string;
  workspaces: WorkspaceOption[];
  workspacesLoading: boolean;
  workspacesError: string;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <aside className="flex max-h-[40vh] w-full shrink-0 flex-col overflow-hidden border-b border-slate-200 bg-white px-5 py-6 xl:max-h-none xl:h-full xl:w-[340px] xl:border-b-0 xl:border-r">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <Eyebrow>Workspace · Agent</Eyebrow>
          <h1 className="mt-2 text-[22px] font-semibold leading-tight tracking-tight text-slate-900">
            Dev Engineer
          </h1>
          <div className="mt-1 font-mono text-[11px] text-slate-500">
            v0 · line-art edition
          </div>
        </div>
        <button
          type="button"
          onClick={onNewSession}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-900 bg-slate-900 px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-white transition-colors duration-200 hover:bg-slate-700"
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
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建
        </button>
      </div>

      <div className="mb-4 rounded-md border border-slate-300 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <Eyebrow>Workspaces</Eyebrow>
          <div className="font-mono text-[11px] text-slate-500">
            {workspacesLoading ? "loading..." : "synced"}
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-3">
          <div className="font-mono text-[40px] font-medium leading-none tabular-nums text-slate-900">
            {workspacesLoading ? "--" : workspaces.length}
          </div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">
            available
          </div>
        </div>
        <div className="mt-3 flex gap-1">
          {Array.from({ length: Math.min(8, Math.max(1, workspaces.length)) }).map(
            (_, idx) => (
              <span
                key={idx}
                className="h-1 flex-1 bg-slate-900"
                aria-hidden="true"
              />
            ),
          )}
          {Array.from({ length: Math.max(0, 8 - workspaces.length) }).map(
            (_, idx) => (
              <span
                key={`empty-${idx}`}
                className="h-1 flex-1 bg-slate-200"
                aria-hidden="true"
              />
            ),
          )}
        </div>
        <p className="mt-3 text-[13px] leading-6 text-slate-600">
          创建会话时绑定工作区，Agent 只在该目录里读文件。
        </p>
        {workspacesError && (
          <div className="mt-3 rounded-sm border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[11px] text-amber-800">
            ! {workspacesError}
          </div>
        )}
      </div>

      <Link
        href="/workflow/bug-fix"
        className="group mb-4 block rounded-md border border-slate-300 bg-white p-4 transition-colors duration-200 hover:border-slate-900 hover:bg-slate-50"
      >
        <div className="flex items-center justify-between">
          <Eyebrow>Workflow</Eyebrow>
          <span className="font-mono text-[10px] text-slate-400 group-hover:text-slate-700">
            beta →
          </span>
        </div>
        <h3 className="mt-2 text-[14px] font-semibold text-slate-900">
          Bug 自动修复
        </h3>
        <p className="mt-1 text-[12px] leading-5 text-slate-600">
          描述 bug → 定位 → 提案 → 你审批 → 落地 → 验证 → 报告
        </p>
      </Link>

      <div className="mb-3 flex items-center justify-between">
        <Eyebrow>Sessions · {sessions.length}</Eyebrow>
        <span className="h-px flex-1 ml-3 bg-slate-200" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
        {sessions.map((session) => {
          const isActive = session.id === activeChatId;

          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
              className={[
                "group relative cursor-pointer rounded-md border bg-white px-4 py-3.5 text-left transition-colors duration-200",
                isActive
                  ? "border-slate-900 border-l-[3px]"
                  : "border-slate-200 hover:border-slate-400",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="truncate text-sm font-medium text-slate-900">
                  {session.title}
                </div>
                <div className="font-mono text-[10px] tabular-nums text-slate-500">
                  {formatTimestamp(session.updatedAt)}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className="inline-flex items-center rounded-sm border border-slate-300 bg-slate-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-600">
                  {session.workspaceName || "no-workspace"}
                </span>
                <span
                  className={[
                    "inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
                    session.workspaceAccessMode === "workspace-tools"
                      ? "border-sky-400 bg-sky-50 text-sky-700"
                      : "border-slate-300 bg-white text-slate-600",
                  ].join(" ")}
                >
                  {WORKSPACE_ACCESS_MODE_LABELS[session.workspaceAccessMode]}
                </span>
                {session.bypassPermissions && (
                  <span className="inline-flex items-center rounded-sm border border-amber-500 bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                    bypass
                  </span>
                )}
              </div>
              <div className="mt-2 line-clamp-2 text-[13px] leading-6 text-slate-600">
                {session.preview || "先选择工作区，再开始提问。"}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
