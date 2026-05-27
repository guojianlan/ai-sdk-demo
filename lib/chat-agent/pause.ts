import type { UIDataTypes, UIMessage, UIMessagePart, UITools } from "ai";

/**
 * 判断 assistant response 的 parts 里是否含有"等用户/客户端介入"的 tool。
 * 命中时，后端 chat loop 应在本步结束后 break，等下一次 POST 带回用户输入
 * 或 approval 决定再继续。
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

export function messageNeedsPause(
  message: UIMessage | null | undefined,
): boolean {
  if (!message) return false;
  return shouldPauseForToolInteraction(message.parts ?? []);
}

/**
 * 「模型本步只甩了一个 tool call、没说话就停了」=> 下一轮要继续跑，给模型机会看
 * tool 结果接着回应。
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
      return false;
    }

    const state = (part as { state?: string }).state;
    return Boolean(state && COMPLETED_TOOL_STATES.has(state));
  }
  return false;
}
