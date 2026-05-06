# Open Agents 对齐计划（Phase 2）

> 目标：在 [open-agents-workflow-integration-plan.md](./open-agents-workflow-integration-plan.md) 完成的 Vercel Workflow 集成基础上，把循环模型、skill 体系、pause-for-tool-interaction、按步落库这几块也对齐到 `tmp/open-agents-main`。
>
> 关联仓库：`tmp/open-agents-main/`（仅作参考，不进生产依赖）。

---

## 0. 已确认的决策（执行前定稿）

| # | 决策项 | 选择 | 影响 |
|---|---|---|---|
| 1 | 外层 loop `maxSteps` | **500**（同 open-agents） | A 路 / Phase 1 |
| 2 | Subagent step 上限 | **100**（同 open-agents） | A 路 / Phase 1 |
| 3 | Skills 接入 LLM 方式 | **open-agents hybrid 模式**：names+descriptions 进 system prompt + `skill` 工具按需拉 body | B 路 / Phase 3 |
| 4 | Skills 一期迁移范围 | **A 档 + B 档共 9 个**（Phase 4 含 UI 类适配工作） | B 路 / Phase 3+4 |
| 5 | Sandbox 改造范围 | **新建 sandbox 层 + 改造全部 5 个 workspace/write 工具** | C 路 / Phase 5 |

> 概念校准：**Skill ≠ Tool**。Tool 是 model 调用的函数（有 schema/execute），Skill 是 markdown 指令文档（扩展 model 上下文、不执行代码）。两者独立维度共存。

---

## 1. 现状对照

| 维度 | 我们 | open-agents | 差距 |
|---|---|---|---|
| Workflow 框架 | ✅ `workflow/api` + `getWritable` | ✅ 同 | 已对齐 |
| 内层 `stopWhen` | `stepCountIs(16)` | `stepCountIs(1)` | **要改** |
| 外层手写循环 | ❌ 只调一次 `runAgentStep` | ✅ `for` loop maxSteps=500 | **要加** |
| `shouldPauseForToolInteraction` | ❌（只有 tool 级 `needsApproval`） | ✅ 在两步之间判断 | **要加** |
| 按步落库 | ❌ 只在末尾 `saveMessages` | ✅ 每步 `persistAssistantMessage` | **要加** |
| Subagent 上限 | 20（只有 explorer） | 100（design / executor / explorer 三个） | **要改：拉到 100** |
| Skill 发现 | ❌ | ✅ `discoverSkills()` + `skills-cache` | **要加** |
| chat-post-finish | ❌ | ✅ auto-commit / PR / usage | **大部分不适用** |
| 沙箱抽象 | ❌ 直接 Node fs | ✅ `Sandbox` interface（cloud only） | **可加：本地实现** |
| Resume buffer | `lib/active-streams.ts` 进程内 Map（**死代码**） | 走 workflow durable stream | **删** |

> **架构定论**：应用数据（messages / summaries / runtime 指针）与 workflow durable state 是两层，应保持分离。耦合面只有 `chat_runtime_state.active_stream_id` 一个 string 指针。详见 §7。

---

## 2. Skills 分档筛选（共 13 个）

不全量迁移。按"对我们有意义"分三档：

### A 档 — 直接迁移，纯 prompt 增强（5 个）
- `ai-sdk` —— AI SDK v6 用法参考，跟项目高度相关
- `chat-sdk` —— chat 协议参考，对调试 UI message 流有用
- `plan-mode` —— 跟我们 `update_plan` 工具配套
- `code-review` —— 通用，无依赖
- `workflow` —— Vercel Workflow DevKit 文档，我们正在用

### B 档 — 迁移但需要适配（4 个）
- `vercel-react-best-practices` —— Next.js 16 + React 19，剔除 Vercel-only 部分
- `emil-design-eng` —— UI 设计参考，按需
- `baseline-ui` —— UI 约束，看跟 Tailwind v4 设计是否冲突
- `frontend-design` / `web-animation-design` —— 纯参考类，按需

### C 档 — 不迁移（4 个）
- `agent-browser` —— 依赖 Playwright/sandbox，无需求
- `deploy-open-harness` —— open-agents 的部署文档
- `remove-demo-limits` —— open-agents 业务的 demo gate
- `skills-lock.json` —— 4 个 GitHub-sourced skill 的锁文件，建议 vendor 进仓库自己维护

---

## 3. 执行计划（5 个 Phase）

### Phase 0 — 删死代码（5min，零风险）

- 删除 [lib/active-streams.ts](../lib/active-streams.ts)
- 全仓 grep 确认零引用（已确认过）
- workflow SDK 的 `getRun(runId).getReadable()` 已经接管了 resume 职责

