import type { UIMessage, UITools } from "ai";

/**
 * 返回类型里 DATA_PARTS = never：sanitizer 只放行 text + 终结态 tool part，
 * 不再有任何 data-* part。这个窄化让返回值能直接喂给 `createAgentUIStreamResponse`
 * 的 `originalMessages`（它要求 DATA_PARTS = never），不用在调用点 cast。
 */
export type SanitizedUIMessage = UIMessage<unknown, never, UITools>;

/**
 * 统一的入站 UI 消息清洗器，两条 chat 路由共用。
 *
 * 处理两类风险（两条路由都可能遇到）：
 *
 * 1. **孤儿 tool part**
 *    客户端 localStorage 里可能留下"半成品"的 tool part：
 *    - 流式刚开始就被中断（`input-streaming` / `input-available`，没有 output）
 *    - 用户开了 approval 卡片但没点同意/拒绝就关页面（`approval-requested` 永远悬空）
 *    这些 part 被回传给 provider 后，因为没有配对的 tool_result，
 *    网关会报 "No tool output found for function call call_xxx" 直接拒绝整次请求。
 *    做法：把所有 tool / dynamic-tool part 限制在"终结状态"（见 `TERMINAL_TOOL_STATES`）。
 *
 * 2. **过期的 provider 元数据**
 *    OpenAI Responses API 的 `rs_*` / item 引用 metadata 可能在上一轮存进 UI message，
 *    下一轮网关不一定能再解析到原始 item，会报错。
 *    做法：清除 parts 上所有 `metadata` / `*Metadata` 结尾的键。
 *    两条路由都做——成本很低，防御面更广。
 */

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "approval-responded",
]);

function isToolLikePart(type: string) {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

function isMetadataKey(key: string) {
  return key === "metadata" || /Metadata$/.test(key);
}

export function sanitizeChatUIMessages(
  messages: unknown[],
): SanitizedUIMessage[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) {
      return [];
    }

    const role =
      "role" in message && typeof message.role === "string"
        ? message.role
        : undefined;

    if (role !== "system" && role !== "user" && role !== "assistant") {
      return [];
    }

    const rawId =
      "id" in message && typeof message.id === "string" ? message.id : "";
    const rawParts =
      "parts" in message && Array.isArray(message.parts) ? message.parts : [];

    const parts = rawParts.flatMap((part) => {
      if (typeof part !== "object" || part === null || !("type" in part)) {
        return [];
      }

      const typeValue = (part as { type: unknown }).type;
      if (typeof typeValue !== "string") {
        return [];
      }

      if (isToolLikePart(typeValue)) {
        const stateValue =
          "state" in part &&
          typeof (part as { state: unknown }).state === "string"
            ? (part as { state: string }).state
            : "";

        if (!TERMINAL_TOOL_STATES.has(stateValue)) {
          return [];
        }
      }

      const cleaned = Object.fromEntries(
        Object.entries(part as Record<string, unknown>).filter(
          ([key]) => !isMetadataKey(key),
        ),
      ) as SanitizedUIMessage["parts"][number];

      return [cleaned];
    });

    if (parts.length === 0) {
      return [];
    }

    return [
      {
        id: rawId || crypto.randomUUID(),
        role,
        parts,
      } satisfies SanitizedUIMessage,
    ];
  });
}
