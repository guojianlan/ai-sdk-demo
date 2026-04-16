import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * 共享的 OpenAI-compatible gateway 配置。
 *
 * 原来这段在 app/api/chat/route.ts 里，把它抽到 lib/ 方便让其他模块（比如 subagents）
 * 用同一套 baseURL / apiKey / modelId，避免配置漂移 + 避免路由文件之间循环依赖。
 */

export const gatewayBaseURL =
  process.env.OPENAI_COMPAT_BASE_URL ??
  process.env.GEMINI_BASE_URL ??
  "http://127.0.0.1:8317/v1";

export const gatewayApiKey =
  process.env.OPENAI_COMPAT_API_KEY ?? process.env.GEMINI_API_KEY;

export const gatewayModelId =
  process.env.OPENAI_COMPAT_MODEL ??
  process.env.GEMINI_MODEL ??
  "gemini-2.5-flash";

export const gateway = createOpenAICompatible({
  name: "local-openai-compatible-gateway",
  baseURL: gatewayBaseURL,
  apiKey: gatewayApiKey,
});
