"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import Link from "next/link";
import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

type WorkspaceOption = {
  root: string;
  name: string;
  description: string;
  isCurrentProject: boolean;
};

type ExperimentToolMode = "workspace-toolset" | "shell" | "hybrid";

type ExperimentEnvInfo = {
  model: string;
  baseURL: string | null;
};

const TOOL_MODES: ReadonlyArray<{
  id: ExperimentToolMode;
  label: string;
  tagline: string;
}> = [
  {
    id: "workspace-toolset",
    label: "workspace-toolset",
    tagline: "细粒度自定义 tools（list / search / read）",
  },
  {
    id: "shell",
    label: "shell",
    tagline: "通用 shell function tool（任何模型可用）",
  },
  {
    id: "hybrid",
    label: "hybrid",
    tagline: "两边都开，让模型自己选",
  },
];

const SUGGESTIONS: Record<ExperimentToolMode, string[]> = {
  "workspace-toolset": [
    "请用 list_files 列出项目根目录，再读 package.json 总结依赖和脚本。",
    "用 search_code 找到 ToolLoopAgent 的使用位置，并说明它的 stopWhen 设置。",
  ],
  shell: [
    "请执行 ls -la 和 cat package.json，然后概括这个项目在用哪些依赖。",
    "用 git log --oneline -5 看最近 5 个提交，再用 git diff HEAD~1 简述上一次改动。",
  ],
  hybrid: [
    "先用 search_code 找 workspaceToolset 的定义，再用 shell 的 rg 交叉验证；告诉我两种方式的证据链差异。",
    "用 list_files 了解目录，再用 shell 执行 wc -l 统计 app 目录下各 tsx 文件的行数。",
  ],
};

function extractMessageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("");
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolPartCard({
  toolName,
  state,
  input,
  output,
  errorText,
}: {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const stateTone =
    state === "output-available"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : state === "output-error"
        ? "bg-rose-50 text-rose-700 ring-rose-200"
        : "bg-slate-50 text-slate-600 ring-slate-200";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-slate-900 px-2.5 py-1 font-mono text-[11px] text-white">
          {toolName}
        </span>
        <span
          className={`rounded-full px-2.5 py-1 font-medium ring-1 ${stateTone}`}
        >
          {state}
        </span>
      </div>

      {input !== undefined && (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-500">
            input
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-slate-950/95 p-3 text-[12px] leading-5 text-slate-100">
            {prettyJson(input)}
          </pre>
        </details>
      )}

      {output !== undefined && (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-500">
            output
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-slate-950/95 p-3 text-[12px] leading-5 text-slate-100">
            {prettyJson(output)}
          </pre>
        </details>
      )}

      {errorText && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {errorText}
        </div>
      )}
    </div>
  );
}

