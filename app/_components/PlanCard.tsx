"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import { useEffect, useState } from "react";

import { planSchema, type Plan } from "@/lib/plan-schema";

import { Eyebrow } from "./Eyebrow";

export type PlanCardProps = {
  task: string;
  workspaceName?: string;
  workspaceRoot?: string;
  onAccept: (plan: Plan, markdown: string) => void;
  onDiscard: () => void;
};

const RISK_STYLES: Record<string, string> = {
  low: "border-emerald-400 bg-emerald-50 text-emerald-700",
  medium: "border-amber-400 bg-amber-50 text-amber-700",
  high: "border-rose-400 bg-rose-50 text-rose-700",
};

type EditableStep = {
  title: string;
  reason: string;
  filesToTouch: string[];
  risk: "low" | "medium" | "high";
  checked: boolean;
};

function planToMarkdown(
  task: string,
  steps: EditableStep[],
  overview: string,
): string {
  const checked = steps.filter((s) => s.checked);
  const lines: string[] = [
    `（已确认的执行计划，请按下列步骤执行这个任务）`,
    ``,
    `**任务**：${task}`,
    ``,
    `**概述**：${overview}`,
    ``,
    `**步骤**：`,
  ];
  checked.forEach((step, idx) => {
    lines.push(
      `${idx + 1}. **${step.title}** _(risk: ${step.risk})_ — ${step.reason}`,
    );
    if (step.filesToTouch.length > 0) {
      lines.push(`   - files: ${step.filesToTouch.join(", ")}`);
    }
  });
  return lines.join("\n");
}

/**
 * 把 streaming 的 partial step 合并到 editableSteps。
 * streaming 期间新 step 到来时追加；已有 step 的新字段更新但不覆盖用户的编辑。
 */
function mergeStreamingSteps(
  existing: EditableStep[],
  incoming: Array<Partial<{
    title: string;
    reason: string;
    filesToTouch: string[];
    risk: "low" | "medium" | "high";
  }>>,
): EditableStep[] {
  const result = [...existing];
  for (let i = 0; i < incoming.length; i++) {
    const src = incoming[i];
    if (!src) continue;
    if (i < result.length) {
      // streaming 阶段模型会先吐半句，再逐步补全同一个字段；
      // 因此这里要用"最新片段覆盖旧片段"，否则标题/原因会永远停在首个半成品。
      //
      // 用户编辑只发生在 done=true 之后，此时不会再有新的 streaming 更新，
      // 所以这里直接覆盖是安全的，不会把用户输入冲掉。
      const cur = result[i];
      result[i] = {
        ...cur,
        title: src.title ?? cur.title,
        reason: src.reason ?? cur.reason,
        filesToTouch: src.filesToTouch ?? cur.filesToTouch,
        risk: src.risk ?? cur.risk,
      };
    } else {
      // 新 step：追加。
      result.push({
        title: src.title ?? "",
        reason: src.reason ?? "",
        filesToTouch: src.filesToTouch ?? [],
        risk: src.risk ?? "low",
        checked: true,
      });
    }
  }
  return result;
}

