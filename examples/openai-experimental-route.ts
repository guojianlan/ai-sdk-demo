export const openAIExperimentalRouteExamples = {
  workspaceToolsetOnly: {
    url: "/api/chat-openai-experimental",
    body: {
      workspaceRoot: "/absolute/path/to/your/workspace",
      workspaceName: "your-workspace",
      toolMode: "workspace-toolset",
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [
            {
              type: "text",
              text: "请梳理这个项目的入口、路由和主要模块。",
            },
          ],
        },
      ],
    },
  },
  shellOnly: {
    url: "/api/chat-openai-experimental",
    body: {
      workspaceRoot: "/absolute/path/to/your/workspace",
      workspaceName: "your-workspace",
      toolMode: "shell",
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [
            {
              type: "text",
              text: "请用 shell 命令分析这个项目的目录结构和入口文件。",
            },
          ],
        },
      ],
    },
  },
  hybrid: {
    url: "/api/chat-openai-experimental",
    body: {
      workspaceRoot: "/absolute/path/to/your/workspace",
      workspaceName: "your-workspace",
      toolMode: "hybrid",
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [
            {
              type: "text",
              text: "请同时比较 workspaceToolset 和 shell 在这个仓库里的分析体验。",
            },
          ],
        },
      ],
    },
  },
} as const;