function MessageView({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const textContent = extractMessageText(message);

  return (
    <div
      className={`flex ${isUser ? "justify-end" : "justify-start"} w-full`}
    >
      <div
        className={`flex w-full max-w-3xl flex-col gap-3 ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">
          {isUser ? "You" : "Agent"}
        </div>

        {textContent && (
          <div
            className={`rounded-3xl px-5 py-4 text-[15px] leading-7 shadow-sm ring-1 whitespace-pre-wrap ${
              isUser
                ? "bg-slate-950 text-white ring-slate-950/80"
                : "bg-white text-slate-800 ring-slate-200"
            }`}
          >
            {textContent}
          </div>
        )}

        {message.parts.map((part, index) => {
          if (part.type === "reasoning" && "text" in part && part.text) {
            return (
              <div
                key={`${message.id}-reasoning-${index}`}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] italic leading-6 text-slate-500"
              >
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  reasoning
                </div>
                {part.text}
              </div>
            );
          }

          if (part.type === "dynamic-tool") {
            return (
              <ToolPartCard
                key={`${message.id}-dtool-${index}`}
                toolName={`dynamic:${part.toolName}`}
                state={part.state}
                input={"input" in part ? part.input : undefined}
                output={"output" in part ? part.output : undefined}
                errorText={
                  "errorText" in part ? (part.errorText as string) : undefined
                }
              />
            );
          }

          if (part.type.startsWith("tool-")) {
            const toolName = part.type.slice("tool-".length);
            const anyPart = part as Record<string, unknown>;

            return (
              <ToolPartCard
                key={`${message.id}-tool-${index}`}
                toolName={toolName}
                state={String(anyPart.state ?? "unknown")}
                input={anyPart.input}
                output={anyPart.output}
                errorText={
                  typeof anyPart.errorText === "string"
                    ? anyPart.errorText
                    : undefined
                }
              />
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}

export default function LocalShellLabPage() {
  const [envInfo, setEnvInfo] = useState<ExperimentEnvInfo | null>(null);
  const [envError, setEnvError] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [selectedWorkspaceRoot, setSelectedWorkspaceRoot] = useState("");
  const [toolMode, setToolMode] = useState<ExperimentToolMode>("shell");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    async function loadEnv() {
      try {
        const response = await fetch("/api/chat-openai-experimental");
        if (!response.ok) {
          throw new Error(`env probe failed: ${response.status}`);
        }
        setEnvInfo((await response.json()) as ExperimentEnvInfo);
      } catch (error) {
        setEnvError(error instanceof Error ? error.message : "加载环境信息失败");
      }
    }

    async function loadWorkspaces() {
      try {
        const response = await fetch("/api/workspaces");
        if (!response.ok) {
          throw new Error("加载工作区失败");
        }
        const data = (await response.json()) as {
          workspaces?: WorkspaceOption[];
        };
        const list = data.workspaces ?? [];
        setWorkspaces(list);
        if (list[0]) {
          setSelectedWorkspaceRoot(list[0].root);
        }
      } catch {
        // ignore; UI will show empty
      }
    }

    void loadEnv();
    void loadWorkspaces();
  }, []);

  const selectedWorkspace = useMemo(
    () => workspaces.find((ws) => ws.root === selectedWorkspaceRoot),
    [workspaces, selectedWorkspaceRoot],
  );

  const chatInstanceId = [
    selectedWorkspaceRoot || "no-workspace",
    toolMode,
  ].join(":");

  const { error, messages, sendMessage, status, stop, setMessages } = useChat({
    id: chatInstanceId,
    transport: new DefaultChatTransport({
      api: "/api/chat-openai-experimental",
      body: () => ({
        workspaceRoot: selectedWorkspaceRoot,
        workspaceName: selectedWorkspace?.name ?? "",
        toolMode,
      }),
    }),
  });

  const isStreaming = status === "submitted" || status === "streaming";

  function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !selectedWorkspaceRoot || isStreaming) {
      return;
    }
    void sendMessage({ text: trimmed });
    setDraft("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    handleSend(draft);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend(draft);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-white px-4 py-8 text-slate-900">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
              AI SDK Lab
            </div>
            <h1 className="mt-2 text-2xl font-semibold">
              Tool 粒度对比台
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              在同一个工作区 + 同一个 prompt 下切换三种 toolMode，观察
              细粒度 workspaceToolset 与通用 shell function tool
              在工具调用、参数、输出上的差异。两者都走普通 function calling，
              任何支持 function calling 的模型都能跑。
            </p>
          </div>
          <Link
            href="/"
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            ← 回主页
          </Link>
        </header>

        <section className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              当前实验环境
            </div>
            {envError ? (
              <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {envError}
              </div>
            ) : envInfo ? (
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-slate-500">model</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {envInfo.model}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-slate-500">baseURL</dt>
                  <dd className="truncate font-mono text-xs text-slate-800">
                    {envInfo.baseURL ?? "(default)"}
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="mt-3 text-sm text-slate-400">加载中…</div>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              工作区
            </div>
            <select
              value={selectedWorkspaceRoot}
              onChange={(event) => setSelectedWorkspaceRoot(event.target.value)}
              className="mt-3 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {workspaces.length === 0 && (
                <option value="">（没有可用工作区）</option>
              )}
              {workspaces.map((workspace) => (
                <option key={workspace.root} value={workspace.root}>
                  {workspace.name}
                  {workspace.isCurrentProject ? "（当前项目）" : ""}
                </option>
              ))}
            </select>
            {selectedWorkspace && (
              <div className="mt-2 truncate text-xs text-slate-500">
                {selectedWorkspace.root}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              toolMode
            </div>
            <div className="flex flex-wrap gap-2">
              {TOOL_MODES.map((mode) => {
                const active = toolMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => setToolMode(mode.id)}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                      active
                        ? "bg-slate-950 text-white"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => setMessages([])}
              className="ml-auto rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              清空对话
            </button>
          </div>

          <p className="mt-3 text-sm text-slate-500">
            {TOOL_MODES.find((mode) => mode.id === toolMode)?.tagline}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {SUGGESTIONS[toolMode].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => handleSend(suggestion)}
                disabled={isStreaming || !selectedWorkspaceRoot}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs text-slate-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </section>

        <section className="flex min-h-[360px] flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          {messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              选择一个 toolMode，点上面的建议 prompt 或自己输入，观察下方的工具调用。
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {messages.map((message) => (
                <MessageView key={message.id} message={message} />
              ))}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error.message}
            </div>
          )}
        </section>

        <form
          onSubmit={handleSubmit}
          className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            placeholder={
              selectedWorkspaceRoot
                ? "输入消息，Enter 发送 / Shift+Enter 换行"
                : "请先选择一个工作区"
            }
            disabled={!selectedWorkspaceRoot}
            className="w-full resize-none rounded-2xl bg-transparent px-3 py-2 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="text-xs text-slate-400">
              status: <span className="font-mono">{status}</span>
            </div>
            <div className="flex gap-2">
              {isStreaming && (
                <button
                  type="button"
                  onClick={() => stop()}
                  className="rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                >
                  停止
                </button>
              )}
              <button
                type="submit"
                disabled={
                  !draft.trim() || isStreaming || !selectedWorkspaceRoot
                }
                className="rounded-full bg-slate-950 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                发送
              </button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
