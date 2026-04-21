import { tool } from "ai";
import { z } from "zod";

import { toolErr, toolOk } from "@/lib/tool-result";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  searchWorkspace,
} from "@/lib/workspaces";

/**
 * 这些字段是工作区相关工具运行时所依赖的最小上下文。
 * 只要 context 中包含这两个字段，就可以复用同一套工具实现。
 */
export type WorkspaceToolContext = {
  workspaceRoot: string;
  workspaceName: string;
};

export function getWorkspaceToolContext(
  context: unknown,
): WorkspaceToolContext {
  if (
    typeof context !== "object" ||
    context === null ||
    !("workspaceRoot" in context) ||
    !("workspaceName" in context)
  ) {
    throw new Error("Workspace tool context is missing for this request.");
  }

  return context as WorkspaceToolContext;
}

/**
 * 读取会话级 bypass 标志。
 *
 * 这个字段是 per-session 的"自动批准开关"。路由层会把它塞进 `experimental_context`，
 * 写入工具的 `needsApproval` 回调据此决定"这次是不是还要弹批准卡片"。
 *
 * 任意缺失 / 类型错误一律当作 false —— 默认行为始终是需要批准，
 * 所以就算客户端没传这个字段或者把它写错了，也不会意外绕过用户授权。
 */
export function getBypassPermissions(context: unknown): boolean {
  if (
    typeof context !== "object" ||
    context === null ||
    !("bypassPermissions" in context)
  ) {
    return false;
  }

  const value = (context as { bypassPermissions: unknown }).bypassPermissions;

  return value === true;
}

/**
 * 工作区工具全部运行在本地服务端，并严格限制在选中的 workspaceRoot 下。
 * 这套工具适合稳定、可控地读取本地代码仓库。
 */
export const workspaceToolset = {
  list_files: tool({
    description:
      "List files and directories inside the selected workspace. Use this first to understand the project layout.",
    inputSchema: z.object({
      relativePath: z
        .string()
        .default(".")
        .describe("Directory path relative to the workspace root."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(4)
        .default(2)
        .describe("How many directory levels to traverse."),
      limit: z
        .number()
        .int()
        .min(20)
        .max(400)
        .default(120)
        .describe("Maximum number of entries to return."),
    }),
    execute: async ({ depth, limit, relativePath }, { experimental_context }) => {
      const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
      try {
        const entries = await listWorkspaceEntries(
          workspaceRoot,
          relativePath,
          depth,
          limit,
        );
        return toolOk({ workspaceRoot, relativePath, entries });
      } catch (error) {
        return toolErr(error);
      }
    },
  }),
  search_code: tool({
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
      const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
      try {
        const matches = await searchWorkspace(
          workspaceRoot,
          query,
          maxResults,
          glob,
        );
        return toolOk({ workspaceRoot, query, matches });
      } catch (error) {
        return toolErr(error);
      }
    },
  }),
  read_file: tool({
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
      const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
      try {
        const file = await readWorkspaceFile(
          workspaceRoot,
          relativePath,
          maxChars,
        );
        return toolOk(file);
      } catch (error) {
        return toolErr(error);
      }
    },
  }),
};
