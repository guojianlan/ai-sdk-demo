# ai-sdk-demo 与 `tmp/` 两个参考框架的对比笔记

这份文档聚焦一个问题：

> 当前仓库和 `tmp/codex-main`、`tmp/open-agents-main` 相比，已经做到了什么，还缺什么，哪些能力最值得借鉴，应该先优化哪里。

我不会做“功能罗列式”的大而全对比，而是只看对这个仓库最有价值的几个维度：

- 执行模型
- 工作区 / 沙箱边界
- 工具设计
- 上下文管理
- 计划与子任务拆分
- 可扩展性
- 权限与审批

---

## 1. 三个项目各自的定位

### 当前仓库 `ai-sdk-demo`

这是一个 **本地 coding agent dev flow 原型**。

它的目标不是做完整产品，而是把下面几件事跑通：

- 选中一个工作区后，让 Agent 去读代码、搜代码、解释项目
- 在需要时做带审批的写入
- 比较不同 tool 粒度的效果
- 用单独的 Plan 模式生成结构化计划

它的强项是：实现轻、结构清楚、适合快速实验。

### `tmp/open-agents-main`

Open Agents 更像一个 **面向真实会话与长任务的 agent product skeleton**。

它强调：

- Agent 和 sandbox 分离
- durable workflow
- 可恢复流式会话
- skill discovery
- 子 agent 注册与任务委派

它的强项不是 prompt，而是 **“把 agent 跑成一个长期在线系统”**。

### `tmp/codex-main`

Codex 更像一个 **工程化程度很高的 agent runtime / protocol 实现**。

它强调：

- prompt layering 与 AGENTS.md 指令继承
- 更正式的 sandbox / approval policy
- context compaction
- 更强的编辑原语，比如 `apply_patch`
- 更严格的执行与会话状态管理

它的强项是 **运行时治理能力**，不是单一 demo 页面。

---

## 2. 当前仓库已经做得好的地方

先说结论：这个仓库并不是“功能太少”，而是已经有了很不错的第一层架子。很多关键思路其实已经和 Codex / Open Agents 对上了。

### 2.1 Prompt 分层是清楚的

主聊天链路在 [`app/api/chat/route.ts`](../app/api/chat/route.ts) 里，不是把一大段 system prompt 硬写死，而是把 prompt 分成：

- persona
- developer rules
- environment context
- user instructions

然后再通过 [`lib/prompt-layers.ts`](../lib/prompt-layers.ts) 和 [`lib/session-primer.ts`](../lib/session-primer.ts) 动态装配。

这点非常接近 Codex 的思路，而且已经比很多 demo 项目成熟。

### 2.2 工作区边界做得不错

[`lib/workspaces.ts`](../lib/workspaces.ts) 已经有几件很关键的防线：

- 统一工作区根目录解析
- 路径 escape 防护，拒绝 `..` 跳出工作区
- 目录遍历深度和数量限制
- 忽略大型噪声目录

对一个本地 agent demo 来说，这已经是合格的“边界控制”。

### 2.3 写入工具是显式审批的

[`lib/write-tools.ts`](../lib/write-tools.ts) 里的 `write_file` / `edit_file` 已经具备两项很重要的产品意识：

- 默认需要审批
- 文案引导模型先读后改

这比“模型直接写磁盘”要健康很多，也和 Codex 的 approval 思路方向一致。

### 2.4 已经开始处理 context 膨胀问题

当前仓库虽然还没有真正的 compaction，但已经做了两个很聪明的轻量处理：

- [`lib/subagents/explorer.ts`](../lib/subagents/explorer.ts) 把"广泛摸代码"隔离到只读子 agent，主上下文只保留摘要
- [`lib/chat/sanitize-messages.ts`](../lib/chat/sanitize-messages.ts) 对悬空 tool parts 做清洗，避免残缺上下文污染后续请求

这说明项目不是没考虑 context，只是还没做到"正式 compaction pipeline"。

### 2.5 Plan 模式是独立链路，不和执行链路缠死

[`lib/plan-generator.ts`](../lib/plan-generator.ts) 用 `streamObject + Zod schema` 做结构化 plan，这个方向是对的。

它的优势是：

- 输出严格
- 前端好渲染
- 用户好 review

