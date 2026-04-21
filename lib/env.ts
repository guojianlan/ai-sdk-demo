import os from "node:os";
import path from "node:path";

/**
 * 全仓库唯一的 env 读取入口。
 *
 * 设计目标：
 * - 所有 `process.env.*` 在这里读取一次，冻结进 `env` 常量；别处不再散落读取。
 * - 启动期验证"必须有至少一个 API key"——没有的话整个模块导出失败，
 *   让 Next.js 启动阶段就抛错，而不是等到请求到达路由才 500。
 * - 其它字段给合理默认（workspaceBaseDir / shell / modelId / baseURL），
 *   缺失时不 crash，只是退回 fallback。
 *
 * 新增 env var 时：在下面 `pickString` 一个新字段，顶部 type 里加上，
 * 其它文件从 `env.foo` 读取，不要再回到 `process.env`。
 */

function pickString(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const gatewayBaseURL =
  pickString(
    process.env.OPENAI_COMPAT_BASE_URL,
    process.env.GEMINI_BASE_URL,
  ) ?? "http://127.0.0.1:8317/v1";

const gatewayApiKey = pickString(
  process.env.OPENAI_COMPAT_API_KEY,
  process.env.GEMINI_API_KEY,
);

const gatewayModelId =
  pickString(process.env.OPENAI_COMPAT_MODEL, process.env.GEMINI_MODEL) ??
  "gemini-2.5-flash";

// 缺 API key → 模块加载期直接 crash，而不是等到请求到达路由才 500。
// 本地 key-less 模型请在 .env.local 里把 OPENAI_COMPAT_API_KEY 设成任意非空字符串。
if (!gatewayApiKey) {
  throw new Error(
    "[env] no API key configured. Set OPENAI_COMPAT_API_KEY or GEMINI_API_KEY in .env.local.",
  );
}

const workspaceBaseDir =
  pickString(process.env.WORKSPACE_BASE_DIR) ??
  path.resolve(process.cwd(), "..");

const shellName =
  pickString(process.env.SHELL)?.split("/").pop() ??
  (os.platform() === "win32" ? "cmd" : "sh");

const isProduction = process.env.NODE_ENV === "production";

export const env = {
  isProduction,
  /**
   * AI SDK logging middleware 的显式开关。
   * `true` / `false` = 显式；`undefined` = 依赖 NODE_ENV（非 production 时开启）。
   */
  aiSdkLoggingExplicit: parseBoolean(process.env.AI_SDK_LOGGING),
  workspaceBaseDir,
  shellName,
  /** 主聊天路由用的 OpenAI-compatible gateway 配置。 */
  gateway: {
    baseURL: gatewayBaseURL,
    apiKey: gatewayApiKey,
    modelId: gatewayModelId,
  },
} as const;

/**
 * 路由级 guard：把 `apiKey: string | undefined` 收窄成 string，没配就抛带提示的错。
 * 理论上模块加载期已经 crash 过了，这个 guard 只是给 route handler 一个局部的
 * "优雅 500 消息"出口——比直接抛 unhandled error 对客户端友好。
 */
export function requireGatewayApiKey(): string {
  if (!env.gateway.apiKey) {
    throw new Error(
      "Missing OPENAI_COMPAT_API_KEY (or GEMINI_API_KEY) in .env.local",
    );
  }
  return env.gateway.apiKey;
}
