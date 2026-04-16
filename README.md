# ai-sdk-demo

一个面向本地代码仓库的 AI SDK agent dev flow 原型。

这个项目不是通用聊天壳子，而是一个专门拿来研究和搭建 coding agent 工作流的 Next.js 16 实验仓库。它把工作区选择、代码阅读工具、写入审批、prompt 分层、subagent，以及不同 tool 粒度的对比实验都放进了同一个项目里。

## 它做什么

- 提供一个中文聊天界面，让 Agent 以“开发工程师”的角色分析你选中的工作区。
- 通过 `workspace-tools` 模式把目录遍历、代码搜索、文件读取能力暴露给模型。
- 通过 `write_file` / `edit_file` 工具演示“先审批、再落盘”的安全写入流程。
- 提供 `bypass permissions` 会话开关，用来测试自动批准写入的体验差异。
- 提供一个实验路由和实验页面，对比细粒度 `workspace-toolset` 与通用只读 `shell` 工具的证据链和交互差异。
- 通过 `explore_workspace` 子 agent，把“需要读很多文件的调查任务”隔离到单独上下文里执行，再返回摘要给主 agent。

## 技术栈

- `Next.js 16`
- `React 19`
- `Vercel AI SDK v6`
- `Tailwind CSS v4`
- `Zod v4`
- `@ai-sdk/devtools`
- `@vscode/ripgrep`

## 结构图

```text
Browser UI
  |
  +-- /                    app/page.tsx
  |     |
  |     +-- useChat(DefaultChatTransport)
  |     +-- 会话管理(localStorage)
  |     +-- 工作区选择 / access mode / approval UI
  |     +-- 工具卡片渲染(read / search / write / approval / explorer)
  |
  +-- /localshell-lab      app/localshell-lab/page.tsx
        |
        +-- 对比 toolMode: workspace-toolset / shell / hybrid
        +-- 直接观察 tool input / output / reasoning

Route Handlers
  |
  +-- /api/workspaces                     app/api/workspaces/route.ts
  |     |
  |     +-- listAvailableWorkspaces()
  |
  +-- /api/chat                           app/api/chat/route.ts
  |     |
  |     +-- ToolLoopAgent(project engineer)
  |     +-- prompt layers
  |     |     +-- persona
  |     |     +-- developer rules
  |     |     +-- environment_context
  |     |     +-- AGENTS.md instructions
  |     |
  |     +-- tools
  |           +-- workspaceToolset(list_files / search_code / read_file)
  |           +-- writeToolset(write_file / edit_file)
  |           +-- subagentToolset(explore_workspace)
  |
  +-- /api/chat-openai-experimental      app/api/chat-openai-experimental/route.ts
        |
        +-- ToolLoopAgent(experimental)
        +-- toolMode: workspace-toolset / shell / hybrid
        +-- shell tool uses read-only command whitelist

Shared Lib
  |
  +-- lib/workspaces.ts
  |     +-- 工作区枚举
  |     +-- 路径归一化与越界防护
  |     +-- 目录遍历 / 文件读取 / rg 搜索
  |
  +-- lib/session-primer.ts
  |     +-- 收集 environment_context
  |     +-- 发现并拼接 AGENTS.md
  |
  +-- lib/prompt-layers.ts
  |     +-- 组装多层 prompt
  |
  +-- lib/shell-tool.ts
  |     +-- 只读 shell 白名单
  |
  +-- lib/subagents/explorer.ts
        +-- explorer 子 agent
```

## 目录导览

- `app/page.tsx`：主聊天页面，会话、工作区、审批卡片、工具输出都在这里。
- `app/localshell-lab/page.tsx`：实验台页面，专门看不同 toolMode 的差异。
- `app/api/chat/route.ts`：正式聊天链路，按 access mode 选择是否开放工作区工具。
- `app/api/chat-openai-experimental/route.ts`：实验链路，比较 `workspace-toolset`、`shell`、`hybrid`。
- `app/api/workspaces/route.ts`：返回可选工作区列表。
- `lib/workspaces.ts`：工作区路径校验、目录遍历、文件读取、代码搜索。
- `lib/workspace-tools.ts`：把工作区能力包装成 AI SDK tools。
- `lib/write-tools.ts`：写入与 search-replace 编辑工具，带 approval 机制。
- `lib/shell-tool.ts`：跨模型通用的只读 shell function tool。
- `lib/subagents/explorer.ts`：只读 explorer 子 agent。
- `lib/session-primer.ts`：组装 `environment_context` 和 `AGENTS.md` 指令。
- `lib/prompt-layers.ts`：把 persona / rules / context / user instructions 分层拼接。
- `docs/`：项目设计思路、Codex prompt 分层分析、roadmap。
- `examples/`：接口调用示例。

## 两条主要链路

### 1. 主聊天链路

适合“先读代码，再回答或修改”的工作流。

- 页面发消息到 `/api/chat`
- 路由按 `workspaceAccessMode` 选择 agent
- agent 在 `prepareCall` 里构建 prompt layers 和 session primer
- 模型按需调用 `list_files`、`search_code`、`read_file`
- 若需要修改文件，则调用 `write_file` 或 `edit_file`
- 默认写入前必须由用户在 UI 上批准

### 2. 实验链路

适合观察“工具粒度如何影响 agent 行为”。

- 页面发消息到 `/api/chat-openai-experimental`
- 通过 `toolMode` 切换三种工具集
- `workspace-toolset`：细粒度、语义明确的 function tools
- `shell`：通用只读 shell tool
- `hybrid`：两边都开，让模型自己决定

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

复制 `.env.example` 到 `.env.local`，至少填一组可用模型配置：

```bash
GEMINI_BASE_URL=http://127.0.0.1:8317/v1
GEMINI_API_KEY=your-api-key-here
GEMINI_MODEL=gemini-2.5-flash

OPENAI_API_KEY=your-openai-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_EXPERIMENT_MODEL=gpt-5-codex
```

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

## 访问模式与工具模式

### `workspaceAccessMode`

- `workspace-tools`：允许模型读取所选工作区内容。
- `no-tools`：模型只知道工作区名字，但不能读目录或文件。

### `toolMode`

- `workspace-toolset`：只开放 `list_files` / `search_code` / `read_file`
- `shell`：只开放只读 `shell` 工具
- `hybrid`：两者都开

## 当前仓库更像什么

它更像“agent 架构实验场”，而不是最终产品。重点价值在于：

- 怎样把 prompt 分层做清楚
- 怎样让工具调用可视化、可审批
- 怎样约束工作区读写边界
- 怎样比较不同工具抽象对模型行为的影响
- 怎样把 subagent 引入主对话而不污染上下文

如果你是想顺着源码理解项目，建议阅读顺序是：

1. `app/page.tsx`
2. `app/api/chat/route.ts`
3. `lib/workspace-tools.ts`
4. `lib/workspaces.ts`
5. `lib/write-tools.ts`
6. `lib/session-primer.ts`
7. `app/api/chat-openai-experimental/route.ts`
8. `lib/shell-tool.ts`
9. `lib/subagents/explorer.ts`
10. `docs/roadmap.md`
