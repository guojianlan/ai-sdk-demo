# AI SDK Dev Flow 路线图

> 这份文档是 **ai-sdk-demo** 项目的学习计划兼开发计划。
> 目标：**把这个仓库做成自己的 agent dev flow**，同时系统学完 Vercel AI SDK v6 的核心能力。
>
> 维护方式：完成一项就把下面的速览表 + 对应小节的 status 改成 `✅ done`，勾掉具体任务里的 checkbox，学到新概念就补到"学到什么"里。
> 优先级是按"价值 / 单位学习成本"排的，不是按字母序。

---

## 进度速览

| 阶段 | 任务 | 状态 | 备注 |
|---|---|---|---|
| — | 已完成的 8 项基础能力 | ✅ done | 见下方"已完成"表格 |
| **P1-a** | 写入工具 + 批准机制 | ✅ done | search-replace 路线；含 per-session bypass；apply_patch 挪到 P5 延伸 |
| **P1-b** | Prompt / tool 观测（@ai-sdk/devtools） | ✅ done | 接入官方 devtools，自写 middleware 挪到 P2-c |
| **P2-a** | Subagents | ✅ done | explorer 子 agent + `explore_workspace` 工具；顺手把 search_code 切到 @vscode/ripgrep 免装 rg |
| **P2-b** | Structured output（`streamObject`） | ✅ done | `/api/plan` 用 `streamObject`；前端 `experimental_useObject` 流式渲染 plan 卡；接受后作为 prefix 注入到下一条 user message |
| **P2-c** | Middleware + Telemetry | ✅ done | 自写 logging middleware（stdout 单行结构化）；和 devtools middleware 叠加；rate-limit 跳过（日常没需求） |
| **P3-a** | MCP 工具接入 | ✅ done | 自写 weather MCP server（stdio + wttr.in）；主 app 用 `@ai-sdk/mcp` 每请求 spawn + `onFinish` 清理 |
| **P3-R** | **生产级重构** | ⬜ pending | **新增**：抽取 chat-agent builder；统一 env / 消息清洗 / tool 结果 shape；消除 `as any` 逃生口 |
| **P3-b** | Message 持久化 + resume streams | ⬜ pending | — |
| **P4-a** | Testing + 模拟模型 | ⬜ pending | — |
| **P4-b** | Context compaction | ⬜ pending | 依赖 P2-c + P3-b |

**状态图例**：⬜ `pending` · 🟡 `in-progress` · ✅ `done` · ⏸️ `paused` · ❌ `dropped`

---

## 已完成 ✅

