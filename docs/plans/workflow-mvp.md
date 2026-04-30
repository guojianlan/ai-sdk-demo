# 从 ToolLoopAgent 到节点式工作流：迁移方案

## Context

当前 `ai-sdk-demo` 的 `/api/chat` 是**全黑盒**模式：一次请求里 `ToolLoopAgent` 跑到 stop（[lib/chat-agent/builder.ts:77](lib/chat-agent/builder.ts#L77) `stopWhen: stepCountIs(stepLimit)`），所有 tool call 在服务端自动执行。

用户目标：
1. **架构层**：把 agent loop 从"服务端一次跑完"拆成**前端驱动的 single-step**——服务端每次只跑一步（一次模型调用 + 它要求的 tool calls），前端拿到结果后自己决定要不要发下一步请求。
2. **产品层**：以新架构为基础做一个 **Coze / n8n 风格的节点式工作流系统**，MVP 是"bug 自动修复"流程（6 节点，TS 硬编码）。
3. **未来**：保留扩展为可视化无限画布的能力。

### 调研关键发现（修正用户认知）

- `tmp/open-agents-main` 实际是**后端驱动**（Vercel Workflow SDK 包裹的 durable workflow，前端只订阅 SSE），`packages/agent/open-harness-agent.ts:79` 也是用 `ToolLoopAgent`。
- `tmp/codex-main-04-22` 是 Rust 实现，`codex-rs/core/src/session/turn.rs:137` 单进程内跑完整个 turn，并行执行多个 tool call。
- 用户原以为的"前端发多次 chat"在生产级开源项目里其实是少数派。但用户已选择此路线，方案按此推进。

---

## 总体架构

```
┌────────── 前端 (app/page.tsx 拓展为工作流模式) ──────────┐
│                                                          │
│  WorkflowRunner (前端 hook)                              │
│   ├─ 加载 workflow definition (从 lib/workflows/)         │
│   ├─ 维护 nodeStates: Map<nodeId, NodeState>             │
│   ├─ 顺序推进节点：调用对应节点 API → 拿结果 → 推进       │
│   └─ 在 human/approval 节点暂停，等用户操作              │
│                                                          │
└──────────────────────────────┬───────────────────────────┘
                               │ HTTP (single-step per call)
                               ▼
┌────────── 后端 single-step API (新) ─────────────────────┐
│                                                          │
│  POST /api/agent/step                                    │
│   - body: { messages, tools, model, instructions,        │
│             experimentalContext, conversationSummary }   │
│   - 内部用 generateText() 或 streamText()，**不带循环**   │
│   - 返回单步结果：{ assistantMessage, toolCalls,         │
│                    finishReason: 'stop' | 'tool-calls' } │
│                                                          │
│  POST /api/agent/tool                                    │
│   - body: { toolName, input, experimentalContext }       │
│   - 单独执行一个 tool（前端在 step 返回 tool-calls 后调用）│
│   - 返回 ToolResult<T>                                   │
│                                                          │
│  POST /api/workflow/[workflowId]/node/[nodeId]/run       │
│   - 节点级别的入口（前端 WorkflowRunner 调用）            │
│   - 内部根据 node.kind 分发到 step / tool / structured / │
│     human approval 等执行器                               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**关键设计决策**：
- **AI SDK 的 `ToolLoopAgent` 不再用于工作流模式**（只在"普通自由聊天"页面保留）。工作流的"loop"由前端 WorkflowRunner 推进。
- Tool 定义、prompt 组装、消息持久化、interactive-tools 那套全部复用。
- Single-step API 内部用 AI SDK 的 `generateText` / `streamText`（**不传 `stopWhen`**），这样模型一返回 tool-calls 就停，不会自动再调一轮。

---

## 文件清单

### 新增

| 路径 | 作用 |
|------|------|
| `lib/workflow/types.ts` | `WorkflowDefinition` / `Node` / `NodeState` / `NodeKind` 类型 + Zod schema |
| `lib/workflow/runner.ts` | 前端用的 `WorkflowRunner` class（顺序推进、状态机、事件发射） |
| `lib/workflow/node-executors.ts` | 后端节点执行器：`runAgentNode` / `runToolNode` / `runStructuredNode` / `runHumanNode` |
| `lib/workflows/bug-fix.ts` | **MVP 工作流定义**：6 节点 TS 硬编码 |
| `lib/agent/single-step.ts` | 封装 `generateText` 跑单步（无 loop），输出统一 `StepResult` |
| `app/api/agent/step/route.ts` | POST 单步 LLM 调用 |
| `app/api/agent/tool/route.ts` | POST 单 tool 执行 |
| `app/api/workflow/[id]/node/[nodeId]/run/route.ts` | POST 节点执行入口 |
| `app/api/workflow/list/route.ts` | GET 列出可用工作流（MVP 只返 `bug-fix`） |
| `app/workflow/[id]/page.tsx` | **工作流运行页面**（与 `/` 主聊天分开）。每节点一张卡片，按状态渲染 |
| `app/_components/workflow/NodeCard.tsx` | 节点卡片：pending / running / awaiting-input / done / error 五态 UI |
| `app/_components/workflow/HumanApprovalCard.tsx` | human 节点的审批 UI（diff 展示 + 通过/拒绝按钮） |

### 修改

| 路径 | 改动 |
|------|------|
| `app/page.tsx` | 顶部加"工作流"按钮，跳到 `/workflow/bug-fix`；其它逻辑不动 |
| `lib/chat-agent/builder.ts` | **不动**（继续给自由聊天页用） |
| `lib/chat-agent/system-prompt.ts` | **复用**：节点执行器调用 `buildSystemPrompt()` 拼 prompt |
| `lib/workspace-tools.ts` / `write-tools.ts` / `interactive-tools.ts` / `subagents/explorer.ts` | **不动**：tool 定义复用，节点执行器按节点配置选用 |

### 删除 / 不引入

- 暂不删除任何现有文件，新旧并行。
- 不引入 Vercel Sandbox / Docker，仍用 `lib/workspaces.ts` 的路径校验（拒绝 `..` 逃逸）。

---

## 数据结构核心

```ts
// lib/workflow/types.ts （要点节选）

export type NodeKind = "agent" | "structured" | "tool" | "human";

export type NodeDefinition = {
  id: string;                // 'diagnose' / 'propose-fix' ...
  kind: NodeKind;
  label: string;             // UI 显示
  // 节点输入：从 context 取哪些字段，再喂给本节点
  inputs: Record<string, string>;  // { bugReport: 'workflow.input.bugReport' }
  // 节点输出 schema（Zod），决定下游能拿到什么
  outputSchema: z.ZodType<unknown>;
  // 节点配置（kind 不同字段不同，用 discriminated union）
  config:
    | { kind: "agent"; instructionsTemplate: string; tools: string[]; maxSteps: number }
    | { kind: "structured"; instructionsTemplate: string; outputSchema: z.ZodType<unknown> }
    | { kind: "tool"; toolName: string }
    | { kind: "human"; promptTemplate: string };
};

export type WorkflowDefinition = {
  id: string;
  label: string;
  inputSchema: z.ZodType<unknown>;
  nodes: NodeDefinition[];   // MVP: 顺序执行（数组顺序即执行顺序）
};

// 运行时
export type NodeState =
  | { status: "pending" }
  | { status: "running"; startedAt: number }
  | { status: "awaiting-input"; payload: unknown }   // human / interactive
  | { status: "done"; output: unknown; durationMs: number }
  | { status: "error"; error: string };

export type WorkflowRunState = {
  workflowId: string;
  context: Record<string, unknown>;  // 累积所有节点 output
  nodeStates: Record<string, NodeState>;
  cursor: number;                     // 当前正在执行的 nodes[i]
};
```

---

## Bug 修复工作流（MVP）—— 6 节点定义

文件：`lib/workflows/bug-fix.ts`

| # | id | kind | 作用 | 关键 inputs | 关键 outputs |
|---|----|----|------|------------|------|
| 1 | `diagnose` | `agent` | 用 read_file/search_code/list_files/explore_workspace 定位 bug | `bugReport` | `{ rootCause, affectedFiles[], evidence[] }` |
| 2 | `propose-fix` | `structured` | 基于诊断输出结构化的修复方案（不写文件，只生成 patch 描述） | `diagnose.output` | `{ summary, patches: [{ file, oldSnippet, newSnippet, rationale }] }` |
| 3 | `human-approval` | `human` | 用户审核修复方案，可"通过 / 拒绝并附评论" | `propose-fix.output` | `{ approved: boolean, comment?: string }` |
| 4 | `apply-patch` | `agent` | 通过则用 edit_file 工具落地（**`bypassPermissions: true`**——已经过人工审批） | `propose-fix.output.patches` | `{ appliedFiles[], skippedFiles[] }` |
| 5 | `verify` | `agent` | 跑 lint / 测试（通过 shell 工具，**MVP 阶段先只跑 `npm run lint`**） | `apply-patch.output` | `{ lintPassed, lintOutput }` |
| 6 | `report` | `agent` | 生成 markdown 总结（哪些文件改了 / 为什么 / 测试结果） | 全部前序 output | `{ markdown }` |

**节点 3 是 `human` kind 的关键**：执行器创建 `awaiting-input` 状态后立刻返回，**不阻塞 HTTP 请求**；前端 WorkflowRunner 看到 `awaiting-input` 状态，渲染 `HumanApprovalCard`，等用户点击后再发起下一次 `/api/workflow/[id]/node/[nodeId]/run`（带 `humanResponse` body）。

**节点 5 需要 shell 工具**：现有 `lib/workspace-tools.ts` 没有 shell tool，**MVP 实现一个最小 `run_lint` tool**（只允许 `npm run lint`，不开放任意 shell），落在新文件 `lib/lint-tool.ts`。后续如要扩展再考虑加白名单 shell。

---

## Single-step 协议关键点

```ts
// app/api/agent/step/route.ts （核心逻辑）
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { messages, toolNames, modelId, instructions, experimentalContext } = body;

  const tools = pickTools(toolNames);  // 从 registry 选

  const result = await generateText({
    model: getModel(modelId),
    messages,
    tools,
    system: instructions,
    experimental_context: experimentalContext,
    // ⚠ 不传 stopWhen / maxSteps，模型返回 tool-calls 就 stop
  });

  return Response.json({
    assistantMessage: result.response.messages[0],   // 只有一条新增 message
    toolCalls: result.toolCalls,                     // 模型本步要求调用的 tools
    finishReason: result.finishReason,               // 'stop' | 'tool-calls'
    usage: result.usage,
  });
}
```

**前端 loop 推进伪代码**：
```ts
while (true) {
  const step = await POST('/api/agent/step', { messages, ...});
  messages.push(step.assistantMessage);
  if (step.finishReason === 'stop') break;

  // tool-calls：逐个执行（或并行），把 tool result 追加到 messages
  for (const call of step.toolCalls) {
    if (isInteractiveTool(call.toolName)) {
      // 暂停，等用户在 UI 操作 → addToolOutput
      await waitUserResponse(call);
    } else if (needsApproval(call.toolName) && !bypassPermissions) {
      // 暂停，等用户审批
      await waitUserApproval(call);
    } else {
      const result = await POST('/api/agent/tool', { toolName: call.toolName, input: call.input });
      messages.push(asToolMessage(call.toolCallId, result));
    }
  }
}
```

`agent` kind 节点内部就是上面这个 loop（节点配置里有 `maxSteps` 上限作为安全阀）。

---

## 验证方法

1. **单元层**：节点执行器测试（暂无测试框架，靠 `npm run lint` + 类型检查兜底）。
2. **集成层** —— 端到端跑 bug-fix 工作流：
   - 在 workspaces 里造一个有 bug 的 demo 项目（如 `tmp/test-workspace/buggy-app/`，故意写一个明显错误）。
   - `npm run dev` 启动。
   - 浏览器开 `/workflow/bug-fix`，输入 bug 描述（"按钮点击没反应"）。
   - 观察 6 个节点卡片依次推进、第 3 个停在 awaiting-input、点通过后继续、最终生成 report。
   - 检查 `tmp/test-workspace/buggy-app/` 文件是否被正确改动、`npm run lint` 在 verify 节点能跑。
3. **回归层**：`/`（自由聊天页）行为不能变——之前的 `useChat` + tool-card + interactive 流程要全部正常。
4. **类型 / lint**：`npm run lint` 必须通过；新增节点执行器的 zod schema 要在编译期能推导。
5. **不跑 `npm run build`**（依据 AGENTS.md：仅在路由/SSR/配置变动时才需要；本次新增 API route 是常规变动，lint 可覆盖）。

---

## 风险与取舍提醒

> 用户已知悉以下取舍仍坚持选 A：

1. **失去 AI SDK 内置 step 机制**：`prepareStep` / `stopWhen` / `experimental_repairToolCall` 等需要在前端 runner 里自己实现等价物（或者放弃这些能力）。
2. **网络往返成本**：6 节点工作流如果每节点内 agent 跑 5 步，总共 ~30 次 HTTP 请求。考虑给 `/api/agent/step` 走 SSE 流式以减少 latency 感知。
3. **状态一致性**：messages 数组在前端维护，刷新页面会丢失。**MVP 只用 sessionStorage 持久化 workflowState**，不入 SQLite。后续若要做"恢复中断的工作流"再加。
4. **interactive-tools 与 human 节点的关系**：两者机制不同——前者在 agent 节点内部生效（agent 主动调），后者是节点级（编排器决定）。MVP 里 human 节点只用于"修复方案审批"，agent 节点内部仍可调用 ask_question 等。

---

## 实施顺序（建议）

1. 类型定义：`lib/workflow/types.ts`
2. 单步 API：`lib/agent/single-step.ts` + `app/api/agent/step/route.ts` + `app/api/agent/tool/route.ts`
3. 节点执行器：`lib/workflow/node-executors.ts`
4. Bug-fix 工作流定义：`lib/workflows/bug-fix.ts` + `lib/lint-tool.ts`
5. 节点级 API：`app/api/workflow/[id]/node/[nodeId]/run/route.ts` + `app/api/workflow/list/route.ts`
6. 前端 runner + 页面：`lib/workflow/runner.ts` + `app/workflow/[id]/page.tsx` + 节点卡片组件
7. 主页入口：`app/page.tsx` 顶部加跳转按钮
8. 端到端验证：造 demo workspace，跑全流程
