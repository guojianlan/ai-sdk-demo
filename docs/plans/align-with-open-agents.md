# 对齐 open-agents：从 MVP 到产品化的实施 plan

## Context

用户诉求：
1. **命名对齐 open-agents**：read / write / edit / glob / grep / bash / task / todo_write / ask_user_question
2. **新增 3 个基础 tool**：`bash` / `web_fetch` / `skill`
3. **客户端 loop 设计借鉴 open-agents**
4. **从 MVP 走向商业 / 线上产品**

调研结论：
- open-agents 的 tool 集合是 12 个左右；我们当前 11 个，重叠约 6 个
- open-agents **不是真正的客户端 loop**——他们是 server-side durable workflow（Vercel Workflow SDK）+ AI SDK `useChat` + SSE，客户端通过 `sendAutomaticallyWhen` 自动续。但他们的**持久化 / resume / abort transport / active stream** 这套生产级机制值得借鉴
- open-agents 有 `packages/sandbox/` 完整 sandbox 抽象层（`Sandbox` 接口 + `VercelSandbox` 实现）；我们目前直接 `node:fs` + `execFile`，无隔离

## 整体路线图（建议分 5 个 PR-sized group 推进）

| Group | 内容 | 推荐优先级 | 工作量 | 是否阻塞下一组 |
|---|---|---|---|---|
| **A** | Tool 命名对齐 + 现有 tool 重命名/扩展 | P0 | ~3h | 不阻塞 |
| **B** | 新增 `bash` / `web_fetch` / `skill` 三个基础 tool | P0 | ~4h | A 做完更顺畅 |
| **C** | `SandboxAdapter` 抽象 + `LocalSandbox` 实现，所有 IO 走 sandbox | P1 | ~3h | B 之后做最佳 |
| **D** | 客户端 loop 增强：AbortableTransport / 持久化 / resume | P2 | ~6h | 独立 |
| **E** | 产品化基础设施：User / Audit log / Quota / 监控 | P3 | ~4h+ | 看业务方向 |

总计 P0+P1：~10 小时（一天工作量）；全部：~20 小时（2-3 天）。

---

## Group A: Tool 命名对齐 + 重新分类

**为什么做**：和 open-agents 的命名对齐，让 LLM 在训练数据里见过相同 tool 名（提升首次成功率），让团队迁移成本降低，让 description 三段式更对齐行业实践。

### 改名 mapping

| 现名 | 新名（对齐 open-agents） | 语义变化 |
|---|---|---|
| `read_file` | **`read`** | 同语义 |
| `write_file` | **`write`** | 同语义 |
| `edit_file` | **`edit`** | 同语义 |
| `list_files` | **`glob`** | **改语义**：从"递归列目录" → "按 glob pattern 匹配文件"。深度 / limit 参数下沉为可选 |
| `search_code` | **`grep`** | 同语义（都是 ripgrep wrapper），改名 |
| `run_lint` | 删除，由 `bash` 取代 | bug-fix workflow 的 verify 节点改用 `bash` 跑 `npm run lint` |
| `update_plan` | **`todo_write`** | 更对齐 Claude Code 用语（todo > plan，更轻量心智） |
| `ask_question` | **`ask_user_question`** | 同语义，对齐 open-agents 命名 |
| `explore_workspace` | **`task`** | 改名（不改语义；后续可能扩成通用 subagent spawner） |
| `ask_choice` | （保留）`ask_choice` | 我们独有，open-agents 没有 |
| `show_reference` | （保留）`show_reference` | 我们独有 |

### 实施动作

1. 重命名 [lib/tools/](lib/tools/) 下文件内容：每个 `defineTool({ name: "..." })` 改名
2. 调整 `lib/tools/workspace.ts` 的 `list_files` 改 `glob`：
   - inputSchema：`pattern: string` 替代 `relativePath / depth / limit`
   - execute：用 `fast-glob` 或 `node:fs.glob` 实现（最低成本：用 `searchWorkspace` 的现有路径过滤逻辑）
3. 删 [lib/tools/lint.ts](lib/tools/lint.ts)（改由 bash 替代，见 Group B）
4. 同步更新所有调用方的 tool 名引用：
   - [lib/agent/source.ts](lib/agent/source.ts) `CHAT_TOOLS_BY_ACCESS_MODE`
   - [lib/workflows/bug-fix.ts](lib/workflows/bug-fix.ts) 节点 `config.tools` 字段
   - [app/api/chat/agent-config.ts](app/api/chat/agent-config.ts) `projectEngineerStaticToolset`
   - [app/api/chat/route.ts](app/api/chat/route.ts) no-tools 分支
   - [app/_components/tool-card/](app/_components/tool-card/) 任何按 toolName dispatch 的注册表