| 能力 | 关联文件 | 学到的 AI SDK 概念 |
|---|---|---|
| 基础聊天 + `ToolLoopAgent` + 只读 workspace 工具 | [lib/workspace-tools.ts](../lib/workspace-tools.ts), [app/api/chat/route.ts](../app/api/chat/route.ts) | `tool()` / `inputSchema` (Zod) / `execute` / `experimental_context` / `stopWhen: stepCountIs(...)` |
| 两种 access mode（workspace-tools / no-tools） | [lib/chat-access-mode.ts](../lib/chat-access-mode.ts) | 用 `callOptionsSchema` + `prepareCall` 做请求级分支 |
| OpenAI 实验路由（workspace-toolset / shell / hybrid） | [app/api/chat-openai-experimental/route.ts](../app/api/chat-openai-experimental/route.ts) | `createOpenAI()` + Responses API + 多 agent 预构造 |
| `/localshell-lab` 调试页 | [app/localshell-lab/page.tsx](../app/localshell-lab/page.tsx) | `useChat` + `DefaultChatTransport` + 渲染 `tool-*` / `dynamic-tool` 部件 |
| Session primer（env + AGENTS.md 发现/拼接） | [lib/session-primer.ts](../lib/session-primer.ts) | 照搬 codex 规则：`.git` marker / 32 KiB 预算 / 向下收集 |
| Prompt 4 层装配 | [lib/prompt-layers.ts](../lib/prompt-layers.ts) | Persona / Developer rules / Environment context / User instructions 分离 |
| 跨模型 shell function tool | [lib/shell-tool.ts](../lib/shell-tool.ts) | function calling 路径 vs OpenAI built-in `local_shell` 的区别 |
| 文档 | [docs/codex-prompt-layering.md](./codex-prompt-layering.md), [codex-base-prompt.md](./codex-base-prompt.md), [codex-refusal-analysis.md](./codex-refusal-analysis.md) | codex 的 prompt 工程心智模型 |
| Prompt / tool 观测（P1-b） | [lib/devtools.ts](../lib/devtools.ts), [package.json](../package.json) | `wrapLanguageModel` + `LanguageModelMiddleware`；接入官方 `@ai-sdk/devtools` 看 run / step / tool call / raw chunks |
| 写入工具 + approval + bypass（P1-a） | [lib/write-tools.ts](../lib/write-tools.ts), [app/page.tsx](../app/page.tsx) 的 `ToolPartCard`, [app/api/chat/route.ts](../app/api/chat/route.ts) | `tool({ needsApproval })` + `addToolApprovalResponse` + `lastAssistantMessageIsCompleteWithApprovalResponses` + `sendAutomaticallyWhen`；part 的 6 状态机（input-streaming / input-available / approval-requested / approval-responded / output-available / output-error）；needsApproval 作为**回调**可读 context → 实现 per-session bypass |
| Subagents（P2-a） | [lib/subagents/explorer.ts](../lib/subagents/explorer.ts), [lib/gateway.ts](../lib/gateway.ts) | 嵌套 `ToolLoopAgent`：`agent.generate({ prompt, options })` 非流调用；外层 `tool({ execute })` 把 agent 包成一个工具，暴露给主 agent 自决调用（抄 open-agents "WHEN TO USE / WHEN NOT TO USE" 模型自决路由，不做分类器/规则兜底）；context 隔离——子 agent 的 20 步 tool 调用不进主 context，只有 `{summary, filesExamined, stepsUsed}` 进 |
| Structured output（P2-b） | [lib/plan-generator.ts](../lib/plan-generator.ts), [app/api/plan/route.ts](../app/api/plan/route.ts), [app/_components/PlanCard.tsx](../app/_components/PlanCard.tsx) | `streamObject({ schema: z.object(...) })` + `toTextStreamResponse()`；前端 `experimental_useObject` 流式渲染 partial plan；接受后 plan 转 markdown 作为 prefix 注入 `sendMessage` |
| 前端组件拆分（P2-b 顺手做的） | [app/_lib/chat-session.ts](../app/_lib/chat-session.ts), [app/_components/](../app/_components/) | `app/page.tsx` 从 2070 行压到 ~390 行（82%）；tool-card / MessageBubble / Session{Sidebar,Header} / WorkspacePicker / EmptyState / ChatInput / PlanCard / Eyebrow 独立文件 |
| Middleware + Telemetry（P2-c） | [lib/middleware/logging.ts](../lib/middleware/logging.ts), [lib/devtools.ts](../lib/devtools.ts) | `LanguageModelV3Middleware` 接口 (`wrapGenerate` / `wrapStream` / `transformParams`)；`wrapLanguageModel` 支持数组 compose；stream 路径用 `TransformStream` 逐 chunk 观察并在 `flush` 里汇总 |
| MCP 工具接入（P3-a） | [mcp-servers/weather/server.ts](../mcp-servers/weather/server.ts), [lib/mcp/weather-client.ts](../lib/mcp/weather-client.ts), [app/api/chat/route.ts](../app/api/chat/route.ts) | 自写 MCP **server**（`@modelcontextprotocol/sdk`，stdio transport，注册 `get_weather` / `get_forecast` + open-meteo 无 key API）；自写 MCP **client**（`@ai-sdk/mcp` 的 `createMCPClient` + `Experimental_StdioMCPTransport` 拉起子进程）；AI SDK 的 `client.tools()` 把 MCP 工具自动转成 agent 可用的 tool map |

---

## P1 —— 让 agent 真的能"改代码"（最紧急）

目前所有工具都是**只读**的。这是 dev flow 和"代码问答机器人"之间的分水岭。做完 P1 这个仓库才算真正的 dev flow。

### P1-a：写入工具 + 批准机制

**Status**: ✅ done（2026-04-15）

**价值**：让 agent 从"观察者"变成"协作者"。

