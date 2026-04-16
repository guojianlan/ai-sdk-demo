# ai-sdk-demo 项目架构导览

> 这份文档的目标不是重复 `README.md`，而是把当前仓库真正的代码结构、主流程、关键节点和阅读顺序讲清楚。  
> 读完后你应该能回答 4 个问题：
>
> 1. 这个项目整体做了什么？
> 2. 主页面、实验页面、Plan 模式分别怎么工作？
> 3. 哪些文件是关键节点？各自负责什么？
> 4. 如果我要继续改这个项目，应该从哪里下手？

---

## 1. 一句话概括

这是一个基于 **Next.js 16 + Vercel AI SDK v6** 的本地 coding agent 实验仓库。

它有三条核心能力：

- **主聊天链路**：让 Agent 读取选中的工作区，分析代码、搜索符号、读取文件，并在需要时发起带审批的写入。
- **实验链路**：比较细粒度 `workspace-toolset` 和通用只读 `shell` tool 的差异。
- **Plan 链路**：在执行前先生成结构化计划，让用户 review / 编辑 / 勾选后再继续。

所以它不是“普通聊天应用”，而是一个面向 **agent dev flow** 的原型仓库。

---

## 2. 目录结构

下面是当前仓库里最关键的目录和文件：

```text
app/
  page.tsx                         主页：状态编排中心
  layout.tsx                       根布局与 metadata
  globals.css                      全局样式
  localshell-lab/page.tsx          实验页面：tool 粒度对比台
  api/
    chat/route.ts                  主聊天路由
    chat-openai-experimental/route.ts
                                   实验路由（workspace-toolset / shell / hybrid）
    plan/route.ts                  Plan 生成路由
    workspaces/route.ts            工作区列表接口
  _components/
    ChatInput.tsx                  输入框 + Plan Mode 开关
    EmptyState.tsx                 空态引导卡
    MessageBubble.tsx              消息气泡
    PlanCard.tsx                   Plan 生成 / review / 勾选 / 接受
    SessionHeader.tsx              聊天区顶部状态栏
    SessionSidebar.tsx             左侧会话栏
    WorkspacePicker.tsx            工作区/访问模式/审批策略选择器
    tool-card/
      ToolPartCard.tsx             tool part 状态机 UI
      input-views.tsx              工具输入预览
      output-views.tsx             工具输出渲染
      types.ts                     tool part 共享类型
  _lib/
    chat-session.ts                会话类型、localStorage、标题推导等纯函数

lib/
  chat-access-mode.ts              workspace-tools / no-tools 模式定义
  gateway.ts                       模型 gateway 配置
  devtools.ts                      @ai-sdk/devtools 包装
  prompt-layers.ts                 Persona / rules / context / AGENTS 分层拼接
  session-primer.ts                environment_context + AGENTS.md 收集
  workspace-tools.ts               list/search/read tool 定义
  workspaces.ts                    工作区边界、遍历、读文件、搜索
  write-tools.ts                   write_file / edit_file + approval
  shell-tool.ts                    只读 shell function tool
  plan-schema.ts                   Plan 的共享 Zod schema
  plan-generator.ts                streamObject 生成结构化计划
  subagents/
    explorer.ts                    只读 explorer 子 agent

docs/
  roadmap.md                       项目路线图
  codex-*.md                       Prompt / Codex 相关研究文档
  project-architecture-guide.md    当前这份文档

examples/
  chat-access-modes.ts             主聊天接口请求示例
  openai-experimental-route.ts     实验接口请求示例
```

---

## 3. 项目整体做了什么

### 3.1 主页面 `/`

主页面不是简单聊天框，而是一个 **“工作区绑定的工程师 Agent 控制台”**。

它做了几件事：

- 管理多会话，每个会话都绑定：
  - `workspaceRoot`
  - `workspaceName`
  - `workspaceAccessMode`
  - `bypassPermissions`
- 用 `useChat()` 与 `/api/chat` 对接
- 渲染消息文本和 tool 调用过程
- 在 tool 需要审批时显示批准卡片
- 支持开启 `Plan Mode`，先生成结构化计划，再把确认后的计划发回聊天链路执行

