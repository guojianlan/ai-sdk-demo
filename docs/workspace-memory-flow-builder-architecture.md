# Workspace Memory 与自定义流程编排架构

> 目标：把当前本地 coding agent 原型，演进成“以 Workspace 为中心、具备长期记忆、可上传项目文档、可在无限画布上自定义流程”的团队自动化平台。
>
> 这份文档基于当前仓库能力和我们的讨论整理。它不要求接入 Vercel sandbox；底层仍然以本机代码、文档、测试环境和本地 sandbox-runtime 为核心。

---

## 1. 背景与方向

我们要做的不是一个固定的 bugfix agent，也不是一个只靠 prompt 驱动的聊天机器人。

正确方向是两层：

```text
Agent Runtime 层
  像 Codex / Claude Code：具备工具、沙箱、会话、上下文压缩、记忆、权限、MCP、skill。

Business Workflow 层
  面向团队业务：bugfix、需求开发、测试验证、状态回写、通知、文档关联、周期性任务。
```

Agent Runtime 应保持通用；Business Workflow 可以由用户在无限画布上自定义。

固定 bugfix 流程只是一个系统预置模板，不应该写死进主 chat agent。

---

## 2. 当前基础能力

当前仓库已经具备一部分底座。

### 2.1 已有 Agent Runtime 能力

- `ToolLoopAgent` 主 agent。
- Workflow 外层循环，每步执行一次 LLM + tool。
- `LocalSandbox` 抽象。
- `@anthropic-ai/sandbox-runtime` 已接入 shell 命令执行路径。
- workspace 工具：`read`、`glob`、`grep`。
- 写入工具：`write`、`edit`。
- shell 工具与审批策略。
- skill 系统：metadata 进 prompt，body 按需通过 `skill` 工具读取。
- MCP 动态工具接入基础。
- subagent：当前已有 explorer 类型。
- context compaction：长对话压缩成 handoff summary。

### 2.2 已有持久化能力

当前持久化根目录：

```text
~/.local-agent/
  agent.db
  sessions/YYYY/MM/DD/<thread-id>.jsonl
```

可通过 `AGENT_STORAGE_DIR` 修改。

当前 SQLite 已有：

```text
threads
messages
thread_summaries
thread_runtime_state
```

这说明 session/thread 已经是持久化对象。

### 2.3 当前不足

当前 `workspace` 还不是一等实体，只是从文件系统扫描出来的目录描述。

目前缺少：

- `workspaces` 持久化表。
- workspace 级长期 memory。
- 文档上传、解析、版本管理。
- workspace 内项目关系管理。
- 自定义 workflow definition。
- workflow run / node run 状态持久化。
- bug / requirement / verification / status update 等业务对象。
- 后台管理界面。

所以当前可以支撑“在某个 session 内完成一次修复”，但还不能完整支撑“团队级、workspace 级、可编排、可追踪、可管理”的自动化流程。

---

## 3. 核心判断：DB、Schema、Prompt 的职责

自定义流程不能全部靠 prompt 实现。

三者边界应该是：

| 层 | 职责 | 不该负责 |
|---|---|---|
| DB | 存流程定义、运行状态、节点结果、文档、记忆、审计日志 | 不负责推理 |
| Schema | 定义流程语言、节点类型、输入输出、配置校验 | 不负责实际执行 |
| Prompt | 驱动 agent 节点完成智能任务 | 不负责全局流程状态 |

一句话：

```text
DB 存事实和状态；
Schema 定义流程语言；
Prompt 只属于 Agent 节点的执行策略。
```

如果全靠 prompt，会无法可靠处理：

- 节点是否执行过。
- 失败后从哪里恢复。
- 哪个分支正在等待人工审批。
- 哪些 bug 已经消费。
- 哪个文档版本参与了本次运行。
- 哪个 agent 修改了哪些文件。
- 并发分支如何 join。
- 定时任务如何避免重复消费。
- 审计、回放、重试、暂停。

这些必须是 Workflow Runtime + DB 的职责。

---

## 4. 目标概念模型

系统最上层应该从 `Session` 变为 `Workspace`。

```text
Workspace
  Project / Repository
  Requirement / Product Document
  Bug / Issue
  Flow Definition
  Flow Run
  Session / Thread
  Memory
  Artifact
```

Session 是 workspace 里的一个交互记录或 workflow run 里的执行记录，不再是业务中心。

---

## 5. Workspace 作为一等实体

### 5.1 Workspace 表

建议新增：

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

说明：

