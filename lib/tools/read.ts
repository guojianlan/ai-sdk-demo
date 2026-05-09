import { z } from "zod";

import { env } from "@/lib/env";
import { approvedTool } from "@/lib/tool-helpers";
import { toolErr, toolOk } from "@/lib/tool-result";
import { isDotEnvFilePath, readWorkspaceFile } from "@/lib/workspaces";

import { getWorkspaceToolContext } from "./context";

/**
 * `read` —— 读工作区里某个文本文件，按字符截断防止把巨大文件吐回模型。
 *
 * 命名对齐 open-agents `tools/read.ts`（key: `read`）。
 *
 * 审批策略：默认免审批；命中 `.env` 系列文件时弹审批，避免模型不小心把
 * 凭据/密钥读进 transcript。对齐 open-agents `read.ts:30`。
 */
export const readTool = approvedTool({
  description:
    "Read a text file from the selected workspace. Use workspace-relative paths and inspect relevant files before answering project questions.",
  inputSchema: z.object({
    relativePath: z
      .string()
      .min(1)
      .describe("File path relative to the workspace root."),
    maxChars: z
      .number()
      .int()
      .min(1000)
      .max(30000)
      .default(12000)
      .describe("Maximum number of characters to return."),
  }),
  name: "read",
  getRuleContent: ({ relativePath }) => relativePath,
  getCwd: (ctx) => getWorkspaceToolContext(ctx).sandbox.workingDirectory,
  needsApproval: ({ relativePath }) =>
    env.dotEnvFileApproval && isDotEnvFilePath(relativePath),
  execute: async ({ maxChars, relativePath }, { experimental_context }) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    try {
      const file = await readWorkspaceFile(sandbox, relativePath, maxChars);
      return toolOk(file);
    } catch (error) {
      return toolErr(error);
    }
  },
});
