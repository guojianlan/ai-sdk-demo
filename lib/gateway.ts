import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { env } from "@/lib/env";

/**
 * 共享的 OpenAI-compatible gateway 配置。
 *
 * 所有配置值都从 `lib/env.ts` 读取——这里不再直接访问 `process.env`。
 * 路由 / subagent / plan generator 都用同一个 `gateway` 实例，避免配置漂移。
 *
 * Reasoning effort 注入：openai-compatible provider 不直接暴露 `reasoning_effort`
 * 字段，但 `chat/completions` 端点本身吃这个 top-level 字段（gpt-5 / o1 系列模型
 * 用它控制思考深度）。我们包一层 fetch，把 env 里设置的值透传到 body 里。
 * 没设置 env 就不动 body，保持原行为。
 */

export const gatewayBaseURL = env.gateway.baseURL;
export const gatewayApiKey = env.gateway.apiKey;
export const gatewayModelId = env.gateway.modelId;
export const gatewayReasoningEffort = env.gateway.reasoningEffort;

const baseFetch: typeof fetch = (...args) => fetch(...args);

const gatewayFetch: typeof fetch = gatewayReasoningEffort
  ? async (input, init) => {
      // 只对 chat completions / responses POST 请求注入 reasoning_effort。
      if (init?.method?.toUpperCase() !== "POST" || !init.body) {
        return baseFetch(input, init);
      }
      try {
        const body =
          typeof init.body === "string"
            ? JSON.parse(init.body)
            : init.body;
        if (
          typeof body === "object" &&
          body !== null &&
          !Array.isArray(body) &&
          !("reasoning_effort" in body)
        ) {
          (body as Record<string, unknown>).reasoning_effort =
            gatewayReasoningEffort;
          return baseFetch(input, {
            ...init,
            body: JSON.stringify(body),
          });
        }
      } catch {
        // body 不是 JSON 字符串（比如 multipart）—— 不动它
      }
      return baseFetch(input, init);
    }
  : baseFetch;

export const gateway = createOpenAICompatible({
  name: "local-openai-compatible-gateway",
  baseURL: gatewayBaseURL,
  apiKey: gatewayApiKey,
  fetch: gatewayFetch,
});
