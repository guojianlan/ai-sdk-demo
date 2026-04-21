import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { env } from "@/lib/env";

/**
 * 共享的 OpenAI-compatible gateway 配置。
 *
 * 所有配置值都从 `lib/env.ts` 读取——这里不再直接访问 `process.env`。
 * 路由 / subagent / plan generator 都用同一个 `gateway` 实例，避免配置漂移。
 */

export const gatewayBaseURL = env.gateway.baseURL;
export const gatewayApiKey = env.gateway.apiKey;
export const gatewayModelId = env.gateway.modelId;

export const gateway = createOpenAICompatible({
  name: "local-openai-compatible-gateway",
  baseURL: gatewayBaseURL,
  apiKey: gatewayApiKey,
});
