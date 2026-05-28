import { tool } from "ai";
import type { FlexibleSchema, InferSchema } from "@ai-sdk/provider-utils";

import {
  evaluatePermission,
  isBypassModeAllowed,
  loadSettings,
  normalizePermissionMode,
  type PermissionBehavior,
  type PermissionMode,
  type Settings,
} from "@/lib/permissions";
import { toolErr } from "@/lib/tool-result";

/**
 * 两个工具工厂，把 AI SDK 裸 `tool()` 的两种用法各收敛成一个调用点：
 *
 * - `approvedTool(...)` → server-side execute，客户端卡审批
 *   用于"改世界"的工具：写磁盘、跑命令、外部 API 造 side effect。
 *
 * - `interactiveTool(...)` → client-side，无 `execute`
 *   用于"问人"的工具：追问、选项、展示卡。output 由客户端 addToolOutput 回灌。
 *
 * 看到 `approvedTool(...)` 就知道"跑在服务端 + 要审批"。
 * 看到 `interactiveTool(...)` 就知道"等用户给回话"。
 * 比裸 `tool({...})` + `needsApproval` + 每次读 context 重复 callback 少一层心智。
 *
 * 类型小设计：用 AI SDK 自己的 `FlexibleSchema` + `InferSchema`，
 * 而不是 `z.ZodType`——AI SDK 的 `tool()` 接受 Zod / JSON Schema / 标准 Schema 三种，
 * `z.ZodType<Input>` 泛型在和 AI SDK 的内部类型协变时容易被降成 `never`，
 * `FlexibleSchema`/`InferSchema` 正好是 AI SDK 自己推断 Input 的那条路径，对齐最稳。
 *
 * --- ACL + PermissionMode 接入（C3 + B2）------------------------------------
 * `approvedTool` 在 needsApproval 阶段按这个决策树拍板：
 *
 *   1. ACL evaluator → deny / allow / ask / null
 *   2. deny  → needsApproval 返回 false，让 execute 阶段返回 toolErr（统一 lifecycle）
 *   3. allow → needsApproval 返回 false（跳过审批）
 *   4. ask   → needsApproval 返回 true（强制审批）
 *   5. null  → 看会话 PermissionMode：
 *        - `bypassPermissions`（且 settings 双闸放行）→ false（跳过审批）
 *        - `acceptEdits` + tool ∈ {write, edit} → false（跳过审批）
 *        - 其它 → 落回各 tool 自己的 needsApproval 默认逻辑
 *
 * 关键不变量：**ACL deny 永远最强**——即使 mode = bypass，ACL 命中 deny 仍然
 * 拦住。这是 settings.json"组织级 deny"的语义保证。
 *
 * execute 阶段独立再 check 一次 ACL deny（防 time-of-check vs time-of-use 漂移）。
 * Mode 的"自动放行"不需要在 execute 重 check —— 那只影响审批决策，不影响执行允许。
 *
 * 为什么 needsApproval 阶段 deny 不抛错？AI SDK 在 needsApproval 抛错会让
 * tool call 卡在"没 output"状态，下次请求 gateway 报 "No tool output found for
 * function call ..." orphan 错。改成 execute 返回 toolErr 让 tool call 有
 * 完整 lifecycle，agent 看到 error 文本能正常调整方向。
 *
 * 工具接入 ACL 必须传 `name`。可选 `getRuleContent`（盘 rule.pattern）和
 * `getCwd`（决定从哪向上找 settings.json）。
 *
 * settings 是**每次评估都现读**：fs cost ~5ms，但用户改 settings.json 立即生效，
 * 调试体验远好于缓存。如果将来跑高频再加 mtime cache。
 */

/**
 * 给定 (config, input, ctx) 评估 ACL，返回 'allow' | 'deny' | 'ask' | null
 * + 同时返回 settings（B2 mode 决策时再用，避免重复读盘）。
 *
 * config.name 没传 → 直接 null（跳过 ACL，settings 仍读以便 mode 判定）。
 */
