# Open Agents / Workflow SDK 集成规划

> 目标：把当前 `ai-sdk-demo` 从“请求内运行的本地 workspace agent demo”演进成更接近 `tmp/open-agents-main` 的 agent dev flow：Workflow SDK 承载 durable server agent，sandbox 成为独立执行环境，agent/tools/skills 对齐 Open Agents，UI 逐步迁移到 Open Agents 风格，并用 Streamdown 替换 `react-markdown`。

## 1. 背景与目标

当前仓库已经具备：

- Next.js 16 + AI SDK v6 主聊天链路
- workspace 读文件 / 搜索 / 写入审批
- SQLite 消息持久化
- 进程内 active stream resume
- Plan mode / `update_plan`
- explorer subagent
- weather MCP
- context compaction
- interactive tools

但它仍然是“主聊天 POST 请求内跑完整 agent loop”的形态。`tmp/open-agents-main` 的核心架构不同：

```text
Web UI -> Workflow run -> Sandbox
```

关键原则：**agent 不是 sandbox**。Agent 运行在 durable workflow 中，sandbox 只是 filesystem / shell / git / dev server / preview port 的执行环境。

本规划要达成四个方向：

1. **Workflow SDK**：集成 `workflow`，优先本地 local workflow 开发模式，后续可切 Vercel durable backend。
2. **Sandbox 抽象**：模仿 Open Agents 的 `Sandbox` interface，把当前本机 workspace 先适配成 `LocalSandbox`，未来再接 Vercel sandbox。
3. **Agent / Tools / Skills 对齐**：工具命名、prompt、subagent、skills discovery 向 `tmp/open-agents-main/packages/agent` 靠拢。
4. **UI / Markdown 迁移**：逐步迁移成 Open Agents 的 tool-call / session UI 结构，并用 Streamdown 替换 `react-markdown`。

非目标：

- 第一阶段不引入 Open Agents 的完整 auth / GitHub App / Postgres / Vercel OAuth。
- 第一阶段不直接复制整套 cloud sandbox 生命周期；先用 local sandbox 跑通接口。
- 第一阶段不改变现有 `.data/chat.db` 的全部模型，只增量扩展 workflow run / sandbox state 表。

## 2. 外部与本地参考

### 2.1 Workflow SDK

官方 Next.js 集成要点：

- 安装 `workflow`。
- 在 `next.config.ts` 里用 `withWorkflow(nextConfig)` 包裹配置。
- `"use workflow"` 标记 durable workflow function。
- `"use step"` 标记可缓存、可重试、具备完整 Node.js 能力的 step function。
- API route 通过 `start(workflowFn, args)` 启动 workflow。
- workflow run 可通过 `getWritable()` 写流，API route 可返回 `run.readable` / `run.getReadable()`。

本仓库对应落点：

- `next.config.ts`：接入 `withWorkflow`。
- `app/workflows/chat.ts`：新增主 agent workflow。
- `app/workflows/sandbox-lifecycle.ts`：后续新增 sandbox idle / hibernate / cleanup workflow。
- `app/api/chat/route.ts`：从直接 `createAgentUIStreamResponse` 改为 `start(runAgentWorkflow, [...])` 后返回 workflow stream。
- `app/api/chat/[chatId]/stream/route.ts`：从进程内 Map 切到 `workflow/api` 的 `getRun(runId).getReadable()`。

### 2.2 Streamdown

Streamdown 是 `react-markdown` 的 streaming-friendly 替代品，支持 `react-markdown` 常见 props，并内建 GFM、代码高亮、mermaid、数学公式、预设 typography 和内部 memoization。

本仓库对应落点：

- `package.json`：新增 `streamdown`，移除不再需要的 `react-markdown` / `remark-gfm`。
- `app/globals.css`：Tailwind v4 增加 `@source "../node_modules/streamdown/dist/*.js";`。
- `app/layout.tsx` 或 markdown 渲染入口：引入 `streamdown/styles.css`。
- `app/_components/AssistantMarkdown.tsx`：替换为 Streamdown wrapper，保留必要的链接定制。

