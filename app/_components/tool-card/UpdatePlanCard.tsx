"use client";

import type { PlanEntryStatus } from "@/lib/tools";

import type { LooseToolPart } from "./types";

/**
 * `update_plan` 的内联渲染。
 *
 * 设计要点：
 * - plan state 活在 `part.input`（AI SDK 会在 tool-call streaming 阶段陆续补全这个字段）；
 *   流式期间（input-streaming）可能拿不全，做了宽容解析：缺字段时退回占位
 * - 三种 status 各有视觉语义（pending 灰 / in_progress 蓝 / completed 绿）
 * - 顶部有一条 progress bar，肉眼一扫就知道 "3/7 completed"
 * - 贴合项目 wireframe 美学：1px 边、mono label、sky-500 accent、方括号标签
 *
 * Schema 兼容：
 * - **新 schema (codex 风格)**：`{ explanation?: string, plan: [{ step, status }] }`
 * - **旧 schema (todo_write)**：`{ goal?, steps: [{ id?, title, status, note? }] }`
 *   旧 SQLite 里的 todo_write 快照可能还带 `done` / `blocked` / `skipped` 老 status
 *   字段，`resolveStatusConfig` 把这些映射到三态视觉，避免老消息渲染崩。
 */

type LegacyEntry = {
  step?: string;
  title?: string;
  status?: string;
  note?: string;
  id?: string;
};

type UpdatePlanInputShape = {
  // 新 schema
  explanation?: string;
  plan?: LegacyEntry[];
  // 旧 schema 兼容
  goal?: string;
  steps?: LegacyEntry[];
};

type StatusVisual = {
  label: string;
  bullet: string;
  bulletClass: string;
  textClass: string;
};

const STATUS_CONFIG: Record<PlanEntryStatus, StatusVisual> = {
  pending: {
    label: "pending",
    bullet: "○",
    bulletClass: "text-slate-400",
    textClass: "text-slate-700",
  },
  in_progress: {
    label: "doing",
    bullet: "●",
    bulletClass: "text-sky-600 animate-pulse",
    textClass: "text-slate-900 font-medium",
  },
  completed: {
    label: "done",
    bullet: "✓",
    bulletClass: "text-emerald-600",
    textClass: "text-slate-500 line-through decoration-slate-300",
  },
};

/** 把任意（可能含历史值）的 status 字符串映射到当前 3 态。 */
function resolveStatusConfig(status: string | undefined): StatusVisual {
  if (!status) return STATUS_CONFIG.pending;
  if (status in STATUS_CONFIG) {
    return STATUS_CONFIG[status as PlanEntryStatus];
  }
  // legacy 兼容：done → completed；blocked / skipped 没有对应视觉，统一回到 pending
  // 灰色，让旧对话不会因为缺渲染分支炸掉。
  if (status === "done") return STATUS_CONFIG.completed;
  return STATUS_CONFIG.pending;
}

function isCompletedStatus(status: string | undefined): boolean {
  return status === "completed" || status === "done";
}

/** 取每条目的标题：新 schema `step` 优先，老 schema 退回 `title`。 */
function entryText(entry: LegacyEntry): string {
  return (entry.step ?? entry.title ?? "").trim();
}

export function UpdatePlanCard({ part }: { part: LooseToolPart }) {
  const input = (part.input ?? {}) as UpdatePlanInputShape;

  // 新 `plan` 优先，缺则回落老 `steps`（兼容历史 todo_write 快照）
  const entries = Array.isArray(input.plan)
    ? input.plan
    : Array.isArray(input.steps)
      ? input.steps
      : [];

  // 新 schema 没 goal 字段，但兼容老消息——存在则展示
  const goal = input.goal?.trim() ?? "";
  const explanation = input.explanation?.trim() ?? "";

  const total = entries.length;
  const completedCount = entries.filter((s) => isCompletedStatus(s.status))
    .length;
  const hasInProgress = entries.some((s) => s.status === "in_progress");
  const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  const state = part.state ?? "input-streaming";
  const isStreaming = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available" || state === "output-error";

  return (
    <div className="corner-bracket relative text-sky-600">
      <span aria-hidden="true" />
      <div className="rounded-md border border-sky-400 bg-sky-50/30 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span
            className={[
              "h-1.5 w-1.5 rounded-full",
              hasInProgress ? "animate-pulse bg-sky-500" : "bg-slate-400",
            ].join(" ")}
          />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">
            plan · update_plan
            {isStreaming && !isDone ? " · live" : ""}
          </span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-slate-600">
            {completedCount} / {total} done
          </span>
        </div>

        {goal && (
          <div className="mb-3 text-[14px] leading-6 text-slate-900">
            <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
              goal
            </span>
            {goal}
          </div>
        )}

        {explanation && (
          <div className="mb-3 font-mono text-[11px] leading-5 text-slate-600">
            <span className="mr-2 uppercase tracking-[0.18em] text-slate-500">
              note
            </span>
            {explanation}
          </div>
        )}

        {total > 0 && (
          <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-sky-500 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        <ol className="space-y-1.5">
          {entries.map((entry, idx) => {
            const cfg = resolveStatusConfig(entry.status);
            const isCompleted = isCompletedStatus(entry.status);
            const text = entryText(entry);
            return (
              <li
                key={entry.id || `step-${idx}`}
                className="flex items-start gap-3 rounded-sm px-1 py-0.5"
              >
                <span
                  className={[
                    "mt-0.5 w-4 shrink-0 text-center font-mono text-[13px]",
                    cfg.bulletClass,
                  ].join(" ")}
                  aria-hidden="true"
                >
                  {cfg.bullet}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={[
                      "text-[13.5px] leading-6",
                      cfg.textClass,
                    ].join(" ")}
                  >
                    {text || <em className="text-slate-400">(untitled)</em>}
                  </div>
                  {entry.note && (
                    <div className="mt-0.5 font-mono text-[11px] leading-5 text-slate-500">
                      → {entry.note}
                    </div>
                  )}
                </div>
                <span
                  className={[
                    "shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]",
                    entry.status === "in_progress"
                      ? "border-sky-500 bg-white text-sky-700"
                      : isCompleted
                        ? "border-emerald-500 bg-white text-emerald-700"
                        : "border-slate-300 bg-white text-slate-500",
                  ].join(" ")}
                >
                  {cfg.label}
                </span>
              </li>
            );
          })}
          {entries.length === 0 && (
            <li className="font-mono text-[11px] text-slate-500">
              (plan streaming…)
            </li>
          )}
        </ol>
      </div>
    </div>
  );
}