5. 类型导出对齐：`PlanStep / PlanStepStatus` → `TodoStep / TodoStepStatus`，`UpdatePlanCard` → `TodoWriteCard`

### 取舍提醒

- **改名是 breaking change**：现有 chat history 里的 tool call message 仍然带旧名（`list_files` 等），LLM 看了会迷惑。**MVP 阶段建议清空 chat-store 重新开始**，不做兼容映射（兼容映射会让代码很丑）。
- `glob` 的语义改动比较大：旧 `list_files` 是"列目录"，新 `glob` 是"匹配 pattern"。如果你常用"列当前目录"，需要传 `pattern: "*"`。这个迁移是值得的——`glob` 表达力远高于 `list_files`。

---

## Group B: 新增 `bash` / `web_fetch` / `skill`

### B1. `bash` —— 通用 shell + 危险命令审批

参考 `open-agents/packages/agent/tools/bash.ts`：

```ts
defineTool({
  name: "bash",
  kind: "shell",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell command to run."),
    cwd: z.string().optional().describe("Working directory relative to workspace root."),
    detached: z.boolean().optional().describe("Run in background, return immediately."),
  }),
  // 默认 needsApproval：危险命令检测；普通命令不审批（让用户改 access mode 控制）
  approval: (input, ctx) => {
    if (ctx.bypassPermissions) return false;
    return commandLooksDangerous(input.command);  // /\brm\s+-rf\b/ + 后续可扩
  },
  execute: async ({ command, cwd, detached }, { sandbox, workspace }) => {
    const wd = cwd
      ? path.resolve(workspace.root, cwd)
      : workspace.root;
    if (detached) {
      const { commandId } = await sandbox.execDetached(command, wd);
      return { detached: true, commandId };
    }
    return sandbox.exec(command, wd, 120_000);  // { success, exitCode, stdout, stderr, truncated }
  },
});
```

**设计要点**：
- 危险命令模式列表初始：`[/\brm\s+-rf\b/, /\bsudo\b/, /:(){.*}.*&/]`（fork bomb 兜底）
- 可通过环境变量配置 timeout（默认 120s）
- 输出 50KB 截断（和 open-agents 一致）
- `detached` 模式给 dev server 之类用（开后端 + 前端跑测试）

### B2. `web_fetch` —— HTTP GET，默认不审批（出网即审批太激进）

参考 `open-agents/packages/agent/tools/fetch.ts`，但**我们不走 curl-in-sandbox**（MVP 直接用 Node `fetch`）：

```ts
defineTool({
  name: "web_fetch",
  kind: "readonly",  // 不改本地状态，但要审批的话设 'shell' 也行
  inputSchema: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  // 不默认审批（read-only 性质）；如果担心 SSRF / 数据泄露，可改 'shell' kind
  execute: async ({ url, method, headers, body }, _ctx) => {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    const truncated = text.length > 20_000;
    return {
      ok: res.ok,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: truncated ? text.slice(0, 20_000) : text,
      truncated,
    };
  },
});
```

**取舍**：
- open-agents 用 `curl in sandbox` 是为了 sandbox 隔离 + 让 sandbox 的网络策略统一管控。我们 MVP 直接 Node fetch（更简单，但出网行为没经 sandbox 限制）。
- **SSRF 风险**：恶意 prompt 让 agent 调 `web_fetch` 拉 `http://169.254.169.254/...`（云元数据）。生产环境要在 fetch 前做 URL 白名单 / 黑名单。MVP 暂不做。

### B3. `skill` —— 从 workspace 读 markdown skill

参考 `open-agents/packages/agent/tools/skill.ts` + `skills/loader.ts`：

```
.claude/skills/                    ← workspace 里的 skill 目录
  ├── code-review.md               ← 一个 skill
  └── refactor-typescript.md
```

每个 skill 文件结构：
```markdown
---
name: code-review
description: Do a thorough code review of a PR or diff
---

# Code Review

You are reviewing $ARGUMENTS. Focus on: ...
```

**实施**：
1. 加 `lib/skills/loader.ts`：`listSkills(workspaceRoot)` 扫描目录返 `SkillMetadata[]`；`loadSkill(name, workspaceRoot)` 读单个 + 解 frontmatter + 替换 $ARGUMENTS
2. 加 `lib/tools/skill.ts`：
   ```ts
   defineTool({
     name: "skill",
     kind: "readonly",
     inputSchema: z.object({
       skill: z.string().describe("Name of the skill to invoke"),
       args: z.string().optional().describe("Arguments to pass into $ARGUMENTS"),
     }),
     execute: async ({ skill, args }, { workspace }) => {
       const loaded = await loadSkill(skill, workspace.root);
       const body = substituteArguments(loaded.body, args ?? "");
       return { name: loaded.name, body };
     },
   });
   ```
