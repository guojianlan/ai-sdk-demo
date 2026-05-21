import type {
  AggregatedHookResult,
  HookContext,
  HookEvent,
  HookPayload,
  HookPayloadFor,
  HookResult,
  RegisteredHook,
} from "./types";

/**
 * Hook 运行时 —— P9-a 的核心。
 *
 * 设计取舍：
 * - **注册顺序 = 优先级**。不引入数字 priority 字段；想"先跑"就先 register。
 *   多数 hook 系统（Express middleware、Webpack tapable）都这么做，肌肉记忆够用。
 * - **失败/超时 hook 不阻塞主流程**。除非 hook 显式返回 `decision: "deny"`，否则
 *   异常和超时都按"跳过这条 hook"处理。这跟 Claude Code 的"hook 非关键路径"
 *   设计一致：hook 是横切关注点，不该把主链路炸掉。
 * - **deny 是唯一短路信号**。一旦命中 deny，后续 hook 不再跑——已经定了的事不用
 *   再讨论。`ask` 不短路，因为可能还有 hook 想注入 context 或改写 input。
 * - **matcher 仅对工具事件生效**。UserPromptSubmit / SessionStart 的 matcher
 *   被故意忽略——避免 hook 作者误以为能用正则匹配 prompt 内容（prompt 可能很长，
 *   匹配语义也不清晰，留给 hook 自己在 handler 里判）。
 */

/** 默认单 hook 超时；想覆盖在 `runHooks` 的 ctx 里传。 */
const DEFAULT_HOOK_TIMEOUT_MS = 5000;

export interface HookRunContext extends HookContext {
  /** 单个 hook 的最大执行时长。超时不算 deny，按"跳过这条"处理。 */
  timeoutMs?: number;
}

/**
 * Hook 注册表 —— 按事件名分桶存。
 *
 * 不做去重：允许同名 hook 注册多次（虽然不推荐），但 `unregister(name)` 会一次清光。
 * `clear()` 主要给单测用。
 */
export class HookRegistry {
  private readonly hooks = new Map<HookEvent, RegisteredHook[]>();

  register<E extends HookEvent>(hook: RegisteredHook<E>): void {
    const bucket = this.hooks.get(hook.event) ?? [];
    bucket.push(hook as RegisteredHook);
    this.hooks.set(hook.event, bucket);
  }

  unregister(name: string): void {
    for (const [event, bucket] of this.hooks) {
      const filtered = bucket.filter((h) => h.name !== name);
      if (filtered.length !== bucket.length) {
        this.hooks.set(event, filtered);
      }
    }
  }

  list<E extends HookEvent>(event: E): RegisteredHook<E>[] {
    return (this.hooks.get(event) ?? []) as RegisteredHook<E>[];
  }

  clear(): void {
    this.hooks.clear();
  }
}

/**
 * 拿出 payload 里给 matcher 用的字符串。
 *
 * - 工具事件 → toolName
 * - 其它事件 → 返回 `null`，表示"matcher 不参与判定"，runtime 会忽略 matcher 直接命中。
 */
function matcherTarget(payload: HookPayload): string | null {
  if (payload.event === "PreToolUse" || payload.event === "PostToolUse") {
    return payload.toolName;
  }
  return null;
}

/** 用 Promise.race 模拟超时；超时分支用 sentinel 区分。 */
const TIMEOUT_SENTINEL = Symbol("hook-timeout");

async function runWithTimeout(
  handler: () => Promise<HookResult | void> | HookResult | void,
  timeoutMs: number,
): Promise<HookResult | void | typeof TIMEOUT_SENTINEL> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutId = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => handler()), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * 跑指定事件下命中 matcher 的所有 hook，聚合结果。
 *
 * 调用方拿到 `AggregatedHookResult` 后自行决策：
 * - `decision === "deny"` → 主流程中止
 * - `decision === "ask"` → 走 approval 流水线
 * - `updatedInput` 不为 undefined → 用它替换原 input（仅 PreToolUse）
 * - `additionalContexts` / `systemMessages` → 按事件类型注入到下一轮上下文
 */
export async function runHooks<E extends HookEvent>(
  registry: HookRegistry,
  event: E,
  payload: HookPayloadFor<E>,
  ctx: HookRunContext = {},
): Promise<AggregatedHookResult> {
  const aggregated: AggregatedHookResult = {
    additionalContexts: [],
    systemMessages: [],
  };

  const target = matcherTarget(payload);
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const handlerCtx: HookContext = { signal: ctx.signal, sessionId: ctx.sessionId };

  for (const hook of registry.list(event)) {
    // matcher 只在工具事件上参与判定；其它事件视为"始终命中"。
    if (target !== null && hook.matcher && !hook.matcher.test(target)) {
      continue;
    }

    let outcome: HookResult | void | typeof TIMEOUT_SENTINEL;
    try {
      outcome = await runWithTimeout(
        () => hook.handler(payload, handlerCtx),
        timeoutMs,
      );
    } catch (err) {
      // 异常隔离：单条 hook 抛错只记一行 warn，不影响主流程也不影响后续 hook。
      // 这里故意用 console.warn 而不是 throw；hook 是横切关注点，不该让主链路挂掉。
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[hooks] ${event} "${hook.name}" threw: ${message}`);
      continue;
    }

    if (outcome === TIMEOUT_SENTINEL) {
      console.warn(`[hooks] ${event} "${hook.name}" timed out after ${timeoutMs}ms`);
      continue;
    }

    if (!outcome) continue;

    if (outcome.additionalContexts && outcome.additionalContexts.length > 0) {
      aggregated.additionalContexts.push(...outcome.additionalContexts);
    }
    if (outcome.systemMessage) {
      aggregated.systemMessages.push(outcome.systemMessage);
    }
    if (outcome.updatedInput !== undefined) {
      // last-write-wins。多 hook 改同一份 input 是边角场景，真发生了由后注册的赢。
      aggregated.updatedInput = outcome.updatedInput;
    }

    if (outcome.decision === "deny") {
      aggregated.decision = "deny";
      aggregated.reason = outcome.reason;
      aggregated.deniedBy = hook.name;
      // deny 是硬短路——后面的 hook 不用再跑了。
      return aggregated;
    }
    if (outcome.decision === "ask" && aggregated.decision !== "ask") {
      aggregated.decision = "ask";
      aggregated.reason = outcome.reason ?? aggregated.reason;
    } else if (outcome.decision === "allow" && aggregated.decision === undefined) {
      aggregated.decision = "allow";
      aggregated.reason = outcome.reason ?? aggregated.reason;
    }
  }

  return aggregated;
}