主页的“状态编排中心”是 [`app/page.tsx`](../app/page.tsx)。
它自己尽量不塞复杂 UI，更多负责：

- `state`
- `useEffect`
- `useChat` 配置
- 顶层布局拼装

而具体 UI 细节已经拆进了 `app/_components/`。

### 3.2 实验页面 `/localshell-lab`

实验页面是一个 **tool 粒度对比台**，目的是比较：

- `workspace-toolset`
- `shell`
- `hybrid`

三种模式下，模型如何获取证据、调用什么工具、输出什么参数和结果。

这条链路的重点不是“完成任务”，而是“观察 agent 行为”。

对应文件是 [`app/localshell-lab/page.tsx`](../app/localshell-lab/page.tsx)。

### 3.3 Plan 模式

Plan 模式是当前仓库里相对独立的一条链路：

- 用户打开 `Plan` toggle
- 点击发送时，不直接进入聊天
- 先弹出 `PlanCard`
- `PlanCard` 调 `/api/plan`
- 服务端用 `streamObject + Zod schema` 生成结构化计划
- 用户勾选 / 编辑 / 接受后
- 再把整理好的 markdown plan 当作一条消息发回 `/api/chat`

这条链路的核心在：

- [`app/_components/PlanCard.tsx`](../app/_components/PlanCard.tsx)
- [`app/api/plan/route.ts`](../app/api/plan/route.ts)
- [`lib/plan-schema.ts`](../lib/plan-schema.ts)
- [`lib/plan-generator.ts`](../lib/plan-generator.ts)

---

## 4. 三条主流程怎么跑

### 4.1 主聊天链路

### 流程图

```text
用户输入
  ↓
app/page.tsx
  ↓
useChat + DefaultChatTransport
  ↓
POST /api/chat
  ↓
createProjectEngineerAgent(...)
  ↓
prepareCall()
  ├─ normalizeWorkspaceRoot()
  ├─ buildSessionPrimer()
  └─ assemblePromptLayers()
  ↓
ToolLoopAgent + tools
  ├─ workspaceToolset
  ├─ writeToolset
  └─ subagentToolset
  ↓
createAgentUIStreamResponse()
  ↓
前端收到 UIMessage parts
  ↓
MessageBubble / ToolPartCard 渲染
```

### 关键代码节点

- 主编排：[`app/page.tsx`](../app/page.tsx)
- 主路由：[`app/api/chat/route.ts`](../app/api/chat/route.ts)
- prompt 分层：[`lib/prompt-layers.ts`](../lib/prompt-layers.ts)
- 会话 primer：[`lib/session-primer.ts`](../lib/session-primer.ts)
- 工作区工具：[`lib/workspace-tools.ts`](../lib/workspace-tools.ts)
- 写入工具：[`lib/write-tools.ts`](../lib/write-tools.ts)
- 子 agent：[`lib/subagents/explorer.ts`](../lib/subagents/explorer.ts)

### 这条链路的关键点

#### 1. 每个会话是“带工作区上下文”的

`page.tsx` 里的 `chatInstanceId` 会把：

- session id
- workspace root
- access mode

拼到一起，确保切会话、切工作区、切模式时不会串台。

#### 2. 自动处理 approval / tool loop 续跑

`useChat()` 配置里用了：

- `lastAssistantMessageIsCompleteWithApprovalResponses`
- `lastAssistantMessageIsCompleteWithToolCalls`

也就是说：

- 用户点了同意/拒绝后，会自动 resend 回服务器
- tool 执行完后，也会自动让模型继续往下生成

这样前端不需要自己手搓“继续执行下一步”的状态机。

#### 3. 主路由不是直接把固定 prompt 丢给模型

`/api/chat` 的 Agent 会在 `prepareCall()` 里动态生成本次调用的完整 instructions：

- Persona
- Developer rules
- Environment context
- AGENTS.md instructions

这使得 prompt 结构清晰，也便于调试和后续演化。

