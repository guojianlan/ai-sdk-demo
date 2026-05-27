import type { Sandbox } from "./interface";

/**
 * 工具运行时从 `experimental_context` 取 sandbox 实例的统一入口。
 * 缺失时直接抛错 —— route + chat loop 都应该保证注入，缺就是 bug。
 */
export function getSandbox(context: unknown): Sandbox {
  if (
    typeof context !== "object" ||
    context === null ||
    !("sandbox" in context)
  ) {
    throw new Error("Sandbox is missing from tool context.");
  }

  const sandbox = (context as { sandbox: unknown }).sandbox;
  if (!sandbox || typeof sandbox !== "object") {
    throw new Error("Sandbox in tool context is not a valid Sandbox instance.");
  }

  return sandbox as Sandbox;
}
