import { tool } from "ai";
import type { FlexibleSchema, InferSchema } from "@ai-sdk/provider-utils";

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
 */

type ApprovedToolConfig<Schema extends FlexibleSchema> = {
  description: string;
  inputSchema: Schema;
  /**
   * 决定本次调用是否要弹审批卡。缺省 = 永远要。
   * `ctx` 是 agent 的 experimental_context——调用点自己 narrow。
   */
  needsApproval?: (
    input: InferSchema<Schema>,
    ctx: unknown,
  ) => boolean | Promise<boolean>;
  execute: (
    input: InferSchema<Schema>,
    options: { experimental_context?: unknown },
  ) => unknown | Promise<unknown>;
};

export function approvedTool<Schema extends FlexibleSchema>(
  config: ApprovedToolConfig<Schema>,
) {
  return tool({
    description: config.description,
    inputSchema: config.inputSchema,
    needsApproval: async (input, { experimental_context }) =>
      config.needsApproval
        ? await config.needsApproval(
            input as InferSchema<Schema>,
            experimental_context,
          )
        : true,
    execute: (input, options) =>
      config.execute(input as InferSchema<Schema>, options),
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
    // "input-available" 状态等 client 的 addToolOutput 回灌，
    // 然后 useChat 的 sendAutomaticallyWhen 自动把更新后的 messages POST 回来，
    // agent 继续下一步。
  });
}
