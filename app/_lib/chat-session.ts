import type { UIMessage } from "ai";

import {
  DEFAULT_WORKSPACE_ACCESS_MODE,
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
// 走单文件 import：barrel 会拉到 node:fs（permissions/settings.ts），
// chat-session 同时被 client 引用，barrel 会拉死编译。
import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  type PermissionMode,
} from "@/lib/permissions/mode";
// 走单文件 import：barrel 会拉到 node:fs（spawn-agent.ts → sub-agent.ts → devtools），
// chat-session 同时被 client 引用，编译会挂。
import {
  DEFAULT_SHELL_APPROVAL_POLICY,
  normalizeShellApprovalPolicy,
  type ShellApprovalPolicy,
} from "@/lib/tools/shell-approval";

/**
 * 主页 chat UI 用到的客户端类型、常量和 API 客户端 helper。
 *
 * 演化：
 * - P3-b：消息搬到服务端 SQLite；session 元数据仍在 localStorage
 * - **P3-c（current）**：session 元数据也搬到服务端 `~/.local-agent/agent.db`，
 *   通过 `/api/sessions/*` 路由暴露。localStorage 仅在水合时被清掉一次防迁移残留。
 */

export type WorkspaceOption = {
  root: string;
  name: string;
  description: string;
  isCurrentProject: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  /** 最后一条消息的文本前缀，单独持久化一份用于侧栏预览（不再保存完整 messages）。 */
  preview: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  workspaceName: string;
  workspaceAccessMode: WorkspaceAccessMode;
  /**
   * 会话级 shell 审批策略。
   *
   * - `never`     —— 任何 shell 命令直接跑（demo / 无人值守模式，危险）
   * - `untrusted` —— 已知安全命令（ls / cat / git status 等）直接跑，其它弹审批（默认）
   * - `always`    —— 任何 shell 命令都弹审批（最保守）
   *
   * 写文件 (`write` / `edit`) 不再走审批——open-agents 风格，靠 git diff 事后 review。
   */
  shellApprovalPolicy: ShellApprovalPolicy;
  /**
   * 会话级 PermissionMode（claude-code 风格的三档）：
   * - `default`           —— 现有行为（每个工具按自己 needsApproval 决定）
   * - `acceptEdits`       —— write/edit 自动过审批，shell 仍按原逻辑
   * - `bypassPermissions` —— 全部自动过；**受 settings.json 双闸控制**
   *
   * ACL 规则永远优先于 mode：mode = bypass 也无法压住 ACL deny。
   */
  permissionMode: PermissionMode;
  /**
   * Plan 模式（codex collaboration mode 的移植）。开启后：
   * - system prompt 注入 plan.md 的 128 行规则
   * - toolset 过滤掉 `update_plan` / `write` / `edit`
   * - shell 仍可用，但 prompt 严格要求 non-mutating 命令
   *
   * 跟 PermissionMode 是两个**正交**维度——可以同时开 plan mode + acceptEdits
   * （虽然没意义，反正写工具被过滤了）。
   */
  planMode: boolean;
};

export const STORAGE_KEY = "ai-sdk-demo.chat-sessions";
export const URL_SESSION_PARAM = "session";

export const SUGGESTIONS = [
  "先帮我梳理这个项目的目录结构和主要模块。",
  "这个项目的启动入口、路由和 API 分别在哪里？",
  "请找出和鉴权最相关的文件，并解释它们之间的关系。",
];

export function getPathLabel(root: string): string {
  const normalized = root.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  return parts.at(-1) ?? normalized;
}

export function createSession(
  workspace?: Partial<WorkspaceOption>,
  workspaceAccessMode: WorkspaceAccessMode = DEFAULT_WORKSPACE_ACCESS_MODE,
  shellApprovalPolicy: ShellApprovalPolicy = DEFAULT_SHELL_APPROVAL_POLICY,
  permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
  planMode: boolean = false,
): ChatSession {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    title: "新对话",
    preview: "",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: workspace?.root ?? "",
    workspaceName: workspace?.name ?? "",
    workspaceAccessMode,
    shellApprovalPolicy,
    permissionMode,
    planMode,
  };
}

export function extractMessageText(message?: UIMessage): string {
  if (!message) {
    return "";
  }

  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function deriveSessionTitle(messages: UIMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const rawTitle = extractMessageText(firstUserMessage);

  if (!rawTitle) {
    return "新对话";
  }

  return rawTitle.length > 24 ? `${rawTitle.slice(0, 24)}...` : rawTitle;
}

export function deriveSessionPreview(messages: UIMessage[]): string {
  // 侧栏预览跳过 role=system 消息——它们是 UI 标记（如 compaction 通知），
  // 内容不是真实对话，不应该当成"最近一句话"展示。
  const lastTextMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role !== "system" && extractMessageText(message),
    );

  // 侧栏 preview 也跑一次 strip：assistant 消息里 `<proposed_plan>` /
  // `<implementation_summary>` XML 块对用户来说没意义，但被 LLM 写在 text part
  // 里，extractMessageText 拿到的是含标签的原文。直接展示会让 sidebar 出现
  // "<proposed_plan> # Title ## Summary ..." 这种生 XML 文本。
  return stripAssistantBlocks(extractMessageText(lastTextMessage));
}

