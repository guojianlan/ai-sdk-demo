import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from "ai";

/**
 * 判断 assistant response 的 parts 里是否含有"等用户/客户端介入"的 tool。
 * 触发条件命中时，外层 workflow loop 应在本步结束后 break，
 * 等下一次 POST（带回 user 输入或 approval 决定）再继续。
 *
 * 触发状态：
 * - `input-available`：纯交互工具（ask_user_question / ask_choice / show_reference）
 *   没有 server-side execute，要等 client 调 `addToolOutput` 回灌结果。
 * - `approval-requested`：write/edit 这类要求用户点"同意/拒绝"的工具。
 *
 * 设计参考：tmp/open-agents-main/apps/web/app/workflows/chat.ts:61-66
 *
 * 注意：原有的 tool 级 `needsApproval` 机制并没有被替代，它在 AI SDK 内层依然生效。
 * 这里多加一层 step 边界判断，是为了让外层 for 循环也"看到"中断信号，
 * 避免在 approval 弹窗未响应前就让 model 继续往下跑。
 */
export function shouldPauseForToolInteraction(
  parts: ReadonlyArray<UIMessagePart<UIDataTypes, UITools>>,
): boolean {
  for (const part of parts) {
    const type = part.type;
    if (typeof type !== "string") continue;
    if (!type.startsWith("tool-") && type !== "dynamic-tool") continue;

    const state = (part as { state?: string }).state;
    if (state === "input-available" || state === "approval-requested") {
      return true;
    }
  }
  return false;
}

/** 便捷形式：直接传 UIMessage，内部读 parts。 */
export function messageNeedsPause(message: UIMessage | null | undefined): boolean {
  if (!message) return false;
  return shouldPauseForToolInteraction(message.parts ?? []);
}

/**
 * 「模型本步只甩了一个 tool call、没说话就停了」=>下一轮要继续跑，给模型机会看
 * tool 结果接着回应。判定方法：在所有 user-visible part 里找**最后一个**——
 * - 是 text/reasoning：模型已经说完话，loop 应该退出
 * - 是已跑完的 tool part：模型还没看到这个结果就停了，loop 必须再跑一步
 *
 * 这是为 OpenAI 类 provider 量身做的：它有时会把"finish=stop"和"emitted tool_call"
 * 同时报上来，导致 result.finishReason !== "tool-calls"，但实际还需要继续 loop。
 *
 * 注意：判"最后一个"时跳过 step-start / step-finish 这种纯结构 marker——它们不
 * 代表模型行为。
 */
const COMPLETED_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "approval-responded",
]);

const STRUCTURAL_PART_TYPES = new Set(["step-start", "step-finish"]);

export function hasCompletedToolCalls(
  parts: ReadonlyArray<UIMessagePart<UIDataTypes, UITools>>,
): boolean {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const type = part.type;
    if (typeof type !== "string") continue;
    if (STRUCTURAL_PART_TYPES.has(type)) continue;

    const isToolPart = type.startsWith("tool-") || type === "dynamic-tool";
    if (!isToolPart) {
      // 最后一段是文本/reasoning/其他——模型已经表达完了，不要再 loop。
      return false;
    }

    const state = (part as { state?: string }).state;
    return Boolean(state && COMPLETED_TOOL_STATES.has(state));
  }
  return false;
}