这一点不比参考项目弱，甚至对于 demo 可解释性来说是加分项。

---

## 3. 和 Open Agents 相比，当前仓库缺什么

Open Agents 最值得借鉴的，不是“多几个工具”，而是 **运行时形态**。

### 3.1 缺 durable workflow / resumable run

当前仓库的主链路本质上仍然是：

- HTTP 请求进来
- `ToolLoopAgent` 在这次请求里跑
- 流式返回

这对于短任务够用，但对长任务、网络抖动、页面刷新、审批中断都比较脆弱。

Open Agents 在 `tmp/open-agents-main/apps/web/app/api/chat/route.ts` 里走的是：

- 启动 durable workflow
- 持久化 `activeStreamId`
- 若已有运行中的 workflow，则重连而不是重复开跑

这套机制的价值很大：

- 页面刷新后可以恢复
- 长任务不会绑死在一个请求上
- 审批和中断更自然

### 3.2 缺"agent 不等于本机文件系统"的抽象

当前仓库直接在 Node 进程里通过 [`lib/workspaces.ts`](../lib/workspaces.ts) 操作本地路径。

这对本地 demo 很方便，但架构上意味着：

- agent 和宿主文件系统强耦合
- 以后切换到远端 sandbox 会比较痛
- 读写、安全、生命周期都挤在一层

Open Agents 通过 sandbox interface 把这些能力抽象掉了。这个分层非常值得学：

- Agent 只知道“有个执行环境”
- 执行环境可以是本机、Vercel sandbox、快照恢复后的 sandbox
- 生命周期、鉴权、停止、恢复都归 sandbox 层

### 3.3 缺 skill discovery 机制

当前仓库想扩展能力，基本还是写代码把新工具接进路由。

Open Agents 在 `packages/agent/skills/discovery.ts` 和 `loader.ts` 里做了更灵活的 skill 机制：

- 扫描技能目录
- 读取 `SKILL.md`
- 解析 frontmatter
- 把 skill 内容动态注入 prompt / 能力层

这对你的项目会特别有帮助，因为你现在已经有：

- AGENTS.md 规则层
- 主 agent
- explorer 子 agent

如果再加一层技能发现，整个系统会从“写死的 demo”变成“可配置的 agent playground”。

### 3.4 子 agent 还太单一

当前仓库只有一个 [`lib/subagents/explorer.ts`](../lib/subagents/explorer.ts)，角色很明确，但能力单一。

Open Agents 的 `task` 工具思路更强：

- 有 subagent registry
- 每个 subagent 有明确职责
- 主 agent 可以按任务类型委派

这意味着你后面可以很自然地拆出：

- explorer：摸清代码
- patcher：做小范围实现
- reviewer：复核风险
- tester：跑验证并总结失败原因

对 coding agent 来说，这比“一个大 agent 包打天下”更可扩展。

### 3.5 缺 provider-specific context 优化

Open Agents 在 `context-management/cache-control.ts` 里对 Anthropic 做了 cache control 标记。

这不是必要功能，但它说明一件事：

> 同一套 agent 逻辑，应该允许在 provider 层做定制化优化。

你的仓库已经有 [`lib/gateway.ts`](../lib/gateway.ts) 和 [`lib/devtools.ts`](../lib/devtools.ts)，很适合再长一层 provider-aware 优化，而不是所有模型一视同仁。

---

## 4. 和 Codex 相比，当前仓库缺什么

Codex 最值得借鉴的，是 **治理能力与编辑能力**。

### 4.1 缺真正的 context compaction

当前仓库只有两种“轻 compaction”：

- explorer 总结
- tool part 清洗

但还没有真正的“历史压缩并保留 handoff summary”的机制。

Codex 在 `tmp/codex-main/codex-rs/core/src/compact.rs` 里已经把 compaction 做成一等能力：

- 可手动 compact
- 可自动 compact
- 历史太长时先压缩再继续
- 压缩结果是给下一个 LLM 的 handoff summary

这对你的仓库意义很大，因为现在一旦会话变长，主 agent 还是会越来越容易失焦。

### 4.2 写入原语还偏脆弱

当前仓库的写入只有：

- `write_file`
- `edit_file`

其中 `edit_file` 依赖 exact string match，这在真实代码修改里有几个明显问题：