#### 4. 主路由会清洗“悬空 tool parts”

如果用户在 tool 正执行一半时刷新页面，本地存储里可能残留半成品 `tool part`。
`sanitizeWorkspaceUIMessages()` 会把非终结态的 tool part 丢掉，避免下次请求时 provider 因缺少 tool result 而报错。

---

### 4.2 实验链路

### 流程图

```text
用户在 /localshell-lab 选择 toolMode
  ↓
POST /api/chat-openai-experimental
  ↓
pickTools(toolMode)
  ├─ workspace-toolset
  ├─ shell
  └─ hybrid
  ↓
ToolLoopAgent
  ↓
createAgentUIStreamResponse()
  ↓
实验页直接展示 text / reasoning / tool input / tool output
```

### 关键代码节点

- 页面：[`app/localshell-lab/page.tsx`](../app/localshell-lab/page.tsx)
- 路由：[`app/api/chat-openai-experimental/route.ts`](../app/api/chat-openai-experimental/route.ts)
- shell tool：[`lib/shell-tool.ts`](../lib/shell-tool.ts)

### 这条链路的关键点

#### 1. 它不是 OpenAI 的 built-in `local_shell`

项目里用的是普通 `function calling` 路径上的自定义 `shell` 工具，而不是 Responses API 的内置 `local_shell`。

这样做的好处是：

- 不被单个 provider / 单个模型限制
- GPT / Gemini / Claude 只要支持 function calling 都能用

#### 2. shell 是只读白名单

`lib/shell-tool.ts` 明确限制了：

- 允许的命令
- 允许的 git 子命令
- 禁止的 shell 操作符

它的定位是“证据采集工具”，不是通用终端。

#### 3. 这条链路更适合做研究和调试

实验页面会把 tool input/output 直接展开给你看，适合观察：

- 模型是否更偏爱 shell 还是细粒度 tools
- 参数组织是否稳定
- 哪种工具证据链更直观

---

### 4.3 Plan 链路

### 流程图

```text
用户打开 Plan Mode
  ↓
ChatInput 提交任务
  ↓
page.tsx 设置 pendingPlanTask
  ↓
PlanCard 挂载
  ↓
POST /api/plan
  ↓
streamPlan()
  ↓
streamObject(model, schema)
  ↓
客户端 experimental_useObject() 接收 partial object
  ↓
用户 review / 编辑 / 勾选
  ↓
接受后转成 markdown
  ↓
回到主聊天链路执行
```

### 关键代码节点

- 入口开关：[`app/_components/ChatInput.tsx`](../app/_components/ChatInput.tsx)
- Plan UI：[`app/_components/PlanCard.tsx`](../app/_components/PlanCard.tsx)
- Plan API：[`app/api/plan/route.ts`](../app/api/plan/route.ts)
- Schema：[`lib/plan-schema.ts`](../lib/plan-schema.ts)
- Generator：[`lib/plan-generator.ts`](../lib/plan-generator.ts)

### 这条链路的关键点

#### 1. 它用的是 `streamObject`，不是 `ToolLoopAgent`

Plan 链路要的是严格结构化输出：

- `overview`
- `steps[]`
- `title`
- `reason`
- `filesToTouch`
- `risk`

所以这里更适合 `generateObject / streamObject`，而不是工具循环。

#### 2. Schema 被抽成独立文件

`planSchema` 放在 [`lib/plan-schema.ts`](../lib/plan-schema.ts)，是为了让客户端和服务端共用。

如果把 schema 写在 `plan-generator.ts`，客户端 import 时会顺着依赖链把服务端模块拉进来，导致浏览器构建出问题。

#### 3. 用户可以在执行前 review

这条设计很重要，它把“先想清楚怎么做”从“直接执行”里拆出来了。
这也是这个仓库区别于普通聊天 demo 的一个关键特征。

---

## 5. 关键实现点

下面这些点，是我认为这个项目最值得理解的设计。

### 5.1 工作区边界是严格受控的

核心文件：[`lib/workspaces.ts`](../lib/workspaces.ts)

