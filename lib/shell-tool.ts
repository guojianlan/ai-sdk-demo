import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { tool } from "ai";
import { z } from "zod";

import { resolveWorkspacePath } from "@/lib/workspaces";
import { getWorkspaceToolContext } from "@/lib/workspace-tools";

/**
 * 跨模型通用的 shell 工具（自定义 function call 形式）。
 *
 * 为什么不用 OpenAI 的 built-in `local_shell`？
 * - 它是 Responses API 协议层的"内置工具类型"，只有特定模型（gpt-5-codex）被训练过
 *   发出对应的 action 结构；其他模型（GPT-5.4 / Gemini / Claude）不认。
 * - 我们的目标是"做一个和模型无关的 agent dev flow"，所以用**普通 function calling**
 *   路径 —— 任何支持 function calling 的模型都能用。
 *
 * codex CLI 本身也走这条路（见 tmp/codex-main/codex-rs/tools/src/local_tool.rs:185）：
 *   ToolSpec::Function(ResponsesApiTool { name: "shell", ... })
 * 它的 models.json 里所有模型都是 shell_type: "shell_command"，没有一个用 "local"。
 *
 * 安全约束：本工具**只允许只读命令**，能命中下面白名单的 binary 才放行。
 * 支持的形式：
 *   - ["ls", "-la"]                        直接命令
 *   - ["/bin/sh", "-c", "ls -la"]          模型常用的 sh -c 包装
 *   - ["bash", "-lc", "rg foo | head"]     简单管道
 * 明确拒绝：; & && || > < backtick $( 等可以串联命令或写文件的操作符。
 */

const execFileAsync = promisify(execFile);

export const DEFAULT_READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "rg",
  "cat",
  "sed",
  "head",
  "tail",
  "wc",
  "stat",
  "tree",
  "basename",
  "echo",
]);

export const DEFAULT_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "grep",
  "ls-files",
  "show",
  "log",
  "rev-parse",
  "branch",
]);

export type ShellToolOptions = {
  /** 只读命令白名单。默认：{@link DEFAULT_READ_ONLY_COMMANDS} */
  readOnlyCommands?: ReadonlySet<string>;
  /** 只读 git 子命令白名单。默认：{@link DEFAULT_READ_ONLY_GIT_SUBCOMMANDS} */
  readOnlyGitSubcommands?: ReadonlySet<string>;
  /** 输出（stdout+stderr）最大字符数。默认 12 KiB。 */
  maxOutputChars?: number;
  /** 默认超时毫秒。默认 10_000。 */
  defaultTimeoutMs?: number;
  /** 超时上限毫秒。默认 20_000。 */
  maxTimeoutMs?: number;
};

/**
 * 校验一条形如 ["ls", "-la"] 的命令头（已归一化过 basename）。
 */
function assertBinaryReadOnly(
  binary: string,
  subcommand: string | undefined,
  readOnlyCommands: ReadonlySet<string>,
  readOnlyGitSubcommands: ReadonlySet<string>,
) {
  if (!binary) {
    throw new Error("shell 必须提供至少一个命令。");
  }

  if (binary === "git") {
    if (!subcommand || !readOnlyGitSubcommands.has(subcommand)) {
      throw new Error(
        `shell 当前只允许只读 git 子命令：${[...readOnlyGitSubcommands].join(
          ", ",
        )}`,
      );
    }
    return;
  }

  if (!readOnlyCommands.has(binary)) {
    throw new Error(
      `shell 当前只允许只读命令：${[
        ...readOnlyCommands,
        "git <只读子命令>",
      ].join(", ")}`,
    );
  }
}

/**
 * 校验 sh -c 里的字符串：拒绝危险操作符，允许简单管道。
 */
