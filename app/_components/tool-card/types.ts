/**
 * Tool part 渲染相关的共享类型 + 工具。
 *
 * AI SDK v6 的 UIMessagePart 是一个很大的联合类型，我们只关心 tool 相关的几个字段。
 * 运行时当 unknown 处理再判——不依赖 SDK 的完整类型推断，避免和内部类型签名纠缠。
 */

export type ApprovalHandler = (params: {
  id: string;
  approved: boolean;
  reason?: string;
}) => void;

/**
 * 交互工具（ask_question / ask_choice / show_reference）用来把用户的 output
 * 回灌给 AI SDK。底层是 `useChat` 返回的 `addToolOutput`。
 *
 * 不直接把 AI SDK 的泛型类型暴露到 props 是故意的——那个泛型依赖 UIMessage
 * 的 Tools 推断，我们在 tool-card 层更想用字符串 toolName 做松散分发。
 */
export type OnToolOutputHandler = (params: {
  tool: string;
  toolCallId: string;
  output: unknown;
}) => void;

export type LooseToolPart = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

export function isToolPart(part: { type: string }): part is LooseToolPart {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

export function getToolName(part: LooseToolPart): string {
  if (part.type === "dynamic-tool" && part.toolName) {
    return part.toolName;
  }

  return part.type.replace(/^tool-/, "");
}