它负责：

- 枚举候选工作区
- 校验工作区路径
- 把相对路径解析到 workspace root 内部
- 拒绝 `..` 逃逸
- 列目录
- 读文本文件
- 搜索代码

这意味着模型并不是“直接获得整个文件系统访问权”，而是被限制在用户选中的工作区里。

这是安全边界的第一层。

### 5.2 工作区能力先被抽成“纯函数”，再包装成 AI tools

核心文件：[`lib/workspace-tools.ts`](../lib/workspace-tools.ts)

这里的思路很干净：

- `lib/workspaces.ts` 解决真实文件系统逻辑
- `lib/workspace-tools.ts` 只负责把这些能力包装成 AI SDK 的 `tool()`

这样分层的好处是：

- 文件系统逻辑可以独立测试
- tool schema 更清晰
- 不同 Agent 可以复用同一组工具

### 5.3 写入工具用了 approval 机制，不是直接落盘

核心文件：[`lib/write-tools.ts`](../lib/write-tools.ts)

这里的设计重点：

- 写入前默认要求用户批准
- `bypassPermissions` 可以在会话级别关闭审批
- `write_file` 用于整文件覆盖或新建
- `edit_file` 用于精确 search-replace

也就是说，这个项目把“代码修改”当成一级能力来设计，但并没有放弃用户控制权。

### 5.4 prompt 不是一坨字符串，而是分层组装

核心文件：

- [`lib/prompt-layers.ts`](../lib/prompt-layers.ts)
- [`lib/session-primer.ts`](../lib/session-primer.ts)

这个设计体现了项目的研究属性。

它把 prompt 分成：

- Persona
- Developer rules
- Environment context
- User instructions（AGENTS.md）

再统一组装成 `instructions` 发给模型。

这样做的价值不只是“好看”，更重要的是：

- 关注点分离
- 更容易调试
- 更接近 Codex 的 prompt 工程思路

### 5.5 AGENTS.md 会被收进模型上下文

`session-primer.ts` 会从项目根一路往下找 `AGENTS.md` / `AGENTS.override.md`，再把它们拼进本次调用的上下文里。

这意味着：

- 仓库规则会真的进入模型上下文
- 修改 `AGENTS.md` 后，下一条消息就会生效

### 5.6 子 agent 用来隔离“调查型任务”

核心文件：[`lib/subagents/explorer.ts`](../lib/subagents/explorer.ts)

当问题需要读很多文件时，主 Agent 不一定亲自读取所有内容，而是可以调用 `explore_workspace`：

- explorer 在自己的上下文里跑
- 用只读工具调查代码
- 最后返回一段摘要

这样可以避免主对话被大量 `read_file` 结果淹没。

### 5.7 tool UI 不是“顺手显示 JSON”，而是有完整状态机

核心文件：

- [`app/_components/tool-card/ToolPartCard.tsx`](../app/_components/tool-card/ToolPartCard.tsx)
- [`app/_components/tool-card/input-views.tsx`](../app/_components/tool-card/input-views.tsx)
- [`app/_components/tool-card/output-views.tsx`](../app/_components/tool-card/output-views.tsx)

主页面对工具调用做了完整建模：

- `input-streaming`
- `input-available`
- `approval-requested`
- `approval-responded`
- `output-available`
- `output-error`

并且针对不同工具做了更合适的可视化，比如：

- `write_file`：文件内容预览
- `edit_file`：红绿 diff
- `read_file`：代码内容展示
- `search_code`：按文件分组展示命中

这说明项目并不满足于“模型能调 tool”，而是在认真设计 **tool UX**。

---

## 6. 关键文件索引

如果你只想抓最核心的“节点代码”，优先看下面这些文件。

### 页面与交互

- [`app/page.tsx`](../app/page.tsx)
  - 主页面总编排
  - `useChat`
  - localStorage / URL session 同步
  - Plan mode 入口
- [`app/_components/MessageBubble.tsx`](../app/_components/MessageBubble.tsx)
  - 文本消息和 tool part 的分发点
