import type { HookEvent, HookSpec, RegisteredHook } from "./types";

/**
 * `defineHook` —— hook 注册工厂。
 *
 * 做两件事：
 * 1. 通过泛型把 `event` 字面量绑到 handler 的 payload 形状上（少一处手写
 *    `as PreToolUsePayload` 之类的窄化）。
 * 2. 把 `matcher`（字符串）compile 成 `RegExp` 存到注册项里，避免 runtime 每次
 *    `runHooks` 都重 compile。
 *
 * 不在这里塞 priority / order 字段——注册顺序就是优先级，简单就好；以后真有需要
 * 再在 `HookRegistry.register` 里加 `{ before: "name" }` 这种 API。
 */
export function defineHook<E extends HookEvent>(spec: HookSpec<E>): RegisteredHook<E> {
  const compiled: RegisteredHook<E> = {
    event: spec.event,
    name: spec.name,
    handler: spec.handler,
  };
  if (spec.matcher !== undefined && spec.matcher !== "") {
    // 用户给空串等价于"不写 matcher"，避免 `new RegExp("")` 命中所有字符串那种
    // 反直觉行为。
    compiled.matcher = new RegExp(spec.matcher);
  }
  return compiled;
}
