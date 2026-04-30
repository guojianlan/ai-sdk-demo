"use client";

import { useState } from "react";

/**
 * agent loop 中模型调用了一个 interactiveTool（无 execute）—— 客户端要收集
 * 用户输入并以 tool result 的形式回灌给 agent。
 *
 * MVP 简化：不按 tool name 区分 UI 形态（ask_question / ask_choice / show_reference
 * 各自有不同字段），统一渲染一个文本输入框，把用户填的字符串作为 `{ answer }`
 * 形态回灌。这能覆盖 ask_question / ask_choice 的常见场景。
 *
 * 后续要做更完整的 dispatch：参考 `app/_components/tool-card/interactive-cards.tsx`
 * 里的 registry 模式按 toolName 分发。
 */
export function AgentInteractiveCard({
  toolCallId,
  toolName,
  input,
  stepCount,
  onSubmit,
}: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  stepCount: number;
  onSubmit: (toolCallId: string, output: unknown) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // ask_question / ask_choice 的 input 都有 `question`；提取出来当主标题。
  const question =
    input &&
    typeof input === "object" &&
    "question" in input &&
    typeof (input as { question: unknown }).question === "string"
      ? (input as { question: string }).question
      : null;

  const submit = () => {
    if (submitted) return;
    if (answer.trim().length === 0) return;
    setSubmitted(true);
    onSubmit(toolCallId, { answer: answer.trim() });
  };

  return (
    <div className="rounded border border-sky-200 bg-sky-50 p-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-700">
          Agent is asking · step {stepCount}
        </div>
        <code className="rounded bg-sky-100 px-2 py-0.5 font-mono text-[11px] text-sky-900">
          {toolName}
        </code>
      </div>

      {question ? (
        <p className="mt-3 text-[14px] leading-7 text-slate-800">{question}</p>
      ) : (
        <pre className="mt-3 max-h-48 overflow-auto rounded bg-white p-3 font-mono text-[11px] text-slate-700">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}

      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        disabled={submitted}
        rows={3}
        placeholder="你的回答..."
        className="mt-3 w-full rounded border border-slate-300 bg-white p-2 text-[13px] focus:border-slate-900 focus:outline-none disabled:bg-slate-50"
      />

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitted || answer.trim().length === 0}
          className="cursor-pointer rounded-md border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          → 回答 agent
        </button>
        {submitted && (
          <span className="self-center text-[12px] text-slate-500">
            已发回 agent，继续 loop...
          </span>
        )}
      </div>
    </div>
  );
}
