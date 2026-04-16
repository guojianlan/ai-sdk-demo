"use client";

import { FormEvent, useState } from "react";

import {
  DEFAULT_WORKSPACE_ACCESS_MODE,
  WORKSPACE_ACCESS_MODES,
  WORKSPACE_ACCESS_MODE_DESCRIPTIONS,
  WORKSPACE_ACCESS_MODE_LABELS,
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import type { WorkspaceOption } from "@/app/_lib/chat-session";

import { Eyebrow } from "./Eyebrow";

/**
 * 新建会话时的工作区/访问模式/bypass 选择器（modal 形式）。
 *
 * 表单的本地 state（当前选中的工作区、自定义路径、访问模式、是否 bypass）
 * 完全内聚在这个组件里；Home 只负责传 `workspaces` 和响应 `onSubmit`。
 *
 * 重置策略：**不写 reset useEffect**。Home 用条件渲染 `{open && <WorkspacePicker ... />}`
 * 控制显示，每次打开都是一次全新 mount，useState 的 lazy initializer 自然跑一遍，
 * 回到默认值 + 自动选中第一个候选工作区。这样避开了 react-hooks/set-state-in-effect 警告。
 */

export type WorkspacePickerSubmit = {
  workspace: WorkspaceOption;
  workspaceAccessMode: WorkspaceAccessMode;
  bypassPermissions: boolean;
};

function getPathLabel(root: string): string {
  const normalized = root.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function WorkspacePicker({
  workspaces,
  onClose,
  onSubmit,
}: {
  workspaces: WorkspaceOption[];
  onClose: () => void;
  onSubmit: (payload: WorkspacePickerSubmit) => void;
}) {
  // Lazy init：每次 mount（= 每次打开 modal）从当前 workspaces 里挑第一个作为默认选中。
  const [selectedWorkspaceRoot, setSelectedWorkspaceRoot] = useState(
    () => workspaces[0]?.root ?? "",
  );
  const [customWorkspaceRoot, setCustomWorkspaceRoot] = useState("");
  const [selectedAccessMode, setSelectedAccessMode] =
    useState<WorkspaceAccessMode>(DEFAULT_WORKSPACE_ACCESS_MODE);
  const [selectedBypassPermissions, setSelectedBypassPermissions] =
    useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const customRoot = customWorkspaceRoot.trim();
    const chosenRoot = customRoot || selectedWorkspaceRoot;

    if (!chosenRoot) {
      return;
    }

    const matchedWorkspace = workspaces.find(
      (workspace) => workspace.root === chosenRoot,
    );
    const workspace = matchedWorkspace ?? {
      root: chosenRoot,
      name: getPathLabel(chosenRoot),
      description: chosenRoot,
      isCurrentProject: false,
    };

    onSubmit({
      workspace,
      workspaceAccessMode: selectedAccessMode,
      bypassPermissions: selectedBypassPermissions,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-[2px] sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="picker-title"
    >
      <div className="corner-bracket relative my-auto w-full max-w-xl text-slate-900">
        <span aria-hidden="true" />
        <div className="max-h-[calc(100vh-2rem)] overflow-y-auto rounded-md border border-slate-900 bg-white p-6 sm:p-7">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <Eyebrow>New · Session</Eyebrow>
              <h3
                id="picker-title"
                className="mt-2 text-2xl font-semibold tracking-tight text-slate-900"
              >
                选择工作区
              </h3>
              <p className="mt-2 text-[13px] leading-6 text-slate-600">
                新建对话时绑定一个工作区。后端 Agent 会把这个目录作为可读取项目范围。
              </p>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 transition-colors duration-200 hover:border-slate-900 hover:text-slate-900"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-5">
            <label className="block">
              <div className="mb-2 flex items-center gap-2">
                <Eyebrow>01 · 候选工作区</Eyebrow>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
              <select
                value={selectedWorkspaceRoot}
                onChange={(event) =>
                  setSelectedWorkspaceRoot(event.currentTarget.value)
                }
                className="w-full cursor-pointer rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition-colors duration-200 focus:border-slate-900"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.root} value={workspace.root}>
                    {workspace.name}
                    {workspace.isCurrentProject ? "（当前项目）" : ""}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <Eyebrow>02 · 自定义路径</Eyebrow>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
              <input
                value={customWorkspaceRoot}
                onChange={(event) =>
                  setCustomWorkspaceRoot(event.currentTarget.value)
                }
                placeholder="/absolute/path/to/workspace"
                className="w-full rounded-md border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-[13px] text-slate-900 outline-none transition-colors duration-200 placeholder:text-slate-400 focus:border-slate-900"
              />
              <div className="mt-2 text-[12px] leading-6 text-slate-500">
                可以输入绝对路径；如果输入相对路径，后端会按默认工作区根目录去解析。
              </div>
            </div>

            <label className="block">
              <div className="mb-2 flex items-center gap-2">
                <Eyebrow>03 · 访问模式</Eyebrow>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
              <select
                value={selectedAccessMode}
                onChange={(event) =>
                  setSelectedAccessMode(
                    normalizeWorkspaceAccessMode(event.currentTarget.value),
                  )
                }
                className="w-full cursor-pointer rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition-colors duration-200 focus:border-slate-900"
              >
                {WORKSPACE_ACCESS_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {WORKSPACE_ACCESS_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
              <div className="mt-2 text-[12px] leading-6 text-slate-500">
                {WORKSPACE_ACCESS_MODE_DESCRIPTIONS[selectedAccessMode]}
              </div>
            </label>

            <div>
              <div className="mb-2 flex items-center gap-2">
                <Eyebrow>04 · 批准策略</Eyebrow>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
              <label
                className={[
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3.5 transition-colors duration-200",
                  selectedBypassPermissions
                    ? "border-amber-500 bg-amber-50"
                    : "border-slate-300 bg-white hover:border-slate-900",
                ].join(" ")}
              >
                <input
                  type="checkbox"
                  checked={selectedBypassPermissions}
                  onChange={(event) =>
                    setSelectedBypassPermissions(event.currentTarget.checked)
                  }
                  disabled={selectedAccessMode !== "workspace-tools"}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                      bypass permissions
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                      危险
                    </span>
                  </div>
                  <div className="mt-1 text-[13px] leading-6 text-slate-700">
                    自动批准本会话内所有写入。Agent 改文件时不再弹确认卡片，直接落盘。
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-slate-500">
                    仅在 access mode 是{" "}
                    <span className="font-mono">workspace-tools</span>{" "}
                    时可用（no-tools 模式下根本没有写入工具，这个开关没意义）。
                  </div>
                </div>
              </label>
            </div>

            <div className="rounded-md border border-slate-300 bg-slate-50 px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
                Preview
              </div>
              <div className="mt-1 break-all font-mono text-[12px] leading-6 text-slate-700">
                {customWorkspaceRoot.trim()
                  ? `→ ${customWorkspaceRoot.trim()}`
                  : selectedWorkspaceRoot
                    ? `→ ${selectedWorkspaceRoot}`
                    : "→ 请选择一个工作区"}
              </div>
              <div className="mt-1 font-mono text-[12px] text-slate-700">
                mode · {WORKSPACE_ACCESS_MODE_LABELS[selectedAccessMode]}
              </div>
              <div
                className={[
                  "mt-1 font-mono text-[12px]",
                  selectedBypassPermissions ? "text-amber-700" : "text-slate-500",
                ].join(" ")}
              >
                approval ·{" "}
                {selectedBypassPermissions
                  ? "bypass（自动执行，不弹确认）"
                  : "required（每次写入都弹确认）"}
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors duration-200 hover:border-slate-900 hover:text-slate-900"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={!customWorkspaceRoot.trim() && !selectedWorkspaceRoot}
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
              >
                创建并进入
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
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