- 上下文稍有漂移就失败
- 多处相似代码很难安全替换
- 大块改动体验差

Codex 的 `apply_patch` 工具是更成熟的中间形态：

- 比“整文件覆盖”更细
- 比“精确字符串替换”更稳
- 还能天然形成审阅友好的补丁

对这个仓库来说，`apply_patch` 几乎是最值得优先吸收的一项能力。

### 4.3 审批策略还太粗

当前仓库的审批模型核心是 [`app/api/chat/route.ts`](../app/api/chat/route.ts) 里的 `bypassPermissions: boolean`。

这足够做 demo，但不够表达真实策略。

Codex 把权限拆得更正式：

- sandbox mode
- approval policy
- 不同工具的批准方式
- MCP 工具级别的单独配置

你的仓库现在还只有：

- 要审批
- 不要审批

中间层缺失很多，比如：

- 只对写操作审批
- 只对 shell 审批
- 只对跨目录写入审批
- 只对网络访问审批
- 会话级记住批准偏好

### 4.4 Plan 还停留在“生成”，没有进入“执行期状态管理”

[`lib/plan-generator.ts`](../lib/plan-generator.ts) 现在做的是前置规划，非常好，但它没有真正进入主执行环。

Codex 的 `update_plan` 思路值得借鉴：

- plan 不是只生成一次
- plan 可以在执行期间持续更新
- 当前步骤、已完成步骤、待执行步骤都能被模型显式维护

这能补齐你当前 Plan 模式和主 agent 之间的断层。

### 4.5 缺更正式的运行时状态持久化

Codex 在配置、审批、SQLite 状态、sandbox policy 等方面已经明显进入“长期运行工具”的思路。

当前仓库的状态更多还在：

- 前端 localStorage
- 当前 HTTP 流式请求
- 少量会话上下文

这适合 demo，但不适合更复杂的 agent 生命周期。

---

## 5. 最值得借鉴的优化点，按优先级排序

下面这部分是最关键的。

不是所有参考能力都值得现在就搬。我的建议是分三层推进。

### P0：最先做，投入小、收益高

#### 1. 给当前仓库补一个 `apply_patch` 工具

优先级最高。

原因：

- 直接提升编辑稳定性
- 比 `edit_file` 更适合真实代码修改
- 保留 approval UI 也更容易
- 不需要先引入 workflow 或 sandbox 才能做

建议落点：

- 新增 `lib/apply-patch-tool.ts`
- 在 [`lib/write-tools.ts`](../lib/write-tools.ts) 旁边并入写工具集
- 仍然通过 approval 机制执行

#### 2. 把 `bypassPermissions` 升级成结构化 `approvalPolicy`

例如：

```ts
type ApprovalPolicy = {
  fileWrite: "always" | "never" | "on-risk";
  shell: "always" | "never" | "on-risk";
  docsWrite: "always" | "never";
  riskyPaths: string[];
};
```

这样比一个布尔值更能支撑后续演进。

建议落点：

- [`app/api/chat/route.ts`](../app/api/chat/route.ts)
- [`lib/workspace-tools.ts`](../lib/workspace-tools.ts)
- [`lib/write-tools.ts`](../lib/write-tools.ts)
- 前端工作区配置 UI

#### 3. 给主 agent 增加 `update_plan` 工具，而不仅是 `/api/plan`

不是替代现有 Plan 模式，而是补上执行期任务管理。

这样可以做到：

- 复杂任务开始时生成 plan
- 执行中持续更新
- 前端显示当前进度

这会让你的 agent 行为看起来更“有控制感”。

#### 4. 给 explorer 的返回增加结构化“证据回执”

现在 explorer 返回：

- summary
- filesExamined
- stepsUsed

可以进一步加：

- keyFindings
- unresolvedQuestions
- confidence

这样主 agent 不用二次阅读同一批文件，也更方便 UI 做透明展示。

### P1：中期做，开始接近真正产品形态

#### 5. 引入 durable run / resume stream

这块是从 Open Agents 借鉴最多的一项。

建议目标：

- 一次聊天对应一个可恢复 run
- 页面刷新时重连流
- 审批和工具调用中断后可恢复

这会明显改善长链路体验。

#### 6. 抽一层执行环境接口，弱化“直接操作宿主文件系统”

