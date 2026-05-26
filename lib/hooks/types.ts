/**
 * Hook 事件模型 —— P9-a。
 *
 * 抄 Claude Code 的事件枚举与 JSON 控制返回契约（PreToolUse / PostToolUse /
 * UserPromptSubmit / SessionStart），加上 codex 的 `additional_contexts` 注入想法。
 * 首版只做 in-process TS hook（spawn 子进程的 command/prompt hook 留给 P9-d）。
 *
 * 设计要点：
 * - 事件枚举用字面量联合，payload 用 discriminated union（按 `event` 字段判型）
 *   —— 让 `runHooks(registry, "PreToolUse", payload)` 在调用点就能查出 payload 形状
 *   是否匹配。
 * - `HookResult` 故意做"宽松联合"：每个字段都 optional，hook 想啥都不返回（纯监听
 *   型，比如日志）就 `return` 或 `return undefined`。决策类 hook 设 `decision`，
 *   注入类 hook 设 `additionalContexts` / `systemMessage`，改写类 hook 设
 *   `updatedInput`。聚合行为见 `runtime.ts` 的 `runHooks`。
 * - `decision: "deny"` 是唯一会中止主流程的硬信号；`"ask"` 只是把最终裁决推回
 *   approval 流水线（P9-b 接入时落地）；`"allow"` 是显式放行（覆盖默认行为）。
 */

/** 事件名 —— 用 Claude Code 的 PascalCase，便于跟外部 settings.json 对齐。 */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "Stop";

/** 工具事件的共同字段。`input` 是 LLM 提供的入参，shape 由具体 tool 决定。 */
export interface PreToolUsePayload {
  event: "PreToolUse";
  toolName: string;
  input: unknown;
  sessionId?: string;
}

/**
 * PostToolUse 的 result 取自 tool execute 的返回值。
 * - 自家工具是 `ToolResult<T>`（含 `ok` 标志）
 * - MCP 工具是各自 shape
 * hook 想根据成功/失败分支处理时，自己做 narrowing。
 */
export interface PostToolUsePayload {
  event: "PostToolUse";
  toolName: string;
  input: unknown;
  result: unknown;
  durationMs: number;
  sessionId?: string;
}

export interface UserPromptSubmitPayload {
  event: "UserPromptSubmit";
  prompt: string;
  sessionId?: string;
}

export interface SessionStartPayload {
  event: "SessionStart";
  sessionId: string;
}

export interface StopPayload {
  event: "Stop";
  sessionId: string;
  finishReason?: string;
  step?: number;
  lastAssistantMessage?: unknown;
}

export type HookPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | UserPromptSubmitPayload
  | SessionStartPayload
  | StopPayload;

/** 按事件名查 payload 形状（给泛型 API 用）。 */
export type HookPayloadFor<E extends HookEvent> = Extract<HookPayload, { event: E }>;

/**
 * 单个 hook 的返回值。
 *
 * - `decision: "deny"` → 中止后续 hook + 主流程（PreToolUse 直接拒、UserPromptSubmit 拒绝该轮）
 * - `decision: "ask"` → 推回 approval 流水线（P9-b）
 * - `decision: "allow"` → 显式放行（覆盖默认 needsApproval）
 * - `updatedInput` → 仅 PreToolUse 有意义，改写 tool 入参后透传给 execute
 * - `additionalContexts` → 字符串数组，注入为 developer/system message（事件不同
 *    注入点不同：UserPromptSubmit 拼 session primer；PostToolUse 注入下一轮上下文）
 * - `systemMessage` → 单条 system message 注入（SessionStart 用）
 * - `reason` → deny/ask 时给用户的解释；纯日志型 hook 不需要
 */
export interface HookResult {
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: unknown;
  additionalContexts?: string[];
  systemMessage?: string;
}

/**
 * hook handler 的执行上下文。
 *
 * - `signal` 用于让外部主动取消（比如请求被 abort）。runtime 也会用它做超时。
 * - `sessionId` 冗余在 payload 里也有；放 ctx 里是为了 hook 不依赖 payload 形状
 *   就能拿到。
 */
export interface HookContext {
  signal?: AbortSignal;
  sessionId?: string;
}

/**
 * hook handler 函数签名。
 *
 * 返回 `void` / `undefined` 等价于"我啥都没说"（纯观察）。这让日志型 hook
 * 不用强行返回 `{}`。
 */
export type HookHandler<E extends HookEvent> = {
  bivarianceHack(
    payload: HookPayloadFor<E>,
    ctx: HookContext,
  ): HookResult | void | Promise<HookResult | void>;
}["bivarianceHack"];

/**
 * `defineHook` 的输入形状。`matcher` 是字符串正则（compile 在 register 时做一次）。
 * 仅对工具事件（PreToolUse / PostToolUse）生效——其它事件给了也会被 runtime 忽略，
 * 避免 hook 作者误以为能匹配 prompt 内容。
 */
export interface HookSpec<E extends HookEvent> {
  event: E;
  name: string;
  matcher?: string;
  handler: HookHandler<E>;
}

/**
 * 注册到 registry 后的形态：matcher 已经 compile 成 RegExp，便于 runtime 直接用。
 */
export interface RegisteredHook<E extends HookEvent = HookEvent> {
  event: E;
  name: string;
  matcher?: RegExp;
  timeoutMs?: number;
  handler: HookHandler<E>;
}

/**
 * `runHooks` 的聚合结果。
 *
 * - `decision` 取自第一个返回 `deny`（短路）或 `ask`（不短路、最高优先级）的 hook；
 *   都没有就是 `undefined`（= 默认行为，调用方按自己的逻辑走）。
 * - `updatedInput` 是 PreToolUse 专属，按 hook 注册顺序 last-write-wins。
 * - `additionalContexts` / `systemMessages` 累加，调用方决定怎么注入。
 * - `deniedBy` 在 `decision: "deny"` 时给出，便于日志和前端展示哪个 hook 拦的。
 */
export interface AggregatedHookResult {
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: unknown;
  additionalContexts: string[];
  systemMessages: string[];
  deniedBy?: string;
}
