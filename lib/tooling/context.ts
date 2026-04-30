import type { ToolContext } from "@/lib/tooling/types";

/**
 * 从 AI SDK 的 `ToolExecutionOptions.experimental_context`（协议层、untyped）
 * 提取业务需要的 `ToolContext`（应用层、typed）。
 *
 * 协议侧（service / step API）放进去什么，这里就解出来什么。当前协议字段：
 *   { workspaceRoot, workspaceName, bypassPermissions, sandbox?, session?, model?, subagentModel? }
 *
 * 路由代码（`/api/agent/step` 的 source resolver）填这个 raw shape；本函数把它
 * 转成业务侧的 `ToolContext` 形态。
 *
 * 缺字段一律抛错——业务 tool 拿到的 ctx 永远是有效的，不需要再做 null check。
 */

type RawContext = {
  workspaceRoot?: unknown;
  workspaceName?: unknown;
  bypassPermissions?: unknown;
  sandbox?: unknown;
  session?: unknown;
  model?: unknown;
  subagentModel?: unknown;
};

export function extractToolContext(experimental: unknown): ToolContext {
  if (typeof experimental !== "object" || experimental === null) {
    throw new Error(
      "Tool context missing: this tool was called without experimental_context. " +
        "Make sure the request goes through /api/agent/step (which sets it).",
    );
  }
  const raw = experimental as RawContext;

  if (typeof raw.workspaceRoot !== "string" || raw.workspaceRoot.length === 0) {
    throw new Error("Tool context: workspaceRoot is required");
  }
  const workspaceName =
    typeof raw.workspaceName === "string" && raw.workspaceName.length > 0
      ? raw.workspaceName
      : raw.workspaceRoot;
  const bypassPermissions = raw.bypassPermissions === true;

  return {
    workspace: { root: raw.workspaceRoot, name: workspaceName },
    bypassPermissions,
    // 其它字段 raw passthrough；类型留 unknown 由消费方各自 narrow（避免抽象层
    // 强制 import sandbox/session/model 类型，保持 plumbing 干净）。
    sandbox: raw.sandbox as ToolContext["sandbox"],
    session: raw.session as ToolContext["session"],
    model: raw.model as ToolContext["model"],
    subagentModel: raw.subagentModel as ToolContext["subagentModel"],
  };
}