### 2.3 Open Agents 本地参考

重点参考路径：

- `tmp/open-agents-main/apps/web/next.config.ts`
- `tmp/open-agents-main/apps/web/app/api/chat/route.ts`
- `tmp/open-agents-main/apps/web/app/workflows/chat.ts`
- `tmp/open-agents-main/packages/sandbox/interface.ts`
- `tmp/open-agents-main/packages/sandbox/vercel/sandbox.ts`
- `tmp/open-agents-main/packages/agent/open-harness-agent.ts`
- `tmp/open-agents-main/packages/agent/system-prompt.ts`
- `tmp/open-agents-main/packages/agent/tools/*`
- `tmp/open-agents-main/packages/agent/skills/*`
- `tmp/open-agents-main/apps/web/components/tool-call/*`
- `tmp/open-agents-main/apps/web/lib/streamdown-config.tsx`

## 3. 目标架构

### 3.1 分层

```text
Browser UI
  |
  | useChat(DefaultChatTransport)
  v
POST /api/chat
  |
  | validate chat/session/workspace
  | persist latest user message
  | create or reconnect sandbox runtime
  | discover skills
  | start workflow
  v
Workflow run: app/workflows/chat.ts
  |
  | loop runAgentStep()
  | stream UIMessageChunk via getWritable()
  | persist assistant message after every terminal/pause point
  | record run/step status
  v
Agent
  |
  | tools read/write/edit/grep/glob/bash/task/todo/skill/ask_user_question/web_fetch
  v
Sandbox adapter
  |
  +-- LocalSandbox: current machine workspace
  +-- CloudSandbox: future Vercel sandbox
```

### 3.2 数据模型变化

当前 SQLite 已有：

- `messages`
- `session_summaries`

建议新增：

- `workflow_runs`
  - `id`
  - `chat_id`
  - `status`: `pending | running | completed | failed | cancelled`
  - `started_at`
  - `finished_at`
  - `total_duration_ms`
  - `error`
- `workflow_run_steps`
  - `workflow_run_id`
  - `step_number`
  - `started_at`
  - `finished_at`
  - `duration_ms`
  - `finish_reason`
  - `raw_finish_reason`
- `chat_runtime_state`
  - `chat_id`
  - `active_stream_id`
  - `sandbox_state_json`
  - `sandbox_expires_at`
  - `updated_at`
- `skills`
  - 可选：第一阶段不必入库，可每次从 workspace / `.agents/skills` discover。

第一阶段可以继续用 `better-sqlite3`，避免把项目提前拖进 Postgres / Drizzle 迁移。

## 4. 迁移阶段

## Phase 0：依赖与基线准备

目标：只接入依赖和配置，不改变运行路径。

改动：

- 安装：
  - `workflow`
  - `streamdown`
  - 视 UI 迁移需要再引入 `lucide-react`、`clsx`、`tailwind-merge`
- `next.config.ts`：
  - 保留 `allowedDevOrigins`
  - 包裹 `withWorkflow(nextConfig)`
- `tsconfig.json`：
  - 按 `workflow` 本地文档决定是否添加 workflow plugin。
- `app/globals.css`：
  - 加 Streamdown Tailwind v4 source。
- `app/layout.tsx`：
  - 引入 `streamdown/styles.css`。

验证：

- `npm run lint`
- 不跑 build，除非 Next / workflow 配置触发 lint 无法覆盖的问题。

风险：

- 本仓库是 Next.js 16.2.3；Workflow 官方文档提到 Next 16.1+ 兼容问题需要较新 `workflow` 版本，因此必须使用当前 latest 或至少 `4.0.1-beta.26+`。

## Phase 1：Workflow 包住当前 server agent

