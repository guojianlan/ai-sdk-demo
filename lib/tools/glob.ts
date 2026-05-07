import { tool } from "ai";
import { z } from "zod";

import { toolErr, toolOk } from "@/lib/tool-result";
import { globWorkspace } from "@/lib/workspaces";

import { getWorkspaceToolContext } from "./context";

/**
 * `glob` —— 按 pattern 找文件，按 mtime 降序返回（最近改的在前）。
 *
 * 命名对齐 open-agents `tools/glob.ts`（key: `glob`）。
 * 我们的实现走 `globWorkspace`（Node fs.readdir + glob → regex），不走 shell find
 * —— 比 open-agents 简单一点，对 Linux/macOS 行为一致。
 */
export const globTool = tool({
  description: [
    "Find files matching a glob pattern.",
    "",
    "WHEN TO USE:",
    "- Locating files by extension or naming pattern (e.g., all *.test.ts files).",
    "- Discovering where components, migrations, or configs live.",
    "- Getting a quick list of recently modified files of a given type.",
    "",
    "WHEN NOT TO USE:",
    "- Searching inside file contents (use `grep` instead).",
    "- Reading file contents (use `read` instead).",
    "",
    "USAGE:",
    "- Supports patterns like '**/*.ts', 'src/**/*.tsx', '*.json'.",
    "- Returns FILES (not directories) sorted by modification time (newest first).",
    "- Skips hidden files and common ignored directories (node_modules, .next, etc.).",
    "- If `path` is omitted the workspace root is used as the base.",
    "- Use workspace-relative paths.",
  ].join("\n"),
  inputSchema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe("Glob pattern to match (e.g., '**/*.ts')."),
    path: z
      .string()
      .optional()
      .describe(
        "Workspace-relative base directory to search from (default: workspace root).",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(400)
      .default(100)
      .describe("Maximum number of results."),
  }),
  execute: async ({ limit, path: basePath, pattern }, { experimental_context }) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    try {
      const files = await globWorkspace(sandbox, pattern, basePath ?? ".", limit);
      return toolOk({
        workspaceRoot: sandbox.workingDirectory,
        pattern,
        baseDir: basePath ?? ".",
        count: files.length,
        files,
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});