- `root` 是本地项目目录。
- `id` 是稳定业务 ID，避免用路径直接做所有外键。
- `status` 可支持 `active`、`archived`。

### 5.2 Workspace Settings

```sql
CREATE TABLE workspace_settings (
  workspace_id TEXT PRIMARY KEY,
  default_model TEXT,
  default_shell_approval_policy TEXT,
  sandbox_enabled INTEGER,
  sandbox_allowed_domains TEXT,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
```

这层不是替代 `.env`。

- `.env` 是应用启动配置。
- workspace settings 是某个项目的运行偏好。

### 5.3 Workspace 关系

一个 workspace 可能关联多个 repo、接口服务、文档源、测试环境。

```sql
CREATE TABLE workspace_relationships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`kind` 示例：

```text
repo
frontend
backend
test_env
bug_tracker
doc_source
mcp_server
api_service
```

---

## 6. 文档上传与需求管理

需求文档不能只是 chat 附件。它应该是 workspace 的知识源。

### 6.1 文档表

```sql
CREATE TABLE workspace_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  version TEXT,
  source TEXT,
  file_path TEXT,
  checksum TEXT,
  extracted_text TEXT,
  metadata TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`type` 示例：

```text
prd
test_case
api_doc
design_doc
release_note
bug_report
manual_note
```

### 6.2 Requirement 表

```sql
CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  document_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

文档上传后可以由 agent 或 parser 抽取 requirement。

后续 bugfix workflow 运行时，应该从 bug 关联到 requirement，再从 requirement 找文档、代码区域和历史记忆。

---

## 7. Memory 系统设计

要学习 Codex 的两层思想：**上下文压缩** 与 **长期记忆** 分开。

### 7.1 第一层：Thread Compaction

当前已有 `thread_summaries`，它服务于当前 thread 的上下文压缩。

语义：

```text
当前对话太长
  -> 把旧消息压缩成 handoff summary
  -> agent 继续本轮任务
```

这不是长期记忆。

建议后续把它升级为更接近 Codex 的 checkpoint 模型：

```sql
CREATE TABLE thread_compactions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  compacted_count INTEGER NOT NULL,
  summary TEXT NOT NULL,
  input_message_ids TEXT,
  replacement_message_ids TEXT,
  tokens_before INTEGER,
  tokens_after INTEGER,
  created_at INTEGER NOT NULL
);
```

当前 `thread_summaries` 可以先保留，后续迁移。

### 7.2 第二层：Workspace Long-Term Memory

workspace memory 是跨 session、跨 workflow 的长期知识。

```sql
CREATE TABLE workspace_memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'draft',
  pinned INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`kind` 示例：

```text
architecture
domain_rule
bug_pattern
testing_note
environment_note
api_contract
team_preference
workflow_lesson
```

`status` 示例：

```text
draft       agent 生成，待审核
active      注入上下文或检索可用
archived    不再使用
rejected    明确拒绝
```

### 7.3 Memory 管理后台

需要有后台页面支持：

- 查看 workspace memories。
- 搜索、筛选、按类型查看。
- 审核 draft memory。
- 手动新增 memory。
- 编辑 memory。
- 归档 memory。
- 查看来源：来自哪个文档、bug、workflow run、chat。
- 设置 pinned。

### 7.4 Memory 注入策略

不要每次把所有 memory 都塞给 agent。

推荐流程：

```text
用户/Workflow 输入
  -> 根据 workspace_id 检索相关 memory
  -> 选出 top N
  -> 作为独立 prompt layer 注入
```

Prompt 层应该分开：

```text
# Conversation summary so far
当前 thread 的压缩摘要

# Relevant workspace memory
跨 session 的长期项目记忆
```

这两个不能混。

---

## 8. 自定义流程：无限画布 Flow Builder

用户可以在无限画布上画流程。画布产物不是 prompt，而是 `FlowDefinition`。

### 8.1 Flow Definition

```ts
type FlowDefinition = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  draftVersion: number;
  publishedVersion?: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  variables: FlowVariable[];
};
```

DB 建议拆成 definition 和 version：

```sql
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE flow_versions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(flow_id, version)
);
```

说明：

- 草稿可以反复编辑。
- 发布后固定 version。
- 每次运行绑定一个 `flow_version`，保证可回放。

### 8.2 Flow Run

```sql
CREATE TABLE flow_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE node_runs (
  id TEXT PRIMARY KEY,
  flow_run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`flow_runs` 保存整次流程状态。

`node_runs` 保存每个节点的执行状态、输入、输出、错误和重试次数。

---

## 9. 节点系统

无限画布不应该让用户自由写任意 prompt 来控制全局流程。

应该提供可组合节点。

### 9.1 第一批节点类型

```text
trigger.manual
trigger.schedule
trigger.webhook

