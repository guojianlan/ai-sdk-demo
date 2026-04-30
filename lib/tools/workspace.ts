import { z } from "zod";

import { defineTool } from "@/lib/tooling";
import {
  listWorkspaceEntries,
  readWorkspaceFile,
  searchWorkspace,
} from "@/lib/workspaces";

/**
 * 工作区只读工具集 —— list_files / search_code / read_file。
 *
 * 全部 `kind: "readonly"`：抽象层永不审批，业务直接专注 IO 逻辑。
 */

export const listFilesTool = defineTool({
  name: "list_files",
  kind: "readonly",
  displayName: "list files",
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
  execute: async ({ depth, limit, relativePath }, { workspace }) => {
    const entries = await listWorkspaceEntries(
      workspace.root,
      relativePath,
      depth,
      limit,
    );
    return { workspaceRoot: workspace.root, relativePath, entries };
  },
});

export const searchCodeTool = defineTool({
  name: "search_code",
  kind: "readonly",
  displayName: "search code",
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
  execute: async ({ glob, maxResults, query }, { workspace }) => {
    const matches = await searchWorkspace(
      workspace.root,
      query,
      maxResults,
      glob,
    );
    return { workspaceRoot: workspace.root, query, matches };
  },
});

export const readFileTool = defineTool({
  name: "read_file",
  kind: "readonly",
  displayName: "read file",
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
  execute: async ({ maxChars, relativePath }, { workspace }) => {
    return readWorkspaceFile(workspace.root, relativePath, maxChars);
  },
});

export const workspaceTools = [listFilesTool, searchCodeTool, readFileTool];
