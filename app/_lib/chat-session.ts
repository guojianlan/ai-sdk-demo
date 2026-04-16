import type { UIMessage } from "ai";

import {
  DEFAULT_WORKSPACE_ACCESS_MODE,
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";

/**
 * 主页 chat UI 用到的客户端类型、常量和 localStorage 相关的纯函数。
 * 抽出来独立一个文件，page.tsx 和各个子组件都可以按需 import，不用把这些
 * 散落在大文件里。
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
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  workspaceName: string;
  workspaceAccessMode: WorkspaceAccessMode;
  /**
   * 会话级"自动批准"开关。开启后写入工具的 needsApproval 会返回 false，
   * Agent 直接执行不弹确认。默认 false（安全态）。
   */
  bypassPermissions: boolean;
  messages: UIMessage[];
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
  bypassPermissions = false,
): ChatSession {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    workspaceRoot: workspace?.root ?? "",
    workspaceName: workspace?.name ?? "",
    workspaceAccessMode,
    bypassPermissions,
    messages: [],
  };
}

export function sanitizeSessions(input: unknown): ChatSession[] {
  if (!Array.isArray(input)) {
    return [createSession()];
  }

  const sessions = input
    .map((item) => {
      const session = item as Partial<ChatSession>;

      if (
        typeof session?.id !== "string" ||
        typeof session?.title !== "string" ||
        !Array.isArray(session?.messages)
      ) {
        return null;
      }

      return {
        id: session.id,
        title: session.title || "新对话",
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
        // 旧快照里没有 bypassPermissions，缺省一律按 false 处理（安全态）。
        bypassPermissions: session.bypassPermissions === true,
        messages: session.messages as UIMessage[],
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

export function getSessionPreview(messages: UIMessage[]): string {
  const lastTextMessage = [...messages]
    .reverse()
    .find((message) => extractMessageText(message));

  return extractMessageText(lastTextMessage) || "先选择工作区，再开始提问。";
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
