import { tool as createToolSchema, type Tool, type ToolSet } from "ai";

/**
 * Agent single-step / streaming 共用的 tool 处理工具。
 *
 * 抽出来是为了让 JSON one-shot (`single-step.ts`) 和 SSE 流式 (`step-stream` 路由)
 * 用同一份 strip / meta 逻辑，避免协议漂移。
 */

export type ToolCallMeta = {
  toolCallId: string;
  toolName: string;
  /** 该 tool 是 interactive（无 execute）—— 客户端要渲染 UI 收集用户输入。 */
  isInteractive: boolean;
  /**
   * 该 tool 是 approvedTool（execute 存在 + needsApproval 是函数）—— 客户端要弹审批卡。
   * 注意：bypassPermissions 由调用方在客户端结合此字段判断"实际是否需要弹卡"。
   */
  isApprovalRequired: boolean;
};

/**
 * 把 tool 集合改造成"schema-only"形态：
 * 用 AI SDK 的 `tool({ description, inputSchema, outputSchema? })` 重建，**不传 execute**。
 *
 * AI SDK 看到无 execute 的 tool 后，模型 toolCall 会被原样回传给调用方，不会触发执行。
 * 这正是 interactive-tool（ask_question 等）的工作机制。
 */
export function stripExecute(tools: ToolSet): ToolSet {
  const stripped: ToolSet = {};
  for (const [name, original] of Object.entries(tools)) {
    // FlexibleSchema 在不同 tool 实例上有不同的 INPUT 推断（Tool<any, any> /
    // Tool<never, never> 等）。这条 dynamic-dispatch 路径上 schema 最终只用于 LLM
    // 的 JSON 序列化，不消费精确类型——cast 到 any 跑掉编译期协变。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = original as Tool<any, any>;
    stripped[name] = createToolSchema({
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    });
  }
  return stripped;
}

/**
 * 客户端分发元信息：通过 tool 实例上的字段判断。
 * - `execute` 不存在 → interactive
 * - `needsApproval` 是函数 → approvedTool（潜在要审批；最终是否真的弹由 bypass 决定）
 */
export function inferToolCallMeta(
  toolName: string,
  toolCallId: string,
  originalTools: ToolSet,
): ToolCallMeta {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = originalTools[toolName] as Tool<any, any> | undefined;
  return {
    toolCallId,
    toolName,
    isInteractive: !t || typeof t.execute !== "function",
    isApprovalRequired: !!t && typeof t.needsApproval === "function",
  };
}