可以先不要上远端 sandbox，但应该先抽接口：

- file read/write
- exec
- search
- stat

先把调用口收敛，再决定底层是：

- 本地 workspace
- 临时隔离目录
- 远端 sandbox

#### 7. 加入 skill discovery

建议支持扫描以下目录：

- `<workspace>/.agents/skills`
- `<workspace>/.codex/skills`
- 用户全局 skills 目录

然后把 skill 内容注入到 session primer 或独立 prompt layer。

这会让你的项目从“一个固定 agent”变成“可扩展 agent 平台”。

### P2：后期做，适合项目产品化后再上

#### 8. 正式做 context compaction

包括：

- 历史超长自动压缩
- 压缩摘要持久化
- 压缩后继续执行
- 下次恢复时把摘要作为 handoff context

#### 9. 做更正式的 permission presets

例如：

- read-only
- workspace-write
- workspace-write + shell-readonly
- full-access

以及：

- on-request
- on-failure
- never

#### 10. 把 subagent 扩展为 registry，而不是单个 explorer

这是复杂任务质量上限的重要来源，但没有必要第一阶段就做重。

---

## 6. 我最建议你现在就改的 5 件事

如果只允许我给这个仓库列一个最务实的优化清单，我会给下面这 5 项：

1. 加 `apply_patch`
2. 把 `bypassPermissions` 改成结构化策略
3. 给主 agent 增加 `update_plan`
4. 给 explorer 增加结构化证据回执
5. 设计 run/resume 的持久化接口

这 5 项里，前 4 项都不需要你先重构成大系统，就能明显提升体验和稳定性。

---

## 7. 如果映射回当前仓库，建议改哪些文件

### `app/api/chat/route.ts`

适合继续承担：

- agent 调用入口
- prompt 层装配
- toolset 注册
- approval policy 注入

但后续应减少它直接承担“会话生命周期”的职责。

### `lib/write-tools.ts`

这里应该成为统一写入入口，后续可扩展为：

- `write_file`
- `edit_file`
- `apply_patch`
- 风险分类后的审批策略

### `lib/subagents/explorer.ts`

这里可以继续保留 explorer，但建议未来把它升级为：

- 多角色 subagent registry 的第一个成员
- 结构化返回而不是纯摘要优先

### `lib/session-primer.ts`

这里已经是好基础，后续可增加：

- primer 缓存
- skills 合并
- AGENTS / skills / environment 的来源清单

### `lib/workspaces.ts`

这里更适合逐步抽象成"执行环境接口"的底层实现，而不应永远直接暴露为唯一实现。

---

## 8. 不建议现在照搬的东西

也有一些能力，我认为现在没必要急着搬。

### 8.1 不建议立刻照搬 Open Agents 的整套 workflow + sandbox 基建

原因不是它不好，而是太重。

你的项目当前核心价值是：

- 把本地 agent dev flow 跑顺
- 把 prompt / tool / approval / plan 做明白

如果过早引入完整 workflow 与远端 sandbox，开发重心会迅速从“agent 体验”偏到“平台运维”。

### 8.2 不建议立刻照搬 Codex 级别的全套 sandbox policy

Codex 的治理层很强，但那是大 runtime 的复杂度。

对当前仓库，先做“结构化 approval policy + 更好的写入工具 + 未来可抽象的执行环境接口”，收益更直接。

---

## 9. 总结

一句话判断：

> 当前仓库已经有了一个不错的 agent demo 核心，强项在 prompt layering、工作区边界、审批写入和实验性 tool design；真正该补的不是“再多几个工具”，而是更稳的编辑原语、更细的权限模型、可恢复的运行时，以及正式的上下文压缩能力。

如果从两个参考项目各取其长，我会这样拿：

- 从 Open Agents 拿：
  - durable run / resume
  - agent 与 sandbox 解耦
  - skill discovery
  - registry 化子 agent

- 从 Codex 拿：
  - `apply_patch`
  - `update_plan`
  - context compaction
  - 更正式的 approval / sandbox policy

对这个仓库来说，最优演进路线不是“照搬一个框架”，而是：

> 保留当前仓库轻量、清晰、适合实验的优点，再有选择地吸收 Open Agents 的运行时能力，以及 Codex 的治理与编辑能力。