function assertReadOnlyShellString(
  cmdString: string,
  readOnlyCommands: ReadonlySet<string>,
  readOnlyGitSubcommands: ReadonlySet<string>,
) {
  const dangerousOperators: Array<[RegExp, string]> = [
    [/;/, ";"],
    [/&/, "& 或 &&"],
    [/\|\|/, "||"],
    [/>/, ">"],
    [/</, "<"],
    [/`/, "反引号"],
    [/\$\(/, "$()"],
  ];

  for (const [pattern, name] of dangerousOperators) {
    if (pattern.test(cmdString)) {
      throw new Error(
        `shell 不允许操作符 ${name}，请用直接命令或简单管道。`,
      );
    }
  }

  const segments = cmdString
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error("shell 命令为空。");
  }

  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    assertBinaryReadOnly(
      path.basename(tokens[0] ?? ""),
      tokens[1],
      readOnlyCommands,
      readOnlyGitSubcommands,
    );
  }
}

export function assertReadOnlyCommand(
  command: string[],
  options: ShellToolOptions = {},
) {
  const readOnlyCommands =
    options.readOnlyCommands ?? DEFAULT_READ_ONLY_COMMANDS;
  const readOnlyGitSubcommands =
    options.readOnlyGitSubcommands ?? DEFAULT_READ_ONLY_GIT_SUBCOMMANDS;

  if (command.length === 0) {
    throw new Error("shell 必须提供至少一个命令。");
  }

  const first = command[0];
  const firstName = path.basename(first);

  // 拆包 sh -c / bash -c，让白名单作用在真实命令上而不是 shell 本身
  if (
    (firstName === "sh" || firstName === "bash") &&
    command[1] === "-c" &&
    typeof command[2] === "string"
  ) {
    assertReadOnlyShellString(
      command[2],
      readOnlyCommands,
      readOnlyGitSubcommands,
    );
    return;
  }

  assertBinaryReadOnly(
    firstName,
    command[1],
    readOnlyCommands,
    readOnlyGitSubcommands,
  );
}

function resolveShellWorkingDirectory(
  workspaceRoot: string,
  requestedWorkingDirectory?: string,
) {
  if (!requestedWorkingDirectory?.trim()) {
    return workspaceRoot;
  }

  const relativePath = path.isAbsolute(requestedWorkingDirectory)
    ? path.relative(workspaceRoot, requestedWorkingDirectory)
    : requestedWorkingDirectory;

  return resolveWorkspacePath(workspaceRoot, relativePath);
}

function formatShellOutput(stdout: string, stderr: string, maxChars: number) {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");

  if (!combined) {
    return "[命令执行成功，但没有输出]";
  }

  return combined.length > maxChars
    ? `${combined.slice(0, maxChars)}\n\n[truncated]`
    : combined;
}

/**
 * 构造一个自定义的 `shell` function tool。
 *
 * AI SDK v6 的 tool() 用法 —— 任何支持 function calling 的模型都能调：
 *   - OpenAI GPT-5 / 5.1 / 5.2 / 5.4 / codex 系列
 *   - Gemini（经兼容网关）
 *   - Claude
 *   - 本地 Llama 等
 *
 * 调用格式（模型侧发出的 JSON）：
 *   {
 *     "command": ["rg", "ToolLoopAgent", "-n"],
 *     "workingDirectory": "lib",     // 可选，相对 workspace 根
 *     "timeoutMs": 5000              // 可选
 *   }
 */
export function createShellTool(options: ShellToolOptions = {}) {
  const maxOutputChars = options.maxOutputChars ?? 12_000;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 20_000;

  return tool({
    description: [
      "Runs a read-only shell command in the selected workspace and returns stdout/stderr.",
      "Arguments are passed via execFile (no shell expansion) unless you wrap in [\"sh\", \"-c\", ...] or [\"bash\", \"-lc\", ...].",
      "Only read-only commands are allowed (ls, find, rg, cat, sed, head, tail, wc, stat, tree, basename, echo, and read-only git subcommands).",
      "Simple pipes are allowed inside sh -c; operators like ; & && || > < backtick $() are rejected.",
      "Always set `workingDirectory` to the relevant subpath when possible; avoid `cd`.",
    ].join("\n"),
    inputSchema: z.object({
      command: z
        .array(z.string())
        .min(1)
        .describe(
          'Command tokens, e.g. ["ls", "-la"] or ["sh", "-c", "rg foo | head"].',
        ),
      workingDirectory: z
        .string()
        .optional()
        .describe(
          "Optional working directory. Relative to workspace root or absolute inside workspace.",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .optional()
        .describe(
          `Optional timeout in milliseconds. Default ${defaultTimeoutMs}; capped at ${maxTimeoutMs}.`,
        ),
    }),
    execute: async (
      { command, workingDirectory, timeoutMs },
      { experimental_context },
    ) => {
      const { workspaceRoot } = getWorkspaceToolContext(experimental_context);

      assertReadOnlyCommand(command, options);

      const cwd = resolveShellWorkingDirectory(workspaceRoot, workingDirectory);
      const effectiveTimeout = Math.min(
        timeoutMs ?? defaultTimeoutMs,
        maxTimeoutMs,
      );

      try {
        const { stdout, stderr } = await execFileAsync(
          command[0],
          command.slice(1),
          {
            cwd,
            timeout: effectiveTimeout,
            maxBuffer: 1024 * 1024 * 4,
            env: process.env,
          },
        );

        return {
          output: formatShellOutput(stdout, stderr, maxOutputChars),
          workingDirectory: path.relative(workspaceRoot, cwd) || ".",
        };
      } catch (error) {
        // execFile 的超时 / 非零退出也会落到这里；把已有的 stdout/stderr 取出返回，
        // 比直接抛错对模型更友好（它能继续基于输出做决策）。
        if (
          typeof error === "object" &&
          error !== null &&
          "stdout" in error &&
          "stderr" in error
        ) {
          const stdout =
            typeof error.stdout === "string"
              ? error.stdout
              : String(error.stdout);
          const stderr =
            typeof error.stderr === "string"
              ? error.stderr
              : String(error.stderr);

          return {
            output: formatShellOutput(stdout, stderr, maxOutputChars),
            workingDirectory: path.relative(workspaceRoot, cwd) || ".",
          };
        }

        throw error;
      }
    },
  });
}
