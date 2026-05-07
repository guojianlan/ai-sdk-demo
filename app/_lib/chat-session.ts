import type { UIMessage } from "ai";

import {
  DEFAULT_WORKSPACE_ACCESS_MODE,
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
// 走单文件 import：barrel 会拉到 node:fs（task.ts → explorer.ts → devtools），
// chat-session 同时被 client 引用，编译会挂。
import {
  DEFAULT_SHELL_APPROVAL_POLICY,
  normalizeShellApprovalPolicy,
  type ShellApprovalPolicy,
} from "@/lib/tools/shell-approval";

/**
 * 主页 chat UI 用到的客户端类型、常量和 localStorage 相关的纯函数。
 * 抽出来独立一个文件，page.tsx 和各个子组件都可以按需 import。
 *
 * ⚠ P3-b 后 `ChatSession` 不再携带 `messages`：消息存在服务端 SQLite，
 * 页面挂载/切 session 时用 `GET /api/chat/history?id=<sessionId>` 拉回来。
 * localStorage 里只留 session 元数据 + 一个派生 `preview` 字段给侧栏展示。
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
  };
}

export function sanitizeSessions(input: unknown): ChatSession[] {
  if (!Array.isArray(input)) {
    return [createSession()];
  }

  const sessions = input
    .map((item) => {
      const session = item as Partial<ChatSession> & { messages?: unknown };

      if (typeof session?.id !== "string" || typeof session?.title !== "string") {
        return null;
      }

      return {
        id: session.id,
        title: session.title || "新对话",
        // 旧 snapshot 里 preview 可能不存在；没有就置空，下次消息进来会自动回填。
        preview: typeof session.preview === "string" ? session.preview : "",
        createdAt:
          typeof session.createdAt === "string" && session.createdAt
            ? session.createdAt
            : new Date().toISOString(),
        updatedAt:
          typeof session.updatedAt === "string" && session.updatedAt
            ? session.updatedAt
            : new Date().toISOString(),
        workspaceRoot:
          typeof session.workspaceRoot === "string" ? session.workspaceRoot : "",
        workspaceName:
          typeof session.workspaceName === "string" ? session.workspaceName : "",
        workspaceAccessMode: normalizeWorkspaceAccessMode(
          session.workspaceAccessMode,
        ),
        // 迁移：旧 snapshot 里如果有 `bypassPermissions: true`，等价于之前「写入不弹卡」
        // —— 现在写入根本不弹卡了，bypass 字段没意义。但 shell 审批是独立维度，
        // 没法直接映射，全部回落到默认 `untrusted`。新写入的 session 一律带新字段。
        shellApprovalPolicy: normalizeShellApprovalPolicy(
          (session as { shellApprovalPolicy?: unknown }).shellApprovalPolicy,
        ),
      } satisfies ChatSession;
    })
    .filter((session): session is ChatSession => session !== null);

  return sessions.length > 0 ? sessions : [createSession()];
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

  return extractMessageText(lastTextMessage);
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