function evaluateAclForCall<Schema extends FlexibleSchema>(
  config: ApprovedToolConfig<Schema>,
  input: InferSchema<Schema>,
  ctx: unknown,
): {
  decision: PermissionBehavior | null;
  ruleContent: string | undefined;
  settings: Settings;
} {
  const cwd = safeGetCwd(config.getCwd, ctx);
  const settings = loadSettings(cwd);
  if (!config.name) {
    return { decision: null, ruleContent: undefined, settings };
  }
  const ruleContent = config.getRuleContent?.(input);
  const decision = evaluatePermission(
    config.name,
    ruleContent,
    settings.rules,
  );
  return { decision, ruleContent, settings };
}

/**
 * 从 experimental_context 取 PermissionMode。无效 / 缺失 → DEFAULT。
 * 不直接 import getPermissionMode 以避免 lib/tool-helpers.ts ↔ lib/tools/context.ts
 * 双向依赖（context.ts 已经 import 过 lib/permissions）。
 */
function getModeFromCtx(ctx: unknown): PermissionMode {
  if (typeof ctx !== "object" || ctx === null || !("permissionMode" in ctx)) {
    return normalizePermissionMode(undefined);
  }
  return normalizePermissionMode(
    (ctx as { permissionMode: unknown }).permissionMode,
  );
}

/**
 * Mode-driven 自动放行判定：当 ACL 没规则匹配时，看 PermissionMode 是不是该跳审批。
 * 返回 true → 直接 needsApproval=false。返回 false → 落回 user-provided needsApproval。
 *
 * - `bypassPermissions` + settings 双闸放行（allowBypassMode=true 且没 disable kill switch）
 *   → 任何工具都跳审批
 * - `acceptEdits` + tool name ∈ {write, edit}
 *   → 写/编辑跳审批，shell 等不动
 * - 其它 → 不跳
 */
function shouldAutoApproveByMode(
  mode: PermissionMode,
  toolName: string | undefined,
  settings: Settings,
): boolean {
  if (mode === "bypassPermissions") {
    return isBypassModeAllowed(settings);
  }
  if (mode === "acceptEdits") {
    return toolName === "write" || toolName === "edit";
  }
  return false;
}

/**
 * 子 agent 上下文检测：父 agent spawn 出来的 sub-agent 跑在 server execute 内，
 * 没有 UI 通道弹审批。`runSubAgent` 在 experimental_context 里塞 `__subagent: true`，
 * approvedTool needsApproval 看到这个 flag 就**跳过审批**（ACL deny 仍然先走）。
 *
 * 等价于"subagent 默认 mode = 自动批准"，但是用 flag 而不是真的把 mode 改成 bypass，
 * 这样不依赖 settings.json `allowBypassMode` 双闸——父对话一开始可能就没开 bypass，
 * subagent 也不应该被双闸卡死。
 */
function isSubagentCtx(ctx: unknown): boolean {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    "__subagent" in ctx &&
    (ctx as { __subagent: unknown }).__subagent === true
  );
}

function isServerAutoApproveCtx(ctx: unknown): boolean {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    "__autoApproveTools" in ctx &&
    (ctx as { __autoApproveTools: unknown }).__autoApproveTools === true
  );
}

function buildAclDenyError(
  toolName: string,
  ruleContent: string | undefined,
): string {
  return `Tool call denied by ACL: tool=${toolName}${
    ruleContent ? `, content=${JSON.stringify(ruleContent)}` : ""
  }. Edit .agents/settings.json or ~/.local-agent/settings.json to adjust.`;
}

