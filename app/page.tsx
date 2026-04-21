"use client";

import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_WORKSPACE_ACCESS_MODE } from "@/lib/chat-access-mode";
import {
  createSession,
  deriveSessionPreview,
  deriveSessionTitle,
  sanitizeSessions,
  STORAGE_KEY,
  URL_SESSION_PARAM,
  type ChatSession,
  type WorkspaceOption,
} from "@/app/_lib/chat-session";

import { ChatInput } from "./_components/ChatInput";
import { EmptyState } from "./_components/EmptyState";
import { MessageBubble } from "./_components/MessageBubble";
import { PlanCard } from "./_components/PlanCard";
import { SessionHeader } from "./_components/SessionHeader";
import { SessionSidebar } from "./_components/SessionSidebar";
import {
  WorkspacePicker,
  type WorkspacePickerSubmit,
} from "./_components/WorkspacePicker";

/**
 * 主页 Home：一切状态和副作用的编排中心。
 * UI 都已经拆成了 _components/*；这里只留：
 * - state + effects（localStorage / URL 同步 / 工作区加载 / useChat）
 * - 顶层 JSX 拼装（侧栏 + header + 消息列表 + 输入框 + picker modal）
 *
 * 需要改 UI 细节：去对应的 _components 文件改；需要改状态/流程：改这里。
 */
