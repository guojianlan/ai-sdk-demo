import { tool } from "ai";
import type { FlexibleSchema, InferSchema } from "@ai-sdk/provider-utils";

import { extractToolContext } from "@/lib/tooling/context";
import { toolErr, toolOk, type ToolResult } from "@/lib/tooling/tool-result";
import type {
  DefinedTool,
  ToolApprovalPolicy,
  ToolContext,
  ToolKind,
} from "@/lib/tooling/types";

/**
 * `defineTool` —— 仓库唯一的 tool 声明入口。
 *
 * 业务只关心三件事：
 *   1. 元数据：name / kind / description（+ 可选 displayName）
 *   2. Schema：inputSchema（+ 可选 outputSchema）
 *   3. 业务执行：execute(input, ctx) → output    （interactive kind 不传）
 *
 * 抽象层封装：
 *   - **审批**：默认按 kind 派生（mutating / shell → bypass-aware；其它 → never）；
 *     可用 `approval` 字段覆盖（"always" / "never" / 自定义 predicate）
 *   - **错误包装**：业务 throw → `{ ok: false, error }`；return T → `{ ok: true, data }`。
 *     业务永远不需要 import toolOk / toolErr。
 *   - **Context 提取**：从 AI SDK 的 `ToolExecutionOptions.experimental_context`
 *     解出 `ToolContext`，业务直接拿 `ctx.workspace.root` 而不是 `getWorkspaceToolContext(experimental_context)`。
 *
 * 类型设计：
 * - `Schema extends FlexibleSchema` —— 直接复用 AI SDK 自身的推断路径，规避
 *   `ZodType<I>` 泛型在和 SDK 内部协变时被降成 `never` 的老坑——SDK 内部就是这样
 *   推断 input 类型的，对齐它最稳。
 * - `InferSchema<Schema>` —— SDK 自己推断出的 input 类型，传给业务 execute。
 */

type DefineToolOptions<
  InputSchema extends FlexibleSchema,
  OutputSchema extends FlexibleSchema | undefined,
> = {
  name: string;
  kind: ToolKind;
  description: string;
  /** UI 友好名（卡片标题等）；不传则等于 name。 */
  displayName?: string;
  inputSchema: InputSchema;
  /** 可选的输出 schema —— LLM 拿来理解返回结构；缺省也能跑。 */
  outputSchema?: OutputSchema;
  /** 审批策略；不传按 kind 派生。详见 `ToolApprovalPolicy`。 */
  approval?: ToolApprovalPolicy<InferSchema<InputSchema>>;
  /**
   * 业务 execute。`interactive` kind **不传**——客户端等用户填，AI SDK 收到
   * 无 execute 的 tool call 会停在 input-available 状态（参见 lib/agent/run-loop.ts）。
   */
  execute?: (
    input: InferSchema<InputSchema>,
    ctx: ToolContext,
  ) => Promise<unknown> | unknown;
};

function defaultApprovalForKind(kind: ToolKind): "always" | "never" | "bypass-aware" {
  switch (kind) {
    case "mutating":
    case "shell":
      return "bypass-aware"; // bypass=false 时审批，bypass=true 时跳过
    case "readonly":
    case "subagent":
    case "interactive":
      return "never";
  }
}

async function shouldRequestApproval<I>(
  policy: ToolApprovalPolicy<I> | undefined,
  kind: ToolKind,
  input: I,
  ctx: ToolContext,
): Promise<boolean> {
  // 业务显式覆盖
  if (policy === "always") return true;
  if (policy === "never") return false;
  if (typeof policy === "function") return policy(input, ctx);

  // 走 kind 默认
  switch (defaultApprovalForKind(kind)) {
    case "always":
      return true;
    case "never":
      return false;
    case "bypass-aware":
      return !ctx.bypassPermissions;
  }
}

export function defineTool<
  InputSchema extends FlexibleSchema,
  OutputSchema extends FlexibleSchema | undefined = undefined,
>(opts: DefineToolOptions<InputSchema, OutputSchema>): DefinedTool {
  const {
    name,
    kind,
    description,
    displayName,
    inputSchema,
    outputSchema,
    approval,
    execute,
  } = opts;

  // interactive tool 不该传 execute；传了就报错——这是 contract violation。
  if (kind === "interactive" && execute) {
    throw new Error(
      `defineTool '${name}': interactive tools must not have execute (output is collected from the user).`,
    );
  }
  if (kind !== "interactive" && !execute) {
    throw new Error(
      `defineTool '${name}': non-interactive tools must define execute.`,
    );
  }

  const aiTool = tool({
    description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    // needsApproval 永远挂上：kind 默认 + 用户覆盖一并由 shouldRequestApproval 决定
    needsApproval: async (rawInput, options) => {
      const ctx = extractToolContext(options.experimental_context);
      return shouldRequestApproval(
        approval,
        kind,
        rawInput as InferSchema<InputSchema>,
        ctx,
      );
    },
    // execute 包装：解 ctx + try/catch + ToolResult 包装
    ...(execute
      ? {
          execute: async (rawInput, options) => {
            const ctx = extractToolContext(options.experimental_context);
            try {
              const result = await execute(
                rawInput as InferSchema<InputSchema>,
                ctx,
              );
              return toolOk(result) satisfies ToolResult<unknown>;
            } catch (error) {
              return toolErr(error) satisfies ToolResult<unknown>;
            }
          },
        }
      : {}),
  });

  return {
    name,
    kind,
    description,
    displayName,
    aiTool,
  };
}
