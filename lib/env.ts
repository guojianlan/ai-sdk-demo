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

/**
 * P4-b compaction 配置。
 *
 * - `thresholdTokens`：对话 token（粗估）超过这个数就触发一次 handoff 摘要。
 *   默认 60k 偏小，是为了 dev 环境实际能触发到；生产里可以往 300k+ 调。
 * - `keepRecentMessages`：压缩后保留最近这么多条原消息逐字传给模型，其余
 *   压成 summary 层。8 是 codex 风格的手感，让模型看见最近的用户意图和工具结果。
 */
function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const compactionThresholdTokens = parseIntOr(
  process.env.COMPACTION_THRESHOLD_TOKENS,
  60_000,
);
const compactionKeepRecentMessages = parseIntOr(
  process.env.COMPACTION_KEEP_RECENT,
  8,
);

/**
 * Agent loop 跑在哪一端。
 *
 * - `server`（默认）：主聊天 `/api/chat` 走 `ToolLoopAgent`，服务端一次跑完
 *   所有 step；workflow agent 节点暂时仍走客户端 loop（节点级显式控制）。
 * - `client`：主聊天和 workflow agent 节点都用前端驱动的 single-step + streaming
 *   协议（`/api/agent/step-stream`）。每一步 LLM 输出文字增量推回前端，前端按
 *   `finishReason` / 审批 / 用户暂停决定是否再发下一步。
 *
 * 必须用 `NEXT_PUBLIC_*` 前缀：客户端 hook 也要读这个值来选择 `useChat` 还是
 * `useClientAgentChat`。
 */
const agentLoopModeRaw =
  pickString(process.env.NEXT_PUBLIC_AGENT_LOOP_MODE) ?? "server";
const agentLoopMode: "client" | "server" =
  agentLoopModeRaw === "client" ? "client" : "server";

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
  /** P4-b context compaction 配置。 */
  compaction: {
    thresholdTokens: compactionThresholdTokens,
    keepRecentMessages: compactionKeepRecentMessages,
  },
  /** Agent loop 跑在哪一端：'client' = 前端驱动 single-step；'server' = 服务端 ToolLoopAgent。 */
  agentLoopMode,
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