export default function Home() {
  const [sessions, setSessions] = useState<ChatSession[]>([createSession()]);
  const [activeChatId, setActiveChatId] = useState("");
  const [draft, setDraft] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspacesError, setWorkspacesError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  // pendingPlanTask：非空字符串表示底部要展示一张 PlanCard 给用户 review。
  const [pendingPlanTask, setPendingPlanTask] = useState("");

  // P3-b: 每个 session 的消息异步从 /api/chat/history 拉取。
  // 结构：{ [sessionId]: UIMessage[] }；undefined 表示还没拉过 / 正在拉。
  const [hydratedMessages, setHydratedMessages] = useState<
    Record<string, UIMessage[]>
  >({});
  const hydratingRef = useRef<Set<string>>(new Set());

  // 聊天消息区的自动滚动：
  // - 消息 / tool part 更新时，如果用户就在底部附近，自动把视口拉到底。
  // - 如果用户主动往上滚去看历史，就不再强拽他回底部（onScroll 里把 userScrolledAway=true）。
  // - 切换 session 时重置为 false，新对话回到底部。
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [userScrolledAway, setUserScrolledAway] = useState(false);

  // --- 工作区发现 ---
  useEffect(() => {
    async function loadWorkspaces() {
      try {
        const response = await fetch("/api/workspaces");
        if (!response.ok) {
          throw new Error("Failed to load workspaces.");
        }
        const data = (await response.json()) as {
          workspaces?: WorkspaceOption[];
        };
        const nextWorkspaces = data.workspaces ?? [];
        setWorkspaces(nextWorkspaces);

        // 首次加载：第一个 session 还没绑定工作区，就默认挂上第一个候选，
        // 避免用户一进来就对着空会话发愣。
        if (nextWorkspaces[0]) {
          setSessions((currentSessions) =>
            currentSessions.map((session, index) =>
              index === 0 && !session.workspaceRoot
                ? {
                    ...session,
                    workspaceRoot: nextWorkspaces[0].root,
                    workspaceName: nextWorkspaces[0].name,
                  }
                : session,
            ),
          );
        }
      } catch (error) {
        setWorkspacesError(
          error instanceof Error ? error.message : "加载工作区失败。",
        );
      } finally {
        setWorkspacesLoading(false);
      }
    }
    void loadWorkspaces();
  }, []);

  // --- localStorage + URL 同步 ---
  // 一次性的水合逻辑：URL `?session=<id>` 优先，其次 localStorage，最后回落第一个 session。
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const urlSessionId = new URLSearchParams(window.location.search).get(
        URL_SESSION_PARAM,
      );

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as {
        activeChatId?: string;
        sessions?: ChatSession[];
      };
      const hydratedSessions = sanitizeSessions(parsed.sessions);
      setSessions(hydratedSessions);

      const urlMatchedId =
        urlSessionId &&
        hydratedSessions.some((session) => session.id === urlSessionId)
          ? urlSessionId
          : null;
      const storageMatchedId = hydratedSessions.some(
        (session) => session.id === parsed.activeChatId,
      )
        ? parsed.activeChatId
        : null;

      setActiveChatId(
        urlMatchedId ?? storageMatchedId ?? hydratedSessions[0].id,
      );
    } catch {
      // 本地存储坏掉了就当首次启动。
    } finally {
      setStorageReady(true);
    }
  }, []);

  // activeChatId 变化时把 URL 改成 `?session=<id>`；用 replaceState 不堆 history 栈。
  useEffect(() => {
    if (!storageReady || !activeChatId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(URL_SESSION_PARAM) === activeChatId) return;
    url.searchParams.set(URL_SESSION_PARAM, activeChatId);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [activeChatId, storageReady]);

  // 持久化到 localStorage。
  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ activeChatId, sessions }),
    );
  }, [activeChatId, sessions, storageReady]);

  // 没有激活的 session → 自动落第一个。
  useEffect(() => {
    if (!activeChatId && sessions[0]) {
      setActiveChatId(sessions[0].id);
    }
  }, [activeChatId, sessions]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeChatId) ?? sessions[0],
    [activeChatId, sessions],
  );
  const activeSessionId = activeSession?.id;

  // P3-b 水合：activeSessionId 变化时去 /api/chat/history 拉消息。
  // 同一个 id 只拉一次；hydratingRef 防并发重复请求（严格模式下 effect 跑两次）。
  useEffect(() => {
    if (!storageReady || !activeSessionId) return;
    if (activeSessionId in hydratedMessages) return;
    if (hydratingRef.current.has(activeSessionId)) return;

    hydratingRef.current.add(activeSessionId);
    const sessionId = activeSessionId;
    (async () => {
      try {
        const response = await fetch(
          `/api/chat/history?id=${encodeURIComponent(sessionId)}`,
        );
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as { messages: UIMessage[] };
        setHydratedMessages((prev) =>
          sessionId in prev ? prev : { ...prev, [sessionId]: data.messages },
        );
      } catch (error) {
        console.error("[page] load history failed", error);
        // 拉失败也落一个空数组：否则 chatInstanceId 永远停在 "loading"，
        // 新会话会发不出消息。
        setHydratedMessages((prev) =>
          sessionId in prev ? prev : { ...prev, [sessionId]: [] },
        );
      } finally {
        hydratingRef.current.delete(sessionId);
      }
    })();
  }, [activeSessionId, hydratedMessages, storageReady]);

  const isHydrated = Boolean(
    activeSessionId && activeSessionId in hydratedMessages,
  );

  // useChat 的 id 拼进 session + workspace + mode + 水合标记：
  // 切换或水合完成时 Chat 实例被重建，initial messages 用新的。
  const chatInstanceId = [
    activeSessionId ?? "chat",
    activeSession?.workspaceRoot ?? "workspace",
    activeSession?.workspaceAccessMode ?? DEFAULT_WORKSPACE_ACCESS_MODE,
    storageReady ? "ready" : "boot",
    isHydrated ? "hydrated" : "loading",
  ].join(":");

  // 关键：transport 必须 memoize。不 memoize 的话每次 render 都 new 一个新实例，
  // useChat 以为 config 变了 → 重置内部状态 → messages 返回新引用 → 触发下方的
  // sessions writeback effect → setSessions 又引发 re-render → 再 new 一个 transport
  // → 死循环（"Maximum update depth exceeded"）。
  //
  // body 里的字段随 session 配置走；只有这些关键字段变化时才重新 new transport。
  const chatTransport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: () => ({
          // P3-b: chatId 是服务端持久化 + resume 的 key；就用 session id。
          chatId: activeSessionId,
          workspaceRoot: activeSession?.workspaceRoot ?? "",
          workspaceName: activeSession?.workspaceName ?? "",
          workspaceAccessMode:
            activeSession?.workspaceAccessMode ?? DEFAULT_WORKSPACE_ACCESS_MODE,
          bypassPermissions: activeSession?.bypassPermissions === true,
        }),
        // 关键：reconnectToStream 默认拼 `${api}/${options.chatId}/stream`，
        // 而 options.chatId 来自 useChat 的 `id`——我们的 chatInstanceId 里塞了
        // workspaceRoot（含斜杠），会把 URL 切成好几段导致 404。
        // 用 prepareReconnectToStreamRequest 改成拿真正的 sessionId 去拼，拍扁这个坑。
        prepareReconnectToStreamRequest: ({ api }) => ({
          api: activeSessionId
            ? `${api}/${encodeURIComponent(activeSessionId)}/stream`
            : api,
        }),
      }),
    [
      activeSessionId,
      activeSession?.workspaceRoot,
      activeSession?.workspaceName,
      activeSession?.workspaceAccessMode,
      activeSession?.bypassPermissions,
    ],
  );

  const initialMessages = useMemo(
    () => (isHydrated && activeSessionId ? hydratedMessages[activeSessionId] : []),
    [isHydrated, activeSessionId, hydratedMessages],
  );

  const {
    addToolApprovalResponse,
    addToolOutput,
    error,
    messages,
    resumeStream,
    sendMessage,
    status,
    stop,
  } = useChat({
    id: chatInstanceId,
    messages: initialMessages,
    transport: chatTransport,
    // 关键：限频。流式模式下，每个 text/tool chunk 都会触发 chat internal 的 messages
    // change 回调；不限频的话一秒可能来 50+ 次，我们挂在 [messages] 上的 writeback 和
    // auto-scroll effect 同步被打同等次数 → React 超过 "max update depth" 报错。
    // 50ms 既够流畅（~20fps），又把渲染次数砸到 1/10 以下。
    experimental_throttle: 50,
    // 自动 resend 的两种触发：
    // 1) 用户刚点完 approval 同意/拒绝 → part 进入 approval-responded，
    //    需要把回执发回服务器让 AI SDK 执行 tool。
    // 2) 兜底：所有 tool 都 output-available 了，让模型继续讲解。
    sendAutomaticallyWhen: ({ messages: currentMessages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({
        messages: currentMessages,
      }) ||
      lastAssistantMessageIsCompleteWithToolCalls({
        messages: currentMessages,
      }),
  });

  // P3-b: 水合完成 / 切回已有会话时，手动挂一次 resumeStream()。
  // 不用 `useChat({ resume })` 的原因：那个 prop 只在 `resume` 从 false→true 时跑一次，
  // 后续 `id`（我们的 chatInstanceId）变化虽然会重建内部 Chat 实例，但**不会**重新触发 resume。
  // 结果就是"切到 B 再切回 A → A 的进行中流不会自动续上"。
  // 这里挂一个 effect，chatInstanceId 或 isHydrated 变化时主动调一次；服务端没 active stream
  // 就静默返回 204，调多次也 no-op。
  useEffect(() => {
    if (!isHydrated) return;
    void resumeStream();
  }, [chatInstanceId, isHydrated, resumeStream]);

  // 消息变化时自动滚动：
  // - 用户没主动滚离底部 → 把 scrollTop 贴到底
  // - 切换 session 时 userScrolledAway 不会自动重置，所以这里 messages 身份变了也会触发
  useEffect(() => {
    if (userScrolledAway) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    // 直接赋值 scrollTop，而不是 smooth scrollIntoView —— streaming 期间 messages
    // 变化很密，smooth 动画会卡在半路、看起来反而抖。
    el.scrollTop = el.scrollHeight;
  }, [messages, userScrolledAway]);

  // 切 session 或 切 workspace 时：清除 "用户滚离底部" 标记，新会话从底部重新开始。
  useEffect(() => {
    setUserScrolledAway(false);
  }, [activeSessionId]);

  // P3-b: useChat 的 messages 不再写回 session（服务端 SQLite 已经持久化）。
  // 只把派生的 title / preview / updatedAt 写回 localStorage，供侧栏展示。
  useEffect(() => {
    if (!activeSessionId || !isHydrated) return;
    const nextTitle = deriveSessionTitle(messages);
    const rawPreview = deriveSessionPreview(messages);
    const nextPreview =
      rawPreview.length > 120 ? `${rawPreview.slice(0, 120)}...` : rawPreview;

    setSessions((currentSessions) => {
      let changed = false;
      const nextSessions = currentSessions.map((session) => {
        if (session.id !== activeSessionId) return session;
        const titleChanged = session.title !== nextTitle;
        const previewChanged = session.preview !== nextPreview;
        if (!titleChanged && !previewChanged) return session;
        changed = true;
        return {
          ...session,
          title: nextTitle,
          preview: nextPreview,
          updatedAt:
            messages.length > 0
              ? new Date().toISOString()
              : session.updatedAt || session.createdAt,
        };
      });
      return changed ? nextSessions : currentSessions;
    });
  }, [activeSessionId, isHydrated, messages]);

  // --- 用户动作 ---
  async function handleSend(text: string) {
    const value = text.trim();
    if (!value || !activeSession?.workspaceRoot) return;
    setDraft("");
    try {
      await sendMessage({ text: value });
    } catch (sendError) {
      console.error("Failed to send message", sendError);
    }
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId === activeChatId) return;
    if (status === "streaming" || status === "submitted") {
      await stop();
    }
    setActiveChatId(sessionId);
    setDraft("");
  }

  async function handlePickerSubmit({
    workspace,
    workspaceAccessMode,
    bypassPermissions,
  }: WorkspacePickerSubmit) {
    if (status === "streaming" || status === "submitted") {
      await stop();
    }
    const nextSession = createSession(
      workspace,
      workspaceAccessMode,
      bypassPermissions,
    );
    // 新会话肯定没 DB 历史，直接预填空数组，免得 hydrate effect 再发一次多余请求。
    setHydratedMessages((prev) => ({ ...prev, [nextSession.id]: [] }));
    setSessions((currentSessions) => [nextSession, ...currentSessions]);
    setActiveChatId(nextSession.id);
    setDraft("");
    setPickerOpen(false);
  }

  const activeAccessMode =
    activeSession?.workspaceAccessMode ?? DEFAULT_WORKSPACE_ACCESS_MODE;

  const canSend =
    Boolean(activeSession?.workspaceRoot) &&
    Boolean(draft.trim()) &&
    status !== "submitted" &&
    isHydrated;

  const statusLabel =
    status === "submitted"
      ? "发送中"
      : status === "streaming"
        ? "分析中"
        : status === "error"
          ? "出错"
          : "就绪";

  return (
    <main className="bg-blueprint h-screen overflow-hidden px-4 py-6 text-slate-900 sm:px-6 sm:py-8">
      <div className="mx-auto flex h-full w-full max-w-[1440px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white xl:flex-row">
        <SessionSidebar
          sessions={sessions}
          activeChatId={activeChatId}
          workspaces={workspaces}
          workspacesLoading={workspacesLoading}
          workspacesError={workspacesError}
          onNewSession={() => setPickerOpen(true)}
          onSelectSession={(id) => void handleSelectSession(id)}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-1 flex-col overflow-hidden px-5 py-6 sm:px-8 lg:px-10">
            <SessionHeader
              activeSession={activeSession}
              activeAccessMode={activeAccessMode}
              status={status}
              statusLabel={statusLabel}
              onStop={() => void stop()}
            />

            <div className="flex min-h-0 flex-1 flex-col">
              <div
                ref={messagesContainerRef}
                onScroll={(event) => {
                  const el = event.currentTarget;
                  // 容差 100px：离底部 100px 以内都视为"在底部"，auto-scroll 继续生效。
                  const nearBottom =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                  setUserScrolledAway(!nearBottom);
                }}
                className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-6 pr-1"
              >
                {messages.length === 0 ? (
                  <EmptyState
                    hasWorkspace={Boolean(activeSession?.workspaceRoot)}
                    accessMode={activeAccessMode}
                    onOpenPicker={() => setPickerOpen(true)}
                    onSendSuggestion={(text) => void handleSend(text)}
                  />
                ) : (
                  messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      onApproval={({ id, approved, reason }) =>
                        void addToolApprovalResponse({ id, approved, reason })
                      }
                      onToolOutput={({ tool, toolCallId, output }) =>
                        // P3-c: 交互工具（ask_question 等）没有 server-side execute，
                        // 卡片收集到用户的选择后靠 addToolOutput 把 output 回灌回去；
                        // 之后 useChat 的 sendAutomaticallyWhen 会自动继续下一步。
                        // 这里做一次 string → typed tool name 的松散 cast，避免把
                        // AI SDK 的泛型类型扩散到整个 tool-card 层。
                        void addToolOutput({
                          tool: tool as Parameters<typeof addToolOutput>[0]["tool"],
                          toolCallId,
                          output,
                        })
                      }
                    />
                  ))
                )}
              </div>

              {error && (
                <div
                  className="mb-4 flex shrink-0 items-start gap-3 rounded-md border border-rose-300 bg-rose-50 px-4 py-3"
                  role="alert"
                >
                  <span className="mt-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-rose-700">
                    err
                  </span>
                  <span className="text-sm text-rose-800">
                    Agent 出现错误：{error.message}
                  </span>
                </div>
              )}

              <ChatInput
                draft={draft}
                onDraftChange={setDraft}
                onSubmit={() => {
                  const task = draft.trim();
                  if (!task || !activeSession?.workspaceRoot) return;
                  if (planMode && !pendingPlanTask) {
                    // Plan mode ON + 还没有打开 plan：先生成 plan，不清空 draft。
                    setPendingPlanTask(task);
                  } else {
                    // 正常发送（plan mode OFF 或 plan 已在显示）。
                    void handleSend(draft);
                  }
                }}
                canSend={canSend}
                status={status}
                hasWorkspace={Boolean(activeSession?.workspaceRoot)}
                planMode={planMode}
                onPlanModeChange={setPlanMode}
              />
            </div>
          </div>
        </section>
      </div>

      {pendingPlanTask && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-[2px] sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Plan review"
        >
          <div className="my-auto w-full max-w-2xl">
            <div className="max-h-[calc(100vh-2rem)] overflow-y-auto rounded-md">
              <PlanCard
                key={pendingPlanTask}
                task={pendingPlanTask}
                workspaceName={activeSession?.workspaceName}
                workspaceRoot={activeSession?.workspaceRoot}
                onDiscard={() => setPendingPlanTask("")}
                onAccept={(_plan, markdown) => {
                  setPendingPlanTask("");
                  setDraft("");
                  void handleSend(markdown);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {pickerOpen && (
        <WorkspacePicker
          workspaces={workspaces}
          onClose={() => setPickerOpen(false)}
          onSubmit={handlePickerSubmit}
        />
      )}
    </main>
  );
}