**学到的 AI SDK 概念**：
- `tool()` 的 `needsApproval` / `toolApproval` 机制
- `prepareStep` 钩子（控制每一步的行为，比如拒绝 / 改写 / 加审批）
- `ChatAddToolApproveResponseFunction`（前端怎么把批准回传）
- UI 侧如何渲染 `tool-approval-request` 状态的 tool 部件

**技术路线决策**：走 **search-replace（open-agents 思路）**，不走 codex apply_patch。
理由：P1-a 的学习目标是 AI SDK 的 approval 机制，不是 patch 解析器。
search-replace 1-2 天即可打通 approval 链路，留时间迭代 UI / 条件审批策略；
codex `*** Begin Patch` 全量 port ≈ 1200-1500 LoC TS，学习密度低（60% 花在 CS 而不是 SDK）。
apply_patch 挪到 **P5 延伸学习**（见本文件最后），等 approval 链路跑通后作为独立实验。

**具体任务**：
- [ ] `lib/write-tools.ts`：定义 `write_file` 工具（整文件写入）
- [ ] `lib/write-tools.ts`：定义 `edit_file` 工具（`oldString` / `newString` / `replaceAll` 搜索替换）
- [ ] 两个工具都标记 `needsApproval`，默认需要用户点"同意"才执行
- [ ] 路径校验复用 `lib/workspaces.ts` 里现成的 `..` 拒绝逻辑
- [ ] Zod 描述文案参考 `tmp/open-agents-main/packages/agent/tools/write.ts`（理解后重写，不直接抄）
- [ ] `/api/chat/route.ts`：在 `workspace-tools` mode 里加入这两个工具
- [ ] 前端：把 `tool-approval-request` 状态的 tool 部件渲染成 diff 预览 + 同意/拒绝两按钮
- [ ] 端到端验证：主页对话"帮我把 README 第一行 typo 改了" → 弹 diff → 同意 → 文件被改

**Done 标准**：上面最后一条端到端验证通过。

**预估**：1-2 天。

---

### P1-b：Prompt / tool 观测（@ai-sdk/devtools）

**Status**: ✅ done · **路线变更（2026-04-15）**

**价值**：看到每次发给模型的完整 prompt、每次 tool 调用的输入/输出、token、耗时、raw provider chunks。
这是调 prompt / 诊断 tool 行为 / 理解多步循环的关键观测手段。

