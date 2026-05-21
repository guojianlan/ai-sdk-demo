import { toolErr } from "@/lib/tool-result";

import { runHooks } from "./runtime";
import type { HookRegistry } from "./runtime";
import type { AggregatedHookResult } from "./types";

/**
 * Tool execute 拦截层 —— P9-b 的关键拼图。
 *
 * 工作模式：
 * - 接收一个 `ToolSet`（key → tool 对象），对每个有 `execute` 的 tool 包一层。
 * - Pre：调用前先跑 PreToolUse hook
 *     - `decision: "deny"` → 直接返回 `toolErr(reason)`，**不调底层 execute**。
 *       LLM 拿到的是个普通 tool error string，能在下一轮自我纠正，对话 lifecycle
 *       完整（不会出现 "No tool output found" 那种 orphan 错）。
 *     - `updatedInput` 不为 undefined → 用它替换原 input 透传给 execute。
 *     - `decision: "ask"` 在这一层**故意忽略**——execute 阶段没 UI 通道弹卡，
 *       审批流水线在 `needsApproval` 阶段（前置 ACL 已经处理）。
 * - Post：execute 结束（无论成功失败）都跑 PostToolUse hook，给日志型 hook 一个
 *   "我跑完了"的统一切点。execute 抛错时把异常 message 包成 toolErr 形态喂 PostToolUse，
 *   让日志 hook 不用分支处理。
 * - **不动**没有 `execute` 的 tool（client-side interactive tool 如 ask_user_question
 *   / ask_choice / show_reference）—— 它们的 output 由前端回灌，没有"server 执行
 *   切点"可挂。
 *
 * 设计取舍：
 * - 不在 `createChatAgent` builder 里直接接，而是暴露成独立函数让 workflow 显式
 *   调用——避免给单测/子 agent 路径强加 hook（subagent 自构 toolset 走自己的链路）。
 * - 用 spread 复制 tool 对象 + 替换 `execute`，依赖 AI SDK 的 tool 是 plain object
 *   这件事。如果将来 AI SDK 改成 class instance，要换成 `tool({...config})` 重建。
 * - PostToolUse hook 永远跑：即使 execute 抛了也跑——这样日志 hook 能记录"失败的
 *   tool call"，否则失败的 call 在 stdout 上是哑的。
 */

type AnyTool = {
  execute?: (input: unknown, options: ToolExecuteOptions) => unknown;
  [key: string]: unknown;
};

type ToolExecuteOptions = {
  experimental_context?: unknown;
  abortSignal?: AbortSignal;
  toolCallId?: string;
};

export interface WrapToolsetContext {
  /** 透传给 hook payload 的 sessionId（一般是 chatId）。 */
  sessionId?: string;
  /** 把 PostToolUse hook 聚合结果交回调用方，用于下一轮模型上下文。 */
  onPostToolUseResult?: (result: AggregatedHookResult) => void | Promise<void>;
}

/**
 * 包整套 toolset。返回值跟入参 ToolSet 结构同形——可以原地替换传给 agent。
 *
 * 为啥泛型 `T extends Record<string, unknown>` 而不是 `ToolSet`：`ToolSet` 在 AI
 * SDK v6 里携带 InputSchema/OutputSchema 推断，wrap 阶段不关心具体形状，保持类型
 * 宽松能避免一堆 `as unknown as ToolSet` 转换。调用方那一层有完整 ToolSet 类型。
 */
export function wrapToolsetWithHooks<T extends Record<string, unknown>>(
  tools: T,
  registry: HookRegistry,
  ctx: WrapToolsetContext = {},
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tools)) {
    wrapped[name] = wrapSingleTool(name, value as AnyTool, registry, ctx);
  }
  return wrapped as T;
}

function wrapSingleTool(
  toolName: string,
  toolObject: AnyTool,
  registry: HookRegistry,
  ctx: WrapToolsetContext,
): AnyTool {
  const original = toolObject.execute;
  if (typeof original !== "function") {
    // Interactive tool（无 execute）—— 不挂 hook，原样返回。
    return toolObject;
  }

  const wrappedExecute = async (
    input: unknown,
    options: ToolExecuteOptions,
  ): Promise<unknown> => {
    const sessionId = ctx.sessionId;
    const signal = options?.abortSignal;

    // ---- PreToolUse ----
    const pre = await runHooks(
      registry,
      "PreToolUse",
      { event: "PreToolUse", toolName, input, sessionId },
      { signal, sessionId },
    );

    if (pre.decision === "deny") {
      const reason = pre.reason ?? "denied by hook";
      const deniedBy = pre.deniedBy ?? "unknown";
      return toolErr(`Tool call denied by hook "${deniedBy}": ${reason}`);
    }

    const effectiveInput =
      pre.updatedInput !== undefined ? pre.updatedInput : input;

    // ---- execute ----
    const startedAt = performance.now();
    let result: unknown;
    let executeError: unknown;
    try {
      result = await original.call(toolObject, effectiveInput, options);
    } catch (err) {
      executeError = err;
    }
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

    // ---- PostToolUse ----
    // 失败也跑：把 throw 拍成 `{ ok:false, error }` 形态喂 hook，统一切点。
    const postResultPayload =
      executeError !== undefined
        ? {
            ok: false as const,
            error:
              executeError instanceof Error
                ? executeError.message
                : String(executeError),
          }
        : result;

    const post = await runHooks(
      registry,
      "PostToolUse",
      {
        event: "PostToolUse",
        toolName,
        input: effectiveInput,
        result: postResultPayload,
        durationMs,
        sessionId,
      },
      { signal, sessionId },
    );
    await ctx.onPostToolUseResult?.(post);

    if (executeError !== undefined) {
      // 重新抛出 —— hook 是横切关注点，不替 agent 决定怎么处理异常。
      // agent 那一侧会按自己的 error handling（toolErr / lifecycle）走。
      throw executeError;
    }
    return result;
  };

  return { ...toolObject, execute: wrappedExecute };
}
