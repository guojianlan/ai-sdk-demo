/**
 * 统一的 tool execute 返回 shape，给 LLM 看。
 *
 * 业务侧**永远不需要 import 这个**——`defineTool` 的 wrapper 自动包：
 *   业务 return T          → { ok: true, data: T }
 *   业务 throw Error("x")  → { ok: false, error: "x" }
 *
 * 这个文件只导出类型 + 内部包装函数，给 lib/tooling/define-tool.ts 用。
 *
 * 业务不再接触 toolOk / toolErr——它们只在 `define-tool.ts` 内部被调用。
 */

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function toolOk<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function toolErr(error: unknown): { ok: false; error: string } {
  if (typeof error === "string") {
    return { ok: false, error };
  }
  if (error instanceof Error) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Unknown error" };
}
