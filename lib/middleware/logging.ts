import type {
  LanguageModelV3FinishReason,
  LanguageModelV3Middleware,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

/**
 * Logging middleware —— 自写一个，对应 roadmap P2-c 的学习目标。
 *
 * 目的：在服务端终端里打印每次 LLM 调用的关键指标，对 prompt / tool 调用链路做"裸眼观察"。
 * 和 `@ai-sdk/devtools` 并存：devtools 往 .devtools/ 持久化给 Web UI 用；
 * 这个 middleware 只往 stdout 输出一条简明日志。
 *
 * 对比 devtools 的实现（tmp/.../middleware.ts），这里砍掉了：
 * - run / step 的概念和 id 生成
 * - 持久化到 JSON 文件
 * - raw chunks 收集
 * 只保留"LLM 调用的可观测性"这一个关注点。
 *
 * 实现要点：
 * - `wrapGenerate`：一次性调用，直接包装 `doGenerate()` 并在 result 返回后打印。
 * - `wrapStream`：流式调用，要在 `stream`（ReadableStream）中插一个 TransformStream，
 *   逐 chunk 观察，`finish` chunk 到达时汇总打印。
 */

type CallLog = {
  mode: "generate" | "stream";
  model: string;
  provider: string;
  durationMs: number;
  usage?: LanguageModelV3Usage;
  finishReason?: LanguageModelV3FinishReason;
  toolCalls: number;
  promptMessages: number;
};

function formatUsage(u?: LanguageModelV3Usage): string {
  if (!u) return "tokens(?)";
  const input = u.inputTokens?.total ?? "?";
  const output = u.outputTokens?.total ?? "?";
  const cached = u.inputTokens?.cacheRead;
  const reasoning = u.outputTokens?.reasoning;
  const extras: string[] = [];
  if (cached != null) extras.push(`cached=${cached}`);
  if (reasoning != null) extras.push(`reasoning=${reasoning}`);
  const extra = extras.length > 0 ? ` ${extras.join(" ")}` : "";
  return `tokens(in=${input} out=${output}${extra})`;
}

function formatFinish(reason?: LanguageModelV3FinishReason): string {
  // v3 的 finishReason 是 { unified, raw }；unified 是跨 provider 归一化过的枚举字符串，
  // 直接把整个对象 toString 会得到 "[object Object]"。
  if (!reason) return "?";
  return reason.unified;
}

function emit(log: CallLog) {
  const parts = [
    `[ai] ${log.mode}`,
    log.model,
    `${log.durationMs}ms`,
    formatUsage(log.usage),
    `tool-calls=${log.toolCalls}`,
    `finish=${formatFinish(log.finishReason)}`,
    `prompt-msgs=${log.promptMessages}`,
  ];
  // 单行 pipe-like 分隔，stdout 里一眼看穿每次请求的开销。
  console.log(parts.join(" · "));
}

function countPromptMessages(prompt: unknown): number {
  if (!Array.isArray(prompt)) return 0;
  return prompt.length;
}

/**
 * 统计 generate 结果里的 tool-call 条目。result.content 是一个 part 数组，
 * 每个 part 有 type 字段（"text" / "tool-call" / "reasoning" / ...）。
 */
function countToolCallsInContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      (part as { type: unknown }).type === "tool-call"
    ) {
      n++;
    }
  }
  return n;
}

/**
 * 环境开关：设 `AI_SDK_LOGGING=false` 显式关掉；否则在非 production 下默认开启。
 * 生产部署时应关闭——日志吃 I/O 还可能把敏感 prompt 片段打到日志里。
 */
function isEnabled(): boolean {
  if (process.env.AI_SDK_LOGGING === "false") return false;
  if (process.env.AI_SDK_LOGGING === "true") return true;
  return process.env.NODE_ENV !== "production";
}

export function loggingMiddleware(): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",

    async wrapGenerate({ doGenerate, params, model }) {
      if (!isEnabled()) return doGenerate();

      const start = Date.now();
      try {
        const result = await doGenerate();
        emit({
          mode: "generate",
          model: model.modelId,
          provider: model.provider,
          durationMs: Date.now() - start,
          usage: result.usage,
          finishReason: result.finishReason,
          toolCalls: countToolCallsInContent(result.content),
          promptMessages: countPromptMessages(params.prompt),
        });
        return result;
      } catch (error) {
        // 失败的调用也打印一行，便于排查 provider 层错误（比如 rate limit、auth）。
        console.log(
          `[ai] generate · ${model.modelId} · ${Date.now() - start}ms · ERROR · ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
    },

    async wrapStream({ doStream, params, model }) {
      if (!isEnabled()) return doStream();

      const start = Date.now();
      const result = await doStream();

      let toolCalls = 0;
      let finishReason: LanguageModelV3FinishReason | undefined;
      let usage: LanguageModelV3Usage | undefined;

      // 把原 stream pipe 到一个 TransformStream，逐 chunk 观察再原样 enqueue 出去。
      // 不拦截内容、不延迟，只是在路过时顺手记账。
      const loggingStream = result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === "tool-call") {
              toolCalls++;
            }
            if (chunk.type === "finish") {
              finishReason = chunk.finishReason;
              usage = chunk.usage;
            }
            controller.enqueue(chunk);
          },
          flush() {
            // 流结束（可能是正常完成，也可能是上游断开）。无论哪种都发一行。
            emit({
              mode: "stream",
              model: model.modelId,
              provider: model.provider,
              durationMs: Date.now() - start,
              usage,
              finishReason,
              toolCalls,
              promptMessages: countPromptMessages(params.prompt),
            });
          },
        }),
      );

      return { ...result, stream: loggingStream };
    },
  };
}
