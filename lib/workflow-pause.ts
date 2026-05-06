import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from "ai";

/**
 * 判断 assistant response 的 parts 里是否含有"等用户/客户端介入"的 tool。
 * 触发条件命中时，外层 workflow loop 应在本步结束后 break，
 * 等下一次 POST（带回 user 输入或 approval 决定）再继续。
 *
 * 触发状态：
 * - `input-available`：纯交互工具（ask_question / ask_choice / show_reference）
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
