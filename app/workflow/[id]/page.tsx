"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { Eyebrow } from "@/app/_components/Eyebrow";
import { NodeCard } from "@/app/_components/workflow/NodeCard";
import { sanitizeSessions, STORAGE_KEY } from "@/app/_lib/chat-session";
import { useWorkflowRunner } from "@/lib/workflow/runner";
import type { WorkflowDefinition } from "@/lib/workflow/types";

/**
 * 工作流运行页 /workflow/[id]
 *
 * 流程：
 * 1. 拉 GET /api/workflow/[id] 拿定义
 * 2. 从 localStorage 读最近一次会话的 workspace 信息（不再单独做 picker，
 *    用户先去 / 主页选过就够了；MVP 不做 workspace inline 选择）
 * 3. 用户填 bugReport → 点击"开始" → useWorkflowRunner 顺序推进节点
 * 4. 节点卡片实时渲染当前状态
 *
 * MVP 局限：
 * - 没选过工作区直接打开本页：提示去主页先选；不做 inline picker
 * - 中断 / 暂停 / 重跑：只暴露 "abort"，没有"重跑某个节点"
 * - 输入只支持 bug-fix 工作流（直接 hard-code bugReport 字段）；后续要做通用
 *   schema-driven 表单
 */

type WorkspaceInfo = {
  root: string;
  name: string;
};

/**
 * useSyncExternalStore 的 snapshot 必须是**引用稳定**的：每次 React 调它都
 * 比较返回值，引用变了就重渲染。如果直接返回 `{ root, name }` 字面量，每次
 * 都是新对象 → 无限重渲染。
 *
 * 解法：缓存 localStorage 原文 + 对应解出来的对象。原文不变就复用同一个引用。
 */
let cachedRaw: string | null = null;
let cachedSnapshot: WorkspaceInfo | null = null;

function readLatestWorkspaceSnapshot(): WorkspaceInfo | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === cachedRaw) {
    return cachedSnapshot;
  }
  cachedRaw = raw;
  cachedSnapshot = parseWorkspaceFromRaw(raw);
  return cachedSnapshot;
}

function parseWorkspaceFromRaw(raw: string | null): WorkspaceInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    const sessions = sanitizeSessions(parsed.sessions);
    const latest = sessions
      .filter((s) => s.workspaceRoot)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!latest) return null;
    return { root: latest.workspaceRoot, name: latest.workspaceName };
  } catch {
    return null;
  }
}

/**
 * subscribe：localStorage 跨 tab 同步走 'storage' 事件。订阅它，别的 tab
 * 改了 sessions 我们这里也能即时拿到——不强需求，但白送，没理由不订。
 */
