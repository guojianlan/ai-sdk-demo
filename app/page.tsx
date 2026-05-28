"use client";

import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_WORKSPACE_ACCESS_MODE } from "@/lib/chat-access-mode";
import { lastAssistantMessageHasCompletedClientContinuationTool } from "@/lib/chat/auto-submit";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionMode,
} from "@/lib/permissions/mode";
import {
  createSession,
  createSessionOnApi,
  deriveSessionPreview,
  deriveSessionTitle,
  fetchSessions,
  STORAGE_KEY,
  updateSessionPermissionModeOnApi,
  updateSessionPlanModeOnApi,
  updateSessionTitleOnApi,
  URL_SESSION_PARAM,
  type ChatSession,
  type WorkspaceOption,
} from "@/app/_lib/chat-session";

import { ChatInput } from "./_components/ChatInput";
import { EmptyState } from "./_components/EmptyState";
import { FlowWorkspace } from "./_components/FlowWorkspace";
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
  // P3-c: sessions 不再用 localStorage 初始化——挂载时从 /api/sessions 拉。
  // 初始 [] 表示"还没拉过"，hydration effect 跑完才填充。
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [draft, setDraft] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [workspacesError, setWorkspacesError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [activeSurface, setActiveSurface] = useState<"chat" | "flows">("chat");
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
        // P3-c: 不再为空 session 默认填充工作区——空列表时让 EmptyState +
        // picker modal 引导用户主动建第一个会话。
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

  // --- 服务端会话列表水合（P3-c）---
  //
  // 挂载时一次性从 `/api/sessions` 拉所有会话，按 updated_at 倒排（服务端已排好）。
  // URL `?session=<id>` 优先决定 active；其次第一个会话；都没就 active=空（empty state）。
  // 同时清掉历史 localStorage 残留——前一版用 `STORAGE_KEY` 持久化过 session 列表，
  // 现在数据源是服务端，留着也不读，主动清掉省得调试时混淆。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        try {
          window.localStorage?.removeItem(STORAGE_KEY);
        } catch {
          // Legacy cleanup is best-effort; session loading must still continue.
        }
        const list = await fetchSessions();
        if (cancelled) return;
        setSessions(list);

        const urlSessionId = new URLSearchParams(window.location.search).get(
          URL_SESSION_PARAM,
        );
        const urlMatchedId =
          urlSessionId && list.some((s) => s.id === urlSessionId)
            ? urlSessionId
            : null;
        setActiveChatId(urlMatchedId ?? list[0]?.id ?? "");
      } finally {
        if (!cancelled) {
          setStorageReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // activeChatId 变化时把 URL 改成 `?session=<id>`；用 replaceState 不堆 history 栈。
  // 没有 active 会话（空列表）→ 移除 URL 参数。
  useEffect(() => {
    if (!storageReady) return;
    const url = new URL(window.location.href);
    if (!activeChatId) {
      if (url.searchParams.has(URL_SESSION_PARAM)) {
        url.searchParams.delete(URL_SESSION_PARAM);
        window.history.replaceState(window.history.state, "", url.toString());
      }
      return;
    }
    if (url.searchParams.get(URL_SESSION_PARAM) === activeChatId) return;
    url.searchParams.set(URL_SESSION_PARAM, activeChatId);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [activeChatId, storageReady]);

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
  // **但**：useChat 在 mount 时就锁住 transport 实例，后续即使 transport 换新引用也不
  // 重新读。所以以前把 permissionMode / planMode 写在 deps 里让 transport 重建是
  // **没用的**——useChat 拿到的还是 mount 那一刻的 transport 闭包，body() 永远返回
  // mount 时的旧值。表现：UI 把 chip 切到 PLAN: ON，下一条请求 body 里 planMode 还是
  // false（去 Network 面板能看到）。
  //
  // 修法：transport **只创建一次**（deps=[]），body() 通过 sessionRef 读最新值。
  // session 状态由 React 正常更新，每次 sendMessage 时 body() 现读 ref —— transport
  // 实例不变，闭包不老化，permissionMode / planMode 切换立即生效。
  const sessionRef = useRef<ChatSession | undefined>(activeSession);
  sessionRef.current = activeSession;

  const chatTransport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: () => {
          const s = sessionRef.current;
          return {
            // P3-b: chatId 是服务端持久化 + resume 的 key；就用 session id。
            chatId: s?.id ?? "",
            workspaceRoot: s?.workspaceRoot ?? "",
            workspaceName: s?.workspaceName ?? "",
            workspaceAccessMode:
              s?.workspaceAccessMode ?? DEFAULT_WORKSPACE_ACCESS_MODE,
            shellApprovalPolicy: s?.shellApprovalPolicy ?? "untrusted",
            permissionMode: s?.permissionMode ?? DEFAULT_PERMISSION_MODE,
            planMode: s?.planMode === true,
          };
        },
        // 关键：reconnectToStream 默认拼 `${api}/${options.chatId}/stream`，
        // 而 options.chatId 来自 useChat 的 `id`——我们的 chatInstanceId 里塞了
        // workspaceRoot（含斜杠），会把 URL 切成好几段导致 404。
        // 用 prepareReconnectToStreamRequest 改成拿真正的 sessionId 去拼，拍扁这个坑。
        prepareReconnectToStreamRequest: ({ api }) => {
          const id = sessionRef.current?.id;
          return { api: id ? `${api}/${encodeURIComponent(id)}/stream` : api };
        },
      }),
    [],
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
    // 自动 resend 只保留人类交互回执：
    // 1) 用户刚点完 approval 同意/拒绝 → part 进入 approval-responded，
    //    需要把回执发回服务器让 AI SDK 执行 tool。
    // 2) ask_user_question / ask_choice / show_reference 这类无 server execute 的
    //    client tool 已由浏览器写入 output，需要把这个 human response 发回后端。
    // 普通 server tool output 的续跑归后端 chat loop 管，
    // 这里不能再用 lastAssistantMessageIsCompleteWithToolCalls，否则会开新 run。
    sendAutomaticallyWhen: ({ messages: currentMessages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({
        messages: currentMessages,
      }) ||
      lastAssistantMessageHasCompletedClientContinuationTool({
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

  // 把 useChat 的 messages 同步回 hydratedMessages：activeSessionId 这条记录始终
  // 是「该会话最新的一帧」。否则切走再切回 useChat 会用首次水合时的旧 snapshot
  // 重建 initialMessages，丢掉这一轮的对话内容。
  // useChat 自带 experimental_throttle:50 已经把更新频率压住了，这里直接跟着跑。
  useEffect(() => {
    if (!activeSessionId) return;
    if (messages.length === 0) return;
    setHydratedMessages((prev) => {
      if (prev[activeSessionId] === messages) return prev;
      return { ...prev, [activeSessionId]: messages };
    });
  }, [activeSessionId, messages]);

  // P3-c: messages 派生 title/preview。preview 是纯 UI 字段（侧栏展示），不持久化；
  // title 变化时 PATCH /api/sessions/:id 同步给服务端（best-effort，失败 swallow）。
  useEffect(() => {
    if (!activeSessionId || !isHydrated) return;
    const nextTitle = deriveSessionTitle(messages);
    const rawPreview = deriveSessionPreview(messages);
    const nextPreview =
      rawPreview.length > 120 ? `${rawPreview.slice(0, 120)}...` : rawPreview;

    let titleActuallyChanged = false;
    setSessions((currentSessions) => {
      let changed = false;
      const nextSessions = currentSessions.map((session) => {
        if (session.id !== activeSessionId) return session;
        const titleChanged = session.title !== nextTitle;
        const previewChanged = session.preview !== nextPreview;
        if (!titleChanged && !previewChanged) return session;
        changed = true;
        if (titleChanged) titleActuallyChanged = true;
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

    // 仅在 title 真的变了时打 PATCH——避免每次 messages 微动都发请求。
    if (titleActuallyChanged && nextTitle && nextTitle !== "新对话") {
      void updateSessionTitleOnApi(activeSessionId, nextTitle);
    }
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

  async function handleStop() {
    const sessionId = activeSessionId;
    await stop();
    if (!sessionId) return;
    try {
      await fetch(`/api/chat/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
      });
    } catch (stopError) {
      console.error("Failed to stop chat run", stopError);
    }
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId === activeChatId) return;
    if (status === "streaming" || status === "submitted") {
      await handleStop();
    }
    setActiveChatId(sessionId);
    setDraft("");
  }

  async function handlePickerSubmit({
    workspace,
    workspaceAccessMode,
    shellApprovalPolicy,
  }: WorkspacePickerSubmit) {
    if (status === "streaming" || status === "submitted") {
      await handleStop();
    }
    const draftSession = createSession(
      workspace,
      workspaceAccessMode,
      shellApprovalPolicy,
    );
    // 新会话没 DB 历史，预填空数组省一次 GET /api/chat/history。
    setHydratedMessages((prev) => ({ ...prev, [draftSession.id]: [] }));

    // 服务端建 thread 元数据（带 accessMode / shellApprovalPolicy）。
    // 不等返回也 OK（chat route 的 upsertThread 是兜底），但等一下能拿到服务端
    // canonical 的 created_at / updated_at，sidebar 排序更准。
    const persistedSession = await createSessionOnApi(draftSession);
    setSessions((currentSessions) => [persistedSession, ...currentSessions]);
    setActiveChatId(persistedSession.id);
    setDraft("");
    setPickerOpen(false);
  }

  const activeAccessMode =
    activeSession?.workspaceAccessMode ?? DEFAULT_WORKSPACE_ACCESS_MODE;

  /**
   * Plan 模式下的实时进度：数最新一条 assistant 消息里的 tool-* part 数量。
   * 仅 streaming 期间且 plan mode 开启时计算；其它情况返回 null。
   *
   * 用途：SessionHeader 状态点旁显示"探索 N 次"，让用户看到 agent 在干活——
   * plan 模式过滤了 update_plan 工具，否则用户没有 plan checkbox 进度可看。
   */
  const planStepInfo = useMemo(() => {
    if (!activeSession?.planMode) return null;
    if (status !== "streaming" && status !== "submitted") return null;
    const latest = [...messages].reverse().find((m) => m.role === "assistant");
    if (!latest) return null;
    const toolCallCount = latest.parts.filter(
      (p) => typeof p.type === "string" && p.type.startsWith("tool-"),
    ).length;
    return { toolCallCount };
  }, [messages, activeSession?.planMode, status]);

  /**
   * 数当前还在跑的 spawn_agent 数量。判定标准：
   *   tool part type = "tool-spawn_agent" 且 state ∈ {"input-streaming", "input-available"}
   * （执行完毕的会变成 "output-available" / "output-error"，不算在跑）
   *
   * 用于 SessionHeader 显示"● N subagent 跑着"的紫色提示，避免 spawn_agent 长跑（30s-3min）
   * 时用户以为对话卡死。
   */
  const activeSubagentCount = useMemo(() => {
    let count = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts) {
        if (
          typeof p.type === "string" &&
          p.type === "tool-spawn_agent" &&
          (p as { state?: string }).state !== undefined &&
          ((p as { state: string }).state === "input-streaming" ||
            (p as { state: string }).state === "input-available")
        ) {
          count++;
        }
      }
    }
    return count;
  }, [messages]);

  /**
   * 切换 PermissionMode：循环 default → acceptEdits → bypassPermissions → default。
   * 流式中禁止切（避免 mid-step 状态混乱）；本地立即更新 UI，后端 PATCH 异步落库。
   */
  function handleCyclePermissionMode() {
    if (!activeSession) return;
    if (status === "streaming" || status === "submitted") return;
    const current = activeSession.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const idx = PERMISSION_MODES.indexOf(current);
    const next: PermissionMode =
      PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length] ??
      DEFAULT_PERMISSION_MODE;
    setSessions((current) =>
      current.map((s) =>
        s.id === activeSession.id ? { ...s, permissionMode: next } : s,
      ),
    );
    void updateSessionPermissionModeOnApi(activeSession.id, next);
  }

  /**
   * 切换 plan 模式开 / 关。流式中禁切；本地立即更新，后端 PATCH 异步落库。
   * 切换会触发 chatTransport memo 重建（planMode 在 deps 里），下一次发送
   * 自动按新的模式跑。
   */
  function handleTogglePlanMode() {
    if (!activeSession) return;
    if (status === "streaming" || status === "submitted") return;
    const next = !(activeSession.planMode === true);
    setSessions((current) =>
      current.map((s) =>
        s.id === activeSession.id ? { ...s, planMode: next } : s,
      ),
    );
    void updateSessionPlanModeOnApi(activeSession.id, next);
  }

  /**
   * 用户点 ProposedPlanCard 的"采用此方案"。
   *
   * 行为：
   * 1. 关掉 plan 模式（触发 PATCH + 本地 state，下一次请求 body.planMode=false）
   * 2. 自动发一条 user message 让 agent 按已经在历史里的 plan 实施
   *
   * plan 文本本身已经在 conversation 里，不必把它再 sendMessage 一次——agent 看到
   * 上一条 assistant 的 `<proposed_plan>` + 我们的"开始实施"指令就能继续。
   */
  function handleAdoptPlan(planContent: string) {
    if (!activeSession) return;
    void planContent; // 不使用 —— plan 文本已在 conversation 历史里，agent 能看到
    if (status === "streaming" || status === "submitted") return;

    // 1. 切出 plan 模式
    if (activeSession.planMode) {
      setSessions((current) =>
        current.map((s) =>
          s.id === activeSession.id ? { ...s, planMode: false } : s,
        ),
      );
      void updateSessionPlanModeOnApi(activeSession.id, false);
    }

    // 2. 发实施指令。略等一帧让 sessionRef 更新到 planMode=false，下一次 chat
    //    请求才能带上正确的 planMode。React 的 setState 同步发起但 ref 赋值在
    //    下一次 render 才更新——用 setTimeout(0) 让 ref 先到位再发请求。
    //
    // 措辞不要带 `<proposed_plan>` XML 标签：那是给模型解析用的内部协议，对
    // 用户来说"自己消息里出现奇怪 tag"反而别扭。上一条 assistant 消息历史里
    // 就有完整方案，"上面的方案"四个字 agent 完全能懂。
    window.setTimeout(() => {
      void sendMessage({
        text: "采纳上面的方案，请开始实施。",
      });
    }, 0);
  }

  /**
   * 用户点 ImplementationSummaryCard 的"创建 commit"。
   *
   * 直接发一条 user message 让 agent 跑 git status / git add / git commit。
   * commit message 由 agent 自己根据 summary 浓缩，不在前端写死格式。
   * shell 工具的 shellApprovalPolicy 仍然控制 git 命令是否要审批。
   */
  function handleCreateCommit(summaryContent: string) {
    if (!activeSession) return;
    void summaryContent; // summary 已在历史里 agent 能看到
    if (status === "streaming" || status === "submitted") return;

    void sendMessage({
      text:
        "请基于上面的 <implementation_summary>，跑 `git status` 看一下当前改动，" +
        "然后用 `git add` + `git commit -m \"<message>\"` 创建一个 commit。" +
        "commit message 用 summary 浓缩成一行（feat/fix/chore/refactor 前缀）。",
    });
  }

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
          activeSurface={activeSurface}
          workspaces={workspaces}
          workspacesLoading={workspacesLoading}
          workspacesError={workspacesError}
          onSurfaceChange={setActiveSurface}
          onNewSession={() => setPickerOpen(true)}
          onSelectSession={(id) => void handleSelectSession(id)}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {activeSurface === "flows" ? (
            <FlowWorkspace
              workspaces={workspaces}
              workspacesLoading={workspacesLoading}
            />
          ) : (
          <div className="mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-1 flex-col overflow-hidden px-5 py-6 sm:px-8 lg:px-10">
            <SessionHeader
              activeSession={activeSession}
              activeAccessMode={activeAccessMode}
              status={status}
              statusLabel={statusLabel}
              onStop={() => void handleStop()}
              onCyclePermissionMode={handleCyclePermissionMode}
              onTogglePlanMode={handleTogglePlanMode}
              planStepInfo={planStepInfo}
              activeSubagentCount={activeSubagentCount}
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
                        // P3-c: 交互工具（ask_user_question 等）没有 server-side execute，
                        // 卡片收集到用户的选择后靠 addToolOutput 把 output 回灌回去；
                        // 之后窄化后的 sendAutomaticallyWhen 只为这类 client tool
                        // 续发，不会吞掉后端 server-tool loop 的所有权。
                        // 这里做一次 string → typed tool name 的松散 cast，避免把
                        // AI SDK 的泛型类型扩散到整个 tool-card 层。
                        void addToolOutput({
                          tool: tool as Parameters<typeof addToolOutput>[0]["tool"],
                          toolCallId,
                          output,
                        })
                      }
                      onAdoptPlan={handleAdoptPlan}
                      onCreateCommit={handleCreateCommit}
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
          )}
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
