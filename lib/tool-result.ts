/**
 * 统一的 tool execute 返回 shape。
 *
 * 目前仓库里 tool 的返回形态有三种：
 * - 直接 throw（workspaceToolset 的 list_files / search_code / read_file）
 * - `{ok, ...data}` 平铺（write_file / edit_file / explore_workspace）
 * - 固定 shape 无 ok 标志（shell 总返回 `{output, workingDirectory}`）
 *
 * P3-R 把所有自家 tool 收敛到这一个 discriminated union。好处：
 * - LLM 看到统一的成功 / 失败结构，能一致地处理 error 字段
 * - 前端 `renderToolOutput` 可以先判 `ok` 再取 `data`，不用逐工具猜 shape
 * - 调用方（如 explorer subagent）能省略"可能 throw"的分支
 *
 * MCP 工具（weather）shape 由 server 决定，不受这个 type 约束——前端的 JSON 兜底已经够用。
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