type ApprovedToolConfig<Schema extends FlexibleSchema> = {
  description: string;
  inputSchema: Schema;
  /**
   * 工具名 —— 接入 ACL 必须给。匹配规则 `rule.tool`（精确或 `*`）。
   * 不传则跳过 ACL，行为完全等价于改造前。
   */
  name?: string;
  /**
   * 从 input 提取被 ACL `rule.pattern` 盘查的字符串。
   * 例如 shell 工具传 command，read/write/edit 传 relativePath。
   * 不传 → 规则只能用整工具一刀切（无 pattern 的 rule 仍能命中）。
   */
  getRuleContent?: (input: InferSchema<Schema>) => string | undefined;
  /**
   * 决定从哪个目录向上找 `.agents/settings.json`。一般是当前 workspace root。
   * 不传 → 用 `process.cwd()`（即 Next.js 进程工作目录，多 workspace 场景下会偏）。
   */
  getCwd?: (ctx: unknown) => string;
  /**
   * 决定本次调用是否要弹审批卡。缺省 = 永远要。
   * 仅在 ACL 评估返回 null（没规则匹配）时被调用。
   * `ctx` 是 agent 的 experimental_context——调用点自己 narrow。
   */
  needsApproval?: (
    input: InferSchema<Schema>,
    ctx: unknown,
  ) => boolean | Promise<boolean>;
  execute: (
    input: InferSchema<Schema>,
    options: { experimental_context?: unknown; abortSignal?: AbortSignal },
  ) => unknown | Promise<unknown>;
};

/**
 * 安全提取 cwd：getCwd 抛错或返回非 string 都退回 `process.cwd()`，
 * 绝不让 ACL 链路把 tool call 整个搞挂。
 */
function safeGetCwd(
  getCwd: ((ctx: unknown) => string) | undefined,
  ctx: unknown,
): string {
  if (!getCwd) return process.cwd();
  try {
    const result = getCwd(ctx);
    return typeof result === "string" && result.length > 0
      ? result
      : process.cwd();
  } catch {
    return process.cwd();
  }
}

export function approvedTool<Schema extends FlexibleSchema>(
  config: ApprovedToolConfig<Schema>,
) {
  return tool({
    description: config.description,
    inputSchema: config.inputSchema,
    needsApproval: async (input, { experimental_context }) => {
      const { decision, settings } = evaluateAclForCall(
        config,
        input as InferSchema<Schema>,
        experimental_context,
      );
      if (decision === "deny") return false; // execute 阶段 toolErr
      if (decision === "allow") return false;
      if (decision === "ask") return true;
      // decision === null —— ACL 没规则匹配
      // 1. 子 agent / flow node 上下文：直接跳审批（没 UI 弹卡，ACL deny 已确认放行）
      if (
        isSubagentCtx(experimental_context) ||
        isServerAutoApproveCtx(experimental_context)
      ) {
        return false;
      }
      // 2. 看 PermissionMode 是不是该自动放行
      const mode = getModeFromCtx(experimental_context);
      if (shouldAutoApproveByMode(mode, config.name, settings)) {
        return false;
      }
      // 都没自动决策 → 落回各 tool 自己的 needsApproval
      return config.needsApproval
        ? await config.needsApproval(
            input as InferSchema<Schema>,
            experimental_context,
          )
        : true;
    },
    execute: async (input, options) => {
      // execute 阶段再 check 一次 ACL deny —— needsApproval 那一遍可能因为时间
      // 差被绕过（settings 同步改 / 多 tool 并发），并且就算没并发，让执行
      // 路径自包含、不依赖 needsApproval 也更鲁棒。
      const { decision, ruleContent } = evaluateAclForCall(
        config,
        input as InferSchema<Schema>,
        options.experimental_context,
      );
      if (decision === "deny" && config.name) {
        return toolErr(buildAclDenyError(config.name, ruleContent));
      }
      return config.execute(input as InferSchema<Schema>, options);
    },
  });
}

type InteractiveToolConfig<
  InputSchema extends FlexibleSchema,
  OutputSchema extends FlexibleSchema,
> = {
  description: string;
  inputSchema: InputSchema;
  /**
   * 客户端填 output 时会按这个 schema 校验。写清楚字段的语义，
   * 卡片组件和 LLM 都依赖它。
   */
  outputSchema: OutputSchema;
};

export function interactiveTool<
  InputSchema extends FlexibleSchema,
  OutputSchema extends FlexibleSchema,
>(config: InteractiveToolConfig<InputSchema, OutputSchema>) {
  return tool({
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    // 故意不给 execute：AI SDK 碰到无 execute 的 tool-call 会停在
    // "input-available" 状态等 client 的 addToolOutput 回灌。
    // 前端只会为显式允许的 client-continuation tools 自动 POST 回服务器；
    // 普通 server tool output 的续跑归后端 chat loop 管。
  });
}
