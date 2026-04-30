import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { defineTool } from "@/lib/tooling";

const execFileAsync = promisify(execFile);

/**
 * `run_lint` —— bug-fix 工作流 verify 节点专用的最小 shell 工具。
 *
 * 设计取舍：
 * - **不开放任意 shell**：MVP 只允许 `npm run lint`，命令硬编码——审批粒度清晰。
 * - **`kind: "shell"`**：抽象层默认按 bypass 决定是否审批；workflow 的 verify
 *   节点会通过 `bypassPermissions: true` 自动跳过弹卡。
 * - **超时 60s / 输出截断 8KB**：lint 通常几秒；超时 = 出问题；输出过长会撑爆 LLM context。
 */

const LINT_OUTPUT_MAX_CHARS = 8000;
const LINT_TIMEOUT_MS = 60_000;

function truncate(text: string): { value: string; truncated: boolean } {
  if (text.length <= LINT_OUTPUT_MAX_CHARS)
    return { value: text, truncated: false };
  return {
    value: `${text.slice(0, LINT_OUTPUT_MAX_CHARS)}\n[output truncated]`,
    truncated: true,
  };
}

export const runLintTool = defineTool({
  name: "run_lint",
  kind: "shell",
  displayName: "run lint",
  description: [
    "Run `npm run lint` in the selected workspace and return the result.",
    "",
    "WHEN TO USE:",
    "- After applying code changes, to verify that the workspace still passes lint.",
    "- As a sanity check before reporting a fix as complete.",
    "",
    "WHEN NOT TO USE:",
    "- For arbitrary shell commands — this tool only runs `npm run lint`.",
    "- For type-checking or running tests — those need separate tools.",
    "",
    "OUTPUT:",
    "- Returns `{ passed: boolean, exitCode: number, output: string, truncated: boolean }`.",
    "- `output` combines stdout + stderr; long output is truncated to keep token usage reasonable.",
  ].join("\n"),
  inputSchema: z.object({
    reason: z
      .string()
      .optional()
      .describe(
        "Optional human-readable reason for running lint (shown in approval UI).",
      ),
  }),
  execute: async (_input, { workspace }) => {
    try {
      const result = await execFileAsync("npm", ["run", "lint"], {
        cwd: workspace.root,
        timeout: LINT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 4,
      });
      const { value, truncated } = truncate(
        `${result.stdout}\n${result.stderr}`.trim(),
      );
      return { passed: true, exitCode: 0, output: value, truncated };
    } catch (error) {
      // execFile reject 形态：error 上挂 stdout / stderr / code（exitCode）/ killed。
      const exec = error as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      if (exec.killed) {
        // 真正的"异常"：超时——抛出去让抽象层包成 toolErr。
        throw new Error(`lint timed out after ${LINT_TIMEOUT_MS / 1000}s`);
      }
      // "lint 失败"是预期可能的业务结果：返结构化 `passed: false` 让模型理解。
      const exitCode = typeof exec.code === "number" ? exec.code : 1;
      const { value, truncated } = truncate(
        `${exec.stdout ?? ""}\n${exec.stderr ?? ""}`.trim(),
      );
      return { passed: false, exitCode, output: value, truncated };
    }
  },
});

export const lintTools = [runLintTool];