目标：不改工具语义，先把主 agent run 从 `/api/chat` 请求内迁到 workflow。

新增：

- `app/workflows/chat.ts`
  - `runAgentWorkflow(options)`
  - `"use workflow"`
  - 内部循环调用 `runAgentStep(...)`
  - 使用 `getWritable<UIMessageChunk>()` 把 AI SDK chunks 写给前端。
- `lib/workflow-store.ts`
  - 保存 active stream id / run status / step timing。

改造：

- `app/api/chat/route.ts`
  - 保留现有消息清洗、compaction、workspace 校验。
  - 改为启动 workflow：
    - 先保存 latest user message。
    - 如果 `chat.activeStreamId` 指向运行中 workflow，则直接 reconnect。
    - 否则 `start(runAgentWorkflow, [options])`。
    - 保存 `activeStreamId = run.runId`。
    - 返回 `createUIMessageStreamResponse({ stream: run.getReadable() })`。
- `app/api/chat/[chatId]/stream/route.ts`
  - 从 `activeStreams.subscribe()` 改为读取 DB 的 `activeStreamId`，再 `getRun(runId).getReadable()`。
- `lib/active-streams.ts`
  - Phase 1 后废弃或保留为 fallback。

保留：

- `createProjectEngineerAgent`
- 当前 `workspaceToolset` / `writeToolset` / `interactiveToolset`
- 当前 SQLite `messages`
- 当前 compaction

关键设计：

- workflow function 只做 orchestration。
- AI SDK 调用、DB、fs、MCP 初始化等 Node 逻辑尽量放在 `"use step"` 函数里。
- 流写入必须在 step 里获取 writer，写完释放 lock。

验收：

- 发送一条普通消息，workflow run 启动并返回 streaming UI。
- 刷新页面后能通过 workflow run 恢复流。
- `stop()` 能取消 workflow，而不是只中断 HTTP 请求。
- 写入审批仍可 round-trip。

## Phase 2：引入 Sandbox 接口与 LocalSandbox

目标：把当前 workspace fs 操作抽象成 sandbox 工具，而不是让 agent 直接知道本机路径。

新增：

- `lib/sandbox/interface.ts`
  - 参考 Open Agents `Sandbox` interface：
    - `type`
    - `workingDirectory`
    - `env`
    - `currentBranch`
    - `environmentDetails`
    - `readFile`
    - `writeFile`
    - `stat`
    - `access`
    - `mkdir`
    - `readdir`
    - `exec`
    - `execDetached`
    - `domain`
    - `stop`
    - `extendTimeout`
    - `snapshot`
    - `getState`
- `lib/sandbox/local.ts`
  - 用当前本机 workspace 实现 `LocalSandbox`。
  - `workingDirectory = workspaceRoot`。
  - `exec` 使用 `child_process.execFile` 或受控 `bash -c`。
  - 路径必须继续复用 `resolveWorkspacePath`，拒绝逃逸。
- `lib/sandbox/connect.ts`
  - `connectSandbox(state)`，第一阶段只支持 `{ type: "local", workspaceRoot }`。

改造：

- `lib/workspaces.ts`
  - 保留纯本地 workspace helpers 给 UI 工作区选择使用。
- `lib/workspace-tools.ts`
  - 新建 Open Agents 风格工具：
    - `read`
    - `write`
    - `edit`
    - `grep`
    - `glob`
    - `bash`
  - 或先保留旧工具名并做 compatibility layer。
- `lib/chat-agent/builder.ts`
  - `experimental_context` 中传 `{ sandbox, skills, model, subagentModel }`，而不是只传 `workspaceRoot`。

建议工具命名最终对齐：

| 当前工具 | Open Agents 对齐目标 |
|---|---|
| `list_files` | `glob` 或 `bash ls` |
| `search_code` | `grep` |
| `read_file` | `read` |
| `write_file` | `write` |
| `edit_file` | `edit` |
| `update_plan` | `todo_write` 或保留兼容 |
| `explore_workspace` | `task` with explorer subagent |
| `ask_question` / `ask_choice` | `ask_user_question` |

