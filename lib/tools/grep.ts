import { tool } from "ai";
import { z } from "zod";

import { toolErr, toolOk } from "@/lib/tool-result";
import { searchWorkspace } from "@/lib/workspaces";

import { getWorkspaceToolContext } from "./context";

/**
 * `grep` —— 工作区文本搜索，优先 ripgrep，挂掉回退纯 Node 实现。
 *
 * 命名对齐 open-agents `tools/grep.ts`（key: `grep`）。
 */
export const grepTool = tool({
  description:
    "Search text across the selected workspace. Useful for locating symbols, routes, configs, and feature-specific code.",
  inputSchema: z.object({
    query: z.string().min(1).describe("The text or symbol to search for."),
    glob: z
      .string()
      .optional()
      .describe("Optional glob such as '*.ts' or 'app/**'."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum number of matches to return."),
  }),
  execute: async ({ glob, maxResults, query }, { experimental_context }) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    try {
      const matches = await searchWorkspace(sandbox, query, maxResults, glob);
      return toolOk({
        workspaceRoot: sandbox.workingDirectory,
        query,
        matches,
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});