source.bug
source.document
source.mcp
source.http

memory.read
memory.write_candidate

agent.task
agent.verify

tool.mcp
tool.skill
tool.shell
tool.http

logic.condition
logic.parallel
logic.join

human.approval
human.input

status.update
notify
```

### 9.2 节点定义 Schema

每种节点都应该有：

```ts
type NodeTypeDefinition = {
  type: string;
  label: string;
  configSchema: JSONSchema;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  executor: NodeExecutor;
};
```

每个节点实例：

```ts
type FlowNode = {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  config: unknown;
};
```

边：

```ts
type FlowEdge = {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  condition?: string;
};
```

### 9.3 Agent 节点

Agent 节点才使用 prompt。

```ts
type AgentTaskNodeConfig = {
  agentRole: "triage" | "fix" | "verify" | "reporter" | string;
  promptTemplate: string;
  tools: string[];
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  maxSteps?: number;
  requireHumanApproval?: boolean;
};
```

Agent 节点输出必须结构化。

示例：

```json
{
  "status": "fixed",
  "summary": "修复了登录页提交按钮在 loading 状态下仍可重复点击的问题。",
  "filesChanged": ["app/login/page.tsx"],
  "verification": {
    "commands": ["npm run lint"],
    "passed": true
  },
  "memoryCandidates": [
    {
      "kind": "bug_pattern",
      "content": "登录页历史上多次出现重复提交问题，修复时应检查 loading guard。"
    }
  ]
}
```

---

## 10. Workflow Runtime

Runtime 负责解释执行 graph。

它不依赖 prompt 决定流程。

### 10.1 执行职责

Runtime 负责：

- 找入口 trigger。
- 计算可执行节点。
- 读取上游节点输出。
- 校验 input schema。
- 调用节点 executor。
- 保存 node run。
- 根据 edge 条件决定下一批节点。
- 处理并发、join、失败、重试、暂停。
- 处理人工审批。
- 恢复中断的 run。

### 10.2 节点状态

```text
pending
running
waiting
completed
failed
skipped
cancelled
```

Flow 状态：

```text
draft
running
paused
completed
failed
cancelled
```

### 10.3 最小执行循环

```text
create flow_run
  -> enqueue trigger output
  -> find runnable nodes
  -> execute node
  -> persist node_run
  -> route outputs through edges
  -> repeat until no runnable nodes
  -> completed / failed / waiting
```

---

## 11. Bugfix 模板流程

你的 bugfix 流程可以作为系统预置模板。

```text
trigger.schedule(5min)
  -> source.bug
  -> source.document
  -> memory.read
  -> agent.task(triage)
  -> logic.condition(can_fix?)
     -> agent.task(fix)
     -> agent.verify
     -> logic.condition(verified?)
        -> status.update(closed)
        -> memory.write_candidate
        -> notify(success)
     -> status.update(reopened / needs_human)
     -> notify(failed)
