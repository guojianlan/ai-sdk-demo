import path from "node:path";

import { z } from "zod";

import { approvedTool } from "@/lib/tool-helpers";
import { toolErr, toolOk } from "@/lib/tool-result";
import { resolveWorkspacePath } from "@/lib/workspaces";

import { getShellApprovalPolicy, getWorkspaceToolContext } from "./context";
import { shellNeedsApproval } from "./shell-approval";

/**
 * `shell` —— 在 workspace 里跑非交互 bash 命令。
 *
 * 命名跟 codex 对齐（codex 的 shell exec），不沿用 open-agents 的 `bash`——后者在
 * Windows 不一定有，叫 `shell` 更中性。
 *
 * 设计：
 * - 必须由 `approvedTool` 包装：`needsApproval` 按 session 配置的
 *   `shellApprovalPolicy` + 该命令是否在「已知安全」列表来决定。
 * - cwd 必须是 workspace-relative 或绝对路径，且解析后的实际目录得在 workspaceRoot
 *   之下——`resolveWorkspacePath` 拒绝 ".." 逃逸。
 * - 走 `sandbox.exec`，超时 120s，stdout/stderr 各自有 1MB 上限（sandbox 层做的）。
 * - 不支持 detached / 长进程。要起 dev server 这类后台服务，请用 npm run dev:all
 *   外面拉一个独立终端，agent 不应该 fork 后台进程到 chat lifecycle 之外。
 */

const SHELL_TIMEOUT_MS = 120_000;

const shellInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      "Bash command to run, non-interactive. NEVER use interactive commands (vim, nano, top, ssh, etc.). Combine commands with `&&` / `;` only when each part is itself short.",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Workspace-relative working directory. Default: workspace root. Reject `..` escape paths.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Short, human-readable reason for running this command. Shown in approval UI when applicable.",
    ),
});

export const shellTool = approvedTool({
  description: [
    "Execute a bash command in the user's workspace (non-interactive).",
    "",
    "WHEN TO USE:",
    "- Running existing project commands (build, test, lint, typecheck).",
    "- Read-only CLI inspection (git status, git diff, git log, ls, etc.).",
    "- Invoking package managers as part of a task (npm, pnpm, yarn, pip).",
    "",
    "WHEN NOT TO USE:",
    "- Reading file contents (use `read` instead).",
    "- Editing or creating files (use `write` / `edit` instead).",
    "- Searching code or text (use `grep` / `glob` instead).",
    "- Interactive commands (shells, editors, REPLs) — there is no TTY.",
    "",
    "USAGE:",
    "- Runs `bash -c \"<command>\"` non-interactively. No TTY/PTY.",
    "- Default cwd is the workspace root. Use `cwd` only when you need a subdirectory; do NOT prepend `cd ...` to the command.",
    "- Timeout: 120s. Output (stdout/stderr) is captured and may be truncated.",
    "- Approval: known-safe read-only commands (`git status`, `ls`, etc.) auto-run; everything else may require user approval depending on session policy.",
    "",
    "DO NOT:",
    "- Chain shell with redirection (`>`, `>>`, `2>&1`), command substitution (`$(...)`, backticks), or background (`&`) — these are blocked by the safety check anyway.",
    "- Run interactive editors / pagers (less, more, vim, nano).",
    "- Spawn long-running servers (next dev, etc.) — they outlive the chat session.",
    "",
    "EXAMPLES:",
    "- Run unit tests: `npm test`",
    "- Check git status: `git status --short`",
    "- List files: `ls -la`, with `cwd: src`",
  ].join("\n"),
  inputSchema: shellInputSchema,
  needsApproval: ({ command }, ctx) =>
    shellNeedsApproval(command, getShellApprovalPolicy(ctx)),
  execute: async (
    { command, cwd: relativeCwd },
    { experimental_context, abortSignal },
  ) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    const workspaceRoot = sandbox.workingDirectory;

    let resolvedCwd: string;
    try {
      resolvedCwd = relativeCwd
        ? resolveWorkspacePath(workspaceRoot, relativeCwd)
        : workspaceRoot;
    } catch (error) {
      return toolErr(error);
    }

    try {
      const result = await sandbox.exec(
        command,
        resolvedCwd,
        SHELL_TIMEOUT_MS,
        { signal: abortSignal },
      );

      return toolOk({
        command,
        cwd: path.relative(workspaceRoot, resolvedCwd) || ".",
        success: result.success,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});
