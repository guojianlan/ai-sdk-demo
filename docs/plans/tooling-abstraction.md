# Tooling 抽象层设计提案

## Context

当前 tool 散落在 6 个文件，每个 tool 都自己处理：
- 从 `experimental_context` 解出 workspaceRoot / bypassPermissions（重复 6 次相同模式）
- 决定 toolOk / toolErr 包装（重复）
- 决定 needsApproval 怎么写（散布）
- 各自 import AI SDK 的 `tool()` / `approvedTool()` / `interactiveTool()`

业务想接入新 tool 时要：
1. 选择哪个 wrapper（approvedTool / interactiveTool / 裸 tool）
2. 知道怎么解 experimental_context
3. 知道怎么注册进 `lib/workflow/tool-registry.ts`
4. 知道怎么写 needsApproval

需要一个抽象层让业务**只关心业务逻辑**：input → output。

## 调研对照

| 设计点 | Codex (Rust) | open-agents (TS+AI SDK) | 我们当前 |
|------|--------------|-------------------------|----------|
| Tool 定义 | `ToolDefinition` struct + `ResponsesApiTool` | 工厂函数 `bashTool(options?)` | 直接 `tool()` / `approvedTool()` |
| Context 抽象 | `ToolInvocation` 包（session/turn/cancellation） | `getSandbox(ctx)` helper 系列 | 各 tool 自己 `getWorkspaceToolContext` |
| 审批模型 | enum 4 档（Untrusted/OnFailure/OnRequest/Never） | boolean \| function | function in approvedTool |
| Tool 分类 | `ToolHandlerKind` enum（Shell/MCP/AgentSpawn/...） | 单一集合 | 按文件分（workspace/write/lint/interactive/subagent/mcp） |
| MCP 集成 | 转换成统一 `ResponsesApiTool` | 单独的 MCP client，per-request 注入 | 同 open-agents |
| 输出包装 | `Result<JsonValue, Error>` | tool 自己决定 | `ToolResult<T>` discriminated union |

**两边的共同点**：业务 tool 只接触 `(input, ctx) => output` 三元组，不直接接触底层 SDK 的协议细节（AI SDK 的 ToolExecutionOptions / Codex 的 ToolPayload）。

## 设计目标

1. **业务 tool 只声明 3 件事**：input schema、output schema、execute(input, ctx) ⇒ output
2. **审批 / 错误包装 / context 提取**全部由抽象层处理
3. **保留对 AI SDK v6 内置机制的兼容**——`needsApproval` 仍然用 v6 协议（这样 step API 的 `tool-approval-request` SSE 事件继续工作）
4. **可扩展**：未来加 sandbox / session / model 等 ctx 字段时，只改 ctx 抽象一处

## 提议的核心抽象

### 1. `ToolKind` —— 一刀切的"这是什么 tool"

```ts
type ToolKind =
  | "readonly"     // list_files / search_code / read_file —— 永不审批
  | "mutating"     // write_file / edit_file —— 默认审批（除非 bypass）
  | "shell"        // run_lint / 未来的 run_test —— 默认审批
  | "interactive"  // ask_question / ask_choice / show_reference —— 无 execute
  | "subagent";    // explore_workspace —— 内部 spawn 子 agent，永不审批
```

`kind` 决定默认审批策略，业务可以覆盖。

### 2. `ToolContext` —— 业务侧拿到的 ctx

```ts
type ToolContext = {
  workspace: {
    root: string;       // 已 normalize
    name: string;
  };
  bypassPermissions: boolean;
};
```

后续要加 `sandbox` / `session` / `subagentModel` 等只需扩展这个 type；业务 tool 用泛型/可选字段访问。

### 3. `defineTool(...)` —— 唯一的 tool 声明入口

```ts
function defineTool<I, O>(opts: {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: ZodType<I>;
  outputSchema?: ZodType<O>;
  /** 默认按 kind 决定；显式覆盖时支持 'always' | 'never' | predicate */
  approval?: "always" | "never" | ((input: I, ctx: ToolContext) => boolean);
  /** interactive kind 不传；其它 kind 必传 */
  execute?: (input: I, ctx: ToolContext) => Promise<O> | O;
}): DefinedTool<I, O>;
```

抽象层做的事：
- 用 v6 的 `tool()` 重建实例，把 inputSchema/outputSchema/execute 对接进去
- `needsApproval` 默认按 kind 派生（mutating/shell → bypass-aware；其它 → false）
- `execute` 包装：从 `ToolExecutionOptions.experimental_context` 解出 `ToolContext`，调业务 execute，自动 try/catch 转 `ToolResult<O>`
- 元数据保留（name / kind / displayName / description）方便注册中心使用

### 4. `ToolRegistry` —— 集中注册