验收：

- 当前本地工作区仍能读/搜/写。
- Agent prompt 显示 “working directory: workspace root; use workspace-relative paths”。
- 后续加 Vercel sandbox 时 tools 不需要再重写。

## Phase 3：Agent 逻辑对齐 Open Agents

目标：把主 Agent 从“ProjectEngineerAgent”演进成 Open Agents 风格的 autonomous coding agent。

参考：

- `packages/agent/open-harness-agent.ts`
- `packages/agent/system-prompt.ts`
- `packages/agent/tools/*`
- `packages/agent/subagents/*`

改动：

- 新增 `lib/agent/open-harness-agent.ts`
  - 或重命名现有 `lib/chat-agent`。
- 新系统 prompt 包含：
  - Role & Agency
  - Task Persistence
  - Guardrails
  - Fast Context Understanding
  - Parallel Execution
  - Tool Usage
  - Planning
  - Delegation
  - User Input
  - Verification Loop
  - Git Safety
  - Security
  - Skills
- 模型 family overlay：
  - Claude：更强 todo discipline。
  - GPT：更强 autonomous completion。
  - Gemini：更简短响应。
  - 其他模型：通用规则。
- `prepareCall`：
  - 根据请求选择 main model / subagent model。
  - 注入 sandbox context。
  - 注入 discovered skills。
  - 注入 AGENTS.md / custom instructions。

保留本项目特色：

- 现有 compaction 可继续保留，但要评估和 Workflow 的 replay / step cache 的关系。
- 现有 Plan Mode 可以保留；后续可转成 `plan-mode` skill。
- 现有 MCP weather 可以继续作为 dynamic tools，但不应阻塞主 agent run。

验收：

- Agent 能按 Open Agents 风格使用 `todo_write` 维护进度。
- Agent 能通过 `task` 调用 explorer/design/executor subagent。
- Agent 能通过 `skill` 加载 skill 指令。
- Agent 工具调用 UI 能识别新工具名。

## Phase 4：Skills 对齐 Open Agents

目标：基础 skill 能力与 `tmp/open-agents-main` 一致。

当前仓库已有：

- `.agents/skills/ui-ux-pro-max`
- `.claude/skills/ui-ux-pro-max`

Open Agents 参考 skills：

- `agent-browser`
- `ai-sdk`
- `baseline-ui`
- `chat-sdk`
- `code-review`
- `deploy-open-harness`
- `emil-design-eng`
- `frontend-design`
- `plan-mode`
- `remove-demo-limits`
- `vercel-react-best-practices`
- `web-animation-design`
- `workflow`

建议策略：

1. **先复制基础 skill 文件到本仓库 `.agents/skills/`**：
   - `workflow`
   - `ai-sdk`
   - `baseline-ui`
   - `agent-browser`
   - `code-review`
   - `frontend-design`
   - `plan-mode`
   - `vercel-react-best-practices`
2. **实现 discovery**：
   - 参考 `packages/agent/skills/discovery.ts`。
   - 扫描顺序：
     - workspace `.agents/skills`
     - user-level skills，可选
   - 同名 first wins，让项目 skill 覆盖用户 skill。
3. **实现 `skill` tool**：
   - 读取 `SKILL.md` / `skill.md` frontmatter。
   - 支持：
     - `name`
     - `description`
     - `disable-model-invocation`
     - `user-invocable`
     - `allowed-tools`
     - `context`
     - `agent`
   - 调用时返回 skill body，注入 skill directory。
4. **UI 增加 slash command**：
   - 输入 `/` 展示 user-invocable skills。
   - 用户 `/workflow` 时，作为普通消息进入 Agent，由 Agent 第一时间调用 `skill`。

验收：

