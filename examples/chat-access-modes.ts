import {
  WORKSPACE_ACCESS_MODE_DESCRIPTIONS,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";

type ChatRequestExample = {
  title: string;
  body: {
    workspaceRoot: string;
    workspaceName: string;
    workspaceAccessMode: WorkspaceAccessMode;
    messages: unknown[];
  };
  notes: string[];
};

const baseMessage = [
  {
    id: "msg_1",
    role: "user",
    parts: [
      {
        type: "text",
        text: "请解释一下这个项目的 app/page.tsx 主要负责什么。",
      },
    ],
  },
];

export const chatAccessModeExamples: Record<
  WorkspaceAccessMode,
  ChatRequestExample
> = {
  "workspace-tools": {
    title: "允许读工作区模式",
    body: {
      workspaceRoot: "/absolute/path/to/your/workspace",
      workspaceName: "your-workspace",
      workspaceAccessMode: "workspace-tools",
      messages: baseMessage,
    },
    notes: [
      WORKSPACE_ACCESS_MODE_DESCRIPTIONS["workspace-tools"],
      "后端会向模型暴露 list_files、search_code、read_file 三个工具。",
      "模型可以通过这些工具间接触发 fs / rg，并基于真实文件回答问题。",
    ],
  },
  "no-tools": {
    title: "无工具模式",
    body: {
      workspaceRoot: "/absolute/path/to/your/workspace",
      workspaceName: "your-workspace",
      workspaceAccessMode: "no-tools",
      messages: baseMessage,
    },
    notes: [
      WORKSPACE_ACCESS_MODE_DESCRIPTIONS["no-tools"],
      "后端不会向模型注册任何读目录、读文件或搜索代码的工具。",
      "如果只给路径不给工具，模型只能基于通用知识回答，不能声称读过你的文件。",
    ],
  },
};
