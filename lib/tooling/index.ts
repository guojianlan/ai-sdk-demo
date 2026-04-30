/**
 * 仓库 tool 抽象层的统一入口。
 *
 * 业务定义 tool：`import { defineTool } from "@/lib/tooling"`
 * 业务消费 tool 集合：`import { globalRegistry } from "@/lib/tooling"`
 *
 * 业务**永远不需要 import**：
 * - tool() / approvedTool() / interactiveTool()（旧 wrapper）
 * - toolOk / toolErr（自动包装）
 * - getWorkspaceToolContext / getBypassPermissions（ctx 抽象）
 */

export { defineTool } from "@/lib/tooling/define-tool";
export { globalRegistry, ToolRegistry } from "@/lib/tooling/registry";
export type {
  DefinedTool,
  SandboxAdapter,
  SessionInfo,
  ToolApprovalPolicy,
  ToolContext,
  ToolKind,
} from "@/lib/tooling/types";