- `/workflow` 能加载 workflow skill。
- UI 可以展示 available skills。
- Agent prompt 会列出 model-invocable skills。
- 同名 skill 去重逻辑正确。

## Phase 5：UI 迁移到 Open Agents 风格

目标：不是像素级照搬，而是迁移信息架构和组件拆分。

建议优先级：

1. **Tool UI**
   - 迁移 `ToolLayout` 思路：
     - 单行紧凑 header
     - status icon
     - summary
     - meta
     - 可展开详情
     - approval buttons 内联
   - 新增 renderer registry：
     - `bash`
     - `read`
     - `write`
     - `edit`
     - `grep`
     - `glob`
     - `task`
     - `todo_write`
     - `ask_user_question`
     - `skill`
     - `web_fetch`
2. **Message rendering**
   - 支持 reasoning group。
   - 支持 data parts：commit / PR / snippets / compaction notice。
   - 用 Streamdown 渲染 text part。
3. **Session layout**
   - 当前左侧 session sidebar 可以保留，但逐步引入 Open Agents 的：
     - session drawer
     - chat switcher
     - model selector
     - sandbox selector / status chip
     - pinned todo panel
4. **File / diff UX**
   - 读文件工具输出支持可展开代码 viewer。
   - edit/write 输出支持 diff preview。
   - 未来接入 workspace file viewer。

不建议第一阶段迁移：

- GitHub repo selector
- auth guard
- PR merge dialogs
- hosted share links
- voice input

这些依赖 Open Agents 的完整产品模型，当前项目不必急着引入。

## Phase 6：Streamdown 迁移

目标：替换 `react-markdown`，提升 streaming markdown 体验。

改动：

- `package.json`
  - add `streamdown`
  - remove `react-markdown`
  - remove `remark-gfm`，确认没有其他用处后再删
- `app/globals.css`
  - `@source "../node_modules/streamdown/dist/*.js";`
- `app/layout.tsx`
  - `import "streamdown/styles.css";`
- `app/_components/AssistantMarkdown.tsx`
  - 替换为：

```tsx
import { Streamdown } from "streamdown";

export function AssistantMarkdown({ text }: { text: string }) {
  return (
    <Streamdown mode="streaming">
      {text}
    </Streamdown>
  );
}
```

后续增强：

- streaming 中传：
  - `mode={isStreaming ? "streaming" : "static"}`
  - `animated={...}`
  - `isAnimating={isStreaming}`
- 自定义 `components.a`，支持 workspace file link。
- 如果需要 Shiki dual theme，再参考 Open Agents `lib/streamdown-config.tsx`。

验收：

- assistant markdown 正常显示 GFM 列表、表格、代码块。
- streaming 期间没有重复 parse 造成的明显卡顿。
- 移除 `react-markdown` 后 lint 通过。

## Phase 7：Cloud Sandbox / Vercel Sandbox 后续

只有当前面 phases 稳定后再做。

新增：

- `lib/sandbox/vercel/*`
  - 可参考 Open Agents `packages/sandbox/vercel/*`。
- `SandboxState`：
  - `{ type: "local", workspaceRoot }`
  - `{ type: "vercel", sandboxName, source, snapshotId, expiresAt }`
- sandbox lifecycle workflow：
  - idle 检查
  - hibernate / snapshot
  - resume
  - status sync

这一步会引入更多产品选择：

- 是否接 GitHub repo clone？
- 是否允许 push / PR？
- 是否需要 Vercel OAuth？
- 是否仍然支持本地 workspace？

建议保持双模式：

- local mode：当前学习/本地项目分析场景。
- cloud mode：接近 Open Agents 产品化场景。

## 5. 文件落点总览

计划新增：