```

这样未来用户可以复制模板，在画布上调整。

例如：

- 不想每 5 分钟跑，改成 webhook。
- 不想自动修复，只做 triage。
- 验证失败时先发给人工审批。
- 状态更新不是 MCP，而是 HTTP POST。
- 增加测试 agent 或产品确认节点。

---

## 12. Adapter 接口

业务系统的变化应该通过 adapter 接入，而不是写死到 workflow。

### 12.1 BugSourceProvider

```ts
type BugSourceProvider = {
  id: string;
  listBugs(input: {
    workspaceId: string;
    since?: number;
  }): Promise<BugRecord[]>;
};
```

来源可以是：

- MCP。
- skill。
- HTTP API。
- 定时拉取。
- 手动导入。

### 12.2 BugStatusReporter

```ts
type BugStatusReporter = {
  id: string;
  updateStatus(input: {
    bugId: string;
    status: string;
    comment?: string;
    metadata?: unknown;
  }): Promise<void>;
};
```

### 12.3 DocumentProvider

```ts
type DocumentProvider = {
  id: string;
  listDocuments(workspaceId: string): Promise<DocumentRecord[]>;
  getDocument(documentId: string): Promise<DocumentContent>;
};
```

### 12.4 VerificationProvider

```ts
type VerificationProvider = {
  id: string;
  run(input: {
    workspaceId: string;
    plan: VerificationPlan;
  }): Promise<VerificationResult>;
};
```

---

## 13. 后台管理界面

无限画布之外，还需要后台管理。

### 13.1 Workspace 管理

- 创建 workspace。
- 绑定本地路径。
- 配置默认模型。
- 配置 shell approval policy。
- 配置 sandbox domains。
- 配置 MCP server / API source。

### 13.2 文档管理

- 上传文档。
- 查看解析文本。
- 绑定需求。
- 管理版本。
- 标记废弃。

### 13.3 Memory 管理

- 查看长期记忆。
- 审核 agent 生成的 memory candidate。
- 手动新增。
- 编辑。
- 归档。
- 查看来源。

### 13.4 Flow 管理

- 无限画布编辑 flow。
- 保存草稿。
- 发布版本。
- 复制模板。
- 查看运行历史。
- 查看每个节点输入输出。
- 从失败节点重试。

---

## 14. 推荐落地顺序

### Phase 1：Workspace 一等实体

- 新增 `workspaces`。
- 新增 `workspace_settings`。
- `/api/workspaces` 从“目录扫描”升级为“扫描 + upsert + DB 返回”。
- `threads.workspace_root` 后续迁移为 `workspace_id` 外键或双写。

### Phase 2：Workspace Memory

- 新增 `workspace_memories`。
- 新增后台 CRUD API。
- 在 prompt layers 中增加 `Relevant workspace memory`。
- 实现 memory 检索的第一版：先用关键词/全文搜索，不急着做 embedding。

### Phase 3：文档上传

- 新增 `workspace_documents`。
- 支持上传 markdown/txt/pdf/docx 的第一版。
- 保存原始文件与 extracted text。
- 文档可被 agent 和 workflow 检索。

### Phase 4：Flow Definition

- 新增 `flows`、`flow_versions`。
- 无限画布先保存 graph JSON。
- 第一批节点：manual trigger、agent task、tool http、condition、notify。

### Phase 5：Flow Runtime

- 新增 `flow_runs`、`node_runs`。
- 实现解释执行器。
- 支持暂停、失败、重试。
- 节点结果落库。

### Phase 6：Bugfix 模板

- 新增 `bugs`、`bug_batches`、`bug_status_updates`。
- 做一个内置 bugfix flow template。
- 允许用户复制后自定义。

### Phase 7：后台自动化

- 定时触发 flow。
- MCP / skill / HTTP adapter。
- 通知 agent / status reporter。
- memory candidate 生成和审核。

---

## 15. 关键设计原则

1. Workspace 是顶层业务对象，session 只是执行记录。
2. Thread compaction 与 long-term memory 必须分开。
3. Flow 编排不能靠 prompt，必须由 graph runtime 管。
4. Prompt 只用于 agent 节点。
5. 每次 flow run 必须绑定固定 flow version，保证可回放。
6. 每个 node run 必须保存 input/output/error，保证可审计。
7. 业务系统通过 adapter 接入，不能写死进 runtime。
8. 固定 bugfix 流程只是模板，不是核心架构。
9. 本项目不需要 Vercel sandbox，LocalSandbox + ASRT 足够作为本地团队工作台底座。
10. 后台管理是核心能力，不是附属 UI；memory、documents、flows 都必须可管理。

---

## 16. 最小可行版本

最小版本不需要一次性做完所有业务。

建议 MVP：

```text
Workspace DB
  -> Workspace Memory CRUD
  -> Document Upload
  -> Flow Definition 保存
  -> Flow Run / Node Run 执行
  -> Agent Task 节点
  -> HTTP Tool 节点
  -> Condition 节点
  -> Manual Trigger
```

MVP 完成后，就可以把 bugfix 流程作为第一张模板 flow 做出来。

这时用户可以：

1. 创建 workspace。
2. 上传需求文档。
3. 添加/审核 workspace memory。
4. 在画布上创建流程。
5. 手动触发流程。
6. 查看每个节点的执行记录。
7. 让 agent 在本地代码里修复问题。

---

## 17. 后续实现入口建议

优先新增这些模块：

```text
lib/workspace-store/
  workspaces.ts
  documents.ts
  memories.ts

lib/flow/
  schema.ts
  graph.ts
  runtime.ts
  node-types.ts
  executors/
    agent-task.ts
    http.ts
    condition.ts
    notify.ts

app/api/workspaces/
app/api/workspaces/[id]/documents/
app/api/workspaces/[id]/memories/
app/api/flows/
app/api/flows/[id]/runs/

app/workspace/
  [workspaceId]/
    memories/
    documents/
    flows/
```

如果要保持当前页面简洁，建议先新增后台路由，不要把这些管理能力塞进现有 `app/page.tsx`。

