"use client";

import { useState, type ComponentType } from "react";

import type { LooseToolPart, OnToolOutputHandler } from "./types";

/**
 * 交互卡片（P3-c）：agent 发出 interactive tool-call 后，这些组件负责在 UI 上
 * 渲染对应的输入/选择/确认界面，并在用户提交时调 `onToolOutput` 回灌 output
 * 给 AI SDK（底层就是 `addToolOutput`）。
 *
 * 约定：
 * - 所有卡片只在 `state === "input-available"` 阶段渲染；
 *   `output-available` 之后交给 output-views 做摘要展示。
 * - 每张卡的 output 形状必须对齐 `lib/interactive-tools.ts` 里对应工具的 outputSchema。
 * - 所有按钮的文案走当前项目的 wireframe 风格（mono + 方括号 + 1px 边）。
 */

type InteractiveCardProps = {
  part: LooseToolPart;
  onToolOutput: OnToolOutputHandler;
};

function CardShell({
  toolName,
  children,
}: {
  toolName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="corner-bracket relative text-sky-600">
      <span aria-hidden="true" />
      <div className="rounded-md border border-sky-400 bg-sky-50/40 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">
            interactive · {toolName}
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

// --- ask_question --------------------------------------------------------

type AskQuestionInput = { question: string; placeholder?: string };

function AskQuestionCard({ part, onToolOutput }: InteractiveCardProps) {
  const input = (part.input ?? {}) as AskQuestionInput;
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const canRespond = Boolean(part.toolCallId) && !submitted;
  const canSubmit = canRespond && answer.trim().length > 0;

  function submit() {
    if (!canSubmit) return;
    setSubmitted(true);
    onToolOutput({
      tool: "ask_question",
      toolCallId: part.toolCallId!,
      output: { answer: answer.trim() },
    });
  }

  return (
    <CardShell toolName="ask_question">
      <div className="mb-3 text-[15px] leading-7 text-slate-900">
        {input.question || "(missing question)"}
      </div>
      <textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder={input.placeholder ?? "输入你的回答…"}
        disabled={!canRespond}
        rows={2}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-[14px] leading-6 text-slate-800 focus:border-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50"
      />
      <div className="mt-3 flex items-center gap-2 border-t border-sky-200 pt-3">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
        >
          提交回答
        </button>
        <span className="ml-auto font-mono text-[10px] text-slate-500">
          ⌘↵ 快捷提交
        </span>
      </div>
    </CardShell>
  );
}

// --- ask_choice ----------------------------------------------------------

type ChoiceOption = { id: string; label: string; description?: string };
type AskChoiceInput = {
  question: string;
  options: ChoiceOption[];
  recommendedId?: string;
  recommendationReason?: string;
};

function AskChoiceCard({ part, onToolOutput }: InteractiveCardProps) {
  const input = (part.input ?? {}) as AskChoiceInput;
  const options = Array.isArray(input.options) ? input.options : [];
  const recommendedId = input.recommendedId;
  const recommendedOption = recommendedId
    ? options.find((option) => option.id === recommendedId)
    : undefined;

  const [typed, setTyped] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const canRespond = Boolean(part.toolCallId) && !submitted;
  const canSubmitText = canRespond && typed.trim().length > 0;

  function submit(answer: string) {
    if (!canRespond) return;
    setSubmitted(true);
    onToolOutput({
      tool: "ask_choice",
      toolCallId: part.toolCallId!,
      output: { answer },
    });
  }

  return (
    <CardShell toolName="ask_choice">
      <div className="mb-3 text-[15px] leading-7 text-slate-900">
        {input.question || "(missing question)"}
      </div>
      <ul className="space-y-2">
        {options.map((option) => {
          const isRecommended = option.id === recommendedId;
          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={!canRespond}
                onClick={() => submit(option.label)}
                className={[
                  "flex w-full cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60",
                  isRecommended
                    ? "border-sky-500 bg-sky-50/60 hover:bg-sky-100/60"
                    : "border-slate-300 bg-white hover:border-sky-500 hover:bg-sky-50/40",
                ].join(" ")}
              >
                <span
                  className={[
                    "mt-0.5 inline-flex w-8 shrink-0 justify-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
                    isRecommended
                      ? "border-sky-500 bg-white text-sky-700"
                      : "border-slate-300 bg-slate-50 text-slate-600",
                  ].join(" ")}
                >
                  {option.id.slice(0, 6)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-slate-900">
                      {option.label}
                    </span>
                    {isRecommended && (
                      <span className="inline-flex items-center rounded-sm border border-sky-500 bg-white px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                        推荐
                      </span>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-[12px] leading-6 text-slate-600">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {options.length === 0 && (
          <li className="font-mono text-[11px] text-rose-700">
            (no options supplied)
          </li>
        )}
      </ul>

      {recommendedOption && input.recommendationReason && (
        <div className="mt-2 font-mono text-[11px] leading-6 text-sky-700">
          → 为什么推荐 &ldquo;{recommendedOption.label}&rdquo;：
          {input.recommendationReason}
        </div>
      )}

      <div className="mt-3 border-t border-sky-200 pt-3">
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
          或者自己写 · 序号 / 选项名 / 自由文本都可以
        </div>
        <div className="flex items-start gap-2">
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={'如 "1" / "第二个" / 或随便写点想法'}
            disabled={!canRespond}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && canSubmitText) {
                event.preventDefault();
                submit(typed.trim());
              }
            }}
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-[14px] leading-6 text-slate-800 focus:border-sky-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50"
          />
          <button
            type="button"
            disabled={!canSubmitText}
            onClick={() => submit(typed.trim())}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-3.5 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
          >
            提交
          </button>
        </div>
      </div>
    </CardShell>
  );
}

// --- show_reference ------------------------------------------------------

type ShowReferenceInput = { title: string; url: string; summary: string };

function ShowReferenceCard({ part, onToolOutput }: InteractiveCardProps) {
  const input = (part.input ?? {}) as ShowReferenceInput;
  const [submitted, setSubmitted] = useState(false);
  const canRespond = Boolean(part.toolCallId) && !submitted;

  function respond(acknowledged: boolean) {
    if (!canRespond) return;
    setSubmitted(true);
    onToolOutput({
      tool: "show_reference",
      toolCallId: part.toolCallId!,
      output: { acknowledged },
    });
  }

  return (
    <CardShell toolName="show_reference">
      <a
        href={input.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block rounded-md border border-slate-300 bg-white p-3 transition-colors duration-200 hover:border-sky-500"
      >
        <div className="text-[14px] font-medium text-slate-900">
          {input.title || "(missing title)"}
        </div>
        <div className="mt-1 break-all font-mono text-[11px] text-sky-700">
          {input.url}
        </div>
        {input.summary && (
          <div className="mt-2 text-[13px] leading-6 text-slate-600">
            {input.summary}
          </div>
        )}
      </a>
      <div className="mt-3 flex items-center gap-2 border-t border-sky-200 pt-3">
        <button
          type="button"
          disabled={!canRespond}
          onClick={() => respond(true)}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-white transition-colors duration-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
        >
          看过了
        </button>
        <button
          type="button"
          disabled={!canRespond}
          onClick={() => respond(false)}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-slate-700 transition-colors duration-200 hover:border-rose-400 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          跳过
        </button>
      </div>
    </CardShell>
  );
}

// --- registry ------------------------------------------------------------

/**
 * toolName → card 组件。ToolPartCard 会据此判断"这个 tool-call 是不是交互卡"。
 * 没命中的工具走默认的 input-available 渲染。
 */
export const interactiveCardRegistry: Record<
  string,
  ComponentType<InteractiveCardProps>
> = {
  ask_question: AskQuestionCard,
  ask_choice: AskChoiceCard,
  show_reference: ShowReferenceCard,
};