function subscribeWorkspace(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

const SSR_SNAPSHOT = () => null;

function useLatestWorkspace(): WorkspaceInfo | null {
  return useSyncExternalStore<WorkspaceInfo | null>(
    subscribeWorkspace,
    readLatestWorkspaceSnapshot,
    SSR_SNAPSHOT,
  );
}

export default function WorkflowPage() {
  const params = useParams<{ id: string }>();
  const workflowId = params?.id;

  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const workspace = useLatestWorkspace();
  const [bugReport, setBugReport] = useState("");

  // 加载工作流定义
  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    fetch(`/api/workflow/${workflowId}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as WorkflowDefinition;
      })
      .then((wf) => {
        if (!cancelled) setWorkflow(wf);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  return (
    <div className="mx-auto min-h-screen max-w-4xl px-6 py-10">
      <header className="mb-8">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500 hover:text-slate-900"
          >
            ← 返回主页
          </Link>
          <span className="h-px flex-1 bg-slate-200" />
        </div>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900">
          {workflow?.label ?? "加载中..."}
        </h1>
        {workflow?.description && (
          <p className="mt-2 text-[14px] leading-7 text-slate-600">
            {workflow.description}
          </p>
        )}
      </header>

      {loadError && (
        <div className="mb-6 rounded border border-rose-200 bg-rose-50 p-4 text-[13px] text-rose-700">
          加载工作流失败：{loadError}
        </div>
      )}

      {!workspace && (
        <div className="mb-6 rounded border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-800">
          还没选过工作区。请先去{" "}
          <Link href="/" className="underline hover:text-amber-900">
            主页
          </Link>{" "}
          选一个工作区，再回到本页。
        </div>
      )}

      {workflow && workspace && (
        <WorkflowContent
          workflow={workflow}
          workspace={workspace}
          bugReport={bugReport}
          setBugReport={setBugReport}
        />
      )}
    </div>
  );
}

function WorkflowContent({
  workflow,
  workspace,
  bugReport,
  setBugReport,
}: {
  workflow: WorkflowDefinition;
  workspace: WorkspaceInfo;
  bugReport: string;
  setBugReport: (v: string) => void;
}) {
  const {
    state,
    start,
    submitHumanResponse,
    submitToolApproval,
    submitToolResult,
    resumeStep,
    setStepByStep,
    abort,
  } = useWorkflowRunner({
    workflow,
    workspaceRoot: workspace.root,
    workspaceName: workspace.name,
  });

  const overallStatus = useMemo(() => {
    switch (state.status) {
      case "idle":
        return { label: "待启动", color: "bg-slate-100 text-slate-600" };
      case "running":
        return { label: "执行中", color: "bg-blue-100 text-blue-700" };
      case "awaiting-input":
        return { label: "等你审批", color: "bg-amber-100 text-amber-700" };
      case "done":
        return { label: "完成", color: "bg-emerald-100 text-emerald-700" };
      case "rejected":
        return { label: "已拒绝", color: "bg-rose-100 text-rose-700" };
      case "error":
        return { label: "失败", color: "bg-rose-100 text-rose-700" };
    }
  }, [state.status]);

  const completedCount = workflow.nodes.filter(
    (n) => state.nodeStates[n.id]?.status === "done",
  ).length;

  return (
    <>
      {/* 工作区 + 状态 */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 bg-slate-50 p-4">
        <div>
          <Eyebrow>Workspace</Eyebrow>
          <p className="mt-1 font-mono text-[12px] text-slate-700">
            {workspace.name}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={state.stepByStep}
              onChange={(e) => setStepByStep(e.target.checked)}
              className="h-4 w-4 cursor-pointer accent-slate-900"
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-700">
              逐步执行
            </span>
          </label>
          <div className="text-right">
            <Eyebrow>Progress</Eyebrow>
            <p className="mt-1 text-[13px] text-slate-700">
              <span
                className={`mr-2 inline-block rounded px-2 py-0.5 text-[11px] ${overallStatus.color}`}
              >
                {overallStatus.label}
              </span>
              {completedCount} / {workflow.nodes.length} 节点完成
            </p>
          </div>
        </div>
      </div>

      {/* 输入表单 */}
      {state.status === "idle" && (
        <div className="mb-8 rounded-md border border-slate-200 bg-white p-6">
          <Eyebrow>01 · Bug 描述</Eyebrow>
          <h2 className="mt-2 text-lg font-semibold text-slate-900">
            描述你遇到的 bug
          </h2>
          <p className="mt-1 text-[13px] text-slate-600">
            越具体越好——症状、复现路径、期望行为。Agent
            会基于这段描述定位、提案修复方案。
          </p>
          <textarea
            value={bugReport}
            onChange={(e) => setBugReport(e.target.value)}
            rows={5}
            placeholder="例：app/page.tsx 里的「发送」按钮点击没反应，控制台无报错。期望是发送消息到 /api/chat..."
            className="mt-4 w-full rounded border border-slate-300 bg-white p-3 text-[14px] focus:border-slate-900 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => start({ bugReport: bugReport.trim() })}
            disabled={bugReport.trim().length < 10}
            className="mt-4 cursor-pointer rounded-md border border-slate-900 bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ▶ 启动工作流
          </button>
          {bugReport.trim().length > 0 && bugReport.trim().length < 10 && (
            <p className="mt-2 text-[12px] text-amber-700">
              描述太短，至少 10 个字符。
            </p>
          )}
        </div>
      )}

      {/* 错误横幅 */}
      {state.error && (
        <div className="mb-6 rounded border border-rose-200 bg-rose-50 p-4 text-[13px] text-rose-700">
          <strong>工作流错误：</strong> {state.error}
        </div>
      )}

      {/* 中断按钮（运行中显示） */}
      {(state.status === "running" || state.status === "awaiting-input") && (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={abort}
            className="cursor-pointer rounded border border-slate-300 bg-white px-3 py-1.5 text-[12px] text-slate-700 hover:border-rose-400 hover:text-rose-700"
          >
            中断工作流
          </button>
        </div>
      )}

      {/* 节点列表 */}
      {state.status !== "idle" && (
        <div className="space-y-4">
          {workflow.nodes.map((node, idx) => (
            <NodeCard
              key={node.id}
              node={node}
              state={
                state.nodeStates[node.id] ?? { status: "pending" }
              }
              index={idx}
              onSubmitHumanResponse={submitHumanResponse}
              onSubmitToolApproval={submitToolApproval}
              onSubmitToolResult={submitToolResult}
              onResumeStep={resumeStep}
            />
          ))}
        </div>
      )}

      {/* 完成 / 重新开始按钮 */}
      {(state.status === "done" ||
        state.status === "rejected" ||
        state.status === "error") && (
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="cursor-pointer rounded-md border border-slate-300 bg-white px-5 py-2 text-sm text-slate-700 hover:border-slate-900 hover:bg-slate-50"
          >
            ↻ 重新开始
          </button>
        </div>
      )}
    </>
  );
}