**技术路线决策**：原计划是手写 `GET /api/prompt-preview` + 折叠面板（半天）。
实际改成接入 Vercel 官方的 **[@ai-sdk/devtools](https://www.npmjs.com/package/@ai-sdk/devtools)** —— 更强、更快、更官方。
- 15 分钟完成接入（3 行 middleware 包装 + 加 script + .gitignore）
- 除了 prompt 还能看到 tool 调用、token、timing、multi-step run 分组
- 独立 Web UI 在 `http://localhost:4983`，数据落 `.devtools/`（已忽略）

**落地文件**：
- [lib/devtools.ts](../lib/devtools.ts) —— `instrumentModel(model)` helper，`NODE_ENV !== "production"` 时用 `wrapLanguageModel` + `devToolsMiddleware()` 包裹
- [app/api/chat/route.ts](../app/api/chat/route.ts) —— 主路由的模型走 instrumentModel
- [app/api/chat-openai-experimental/route.ts](../app/api/chat-openai-experimental/route.ts) —— 实验路由的模型同样包裹
- [package.json](../package.json) —— 加了 `dev:devtools` / `dev:all` 两个 script
- [.gitignore](../.gitignore) —— 忽略 `.devtools/`

**使用方式**：
```bash
# 两个终端
npm run dev              # Next.js
npm run dev:devtools     # devtools Web UI at :4983
# 或一条命令都起：
npm run dev:all
```

**后续**：自己写一个"极简版" logging middleware 作为学习练习，挪到 **P2-c（Middleware + Telemetry）**，目标是照着 `node_modules/@ai-sdk/devtools/src/middleware.ts`（~200 行）理解 `LanguageModelMiddleware` 接口和 `wrapLanguageModel` 的组装机制。

---

## P2 —— 核心 AI SDK 能力

这几项是深入学 AI SDK v6 必经的概念，按依赖顺序排。

### P2-a：Subagents

**Status**: ⬜ pending · **依赖**：P1-b

**价值**：避免主 context 被 shell 输出 / 大文件读取灌爆。

**学到的 AI SDK 概念**：
- 嵌套 `ToolLoopAgent`（子 agent 作为工具暴露给主 agent）
- `InferAgentUIMessage`（子 agent 的消息类型推断）
- Context 隔离：子 agent 跑完只回一份摘要给主 agent，过程中间的 tool 调用不进主 context

**具体任务**：
- [ ] 做一个 `explorerSubagent` —— 只给 read-only tools，专门负责"先摸清项目结构"
- [ ] 主 agent 暴露 `explore_workspace(question)` 工具，内部调用 explorer subagent，返回结构化摘要
- [ ] 在 `/localshell-lab` 加第四个 mode `subagent` 做对照实验

**Done 标准**：对话里问"这个项目怎么做鉴权？"，主 agent 调用 explorer subagent，subagent 查 30 个文件但只返回 500 字摘要，主 context 只增加那 500 字。

**预估**：1 天。

---

### P2-b：Structured output（`generateObject` / `streamObject`）

**Status**: ⬜ pending

**价值**：当 agent 需要产出"计划"、"diff 决策"、"文件分类"等结构化结果时，不要让它写自由文本然后 parse —— 直接用 `generateObject` 拿到 typed JSON。

**学到的 AI SDK 概念**：
- `generateObject({ schema: z... })`
- `streamObject` —— 边流边构建对象（partial JSON）
- 和 `ToolLoopAgent` 的区别：这是**一次性调用**，不走 loop

**具体任务**：
- [ ] `lib/plan-generator.ts`：给一个任务描述，返回 `z.object({ steps: z.array(z.object({ title, reason, estimated_minutes })) })`
- [ ] `/api/plan` 端点：客户端发任务描述，流式返回 plan
- [ ] 在主页加"先出 plan 再执行"的 toggle（类似 codex 的 `update_plan` 工具）

**Done 标准**：发 "帮我把 localStorage 换成 IndexedDB"，先出一个 5 步结构化 plan，每步能编辑后再执行。

**预估**：1 天。

---

### P2-c：Middleware + Telemetry

**Status**: ⬜ pending

**价值**：生产级别的可观测性和横切关注点。

**学到的 AI SDK 概念**：
- `wrapLanguageModel` / `wrapProvider`
- `LanguageModelMiddleware` —— 能拦截请求/响应做日志、缓存、rate limit、prompt 改写
- `TelemetrySettings` + OpenTelemetry 集成

**具体任务**：
- [ ] `lib/middleware/logging.ts` —— 打印每次 API 调用的 prompt、tokens、耗时（参考 `node_modules/@ai-sdk/devtools/src/middleware.ts` 的接口实现）
- [ ] `lib/middleware/rate-limit.ts` —— 简单 token bucket，防手抖刷接口
- [ ] 在两个路由的 `model` 处组合 instrument + logging + rate-limit

**Done 标准**：`npm run dev` 的日志里能看到每次 LLM 调用的结构化信息（model / tokens / 耗时 / tool 调用次数）。同时和 `@ai-sdk/devtools`（已在 P1-b 接入）并存，两者不互斥。

**预估**：半天到 1 天。

---

## P3 —— 生态集成

### P3-a：MCP（Model Context Protocol）工具接入

**Status**: ⬜ pending

**价值**：接入外部 MCP server（git / filesystem / 数据库 / 搜索），不用每个工具都自己写。

**学到的 AI SDK 概念**：
- `experimental_createMCPClient`
- stdio / SSE transport
- 动态工具注册（MCP 的工具列表在运行期才能知道）

**具体任务**：
- [ ] 接一个现成的 MCP server（比如 `@modelcontextprotocol/server-filesystem` 或 git MCP）
- [ ] 把它的工具动态合进 `toolset`
- [ ] 在 lab 页加第五个 mode 或新建 `/mcp-lab` 页

**Done 标准**：启动时 agent 自动发现 MCP server 的工具，在 tool 卡片里看到 `mcp-*` 前缀的调用。

**预估**：1 天。

---

### P3-R：生产级重构（新增）

**Status**: ⬜ pending · **定稿 2026-04-17**

**价值**：P1-a 到 P3-a 跑了一轮从零到功能全覆盖，积累了大量快速迭代产物。在继续加 feature 之前回头整一轮，把"一次性代码"收敛成可维护的生产级架构。

**重构清单（按执行顺序）**：

- [ ] **1. 统一 env 配置**：新建 `lib/env.ts`，集中所有 env 读取 + 启动期校验（缺必填 → 直接 crash），替代散落在 `lib/gateway.ts` / `lib/devtools.ts` / 实验路由 / `lib/middleware/logging.ts` 里的零散读取
- [ ] **2. 统一消息清洗**：合并 `sanitizeWorkspaceUIMessages`（主路由）与 `sanitizeExperimentUIMessages`（实验路由）为一个参数化的 `lib/chat/sanitize-messages.ts`，两条路由共用
- [ ] **3. 抽取 chat-agent builder**：把"persona → developer rules → session primer → prompt layers → ToolLoopAgent 构造"这条在两个路由里重复 60%+ 的 pipeline 抽成 `lib/chat-agent/builder.ts`；两条路由文件 < 80 行（现在各 ~330）
- [ ] **4. prompt 分层合并**：`assemblePromptLayers` + `buildSessionPrimer` + persona 字符串 + developer rules 字符串 → 合成 `buildSystemPrompt(persona, modeConfig, workspace)` 单一入口
- [ ] **5. 工具结果 shape 统一**：定义 `type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string }`；所有 tool 的 execute 收敛到这个 shape（现在 write_file 用 `{ok,error}` 而 read_file 直接 throw、shell 用 `{success, exitCode}`）
- [ ] **6. 消除类型逃生口**：搜索全 app 的 `as any` / `as never` / `as ToolSet`，用正确的泛型或 discriminated union 替代

**Done 标准**：
1. 两条 chat 路由文件各 < 80 行
2. `lib/env.ts` 启动期缺必填就 crash
3. 全 app 无 `as any` / `as never`（除注释说明不可避免的场景）
4. 所有 tool 返回 `ToolResult<T>` 联合
5. `npm run build` 通过 + 现有功能（approval / bypass / subagent / MCP weather / plan）全部不回归

**预估**：1 天（纯重构，不加 feature）。

---

### P3-b：Message 持久化 + resume streams

**Status**: ⬜ pending

**价值**：刷新页面不丢对话，断网重连能接上流。

**学到的 AI SDK 概念**：
- `useChat` 的 `id` 语义 + 服务端状态
- `createUIMessageStream` 的 `resumableStream` 模式
- 怎么在 Next.js 里接 Redis / SQLite 存消息

**具体任务**：
- [ ] `lib/chat-store.ts` —— 简单的 SQLite / Redis 消息 store
- [ ] `GET /api/chat/history?id=...` + `POST /api/chat` 写入
- [ ] 前端 `useChat` 改成从服务端加载历史

**Done 标准**：发一条消息，刷新页面，对话还在；长流过程中断网再连上能继续看到剩下的输出。

**预估**：1-2 天。

---

## P4 —— 工程化 / 测试

### P4-a：Testing + 模拟模型

**Status**: ⬜ pending

**价值**：给自定义 tool、primer、prompt 装配写测试；对 prompt 做回归。

**学到的 AI SDK 概念**：
- `simulateReadableStream` —— 模拟 LLM 响应流
- `MockLanguageModelV3` —— 不真的调用 LLM，给定脚本的响应
- 集成进 Vitest / Node test runner

**具体任务**：
- [ ] 给 `lib/shell-tool.ts` 的白名单校验加单测（纯函数，最容易）
- [ ] 给 `lib/session-primer.ts` 的向下收集逻辑加单测（需要 fs 测试工具）
- [ ] 给 prompt 装配加快照测试（`assemblePromptLayers(...)` 输出固定结构）

**Done 标准**：`npm test` 跑起来，覆盖核心 lib。

**预估**：1-2 天。

---

### P4-b：Context compaction

**Status**: ⬜ pending · **依赖**：P2-c（需要日志才能观察）+ P3-b（需要持久化才能测长对话）

**价值**：长对话不爆炸。这也是 codex 里最复杂的一块（见 [tmp/codex-main/codex-rs/core/src/compact.rs](../tmp/codex-main/codex-rs/core/src/compact.rs)）。

**学到的 AI SDK 概念**：
- `pruneMessages` —— AI SDK 内置的消息剪枝
- 自己实现 summarization compaction（老对话被 LLM 总结成一段放 system prompt）

**具体任务**：
- [ ] `lib/compaction.ts` —— 定义 trigger（比如 token > 80% context window 时）+ 策略（总结 + 保留最近 N 轮）
- [ ] 在 `/api/chat` 里接入，日志输出 compaction 触发时机

**Done 标准**：跑 20 轮对话后看到一次自动 compaction，之后对话继续连贯。

**预估**：2-3 天。

---

## 参考快照：P1 完成后项目长什么样

想象一下 P1-a 和 P1-b 都做完之后：

- 用户说："改一下 tsconfig 的 strict 配置"
- Agent 用 `read_file` 读 tsconfig.json
- Agent 调 `apply_patch`，弹出 diff 预览 —— 你点"同意"
- 文件被改，agent 说"改完了，要跑 `npm run build` 验证吗？"
- 你点"同意"，shell 工具跑 build，返回结果

这就是一个**能干活的 coding agent**。后面 P2 / P3 / P4 都是在这个基础上加厚度 —— 更不爆 context、更会规划、更可观测、更贴近生产。

---

## 进度追踪惯例

**做一项的标准流程**（下次打开文档可以直接照抄）：

1. **开工**：把**进度速览表**对应行和**任务小节的 Status** 同步改成 `🟡 in-progress`
2. **过程中**：勾掉 `具体任务` 里做完的 checkbox（`- [ ]` → `- [x]`）
3. **收工**：
   - 进度速览表的状态改成 `✅ done`
   - 任务小节的 Status 改成 `✅ done`
   - 在顶部"已完成"表格里**新加一行**，带上关联文件 + 学到的 AI SDK 概念
   - 如果过程中发现文档里漏了什么/顺序错了，顺手修 roadmap

**插队 / 阻塞时**：在下面加 / 更新"当前阻塞"段：

> **当前阻塞**（清空当不阻塞时）：
> - 例："P1-a 在等 diff 渲染组件选型，先转去做 P1-b"

**下次接手时怎么对齐**：打开这份文档 →看顶部"进度速览"表找状态不是 ✅ 的最上面一行 → 打开对应小节从未勾的第一个 checkbox 继续做。

---

## 改 roadmap 的触发条件

- 某项做完后，回来看看后续是否要调整 —— 有时完成 A 会让 B 变得更简单或更不必要
- AI SDK 有新版本 / 新 feature，评估是否值得插队
- 学到新的 codex / Claude Code 设计（比如某个 prompt 技巧、context 策略），评估是否值得做实验

---

## P5 —— 延伸学习（非主线，跑完后实验用）

### P5-a：codex `apply_patch` 移植实验

**Status**: ⬜ parked · **触发条件**：P1-a 完成后、且遇到 search-replace 的局限（例如多文件原子编辑需求、LLM 空白飘移太频繁）再启动

**价值**：
- 读 [tmp/codex-main/codex-rs/apply-patch/](../tmp/codex-main/codex-rs/apply-patch/) 学 patch 解析器的工程设计
- 四层模糊匹配（精确 → 去尾空白 → 去首尾空白 → Unicode 归一）对 LLM 输出鲁棒性的改进
- 多文件原子应用的 rollback 思路

**建议范围**（最小子集）：
- `*** Begin/End Patch` 包裹 + `*** Update File:` + `*** Add File:` + `@@` + 多 hunk
- 2 层模糊匹配（精确 + 去首尾空白），跳过 Unicode 归一
- 全部 parse/compute 完才写盘，保证原子
- 跳过 `*** Delete File:` / `*** Move to:` / bash heredoc 提取 / `*** End of File` 边界 marker

**预估**：1-2 天（单独一个实验，不插队）

**产出**：`lib/apply-patch/`（parser/seek/applier/index），外层再用同样的 `needsApproval` 包装成一个工具；和 P1-a 的 `write_file` / `edit_file` 并存，让模型根据任务选择。
