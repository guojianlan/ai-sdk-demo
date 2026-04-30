"use client";

/**
 * 用户开了"逐步执行"开关后，agent 在每个 step 之间会停下等用户点"继续"。
 *
 * 这张卡显示：
 * - 当前已经跑到第几步（n / max）
 * - 上一步 LLM 输出的纯文本（让用户知道刚发生了什么）
 * - "继续下一步"按钮 + "关闭逐步模式自动跑完"按钮
 */
export function AgentStepPauseCard({
  stepCount,
  maxSteps,
  lastText,
  onResume,
}: {
  stepCount: number;
  maxSteps: number;
  lastText: string;
  onResume: () => void;
}) {
  return (
    <div className="rounded border border-slate-300 bg-slate-50 p-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-700">
          Step-by-step paused
        </div>
        <span className="font-mono text-[11px] text-slate-600">
          {stepCount} / {maxSteps} steps
        </span>
      </div>

      <p className="mt-2 text-[13px] text-slate-700">
        agent 跑完了第 {stepCount} 步。点击下面继续到下一步。
        要让它一口气跑完，去顶部关掉&quot;逐步执行&quot;开关。
      </p>

      {lastText.trim().length > 0 && (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-[12px] text-slate-500 hover:text-slate-700">
            上一步的文字输出
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-sans text-[12px] text-slate-800">
            {lastText}
          </pre>
        </details>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={onResume}
          className="cursor-pointer rounded-md border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-700"
        >
          → 继续下一步
        </button>
      </div>
    </div>
  );
}
