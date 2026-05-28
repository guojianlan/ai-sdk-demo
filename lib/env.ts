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

const gatewayImageModelId =
  pickString(process.env.OPENAI_COMPAT_IMAGE_MODEL) ?? "gpt-image-1";

/**
 * Reasoning effort（OpenAI gpt-5 系 / o1 系列等推理模型支持的
 * `reasoning_effort` 参数）。可选值：`minimal / low / medium / high`。
 * 未设置 → 不注入字段，让 provider 用默认（通常是 medium）。
 */
const gatewayReasoningEffort = (() => {
  const raw = pickString(process.env.OPENAI_COMPAT_REASONING_EFFORT);
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (
    lower === "minimal" ||
    lower === "low" ||
    lower === "medium" ||
    lower === "high"
  ) {
    return lower;
  }
  console.warn(
    `[env] unrecognized OPENAI_COMPAT_REASONING_EFFORT=${raw}; ignoring.`,
  );
  return undefined;
})();

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

// 外层 chat loop 的步数上限：每"步"= 一次 LLM 调用 + 它本轮的 tool 执行。
// 默认 500 对齐 open-agents；普通对话远到不了，主要防失控死循环。
const outerStepLimit = parseIntOr(process.env.CHAT_OUTER_STEP_LIMIT, 500);

/**
 * Memory 抽取器（A2 Phase 1）专用模型。
 *
 * 不配（`undefined`）→ 用主对话同一个 model（`gateway.modelId`）。
 * 配了便宜模型（`MEMORY_EXTRACTOR_MODEL=deepseek-v4-flash` 或 `gpt-5-mini`）→
 * Phase 1 跑那个，省 token；主对话不受影响。
 *
 * 对齐 codex：他们 Phase 1 用 `gpt-5-mini` LOW reasoning，Phase 2 用 `gpt-5`
 * MEDIUM reasoning。我们暂时不分两档（Phase 2 用同一个 env），将来不够再加。
 */
const memoryExtractorModel = pickString(process.env.MEMORY_EXTRACTOR_MODEL);

/**
 * 跨对话长期记忆（`~/.local-agent/memory/MEMORY.md`）注入 system prompt 的字符上限。
 *
 * 默认 8000 字符（≈ 2000 token），超出截断只取头部 + 末尾加警告。原因：
 * - prompt 的预算紧；MEMORY.md 通常是 consolidator 整合后的索引（每条 ≤ 150 字符），
 *   8000 能容 ~50 条索引项，对个人用户够用
 * - 大用户 / 团队 memory 可以调高 `AGENT_MEMORY_MAX_CHARS=20000`
 * - 真要塞更多请走"按需拉"模式（A4 `memory_write` tool 之外再加 `memory_read`）
 */
const memoryMaxChars = parseIntOr(process.env.AGENT_MEMORY_MAX_CHARS, 8000);

/**
 * `spawn_agent` 递归调用的深度上限。
 *
 * 0 = 主 agent；1 = 子 agent（主 agent spawn 出来）；2 = 孙 agent；以此类推。
 *
 * 默认 2 —— 主 agent 可以 spawn 子 agent，子 agent 还能再 spawn 一次孙 agent，
 * 再深就拒绝。这个上限是 token / 失控防御：每多一层都让单个 chat turn 翻倍消耗。
 *
 * codex 用 `agent_max_depth` 配置同样的事；他们默认更宽松（用户可调），我们
 * 收紧默认值。想加大设 `SUBAGENT_MAX_DEPTH=3` 或更高。
 */
const subAgentMaxDepth = parseIntOr(process.env.SUBAGENT_MAX_DEPTH, 2);

/**
 * 持久化存储根目录。
 *
 * 设计：默认 `~/.local-agent/`——刻意起一个 **跟当前项目名解耦** 的中性名，
 * 这样将来项目重命名 / 做桌面端 / 多项目共享会话历史时，只改这里一行就够。
 *
 * 目录结构（参考 codex `~/.codex/` + claude-code `~/.claude/`）：
 *   ~/.local-agent/
 *   ├── agent.db                       SQLite 元数据索引（线程列表、archive 状态等）
 *   └── sessions/YYYY/MM/DD/
 *       └── <thread-id>.jsonl          会话源真相（append-only）
 */
const storageDir =
  pickString(process.env.AGENT_STORAGE_DIR) ??
  path.join(os.homedir(), ".local-agent");

/**
 * `.env*` 文件读写是否要求审批。
 *
 * 背景：codex 用 OS sandbox / claude-code 用 ML classifier 来挡敏感文件，都没有
 * 显式 .env 路径检测。我们没那两套底层防御，所以参考 open-agents 在应用层加了一道
 * 弱保护——但它确实会在你正常折腾 .env.example / .env.local 时多弹一次。
 *
 * 默认 `false`（关）。打开后：read / write / edit 命中 `.env*` basename 时强制弹审批卡。
 */
const dotEnvFileApproval =
  parseBoolean(process.env.DOTENV_FILE_APPROVAL) ?? false;

/**
 * OS 级沙箱（@anthropic-ai/sandbox-runtime）配置。
 *
 * 设计：默认关。打开后，`LocalSandbox.exec()` 把每条 shell 命令包到 sandbox-exec
 * （macOS）/ bwrap（Linux）里跑——同 claude-code 的 sandbox 实现底层。
 *
 * 跨平台行为：
 * - macOS: `sandbox-exec` 系统内置，开箱即用
 * - Linux: 需要预装 `bwrap`（`apt install bubblewrap` / `dnf install bubblewrap`）；
 *          没装的话初始化会失败，回落到软沙箱（不阻塞流程）
 * - Windows: ASRT 不支持，直接走软沙箱
 *
 * 网络白名单：只在 sandboxEnabled=true 时生效。逗号分隔域名，比如：
 *   SANDBOX_ALLOWED_DOMAINS=registry.npmjs.org,github.com,*.github.com
 * 不配 → 默认全 deny（典型只读工作流足够，但 npm install / git push 会被拦）。
 */
const sandboxEnabled = parseBoolean(process.env.SANDBOX_ENABLED) ?? false;

const sandboxAllowedDomains = (
  pickString(process.env.SANDBOX_ALLOWED_DOMAINS) ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

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
    imageModelId: gatewayImageModelId,
    /** 可选 reasoning_effort，值在 minimal/low/medium/high 之中，否则 undefined。 */
    reasoningEffort: gatewayReasoningEffort,
  },
  /** P4-b context compaction 配置。 */
  compaction: {
    thresholdTokens: compactionThresholdTokens,
    keepRecentMessages: compactionKeepRecentMessages,
  },
  /** 主聊天外层 for 循环的步数上限（对齐 open-agents 的 maxSteps=500）。 */
  outerStepLimit,
  /** spawn_agent 递归深度上限。默认 2（主 → 子 → 孙）。 */
  subAgentMaxDepth,
  /** MEMORY.md 注入 system prompt 的字符上限。默认 8000。 */
  memoryMaxChars,
  /** Memory 抽取器专用模型。undefined → 落回主模型。 */
  memoryExtractorModel,
  /** read / write / edit 命中 `.env*` 路径时是否弹审批。默认 false。 */
  dotEnvFileApproval,
  /** ASRT OS 沙箱配置（默认关）。 */
  sandbox: {
    enabled: sandboxEnabled,
    /** 允许出网的域名清单。空数组 = 全 deny。 */
    allowedDomains: sandboxAllowedDomains,
  },
  /** 持久化存储根目录（默认 `~/.local-agent/`）。 */
  storageDir,
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
