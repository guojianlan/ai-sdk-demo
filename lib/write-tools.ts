import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { approvedTool } from "@/lib/tool-helpers";
import { toolErr, toolOk } from "@/lib/tool-result";
import { resolveWorkspacePath } from "@/lib/workspaces";
import {
  getBypassPermissions,
  getWorkspaceToolContext,
} from "@/lib/workspace-tools";

/**
 * 写入工具的设计目标：
 * - 所有改动都通过 approval 机制让用户在 UI 上亲自点同意。
 * - 路径解析统一复用 `resolveWorkspacePath`，拒绝任何 ".." 逃逸。
 * - Zod 描述文案强调"先读后改"，降低模型误改的概率。
 *
 * 实现细节：两个工具都走 `approvedTool`（见 lib/tool-helpers.ts），
 * `needsApproval` 的语义是"除非会话开了 bypassPermissions，否则一律要弹卡"。
 * execute 只在用户点同意之后才会跑，里面不用重复做审批判断。
 */

const writeFileInputSchema = z.object({
  relativePath: z
    .string()
    .min(1)
    .describe(
      "File path relative to the workspace root, e.g. 'README.md' or 'lib/util.ts'.",
    ),
  content: z
    .string()
    .describe("Full UTF-8 content to write. Will overwrite the file entirely."),
  reason: z
    .string()
    .optional()
    .describe(
      "Short, human-readable reason for this write. Shown in the approval UI.",
    ),
});

const editFileInputSchema = z.object({
  relativePath: z
    .string()
    .min(1)
    .describe(
      "File path relative to the workspace root. Read the file first before editing.",
    ),
  oldString: z
    .string()
    .min(1)
    .describe(
      "Exact text to replace, including whitespace and indentation. Must be unique in the file unless `replaceAll` is true.",
    ),
  newString: z
    .string()
    .describe("Replacement text. Must differ from `oldString`."),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence instead of requiring a unique match. Default: false.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Short, human-readable reason for this edit. Shown in the approval UI.",
    ),
});

function countLines(text: string) {
  if (text.length === 0) {
    return 0;
  }

  return text.split("\n").length;
}

async function readFileIfExists(absolutePath: string) {
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

export const writeFileTool = approvedTool({
  description: [
    "Write UTF-8 content to a workspace file. Overwrites the file entirely if it exists; creates it (with parent directories) otherwise.",
    "",
    "WHEN TO USE:",
    "- Creating a new file that does not yet exist.",
    "- Completely replacing the contents of a small/medium file after reading it.",
    "- Generating code or configuration from scratch for a task.",
    "",
    "WHEN NOT TO USE:",
    "- Small, localized edits inside an existing file (prefer `edit_file`).",
    "- Reading files (use `read_file`).",
    "",
    "IMPORTANT:",
    "- Always read the file first with `read_file` before overwriting it.",
    "- Never proactively create docs (*.md) unless the user explicitly asks.",
    "- Never write files that contain secrets (.env, credentials, api keys).",
    "- The user must approve every write in the UI; state your `reason` clearly.",
  ].join("\n"),
  inputSchema: writeFileInputSchema,
  needsApproval: (_input, ctx) => !getBypassPermissions(ctx),
  execute: async ({ content, relativePath }, { experimental_context }) => {
    const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
    try {
      const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
      const previous = await readFileIfExists(absolutePath);

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");

      return toolOk({
        path: path.relative(workspaceRoot, absolutePath) || relativePath,
        operation: (previous === null ? "created" : "overwritten") as
          | "created"
          | "overwritten",
        bytesWritten: Buffer.byteLength(content, "utf8"),
        lines: countLines(content),
        previousLines: previous === null ? 0 : countLines(previous),
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});

export const editFileTool = approvedTool({
  description: [
    "Replace an exact text fragment inside an existing workspace file (search-replace).",
    "",
    "WHEN TO USE:",
    "- Small, precise edits to an existing file you have already read.",
    "- Renaming a symbol within a single file (use `replaceAll: true`).",
    "- Changing a specific block that matches byte-for-byte what `read_file` returned.",
    "",
    "WHEN NOT TO USE:",
    "- Creating new files (use `write_file`).",
    "- Large structural rewrites (use `write_file`).",
    "- Multi-file refactors (call this tool multiple times, once per file).",
    "",
    "USAGE:",
    "- `oldString` must match EXACTLY, including indentation and trailing whitespace.",
    "- By default `oldString` must appear exactly once; otherwise set `replaceAll: true`.",
    "- Never include line-number prefixes (`42: `) from the read output.",
    "- The user must approve every edit in the UI; state your `reason` clearly.",
  ].join("\n"),
  inputSchema: editFileInputSchema,
  needsApproval: (_input, ctx) => !getBypassPermissions(ctx),
  execute: async (
    { newString, oldString, relativePath, replaceAll = false },
    { experimental_context },
  ) => {
    const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
    try {
      const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);

      if (oldString === newString) {
        return toolErr("oldString and newString are identical; nothing to do.");
      }

      const previous = await readFileIfExists(absolutePath);

      if (previous === null) {
        return toolErr(
          `File not found: ${relativePath}. Use write_file to create a new file.`,
        );
      }

      if (!previous.includes(oldString)) {
        return toolErr(
          "oldString was not found. Check whitespace/indentation and ensure the text matches read_file output byte-for-byte.",
        );
      }

      const occurrences = previous.split(oldString).length - 1;

      if (occurrences > 1 && !replaceAll) {
        return toolErr(
          `oldString matched ${occurrences} times. Provide more surrounding context to make it unique, or pass replaceAll: true. (occurrences: ${occurrences})`,
        );
      }

      const nextContent = replaceAll
        ? previous.split(oldString).join(newString)
        : previous.replace(oldString, newString);

      await fs.writeFile(absolutePath, nextContent, "utf8");

      const matchIndex = previous.indexOf(oldString);
      const startLine = previous.slice(0, matchIndex).split("\n").length;

      return toolOk({
        path: path.relative(workspaceRoot, absolutePath) || relativePath,
        operation: "edited" as const,
        replacements: replaceAll ? occurrences : 1,
        startLine,
        removedLines: countLines(oldString),
        addedLines: countLines(newString),
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});

/**
 * 带写入能力的完整工具集。
 * 把 readonly 和 write 保持在两个导出里，方便在不同 access mode 下灵活组合。
 */
export const writeToolset = {
  write_file: writeFileTool,
  edit_file: editFileTool,
};
