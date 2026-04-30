import type { LanguageModel, Tool } from "ai";

/**
 * Tooling 抽象层核心类型。
 *
 * 设计意图：业务定义 tool 时只关心 (input, ctx) → output 三元组，不直接接触
 * AI SDK 的 ToolExecutionOptions / experimental_context 协议。
 *
 * 抽象层负责：
 * - context 提取（ToolExecutionOptions.experimental_context → ToolContext）
 * - 错误包装（业务 throw → toolErr；return T → toolOk(T)）
 * - 审批策略（按 ToolKind 自动派生，业务可覆盖）
 */

/**
 * Tool 分类。决定默认审批行为：
 *   - readonly    永不审批（list_files / read_file / explore_workspace 等）
 *   - mutating    默认审批（write_file / edit_file 等改文件的）
 *   - shell       默认审批（run_lint / 未来的 run_test 等执行外部命令）
 *   - interactive 无 execute；客户端等用户填（ask_question 等）
 *   - subagent    永不审批（内部 spawn 子 agent，自身不改世界）
 */
export type ToolKind =
  | "readonly"
  | "mutating"
  | "shell"
  | "interactive"
  | "subagent";

/**
 * Sandbox 适配器占位类型。当前 MVP 直接 fs / execFile 在 workspace.root 下跑；
 * 未来引入 Vercel Sandbox / Docker / 远程 VM 时把这个 type 实例化成统一接口
 * （exec / readFile / writeFile / listDir 等），业务 tool 通过这个跑而不是直接
 * 调 node:fs。
 */
export type SandboxAdapter = {
  /** 占位：未来加 exec / readFile / writeFile 等方法。 */
  readonly kind: "local" | "vercel" | "docker" | "remote";
};

/**
 * Session 上下文：哪条会话、哪个 chatId 等。当前主聊天的 server 模式有 chatId
 * 持久化；client 模式 / workflow 暂时没有。占位是为了将来加"持久化历史 / 跨会话
 * 共享 todo / 长任务断点续跑"等。
 */
export type SessionInfo = {
  /** 会话级别的稳定 id。无会话时为 undefined。 */
  sessionId?: string;
  /** Workflow 运行 id（仅 source.kind === 'workflow-node' 时有）。 */
  runId?: string;
};

/**
 * 业务 tool execute 的全部上下文。
 *
 * 设计取舍：
 * - workspace 必有（所有 tool 都在某个工作区内运行）
 * - bypassPermissions 必有（审批模型读它）
 * - sandbox / session / model / subagentModel 都是 optional —— 当前主流程用不上，
 *   但 explorer subagent 需要 model 来 spawn 子 ToolLoopAgent；将来 vercel
 *   sandbox 集成需要 sandbox 字段。预留位置避免未来破坏性改动。
 */
export type ToolContext = {
  workspace: {
    root: string;
    name: string;
  };
  bypassPermissions: boolean;
  /** 沙箱适配器；MVP 阶段一般不传（业务直接 fs / execFile）。 */
  sandbox?: SandboxAdapter;
  /** 会话信息；当前可能为 undefined。 */
  session?: SessionInfo;
  /** 主 LLM 实例。subagent / 子任务可能需要 spawn 用。 */
  model?: LanguageModel;
  /** 专门跑 subagent 的轻量模型。未配置时 fallback 到 model。 */
  subagentModel?: LanguageModel;
};

/**
 * `defineTool` 的审批策略字段。
 *
 *   - 默认（不传）：按 kind 派生（mutating / shell → bypass-aware；其它 → never）
 *   - "always"   永远审批（即使 bypass 也审）
 *   - "never"    永远不审批
 *   - predicate  业务自己决定（input 和 ctx 都给到）
 */
export type ToolApprovalPolicy<I> =
  | "always"
  | "never"
  | ((input: I, ctx: ToolContext) => boolean | Promise<boolean>);

/**
 * `defineTool` 注册后产出的 tool 元数据 + AI SDK 实例。
 *
 * - `aiTool`        →  AI SDK 的 Tool 实例，给 streamText / generateText 用
 * - `name` / `kind` / `description` / `displayName` →  注册中心 / UI 用
 *
 * 不暴露 inputSchema / outputSchema / execute / approval —— 这些是 aiTool 内部已封好的。
 */
export type DefinedTool = {
  name: string;
  kind: ToolKind;
  description: string;
  /** UI 友好名（卡片标题等）；不传则等于 name。 */
  displayName?: string;
  /** AI SDK 协议的 Tool 实例。直接 spread 进 `tools: ToolSet` 即可。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiTool: Tool<any, any>;
};
