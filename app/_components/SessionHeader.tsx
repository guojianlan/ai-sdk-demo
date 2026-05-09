"use client";

import type { ChatStatus } from "ai";

import {
  WORKSPACE_ACCESS_MODE_LABELS,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "@/lib/permissions/mode";
import type { ChatSession } from "@/app/_lib/chat-session";

/**
 * 聊天区顶部那一条紧凑状态栏：
 * 标题 + workspace chip + mode chip + permission-mode chip(可点) + 状态点 + 停止按钮。
 *
 * 一行搞定，信息密度高，不占消息区空间。完整工作区路径藏在标题的
 * `title` 属性里作为 tooltip，需要时悬停看。
 *
 * permission-mode chip 点击循环 default → acceptEdits → bypassPermissions → default。
 * 流式中禁用（避免 mid-step 状态混乱）。
 */

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: "审批：默认",
  acceptEdits: "审批：自动接受写入",
  bypassPermissions: "审批：bypass(危险)",
};

const PERMISSION_MODE_TOOLTIPS: Record<PermissionMode, string> = {
  default:
    "PermissionMode = default —— 每个工具按自己 needsApproval 决定是否弹审批。点击切换。",
  acceptEdits:
    "PermissionMode = acceptEdits —— write/edit 自动过审批，shell 仍按原逻辑。点击切换。",
  bypassPermissions:
    "PermissionMode = bypassPermissions —— 全部自动过；需要 settings.json 写 allowBypassMode=true 才真正生效。点击切换。",
};

const PERMISSION_MODE_STYLES: Record<PermissionMode, string> = {
  default: "border-slate-300 bg-white text-slate-600",
  acceptEdits: "border-emerald-400 bg-emerald-50 text-emerald-700",
  bypassPermissions: "border-rose-500 bg-rose-50 text-rose-700",
};

export function SessionHeader({
  activeSession,
  activeAccessMode,
  status,
  statusLabel,
  onStop,
  onCyclePermissionMode,
  onTogglePlanMode,
  planStepInfo,
  activeSubagentCount,
}: {
  activeSession: ChatSession | undefined;
  activeAccessMode: WorkspaceAccessMode;
  status: ChatStatus;
  statusLabel: string;
  onStop: () => void;
  onCyclePermissionMode: () => void;
  onTogglePlanMode: () => void;
  /**
   * Plan 模式下的实时进度。null = 不显示。
   * 由 page.tsx 从 messages 算出来，避免 SessionHeader 直接接 messages。
   */
  planStepInfo: { toolCallCount: number } | null;
  /** 当前正在跑的 spawn_agent 个数（input-available 状态的 spawn_agent tool part 数）。 */
  activeSubagentCount: number;
}) {
  const isStreaming = status === "streaming" || status === "submitted";
  const permissionMode: PermissionMode =
    activeSession?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const planMode = activeSession?.planMode === true;

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
        {activeSession?.shellApprovalPolicy === "never" && (
          <span
            className="inline-flex items-center gap-1 rounded-sm border border-amber-500 bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700"
            title="Shell 审批策略：never —— 任何 shell 命令直接跑，不弹审批"
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
            shell:never
          </span>
        )}
        {activeSession?.shellApprovalPolicy === "always" && (
          <span
            className="inline-flex items-center gap-1 rounded-sm border border-slate-400 bg-slate-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-700"
            title="Shell 审批策略：always —— 任何 shell 命令都弹审批"
          >
            shell:always
          </span>
        )}
        <button
          type="button"
          onClick={onCyclePermissionMode}
          disabled={!activeSession || isStreaming}
          aria-label="切换 PermissionMode"
          title={PERMISSION_MODE_TOOLTIPS[permissionMode]}
          className={[
            "inline-flex cursor-pointer items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors duration-150",
            "disabled:cursor-not-allowed disabled:opacity-60",
            PERMISSION_MODE_STYLES[permissionMode],
          ].join(" ")}
        >
          {PERMISSION_MODE_LABELS[permissionMode]}
        </button>
        <button
          type="button"
          onClick={onTogglePlanMode}
          disabled={!activeSession || isStreaming}
          aria-label={planMode ? "退出 Plan 模式" : "进入 Plan 模式"}
          aria-pressed={planMode}
          title={
            planMode
              ? "Plan 模式 ON —— agent 只 plan 不动手；write/edit/update_plan 工具被屏蔽。点击退出。"
              : "Plan 模式 OFF —— 点击进入：先讨论方案，agent 输出 <proposed_plan> 块，确认后再切回执行。"
          }
          className={[
            "inline-flex cursor-pointer items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors duration-150",
            "disabled:cursor-not-allowed disabled:opacity-60",
            planMode
              ? "border-violet-500 bg-violet-50 text-violet-700"
              : "border-slate-300 bg-white text-slate-600",
          ].join(" ")}
        >
          {planMode ? "PLAN: ON" : "PLAN: OFF"}
        </button>
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
          {/* plan 模式 + streaming：附加工具调用计数，让用户看到 agent 在干活
              （update_plan 在 plan 模式被屏蔽，没了 plan checkbox 进度信号） */}
          {isStreaming && planMode && planStepInfo && planStepInfo.toolCallCount > 0 && (
            <span className="text-violet-700">
              · 探索 {planStepInfo.toolCallCount} 次
            </span>
          )}
          {/* 活跃 subagent 计数：spawn_agent 跑得久（30s-3min），用户没这个提示
              很容易以为整个对话卡死。即使没在 streaming 也显示——只要还有 subagent
              没结束就提示一下（理论上 streaming 结束 = 所有 spawn_agent 也结束，
              但 UI 状态可能滞后） */}
          {activeSubagentCount > 0 && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-sm border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
              {activeSubagentCount} subagent{activeSubagentCount > 1 ? "s" : ""}
            </span>
          )}
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