### Phase 1 — Loop 模型改造（1-2h，纯重构）

目标：内层 `stopWhen: 16` → `stopWhen: 1`，外层补手写 `for` 循环。

1. [lib/chat-agent/builder.ts](../lib/chat-agent/builder.ts):77 把 `stopWhen: stepCountIs(config.stepLimit)` 改成 `stepCountIs(1)`，从 `ChatAgentConfig` 删除 `stepLimit`（或保留作为 defense in depth 的硬上限）。
2. [app/api/chat/agent-config.ts](../app/api/chat/agent-config.ts):154 删 `stepLimit: 16`，新增 `OUTER_STEP_LIMIT = 500`（同 open-agents，可通过 env 覆盖）。
3. [app/workflows/chat.ts](../app/workflows/chat.ts):38 `runAgentWorkflow` 改成循环：
   - `runAgentStep` 返回 `{ responseMessage, finishReason }`
   - 累加 response 到 `modelMessages`
   - 出口：`finishReason !== "tool-calls"` 或 `step+1 >= maxSteps` 或 `shouldPauseForToolInteraction(parts)`（Phase 2 接入）
4. **每步 saveMessages**：把 [chat.ts:128-135](../app/workflows/chat.ts#L128) 提到循环内，注意 `compactionNotice` 只在第一步推一次。
5. **验证**：手跑一次需要多步的对话（list_files → read_file → 总结），看 step 日志和 saveMessages 调用次数。lint 通过即可。

### Phase 2 — `shouldPauseForToolInteraction`（30min）

目标：让 approval / interactive tools 在 step 边界中断 outer loop。

1. 新建 `lib/workflow/should-pause.ts`：照抄 open-agents 的判断——遍历 response message parts，遇到 `ToolUIPart` 且 `state in {input-available, approval-requested}` 返回 true。
2. 接入 `app/workflows/chat.ts` 外层循环：`if (finishReason === "tool-calls" && shouldPauseForToolInteraction(parts)) break;`
3. 验证现有 approval / `ask_question` 场景。

### Phase 3 — Skills 体系骨架（A 档 5 个，1 天）

> **采用 open-agents hybrid 模式**：names+descriptions 进 system prompt（小开销，告诉 model 有什么可用），完整 SKILL.md body 通过 `skill` 工具按需拉取。
>
> 参考实现位置：
> - 工具定义：`tmp/open-agents-main/packages/agent/tools/skill.ts`
> - prompt 注入：`tmp/open-agents-main/packages/agent/system-prompt.ts:370-413` (`buildSkillsPrompt`)
> - 类型/frontmatter：`tmp/open-agents-main/packages/agent/skills/types.ts`

#### 3.1 拷贝 A 档 5 个 skill（无适配）

从 `tmp/open-agents-main/.agents/skills/{ai-sdk,chat-sdk,plan-mode,code-review,workflow}/` → `/.agents/skills/` 整目录搬运。

#### 3.2 实现 skills 模块

1. 新建 `lib/skills/types.ts`：定义 `Skill` 类型（`name`, `description`, `body`, `frontmatter`），含 `disable-model-invocation` / `user-invocable` / `allowed-tools` 字段（参考 open-agents schema）。
2. 新建 `lib/skills/discover.ts`：扫 `.agents/skills/*/SKILL.md`，解析 YAML frontmatter + body。**不依赖 sandbox**，直接 `fs/promises`。
3. 新建 `lib/skills/cache.ts`：进程内 `Map<sessionId, Skill[]>`，按 sessionId 缓存（避免每请求重扫磁盘）。
4. 新建 `lib/tools/skill.ts`：实现 `skill` 工具
   - inputSchema: `{ skill: string, args?: string }`
   - execute: 从 `experimental_context.skills` 找到对应 name，读 SKILL.md body 返回（去掉 frontmatter）
   - 返回 `ToolResult<{ name: string; body: string }>`，符合我们 `lib/tool-result.ts` 规范

#### 3.3 system prompt 接入

在 `lib/chat-agent/system-prompt.ts` 添加 `buildSkillsSection(skills)`，输出：

```
## Skills
- 使用 `skill` 工具按需拉取下面任一 skill 的完整指令
- 用户输入 "/<skill-name>" 即代表显式调用
- 部分 skill 不允许模型主动调用，仅响应用户显式触发

可用 skills:
- ai-sdk: <description>
- workflow: <description>
- ...
```

#### 3.4 接入 chat 路由

1. POST `/api/chat` handler 里调 `discoverSkills()` → 缓存 → 通过 `experimental_context.skills` 注入 agent
2. agent 的 system prompt 通过 `buildSkillsSection(skills)` 拼入

#### 3.5 验证

- 发 "用 ai-sdk skill 解释 streamText 怎么用" → 观察是否调 `skill` 工具
- 发 "/plan-mode" → 观察 user-invocable 是否触发
- 检查 system prompt 大小（5 个 skill 的 names+descriptions 估计 1-2K，可接受）

### Phase 4 — B 档 4 个 skill 适配（半天）

> A 档骨架 work 之后做 B 档（`vercel-react-best-practices` / `emil-design-eng` / `baseline-ui` / `frontend-design` / `web-animation-design`，共 5 个，原计划写 4 个有误）。

1. 整目录拷过来（机制 Phase 3 已就绪）。
2. 逐个 review SKILL.md 内容：
   - `vercel-react-best-practices`：剔除 Vercel-only / 部署相关条款
   - `emil-design-eng` / `baseline-ui` / `frontend-design` / `web-animation-design`：检查跟 Tailwind v4 + 我们现有 UI 风格的冲突点，必要时本地 fork 改写
3. **不引入 `skills-lock.json`**：vendor 进仓库自己维护（符合 cleanup bias）。
4. （可选）`scripts/sync-skills.ts`：从 `tmp/open-agents-main/.agents/skills/` 同步指定子集，方便后续 open-agents 升级时 diff。

---

## 4. 决策点（已收敛 → 见 §0 决策表）

下面是**剩余开放问题**，可在执行 PR 中拍板：

1. ~~maxSteps~~ → 已定 **500**
2. ~~Subagent step 上限~~ → 已定 **100**（同 open-agents）
3. **`stepLimit` 字段**：删字段更干净；保留作为 AI SDK 内层硬上限的 defense in depth 也合理。建议**删**（cleanup bias）。
4. ~~Skills 接入方式~~ → 已定 **open-agents hybrid**
5. **`onWorkflowFinish` hook**：暂不引入（YAGNI），需要 auto-commit 之类的功能时再加。
6. **Ship 节奏**：A 路 = Phase 0+1+2 一个 PR；B 路 = Phase 3 一个 PR，Phase 4 一个 PR；C 路 = Phase 5 一个 PR。3 路并行（A 路先 merge，B/C 同时跑）。

---

## 5. 后续讨论中的两个开放话题

### 5.1 本地 sandbox 实现

open-agents 的 [packages/sandbox/interface.ts](../tmp/open-agents-main/packages/sandbox/interface.ts) 已经定义了完整的 `Sandbox` interface（`readFile`/`writeFile`/`stat`/`readdir`/`exec`/`mkdir`/`access` + lifecycle hooks）。当前唯一实现是 `vercel/`。

**评估**：
- 实现成本低：纯 Node `fs/promises` + `child_process.spawn` 即可
- 收益：(a) 现有 workspace tools 可以基于统一接口，将来切 cloud sandbox 零改动；(b) 测试时 mock 一个 sandbox 就行
- 风险：现有 [lib/workspaces.ts](../lib/workspaces.ts) 已经做了路径校验、ripgrep 调用，要小心**不要破坏 `..` escape 防御**
- 建议：作为 **Phase 5（独立 PR）**，先不阻塞 loop / skill 改造

详见 §6。

### 5.2 Workflow 引擎选择

**已经定了**：我们正在用 `workflow` package v4.2.4（即 Vercel Workflow DevKit），跟 open-agents 同款。

`https://workflow-sdk.dev/worlds/local` 是 Workflow SDK 自带的本地开发模式——不需要部署到 Vercel。我们 dev 时已经用 local world 跑（[app/workflows/chat.ts](../app/workflows/chat.ts) 的 `"use workflow"` directive 由 SDK 在本地 in-process 解释执行）。所以**不需要自实现，也不需要担心 vendor lock**。生产部署时再决定 local / Vercel-hosted。

详见 §7。

---

## 6. Phase 5 — 本地 Sandbox 实现 + 全量工具改造

> 不阻塞 Phase 1-4，独立 PR 排期。**改造范围 = 5 个工具全切**：list_files / search_code / read_file / write_file / edit_file。

#### 6.1 sandbox 层

1. 新建 `lib/sandbox/` 目录
2. 拷贝 `packages/sandbox/interface.ts` → `lib/sandbox/interface.ts`，把 `SandboxType = "cloud"` 改为 `"cloud" | "local"`
3. 新建 `lib/sandbox/local/index.ts` 实现 `LocalSandbox`：
   - `workingDirectory`：从 `WORKSPACE_BASE_DIR` 推导
   - `readFile / writeFile / stat / readdir / mkdir / access`：直接 `fs/promises`，**内部复用 [lib/workspaces.ts](../lib/workspaces.ts) 的 `..` escape 校验**
   - `exec`：`child_process.spawn` + AbortSignal + truncate stdout/stderr（用于 ripgrep）
   - `getState`：`{ type: "local", workingDirectory }`
   - 不实现 `snapshot` / `extendTimeout`（cloud-only 概念）
4. 新建 `lib/sandbox/factory.ts`：`connectSandbox(state)` 按 `type` dispatch

#### 6.2 工具改造（5 个）

| 工具 | 文件 | 改造内容 |
|---|---|---|
| `list_files` | [lib/workspace-tools.ts](../lib/workspace-tools.ts) | 改用 `sandbox.readdir` |
| `search_code` | [lib/workspace-tools.ts](../lib/workspace-tools.ts) | 改用 `sandbox.exec("rg ...")` |
| `read_file` | [lib/workspace-tools.ts](../lib/workspace-tools.ts) | 改用 `sandbox.readFile` |
| `write_file` | [lib/write-tools.ts](../lib/write-tools.ts) | 改用 `sandbox.writeFile`，**保留 approval 流** |
| `edit_file` | [lib/write-tools.ts](../lib/write-tools.ts) | 改用 `sandbox.readFile + writeFile`，**保留 approval 流** |

#### 6.3 sandbox 注入

通过 `experimental_context.sandbox` 把当前 sandbox 实例传给所有工具，工具内部 `getSandbox(ctx)` 拿。

#### 6.4 验证（关键）

- ✅ 三个 read 工具基础功能（list / search / read）
- ✅ **approval 流回归**：write_file 弹审批 → 同意 → 实际写盘；拒绝 → 不写
- ✅ `..` escape 攻击仍被拒（通过新 sandbox 也不能逃出 workspaceRoot）
- ✅ ripgrep 大结果不爆内存（exec 截断生效）
- ✅ AbortSignal 中断 exec 时不留僵尸进程

---

## 7. Phase 6（草案）— 多实例部署迁移

> **触发条件**：要上 Vercel / 多实例。短期不做。

架构上是**两层独立 storage**，迁移分两条独立轨道，互不阻塞：

```
应用数据（我们自己管）         Workflow durable state（SDK 管）
─────────────────────         ──────────────────────────────
chat-store.ts (SQLite)         workflow package (local world)
  ├ messages                     ├ run lifecycle
  ├ session_summaries            ├ durable SSE stream
  └ chat_runtime_state ────→     └ runId → run object
                  (耦合点：一个 workflowRunId 字符串指针)
```

### 轨道 A — Workflow world：local → postgres

- 按 `https://workflow-sdk.dev/worlds/postgres` 文档加 adapter 与 connection string
- 新建 `workflow.config.ts`（或对应配置）指定 world
- **业务代码 [app/workflows/chat.ts](../app/workflows/chat.ts) 零修改**
- 影响：workflow 的 run 状态 / durable stream 从内存搬到 pg

### 轨道 B — 应用数据：SQLite → Postgres

- [lib/chat-store.ts](../lib/chat-store.ts) 换 driver：`better-sqlite3` → `pg` 或 drizzle，SQL 基本不变
- 三张表（`messages` / `session_summaries` / `chat_runtime_state`）做 schema migration
- 引入 migration 工具（drizzle-kit / kysely / 原生 SQL，按团队偏好）
- 影响：消息历史 / summary / runtime 指针跨实例可见

### 不做的事

- **不**把 messages 塞进 workflow durable state（混淆"执行级"与"业务级"，删 run ≠ 删 chat history）
- **不**保留 `active-streams.ts` 替代方案（已是死代码，workflow durable stream 自带 resume）

短期完全不需要。

---

## 8. 风险登记

- **Loop 改造容易出 saveMessages 重复 / 顺序错误的 bug**：加 step 日志 + manual smoke test（多步对话）
- **maxSteps=500 + bug 死循环代价高**：建议 Phase 1 同步加一条"检测到连续 N 步无新 tool call 就 break"的逃生通道（可选）
- **B 档 UI skill 跟 Tailwind v4 风格冲突**：Phase 4 必须逐个 review SKILL.md 内容，必要时 fork 改写
- **Sandbox 全量 5 个工具改造**：approval 流必须完整回归测试（write/edit 改动面最大）
- **删 `stepLimit` 配置字段**：检查 [docs/](.) 和 README 引用
- **删 `active-streams.ts`**：确认零引用（已确认），不需要保留兼容
