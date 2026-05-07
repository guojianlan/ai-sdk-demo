import { tool } from "ai";
import { z } from "zod";

import { toolErr, toolOk } from "@/lib/tool-result";
import { readWorkspaceFile } from "@/lib/workspaces";

import { getWorkspaceToolContext } from "./context";

/**
 * `read` —— 读工作区里某个文本文件，按字符截断防止把巨大文件吐回模型。
 *
 * 命名对齐 open-agents `tools/read.ts`（key: `read`）。
 */
export const readTool = tool({
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