```ts
const registry = new ToolRegistry();
registry.register(listFilesTool, readFileTool, writeFileTool, ...);

// 调用方按需取
registry.pick(["list_files", "read_file"]) → ToolSet
registry.byKind("readonly") → DefinedTool[]
registry.all() → DefinedTool[]
```

替代现在的 `lib/workflow/tool-registry.ts`。

### 5. 业务 tool 的对照（重写后）

**之前**（`lib/write-tools.ts` 部分）：
```ts
export const writeFileTool = approvedTool({
  description: [...].join("\n"),
  inputSchema: writeFileInputSchema,
  needsApproval: (_input, ctx) => !getBypassPermissions(ctx),
  execute: async ({ content, relativePath }, { experimental_context }) => {
    const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
    try {
      const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
      const previous = await readFileIfExists(absolutePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
      return toolOk({ path: ..., operation: ..., bytesWritten: ... });
    } catch (error) {
      return toolErr(error);
    }
  },
});
```

**之后**：
```ts
export const writeFileTool = defineTool({
  name: "write_file",
  kind: "mutating",
  description: [...].join("\n"),
  inputSchema: writeFileInputSchema,
  // approval / bypassPermissions / 错误包装 / experimental_context 解析全部消失
  execute: async ({ content, relativePath }, { workspace }) => {
    const absolutePath = resolveWorkspacePath(workspace.root, relativePath);
    const previous = await readFileIfExists(absolutePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    return { path: ..., operation: ..., bytesWritten: ... };
  },
});
```

业务代码减少 ~30%；新写一个 tool 的认知成本从"理解 4 套 wrapper + 2 套 helper"降到"填 5 个字段"。

## 实施范围（让你选）

### 选项 A: 完整重构（推荐）

1. 新建 `lib/tooling/` 目录：`define-tool.ts` / `registry.ts` / `context.ts` / `tool-result.ts` / `index.ts`
2. 把 6 个 tool 文件按业务分类重写到 `lib/tools/`：`workspace.ts` / `write.ts` / `lint.ts` / `interactive.ts` / `subagent.ts`
3. 删 `lib/workflow/tool-registry.ts`、`lib/tool-helpers.ts`、`lib/workspace-tools.ts` / `lib/write-tools.ts` / `lib/lint-tool.ts` / `lib/interactive-tools.ts` 旧文件
4. 更新 `lib/agent/source.ts` 用新 registry 选 tool
5. 更新 MCP（weather-client）也用 `defineTool` 包一层（保持统一）

工作量：~600 行代码挪动、~10 个文件改动。1-2 小时。

### 选项 B: 只引入 `defineTool`，不重构现有 tool

只新建 `lib/tooling/define-tool.ts`，文档+一两个示例。让你以后写新 tool 时用，旧 tool 暂不动。

工作量：~150 行新代码。30 分钟。

### 选项 C: 暂不动，只把 6 个 tool 文件移到 `lib/tools/` 目录下整理位置

纯粹的目录整理，不引入新抽象。

工作量：5 分钟。

## 取舍提醒

**反对完整重构的理由（万一你想保留现状）**：
- 当前每个 tool 文件 50-200 行，可读性其实不差
- AI SDK 的 `tool()` 已经是个不错的抽象，再加一层 indirection 给后人调试成本
- 如果将来不打算大量加新 tool，抽象的边际收益小
- "abstract too early" 的常见陷阱：抽象出的 ctx type 还没遇到 sandbox / session 等真正需求时就稳定下来，后期反而要破坏性改

**支持完整重构的理由**：
- 你已经明确说"想做工作流系统、可能让用户接入业务"——那时候业务 tool 数量会上去（10+ 个），抽象层的回报点就到了
- ToolKind 枚举让审批模型清晰可见，不用每个 tool 自己写 needsApproval predicate
- ToolContext 集中后，加 sandbox 等只改一个文件
- 和工作流的 source 抽象（最近一轮做的）形成对称：客户端讲"我是谁"，业务 tool 讲"我是什么 kind"，调度层负责所有 plumbing

我的推荐是 **选项 A**，但**先用一个 tool 走通整个抽象**（write_file），跑通 build / lint / SSE 实测，再批量重写其它 5 个。这样如果中途发现 ctx 抽象的某个字段设计有问题，影响面只 1 个文件。

## 待你确认

1. 选 A / B / C？
2. 如果选 A：`ToolContext` 现在就要预留哪些字段？（workspace / bypassPermissions 是必有的，sandbox / session / model 这些要不要现在留位）
3. 是否要把现在的 `ToolResult<T>` discriminated union 也并入 `defineTool` 的自动错误包装里（即业务 tool 可以直接 throw / return T，抽象层自动包成 toolOk/toolErr）？