```text
app/workflows/chat.ts
app/workflows/sandbox-lifecycle.ts
lib/workflow-store.ts
lib/sandbox/interface.ts
lib/sandbox/local.ts
lib/sandbox/connect.ts
lib/sandbox/types.ts
lib/agent/open-harness-agent.ts
lib/agent/system-prompt.ts
lib/agent/tools/
lib/agent/skills/
lib/agent/subagents/
app/_components/open-agents/
```

计划改造：

```text
next.config.ts
package.json
app/globals.css
app/layout.tsx
app/page.tsx
app/api/chat/route.ts
app/api/chat/[chatId]/stream/route.ts
app/api/chat/history/route.ts
app/_components/AssistantMarkdown.tsx
app/_components/MessageBubble.tsx
app/_components/tool-card/*
lib/chat-store.ts
lib/chat-agent/*
lib/workspace-tools.ts
lib/write-tools.ts
lib/subagents/explorer.ts
```

计划逐步废弃：

```text
lib/active-streams.ts
app/_components/tool-card/ToolPartCard.tsx   # 被 Open Agents 风格 renderer registry 替代
app/_components/tool-card/input-views.tsx
app/_components/tool-card/output-views.tsx
```

## 6. 关键决策

### 6.1 先 local sandbox，不先 Vercel sandbox

原因：

- 用户当前重点是“业务或者跑 server agent 的时候模仿 open-agents 的 sandbox 和 agent 逻辑”。
- 当前项目已经基于本机 workspace 工作。
- 先抽接口可以低风险复用现有能力。
- Vercel sandbox 涉及 token、snapshot、repo clone、ports、timeout、lifecycle，应该放在后续 phase。

### 6.2 Workflow 先承载 agent run，不马上重构所有工具

原因：

- 最大架构收益来自 durable run / resumable stream / cancel。
- 工具命名和 sandbox 化可以紧随其后，不需要和 workflow 一次性耦合。

### 6.3 UI 迁移先迁 tool-call，不先迁整页

原因：

- 当前 UI 最大复杂点是 tool part 状态机。
- Open Agents 的 `ToolLayout + renderers` 结构正好能替代当前 `ToolPartCard + input/output views`。
- 整页布局涉及会话、模型、sandbox status、repo/git 面板，适合在 runtime 变稳后再迁。

### 6.4 Skills 采用 Open Agents frontmatter schema

原因：

- 当前仓库已有 `.agents/skills`。
- Open Agents 的 `skill` tool 和 discovery 设计足够轻，不需要引入外部服务。
- 后续 slash command、model-only skill、allowed-tools 都能自然扩展。

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Workflow SDK 与 Next 16 兼容细节 | dev/build 失败 | 先读 `node_modules/workflow/docs/`，使用最新 `workflow`，小步接入 |
| workflow function sandbox 限制 | Node/fs/AI SDK 在 workflow 中报错 | 业务逻辑放 `"use step"`，workflow 只 orchestration |
| 流恢复语义变化 | 前端 `resumeStream()` 行为不一致 | 先保持 AI SDK `createUIMessageStreamResponse` chunk 格式，逐步替换 stream route |
| SQLite schema 扩展混乱 | 历史消息损坏 | 只新增表，不改现有 messages 结构；写迁移脚本或 lazy create |
| Sandbox 抽象过度设计 | 延迟核心迁移 | 第一版只实现 LocalSandbox 需要的方法 |
| 工具名切换破坏现有 UI | tool renderer 不识别 | 先双注册旧名和新名，UI registry 同时支持 |
| Skills 过多导致 prompt 变大 | token 增长 | prompt 只列 metadata，body 通过 `skill` tool 按需加载 |
| Streamdown 样式影响现有视觉 | UI 变形 | 先只替换 assistant text area，保留 wrapper 做局部样式控制 |

## 8. 推荐实施顺序

1. **Workflow + Streamdown 基础依赖**
   - `withWorkflow`
   - Streamdown 最小替换
2. **Workflow chat run**
   - `app/workflows/chat.ts`
   - `/api/chat` start/reconnect
   - stream route 改 `getRun`
   - stop route