/**
 * 把 assistant text 里的 XML 块拆解：
 * - 完整对（`<tag>...</tag>`）→ 用块内 markdown 内容替代标签
 * - 未闭合的开标签（流式中）→ 标签和后面的内容全部丢弃
 *
 * 跟 `app/_components/assistant-blocks.ts` 的 splitOnBlocks 同思路，但这里
 * 输出**纯文本**（给 sidebar / 任何不需要渲染卡片的场景用），不分段。
 */
function stripAssistantBlocks(text: string): string {
  if (!text) return text;
  // 完整对：用块内 trim 后的内容替代
  let out = text.replace(
    /<(proposed_plan|implementation_summary)>([\s\S]*?)<\/\1>/g,
    (_, _tag, inner: string) => inner.trim(),
  );
  // 未闭合的开标签：截断到开标签之前
  const unclosed = out.match(/<(proposed_plan|implementation_summary)>/);
  if (unclosed && unclosed.index !== undefined) {
    out = out.slice(0, unclosed.index);
  }
  return out.trim();
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

// ========== API client helpers ===========================================
//
// 直接 fetch /api/sessions 的小封装。前端代码只跟这一层打交道，
// 不需要知道服务端 Thread 字段名（snake_case → camelCase 已在路由层做完）。

/** 服务端 `Thread` 形状（route.ts:GET /api/sessions 返回的）。 */
type ApiThread = {
  id: string;
  workspaceRoot: string;
  workspaceName: string | null;
  workspaceAccessMode: string | null;
  shellApprovalPolicy: string | null;
  permissionMode: string | null;
  planMode: boolean;
  title: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

function threadToSession(thread: ApiThread): ChatSession {
  return {
    id: thread.id,
    title: thread.title ?? "新对话",
    preview: "", // 派生字段，从 messages 里算；列表里如果还没拉过 messages 就先空着
    createdAt: new Date(thread.createdAt).toISOString(),
    updatedAt: new Date(thread.updatedAt).toISOString(),
    workspaceRoot: thread.workspaceRoot,
    workspaceName: thread.workspaceName ?? "",
    workspaceAccessMode: normalizeWorkspaceAccessMode(thread.workspaceAccessMode),
    shellApprovalPolicy: normalizeShellApprovalPolicy(thread.shellApprovalPolicy),
    permissionMode: normalizePermissionMode(thread.permissionMode),
    planMode: thread.planMode === true,
  };
}

/** GET /api/sessions —— 拉所有未归档会话。失败返回空数组。 */
export async function fetchSessions(): Promise<ChatSession[]> {
  try {
    const response = await fetch("/api/sessions");
    if (!response.ok) {
      console.warn("[sessions] list failed:", response.status);
      return [];
    }
    const data = (await response.json()) as { threads?: ApiThread[] };
    return (data.threads ?? []).map(threadToSession);
  } catch (error) {
    console.warn("[sessions] list error:", error);
    return [];
  }
}

/**
 * POST /api/sessions —— picker 提交时显式建 thread。
 * 服务端 upsert：若 id 已存在直接返回老的，幂等。
 */
export async function createSessionOnApi(session: ChatSession): Promise<ChatSession> {
  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: session.id,
        workspaceRoot: session.workspaceRoot,
        workspaceName: session.workspaceName,
        workspaceAccessMode: session.workspaceAccessMode,
        shellApprovalPolicy: session.shellApprovalPolicy,
        permissionMode: session.permissionMode,
        planMode: session.planMode,
        title: session.title,
      }),
    });
    if (!response.ok) {
      console.warn("[sessions] create failed:", response.status);
      return session;
    }
    const data = (await response.json()) as { thread: ApiThread };
    return threadToSession(data.thread);
  } catch (error) {
    console.warn("[sessions] create error:", error);
    return session;
  }
}

/** PATCH /api/sessions/:id —— 改 title。失败 swallow（前端 state 不回滚，下次刷新自然修正）。 */
export async function updateSessionTitleOnApi(
  id: string,
  title: string,
): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  } catch (error) {
    console.warn("[sessions] patch title error:", error);
  }
}

/** PATCH /api/sessions/:id —— 改 permissionMode。失败 swallow，跟 title 同样策略。 */
export async function updateSessionPermissionModeOnApi(
  id: string,
  permissionMode: PermissionMode,
): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissionMode }),
    });
  } catch (error) {
    console.warn("[sessions] patch permissionMode error:", error);
  }
}

/** PATCH /api/sessions/:id —— 切 plan mode 开关。失败 swallow。 */
export async function updateSessionPlanModeOnApi(
  id: string,
  planMode: boolean,
): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planMode }),
    });
  } catch (error) {
    console.warn("[sessions] patch planMode error:", error);
  }
}

/** DELETE /api/sessions/:id —— 永久删除（messages + jsonl + 元数据）。 */
export async function deleteSessionOnApi(id: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (error) {
    console.warn("[sessions] delete error:", error);
  }
}