export function PlanCard({
  task,
  workspaceName,
  workspaceRoot,
  onAccept,
  onDiscard,
}: PlanCardProps) {
  const { object, submit, isLoading, stop, error } = useObject({
    api: "/api/plan",
    schema: planSchema,
  });

  useEffect(() => {
    submit({ task, workspaceName, workspaceRoot });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const partial = object as Partial<Plan> | undefined;

  // 可编辑 state：streaming 到一步就追加一步，完成后完全可编辑。
  const [overview, setOverview] = useState("");
  const [steps, setSteps] = useState<EditableStep[]>([]);

  // streaming 期间持续用"最新 partial"刷新 overview / steps。
  // 不能只盯 steps.length，因为同一步里的 title/reason 会在数组长度不变时不断补全。
  useEffect(() => {
    if (partial?.overview) {
      setOverview(partial.overview);
    }
    if (partial?.steps) {
      setSteps((prev) =>
        mergeStreamingSteps(prev, partial.steps as Array<Partial<EditableStep>>),
      );
    }
  }, [partial]);

  const done = !isLoading && !error;
  const checkedCount = steps.filter((s) => s.checked).length;
  const canAccept = done && checkedCount > 0 && overview.trim().length > 0;

  function toggleStep(idx: number) {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, checked: !s.checked } : s)),
    );
  }

  function updateStep(idx: number, field: "title" | "reason", value: string) {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)),
    );
  }

  function handleAccept() {
    if (!canAccept) return;
    const plan: Plan = {
      overview,
      steps: steps
        .filter((s) => s.checked)
        .map(({ title, reason, filesToTouch, risk }) => ({
          title,
          reason,
          filesToTouch,
          risk,
        })),
    };
    onAccept(plan, planToMarkdown(task, steps, overview));
  }

  function handleRegenerate() {
    if (isLoading) stop();
    setOverview("");
    setSteps([]);
    submit({ task, workspaceName, workspaceRoot });
  }

  return (
    <div className="rounded-md border border-slate-300 bg-white">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
        <span
          className={[
            "h-1.5 w-1.5 rounded-full",
            isLoading
              ? "animate-pulse bg-sky-500"
              : error
                ? "bg-rose-500"
                : "bg-emerald-500",
          ].join(" ")}
        />
        <Eyebrow>Plan · {done ? "Review" : "Generating"}</Eyebrow>
        {done && (
          <span className="ml-auto font-mono text-[10px] text-slate-500">
            {checkedCount}/{steps.length} selected
          </span>
        )}
      </div>

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-[13px] text-rose-800">
          {error.message}
        </div>
      )}

      {/* Overview */}
      <div className="px-4 py-3">
        {done ? (
          <input
            value={overview}
            onChange={(e) => setOverview(e.currentTarget.value)}
            className="w-full rounded-sm border border-slate-200 bg-white px-2 py-1.5 text-[13px] leading-6 text-slate-800 outline-none focus:border-slate-900"
          />
        ) : (
          <div className="text-[13px] leading-7 text-slate-700">
            {overview || (
              <span className="font-mono text-[12px] text-slate-400">
                overview generating…
              </span>
            )}
          </div>
        )}
      </div>

      {/* Steps — 始终显示 checkbox */}
      {steps.length > 0 && (
        <ol className="divide-y divide-slate-100 border-t border-slate-200">
          {steps.map((step, idx) => (
            <li key={idx} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={step.checked}
                  disabled={!done}
                  onChange={() => toggleStep(idx)}
                  className="mt-1 h-4 w-4 cursor-pointer accent-slate-900 disabled:cursor-default disabled:opacity-50"
                />

                <div
                  className={[
                    "min-w-0 flex-1",
                    !step.checked && done ? "opacity-40" : "",
                  ].join(" ")}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {done ? (
                      <input
                        value={step.title}
                        onChange={(e) =>
                          updateStep(idx, "title", e.currentTarget.value)
                        }
                        className="min-w-0 flex-1 rounded-sm border border-slate-200 bg-white px-2 py-1 text-[14px] font-medium text-slate-900 outline-none focus:border-slate-900"
                      />
                    ) : (
                      <span className="text-[14px] font-medium text-slate-900">
                        {step.title || (
                          <em className="font-normal text-slate-400">…</em>
                        )}
                      </span>
                    )}
                    {step.risk && (
                      <span
                        className={[
                          "inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em]",
                          RISK_STYLES[step.risk] ?? RISK_STYLES.low,
                        ].join(" ")}
                      >
                        {step.risk}
                      </span>
                    )}
                  </div>
                  {done ? (
                    <input
                      value={step.reason}
                      onChange={(e) =>
                        updateStep(idx, "reason", e.currentTarget.value)
                      }
                      className="mt-1 w-full rounded-sm border border-slate-200 bg-white px-2 py-1 text-[13px] text-slate-600 outline-none focus:border-slate-900"
                    />
                  ) : (
                    step.reason && (
                      <div className="mt-1 text-[13px] leading-6 text-slate-600">
                        {step.reason}
                      </div>
                    )
                  )}
                  {step.filesToTouch.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {step.filesToTouch.map((file, fIdx) => (
                        <span
                          key={`${file}-${fIdx}`}
                          className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                        >
                          {file}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-slate-50/60 px-4 py-2.5">
        <button
          type="button"
          onClick={handleAccept}
          disabled={!canAccept}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
        >
          接受并执行 ({checkedCount})
        </button>
        <button
          type="button"
          onClick={handleRegenerate}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-slate-700 transition-colors duration-200 hover:border-slate-900 hover:text-slate-900"
        >
          重新生成
        </button>
        {isLoading && (
          <button
            type="button"
            onClick={() => stop()}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-slate-700 transition-colors duration-200 hover:border-rose-400 hover:text-rose-700"
          >
            停止
          </button>
        )}
        <button
          type="button"
          onClick={onDiscard}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500 transition-colors duration-200 hover:text-slate-900"
        >
          丢弃
        </button>
      </div>
    </div>
  );
}