- [`app/_components/tool-card/ToolPartCard.tsx`](../app/_components/tool-card/ToolPartCard.tsx)
  - tool 状态机 UI
- [`app/_components/WorkspacePicker.tsx`](../app/_components/WorkspacePicker.tsx)
  - 会话创建和安全策略入口

### 服务端入口

- [`app/api/chat/route.ts`](../app/api/chat/route.ts)
  - 主 Agent 入口
- [`app/api/chat-openai-experimental/route.ts`](../app/api/chat-openai-experimental/route.ts)
  - 实验 Agent 入口
- [`app/api/plan/route.ts`](../app/api/plan/route.ts)
  - 结构化 plan 入口

### 底层能力

- [`lib/workspaces.ts`](../lib/workspaces.ts)
  - 路径边界、读文件、列目录、搜索
- [`lib/workspace-tools.ts`](../lib/workspace-tools.ts)
  - list/search/read tool
- [`lib/write-tools.ts`](../lib/write-tools.ts)
  - write/edit tool + approval
- [`lib/shell-tool.ts`](../lib/shell-tool.ts)
  - 只读 shell 白名单
- [`lib/session-primer.ts`](../lib/session-primer.ts)
  - `environment_context` + `AGENTS.md`
- [`lib/prompt-layers.ts`](../lib/prompt-layers.ts)
  - prompt 分层拼接
- [`lib/subagents/explorer.ts`](../lib/subagents/explorer.ts)
  - explorer 子 agent
- [`lib/plan-generator.ts`](../lib/plan-generator.ts)
  - `streamObject` 生成结构化计划

---

## 7. 推荐阅读顺序

如果你想真正理解项目，建议按下面顺序读：

### 第一轮：先抓主线

1. [`app/page.tsx`](../app/page.tsx)
2. [`app/api/chat/route.ts`](../app/api/chat/route.ts)
3. [`lib/workspace-tools.ts`](../lib/workspace-tools.ts)
4. [`lib/workspaces.ts`](../lib/workspaces.ts)
5. [`lib/write-tools.ts`](../lib/write-tools.ts)

读完这五个文件，你基本就理解了“主聊天链路怎么跑”。

### 第二轮：理解上下文和 prompt

6. [`lib/session-primer.ts`](../lib/session-primer.ts)
7. [`lib/prompt-layers.ts`](../lib/prompt-layers.ts)
8. [`docs/codex-prompt-layering.md`](./codex-prompt-layering.md)

读完这一轮，你会明白这个项目为什么不只是“普通 system prompt”。

### 第三轮：看扩展能力

9. [`app/api/chat-openai-experimental/route.ts`](../app/api/chat-openai-experimental/route.ts)
10. [`lib/shell-tool.ts`](../lib/shell-tool.ts)
11. [`app/localshell-lab/page.tsx`](../app/localshell-lab/page.tsx)
12. [`lib/subagents/explorer.ts`](../lib/subagents/explorer.ts)
13. [`app/_components/PlanCard.tsx`](../app/_components/PlanCard.tsx)
14. [`lib/plan-generator.ts`](../lib/plan-generator.ts)

这时你就能理解“实验链路、subagent、Plan 模式”这些增量能力。

---

## 8. 我对这个项目的判断

如果只看页面，它像一个聊天应用。  
如果看代码结构，它其实是一个 **本地 agent 工作流实验平台**。

它的真正重点是：

- 如何给模型受控的代码访问能力
- 如何把工作区、工具和安全边界绑定起来
- 如何把 prompt 分层和项目规则注入做清楚
- 如何把 tool 调用可视化
- 如何在执行前引入 plan review
- 如何比较不同工具抽象对 agent 行为的影响

所以这个仓库最值得学习的不是 UI，而是它把“Agent 怎么接近真实开发工作流”这件事拆得很清楚。

如果后面你还想继续往下挖，我建议下一份文档可以单独写：

- “主聊天链路逐行讲解”
- “Plan 模式实现细节”
- “ToolPartCard 状态机说明”
- “workspace-tools 与 shell 工具的差异”
