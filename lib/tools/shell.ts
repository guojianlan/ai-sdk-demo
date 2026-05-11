import path from "node:path";

import { z } from "zod";

import {
  DEFAULT_TRUNCATE_BYTES,
  truncateMiddle,
} from "@/lib/output-truncation";
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
 *   **进 model context 前再过一道 `truncateMiddle(..., 10K)` 中间截断**（codex 风格）——
 *   sandbox 1MB 是给 UI 看的，模型只需要头尾各 ~5KB 就够看懂这次命令干了啥；中间
 *   被剪掉的部分用 `[... N bytes omitted ...]` 标记让 agent 知道有信息丢失，需要
 *   narrow 命令重跑。参考 `codex-rs/utils/output-truncation/src/lib.rs`。
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
    "PREFER (when shell is the right choice):",
    "- For text search prefer `rg`; for file discovery prefer `rg --files` — both are much faster than `grep` / `find`. Fall back only if `rg` is missing.",
    "- For reading files use native commands (`cat`, `sed -n '1,200p' file`, `head`, `tail`). Do NOT use `python3 -c \"print(open(...).read())\"` or `node -e \"...fs.readFile...\"` to dump file contents — they are slower, noisier, and easier to truncate.",
    "- Reach for `python3` / `node -e` only when you genuinely need a small computation a shell pipeline cannot express (parsing JSON without `jq`, complex string ops, etc.) — not as a wrapper around `cat`/`grep`.",
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
  name: "shell",
  getRuleContent: ({ command }) => command,
  getCwd: (ctx) => getWorkspaceToolContext(ctx).sandbox.workingDirectory,
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

      // sandbox 已经做了 1MB head-cap（防 OOM）。这里再做 codex 风格的
      // middle-truncate 到 10K bytes —— 把头尾保留给模型看（命令开头通常
      // 是 progress / 输入回显，尾部通常是 exit summary / 错误信息），
      // 中间砍掉换成 `[... N bytes omitted ...]`。
      // 这层截断**只影响进 model context 的内容**，UI 仍能看到 sandbox 截过
      // 的完整 1MB（如果将来分开两路返回的话；目前 UI 也读这层）。
      const stdout = truncateMiddle(result.stdout, DEFAULT_TRUNCATE_BYTES);
      const stderr = truncateMiddle(result.stderr, DEFAULT_TRUNCATE_BYTES);
      const truncated =
        result.truncated ||
        stdout !== result.stdout ||
        stderr !== result.stderr;

      return toolOk({
        command,
        cwd: path.relative(workspaceRoot, resolvedCwd) || ".",
        success: result.success,
        exitCode: result.exitCode,
        stdout,
        stderr,
        truncated,
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});
