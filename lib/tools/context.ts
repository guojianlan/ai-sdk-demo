import { getSandbox } from "@/lib/sandbox";
import type { Sandbox } from "@/lib/sandbox/interface";

import {
  DEFAULT_SHELL_APPROVAL_POLICY,
  normalizeShellApprovalPolicy,
  type ShellApprovalPolicy,
} from "./shell-approval";

/**
 * 工具运行时的最小上下文。`lib/tools/*.ts` 里所有 tool 都从这里取共享状态。
 *
 * 字段说明：
 * - sandbox: workspace 文件操作入口（通过 lib/sandbox 抽象，本地实现 = LocalSandbox）。
 * - workspaceName: 纯展示用，UI tool result 里要显示。
 *
 * 注意 sandbox.workingDirectory 即原来的 workspaceRoot，工具内部都从这里取根路径。
 */
export type WorkspaceToolContext = {
  sandbox: Sandbox;
  workspaceName: string;
};

export function getWorkspaceToolContext(
  context: unknown,
): WorkspaceToolContext {
  if (
    typeof context !== "object" ||
    context === null ||
    !("workspaceName" in context)
  ) {
    throw new Error("Workspace tool context is missing for this request.");
  }

  const sandbox = getSandbox(context);
  const { workspaceName } = context as { workspaceName: string };

  return { sandbox, workspaceName };
}

/**
 * 读取会话级 shell 审批策略。
 *
 * 由路由层从 ChatSession 拿出来塞进 `experimental_context`，`shell` 工具的
 * `needsApproval` 据此决定要不要弹批准卡。任何缺失 / 错误值都会回落到默认
 * `untrusted` —— 已知安全命令直接跑，其它弹审批。
 */
export function getShellApprovalPolicy(context: unknown): ShellApprovalPolicy {
  if (
    typeof context !== "object" ||
    context === null ||
    !("shellApprovalPolicy" in context)
  ) {
    return DEFAULT_SHELL_APPROVAL_POLICY;
  }

  return normalizeShellApprovalPolicy(
    (context as { shellApprovalPolicy: unknown }).shellApprovalPolicy,
  );
}
