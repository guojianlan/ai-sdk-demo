# ai-sdk-demo

一个面向本地代码仓库的 AI SDK agent dev flow 原型。

这个项目不是通用聊天壳子，而是一个专门拿来研究和搭建 coding agent 工作流的 Next.js 16 实验仓库。它把工作区选择、代码阅读工具、写入审批、prompt 分层、subagent、MCP 工具接入都放进了同一个项目里。

## 它做什么

- 提供一个中文聊天界面，让 Agent 以"开发工程师"的角色分析你选中的工作区。
- 通过 `workspace-tools` 模式把目录遍历、代码搜索、文件读取能力暴露给模型。
- 通过 `write_file` / `edit_file` 工具演示"先审批、再落盘"的安全写入流程。
- 提供 `bypass permissions` 会话开关，用来测试自动批准写入的体验差异。
- 通过 `explore_workspace` 子 agent，把"需要读很多文件的调查任务"隔离到单独上下文里执行，再返回摘要给主 agent。
- 通过自写的 weather MCP server 演示 `@ai-sdk/mcp` 的动态工具接入。

## 技术栈

- `Next.js 16`
- `React 19`
- `Vercel AI SDK v6`
- `Tailwind CSS v4`
- `Zod v4`
- `@ai-sdk/devtools`
- `@ai-sdk/mcp` + `@modelcontextprotocol/sdk`
- `@vscode/ripgrep`

## 结构图

```text
Browser UI
  |
  +-- /                    app/page.tsx
        |
        +-- useChat(DefaultChatTransport)
        +-- 会话管理(localStorage)
        +-- 工作区选择 / access mode / approval UI
        +-- 工具卡片渲染(read / search / write / approval / explorer)
        +-- PlanCard(streamObject)

Route Handlers
  |
  +-- /api/workspaces       app/api/workspaces/route.ts
  |     +-- listAvailableWorkspaces()
  |
  +-- /api/chat             app/api/chat/route.ts + agent-config.ts
  |     +-- createChatAgent(lib/chat-agent/builder.ts)
  |     +-- prompt layers: persona + developer rules + env_context + AGENTS.md
  |     +-- tools
  |           +-- workspaceToolset(list_files / search_code / read_file)
  |           +-- writeToolset(write_file / edit_file, needsApproval)
  |           +-- subagentToolset(explore_workspace)
  |           +-- weather MCP(get_weather / get_forecast, 动态)
  |
  +-- /api/plan             app/api/plan/route.ts
        +-- streamObject(planSchema)

Shared Lib
  |
  +-- lib/env.ts                全仓 env 读取 + 启动期校验
  +-- lib/gateway.ts            OpenAI-compatible gateway 实例
  +-- lib/chat-agent/           builder + buildSystemPrompt 单入口
  +-- lib/chat/sanitize-messages.ts  UI message 清洗
  +-- lib/tool-result.ts        ToolResult<T> discriminated union
  +-- lib/workspaces.ts         路径校验 + 目录遍历 + rg 搜索
  +-- lib/workspace-tools.ts    把工作区能力包装成 AI SDK tools
  +-- lib/write-tools.ts        write_file + edit_file + approval
  +-- lib/subagents/explorer.ts explorer 子 agent
  +-- lib/mcp/weather-client.ts @ai-sdk/mcp client 拉起 weather server
  +-- lib/session-primer.ts     environment_context + AGENTS.md 收集
  +-- lib/prompt-layers.ts      多层 prompt 组装
  +-- lib/devtools.ts           instrumentModel = logging + devtools middleware
  +-- lib/middleware/logging.ts 自写 stdout logging middleware
  +-- lib/plan-generator.ts     streamObject plan 生成器
```

## 目录导览