3. **system prompt 注入**：`lib/agent/source.ts` 的 `chat` source 在拼 system 时附加一段"Available skills: ..."列表，让 LLM 知道有哪些 skill 可调

**为什么有用**：用户可以在 workspace 自定义"code-review" / "write-doc" / "refactor-x" 等 skill，agent 一句 `skill("code-review", "this PR")` 就引入对应 prompt 模板。这是 open-agents 的核心差异化能力。

### 取舍提醒

- **bash 一旦上线，能力翻倍但风险也翻倍**：恶意 prompt 可以让 agent 跑 `cat ~/.ssh/id_rsa`。强烈建议 Group B 同时做 Group C（sandbox 隔离），否则线上不能开 bash。
- **skill 系统的 admin/sharing 模型**没设计：MVP 只支持 workspace-local skills（每个工作区自己 .claude/skills/）；未来要做"全局 skill 库 / 用户共享"再加。

---

## Group C: SandboxAdapter 抽象 + LocalSandbox

### 接口设计（抄 open-agents）

```ts
// lib/sandbox/types.ts
export interface SandboxAdapter {
  readonly type: "local" | "vercel" | "docker" | "remote";
  readonly workingDirectory: string;

  // 文件操作
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<...>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;

  // 命令执行
  exec(command: string, cwd: string, timeoutMs: number, options?: { signal?: AbortSignal }): Promise<ExecResult>;
  execDetached?(command: string, cwd: string): Promise<{ commandId: string }>;

  // 生命周期（VercelSandbox 用）
  stop(): Promise<void>;
  getState?(): unknown;        // 用于 hibernate / persist
  snapshot?(): Promise<{ snapshotId: string }>;
}

export type ExecResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};
```

### 实施

1. `lib/sandbox/types.ts` —— interface 定义（如上）
2. `lib/sandbox/local.ts` —— `LocalSandbox` 实现（直接 `node:fs` + `execFile`，等同当前行为）
3. `lib/sandbox/factory.ts` —— `connectSandbox(type, state)` 工厂
4. **改造现有业务 tool** 通过 sandbox 调用而不是直接 IO：
   - [lib/tools/write.ts](lib/tools/write.ts) `write` / `edit` → 用 `sandbox.writeFile / readFile`
   - [lib/tools/workspace.ts](lib/tools/workspace.ts) `read` / `glob` / `grep` → 用 sandbox
   - 新建的 `bash` → 用 `sandbox.exec`
5. **`ToolContext.sandbox` 由 optional 改为 required**：抽象层在调 tool 之前确保 sandbox 已构造
6. **chat / workflow 路由初始化 sandbox**：`/api/agent/step` 在 resolve source 后构造 LocalSandbox 实例传进 experimentalContext

### 收益

- **业务 tool 零变更**就能切换部署环境（本地 → Vercel Sandbox → Docker → 远程 VM）
- 路径校验、权限模型、超时、输出截断**集中在 sandbox 层一处**，业务 tool 不再各写一份
- 给未来"用户上传 zip 文件作为临时 workspace" / "snapshot/resume 长任务" 等能力铺路

### 取舍

- 现在 `lib/workspaces.ts` 的 `resolveWorkspacePath` / `listWorkspaceEntries` / `searchWorkspace` 等会被 LocalSandbox **完全吃掉**——文件可以删，所有逻辑挪进 sandbox
- 改造工作量集中，但每个文件只动几行（fs → sandbox.fs）

---

## Group D: 客户端 loop 增强

**当前现状对照 open-agents**：

| 能力 | open-agents | 我们 client 模式 |
|---|---|---|
| Loop driver | server workflow + `useChat` 消费 SSE | 自己 hook 跑 `runAgentLoop` |
| Transport | `AbortableChatTransport` 包装 `DefaultChatTransport`，集中管 abort | 直接 `fetch`，abort 散在 hook 里 |
| 持久化 | PostgreSQL（`chats` + `chatMessages` 表） | **无**（messages 在 useState，刷新丢） |
| Resume | `chats.activeStreamId` + `/api/chat/[id]/stream` GET 重连 | 无 |
| Auto-submit | `sendAutomaticallyWhen` 检查 tool parts 全到终态 | 我们 hook 里手动 await deferred |
| 中断 | POST `/api/chat/[id]/stop` + Workflow SDK `getRun().cancel()` | client `AbortController.abort()` |

**我建议借鉴的部分**（按价值排）：

### D1. AbortableTransport 抽象（小改动，大清晰）

把 `step-client.ts` 里的 fetch 包成一个 `StepTransport` 类，统一管 abort + retry + auth header。
工作量：1h。收益：以后加 token / rate limit header / retry 集中改一处。

### D2. 客户端 messages 持久化（中等改动，大体验提升）

