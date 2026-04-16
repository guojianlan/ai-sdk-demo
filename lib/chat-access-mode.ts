/**
 * 访问模式决定模型是否可以通过服务端工具读取所选工作区，
 * 还是只能把工作区路径当作纯文本上下文来使用。
 */
export const WORKSPACE_ACCESS_MODES = [
  "workspace-tools",
  "no-tools",
] as const;

export type WorkspaceAccessMode = (typeof WORKSPACE_ACCESS_MODES)[number];

/**
 * 默认优先提供基于代码事实的回答，因此除非请求显式切换到更保守的
 * no-tools 模式，否则会启用工作区读取工具。
 */
export const DEFAULT_WORKSPACE_ACCESS_MODE: WorkspaceAccessMode =
  "workspace-tools";

export const WORKSPACE_ACCESS_MODE_LABELS: Record<
  WorkspaceAccessMode,
  string
> = {
  "workspace-tools": "允许读工作区",
  "no-tools": "无工具模式",
};

export const WORKSPACE_ACCESS_MODE_DESCRIPTIONS: Record<
  WorkspaceAccessMode,
  string
> = {
  "workspace-tools":
    "Agent 可以列目录、搜索代码、读取选中工作区中的文本文件。",
  "no-tools":
    "Agent 只知道你选了哪个目录，但不能读取目录结构或文件内容。",
};

/**
 * 将客户端传入的任意值归一化为受支持的访问模式。
 * 未识别的值会刻意回退到默认模式。
 */
export function normalizeWorkspaceAccessMode(
  value: unknown,
): WorkspaceAccessMode {
  return value === "no-tools" ? "no-tools" : DEFAULT_WORKSPACE_ACCESS_MODE;
}