- `app/page.tsx`：主聊天页面，会话、工作区、审批卡片、工具输出都在这里。
- `app/api/chat/route.ts`：聊天路由。按 access mode 选择是否开放工作区工具。
- `app/api/chat/agent-config.ts`：persona、developer rules、schema、agent factory。
- `app/api/workspaces/route.ts`：返回可选工作区列表。
- `app/api/plan/route.ts`：plan 生成路由，用 `streamObject`。
- `lib/env.ts`：所有 env 读取的唯一入口，启动期校验。
- `lib/chat-agent/builder.ts`：两条链路共用的 `createChatAgent`（现在只剩主链路，但保留作为抽象）。
- `lib/workspaces.ts`：工作区路径校验、目录遍历、文件读取、代码搜索。
- `lib/workspace-tools.ts`：把工作区能力包装成 AI SDK tools。
- `lib/write-tools.ts`：写入与 search-replace 编辑工具，带 approval 机制。
- `lib/tool-result.ts`：`ToolResult<T>` discriminated union + `toolOk` / `toolErr` helpers。
- `lib/subagents/explorer.ts`：只读 explorer 子 agent。
- `lib/mcp/weather-client.ts`：weather MCP client，按请求 spawn 子进程。
- `mcp-servers/weather/`：自写 weather MCP server。
- `lib/session-primer.ts`：组装 `environment_context` 和 `AGENTS.md` 指令。
- `lib/prompt-layers.ts`：把 persona / rules / context / user instructions 分层拼接。
- `docs/`：项目设计思路、Codex prompt 分层分析、roadmap。
- `examples/`：接口调用示例。

## 主链路

适合"先读代码，再回答或修改"的工作流。

- 页面发消息到 `/api/chat`
- 路由按 `workspaceAccessMode` 选择 agent
- agent 在 `prepareCall` 里构建 prompt layers 和 session primer
- 模型按需调用 `list_files`、`search_code`、`read_file`
- 若需要修改文件，则调用 `write_file` 或 `edit_file`
- 默认写入前必须由用户在 UI 上批准
- 调查类问题（需要读多文件）会走 `explore_workspace` 子 agent，只把摘要回传

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

复制 `.env.example` 到 `.env.local`，填一组可用的 OpenAI-compatible gateway 配置：

```bash
GEMINI_BASE_URL=http://127.0.0.1:8317/v1
GEMINI_API_KEY=your-api-key-here
GEMINI_MODEL=gemini-2.5-flash
```

也可以用 `OPENAI_COMPAT_*` 代替 `GEMINI_*`（作用相同，只是命名更中立）。

3. 启动开发环境

```bash
npm run dev
```

如果你想同时看 AI SDK 的调试面板：

```bash
npm run dev:all
```

- App: `http://localhost:3000`
- Devtools: `http://localhost:4983`

## 访问模式

### `workspaceAccessMode`

- `workspace-tools`：允许模型读取所选工作区内容。
- `no-tools`：模型只知道工作区名字，但不能读目录或文件。

## 当前仓库更像什么

它更像"agent 架构实验场"，而不是最终产品。重点价值在于：

- 怎样把 prompt 分层做清楚
- 怎样让工具调用可视化、可审批
- 怎样约束工作区读写边界
- 怎样把 subagent 引入主对话而不污染上下文
- 怎样接入 MCP 动态工具并做好生命周期
- 怎样把中间件 / 可观测性叠起来（logging + devtools）

如果你是想顺着源码理解项目，建议阅读顺序是：

1. `app/page.tsx`
2. `app/api/chat/route.ts` + `app/api/chat/agent-config.ts`
3. `lib/chat-agent/builder.ts` + `lib/chat-agent/system-prompt.ts`
4. `lib/workspace-tools.ts`
5. `lib/workspaces.ts`
6. `lib/write-tools.ts` + `lib/tool-result.ts`
7. `lib/session-primer.ts` + `lib/prompt-layers.ts`
8. `lib/subagents/explorer.ts`
9. `lib/mcp/weather-client.ts` + `mcp-servers/weather/`
10. `docs/roadmap.md`