两条路：
- **方案 a**: 复用现有的 server `chat-store`（SQLite），让 client 模式也走同一套持久化。每次 `runAgentLoop` 推进时调 `/api/chat-store/append` 写入；hook 启动时调 `/api/chat-store/[id]` 读历史。
- **方案 b**: 浏览器侧 IndexedDB。完全前端，无后端依赖。

我推荐 **方案 a**：和 server 模式打通，跨设备 / 跨刷新一致。

工作量：2-3h。需要：
1. 新加 `/api/chat-history/[chatId]` GET / POST 路由
2. `useClientAgentChat` 启动时拉历史，每个 `onMessagesUpdated` callback 后异步 POST 写入
3. UI 加 sessionId 概念（当前 client 模式无 session id，需要生成 + 写 URL）

### D3. Resume 正在跑的 stream（大改动）

完全照搬 open-agents 的"active stream registry"模式：
- `lib/active-streams.ts` 已经有了（server 模式用），可以直接复用
- `/api/agent/step` 启动时 `activeStreams.register(chatId)`，把 SSE 流 tee 一份进内存 buffer
- 新加 `/api/agent/[chatId]/stream` GET，subscribe 现有 buffer
- client 启动时 GET 试图 resume；返 204 就当没事，返流就接着读

工作量：2-3h。复杂度集中在"如何把 in-progress 的 step 状态（liveStep）也恢复"。MVP 可以简化：只恢复 messages，liveStep 重置。

### 取舍

- D1 几乎无副作用，**强烈建议做**
- D2 让 client 模式可用度大幅提升，但要小心 hook 的依赖数组管理（messages 频繁变 → 频繁 POST）
- D3 是"刷新页面不丢"的核心，但实现复杂；如果用户场景是"短对话 + 偶尔刷新无所谓"，可以不做

---

## Group E: 产品化基础设施

这一组**取决于业务方向**，不动代码先列清单：

### E1. User 概念（多租户必备）
- 加 Auth（NextAuth / Clerk / 自建）
- `ToolContext.user: { id, email, plan }`
- 每个 chat / workflow run 关联 userId
- workspace 隔离：每用户自己的 workspace 列表

### E2. Audit log
- 新加 `audit_log` 表：`{ id, userId, ts, kind: 'tool_call' | 'workflow_run' | ..., toolName?, input?, output?, durationMs }`
- 在 `defineTool` 抽象层挂 hook：每个 tool execute 前后写一条
- 给后续合规 / 审查 / debug 用

### E3. Quota / rate limit
- per-user：每天最大 tool call 数 / token 数 / cost
- per-tool：bash 每分钟最多 10 次
- 在 `runAgentLoop` 入口检查，超 quota 直接拒绝
- middleware 抽象（middleware/quota.ts）

### E4. 错误监控
- Sentry / Datadog 接入
- `defineTool` 抽象层：tool execute 抛错时自动上报
- step API 抛错也上报

### E5. MCP 重新接入
- 当前 MCP（weather）只在 server 模式 chat 路由里用
- 客户端 client 模式 + workflow 都没接 MCP
- MCP 是"动态外部工具"——和我们的 `defineTool`（静态注册）不同
- 设计：`source.ts` 在 resolve 时如果指定了 mcpEndpoints，per-request spawn MCP client，把工具临时合并进 ToolSet

### 取舍

E1 / E2 / E3 / E4 是 SaaS 化必做。
E5 是按需做（看你的产品要不要支持 MCP 生态）。

---

## 推荐落地顺序

按"独立 PR + 风险可控"原则：

```
Day 1 (P0):
  上午: Group A (命名对齐 + glob 改造)
  下午: Group B 部分 (bash + web_fetch；skill 留到下次)

Day 2 (P0/P1):
  上午: Group B 完成 (skill 接入 + system prompt 注入)
  下午: Group C (Sandbox 抽象，所有 IO 走 sandbox)

Day 3 (P2):
  上午: Group D1 (AbortableTransport)
  下午: Group D2 (client 持久化)

后续 (P3):
  Group D3 (resume) + Group E (产品化基础设施) 按需
```

完整跑完 P0+P1+P2 大约 2.5 天工作量。

---

## 待确认

1. **范围**：A+B / A+B+C / A+B+C+D / 全部，你想先做哪组？
2. **glob 改造**：要不要保留旧 `list_files` 的"递归列目录"行为？（可以做成 `glob({ pattern: "**/*", maxDepth: 2 })` 等同效果）
3. **bash 危险命令模式**：列表你想加哪些？（默认 `rm -rf` / `sudo` / fork bomb）
4. **skill 目录约定**：`.claude/skills/` 还是 `.skills/` 还是别的？（用户上传/分享时还会牵涉）
5. **client 持久化**：复用 server SQLite 还是浏览器 IndexedDB？我倾向前者
6. **是否同时做 Group A 的 breaking name change**？现有 chat history 里旧 tool 名会"过时"，需不需要 history wipe？
