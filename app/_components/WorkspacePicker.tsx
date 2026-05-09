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
// 直接 import 单文件，绕开 `@/lib/tools` barrel——后者会拉到 spawn-agent.ts →
// sub-agent.ts → devtools (node:fs)，client bundle 编译会挂。
import {
  DEFAULT_SHELL_APPROVAL_POLICY,
  SHELL_APPROVAL_POLICIES,
  type ShellApprovalPolicy,
} from "@/lib/tools/shell-approval";
import type { WorkspaceOption } from "@/app/_lib/chat-session";

import { Eyebrow } from "./Eyebrow";

/**
 * 新建会话时的工作区 / 访问模式 / shell 审批策略选择器（modal 形式）。
 *
 * 表单的本地 state 完全内聚在这个组件里；Home 只负责传 `workspaces` 和响应 `onSubmit`。
 *
 * 重置策略：**不写 reset useEffect**。Home 用条件渲染 `{open && <WorkspacePicker ... />}`
 * 控制显示，每次打开都是一次全新 mount，useState 的 lazy initializer 自然跑一遍，
 * 回到默认值 + 自动选中第一个候选工作区。这样避开了 react-hooks/set-state-in-effect 警告。
 */

const SHELL_POLICY_LABELS: Record<ShellApprovalPolicy, string> = {
  never: "Never · 全部直接跑",
  untrusted: "Untrusted · 仅未知命令弹审批（默认）",
  always: "Always · 任何命令都弹审批",
};

const SHELL_POLICY_DESCRIPTIONS: Record<ShellApprovalPolicy, string> = {
  never:
    "任何 shell 命令直接跑、不弹审批。适合无人值守 / 自动化脚本场景，*不要*用于生产 demo。",
  untrusted:
    "已知安全的只读命令（ls / cat / git status / git diff / grep 等）直接跑；其它命令（包括 npm run、git push、curl 等）需要你点同意才执行。",
  always:
    "每条 shell 命令都弹卡让你点同意。最保守，agent 跑得很慢但完全可控。",
};

export type WorkspacePickerSubmit = {
  workspace: WorkspaceOption;
  workspaceAccessMode: WorkspaceAccessMode;
  shellApprovalPolicy: ShellApprovalPolicy;
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
  const [selectedShellPolicy, setSelectedShellPolicy] =
    useState<ShellApprovalPolicy>(DEFAULT_SHELL_APPROVAL_POLICY);

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
      shellApprovalPolicy: selectedShellPolicy,
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

            <label className="block">
              <div className="mb-2 flex items-center gap-2">
                <Eyebrow>04 · Shell 审批策略</Eyebrow>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
              <select
                value={selectedShellPolicy}
                onChange={(event) =>
                  setSelectedShellPolicy(
                    event.currentTarget.value as ShellApprovalPolicy,
                  )
                }
                disabled={selectedAccessMode !== "workspace-tools"}
                className="w-full cursor-pointer rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition-colors duration-200 focus:border-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
              >
                {SHELL_APPROVAL_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {SHELL_POLICY_LABELS[policy]}
                  </option>
                ))}
              </select>
              <div className="mt-2 text-[12px] leading-6 text-slate-500">
                {SHELL_POLICY_DESCRIPTIONS[selectedShellPolicy]}
              </div>
              {selectedAccessMode !== "workspace-tools" && (
                <div className="mt-1 text-[12px] leading-5 text-slate-400">
                  no-tools 模式下没有 shell 工具，这个策略不生效。
                </div>
              )}
            </label>

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
                  selectedShellPolicy === "never"
                    ? "text-amber-700"
                    : "text-slate-500",
                ].join(" ")}
              >
                shell · {SHELL_POLICY_LABELS[selectedShellPolicy]}
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