3. **LocalSandbox**
   - 抽 `Sandbox` interface
   - 当前 tools 改走 sandbox
4. **Open Agents tools**
   - `read/write/edit/grep/glob/bash/todo_write/task/skill/ask_user_question`
   - 旧工具 compatibility
5. **Skills**
   - discovery
   - skill tool
   - 复制基础 skills
   - slash command UI
6. **Open Agents tool UI**
   - `ToolLayout`
   - renderer registry
   - todo / task / skill / bash / read / edit 优先
7. **Agent prompt and subagents**
   - Open Harness style system prompt
   - model family overlays
   - explorer/design/executor registry
8. **Cloud sandbox**
   - Vercel sandbox adapter
   - lifecycle workflow
   - preview ports
   - optional git/push/PR

## 9. 第一阶段 Done 标准

第一阶段指 Phase 0 + Phase 1 + Streamdown 最小替换。

完成后应满足：

- `next.config.ts` 已接入 `withWorkflow`。
- `/api/chat` 不再直接跑 agent loop，而是启动 workflow run。
- 进行中聊天流通过 workflow run 可恢复。
- 取消按钮能取消 workflow run。
- 消息仍保存到 SQLite。
- 当前 workspace tools 和 write approval 仍可用。
- Assistant markdown 已由 Streamdown 渲染。
- `npm run lint` 通过。

## 10. 第二阶段 Done 标准

第二阶段指 Phase 2 + Phase 3 的最小版本。

完成后应满足：

- 有 `Sandbox` interface。
- 当前本机 workspace 通过 `LocalSandbox` 运行。
- tools 从 `workspaceRoot` context 迁移到 `sandbox` context。
- 新工具名至少支持：
  - `read`
  - `write`
  - `edit`
  - `grep`
  - `glob`
  - `bash`
  - `todo_write`
- Agent prompt 接近 Open Agents 的 task persistence / verification loop / git safety。
- `task` 或兼容 `explore_workspace` 能调用 explorer subagent。

## 11. 第三阶段 Done 标准

第三阶段指 skills + UI 迁移。

完成后应满足：

- `.agents/skills` 中有 Open Agents 基础 skills。
- Agent prompt 只列 skills metadata。
- `skill` tool 能加载 skill body。
- `/skill-name` slash command 能进入 agent。
- Tool UI 改为 `ToolLayout + renderer registry`。
- `todo_write` 有 pinned 或可展开任务视图。
- `task` subagent 有运行状态和最终摘要视图。

## 12. 待确认问题

这些问题不阻塞 Phase 0/1，但会影响 Phase 2 之后的设计：

1. 是否长期保留“本机工作区模式”，还是最终完全转 cloud sandbox？
2. 是否要接 GitHub repo clone / push / PR？
3. 是否要把 SQLite 继续用到底，还是后续迁 Postgres/Drizzle？
4. 是否要保留当前 Plan Mode，还是把它降级成 `plan-mode` skill？
5. `bypass permissions` 是否继续作为会话级开关，还是改成 Open Agents 风格的 command-level approval policy？
6. 是否允许 `bash` 默认免审批，仅危险命令审批？Open Agents 只对 `rm -rf` 等危险模式审批；当前仓库写入默认审批更保守。

## 13. 近期最小任务清单

建议下一步按这个顺序开工：

1. 安装 `workflow` 和 `streamdown`。
2. 用 `withWorkflow` 包裹 `next.config.ts`。
3. 用 Streamdown 替换 `AssistantMarkdown`。
4. 新增 `app/workflows/chat.ts`，把现有 agent run 包进 workflow。
5. 新增 SQLite workflow run / active stream 字段。
6. 改 `/api/chat` 为 workflow start/reconnect。
7. 改 stream route 和 stop route。
8. 跑 `npm run lint`，手测一轮普通聊天、写入审批、刷新恢复。

