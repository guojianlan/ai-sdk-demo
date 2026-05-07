import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import type { Sandbox } from "@/lib/sandbox/interface";
import { toolErr, toolOk } from "@/lib/tool-result";
import { resolveWorkspacePath } from "@/lib/workspaces";

import { getWorkspaceToolContext } from "./context";

/**
 * `write` + `edit` —— 写入工具。命名对齐 open-agents `tools/write.ts`，
 * 一个文件 export 两个工具（write 整文件覆盖，edit search-replace）。
 *
 * **不走审批**——跟 open-agents / codex 对齐：写文件不弹审批卡，直接落盘。
 * 安全靠两条：
 *   1. `resolveWorkspacePath` + LocalSandbox 内部校验，拒绝任何 ".." 逃逸；
 *   2. 用户事后通过 git status / chat 历史 review 改了什么。
 * 真正需要审批的副作用集中在 `shell` 工具——那里走 `approvedTool` + 配置化的
 * shellApprovalPolicy。
 */

const writeInputSchema = z.object({
  relativePath: z
    .string()
    .min(1)
    .describe(
      "File path relative to the workspace root, e.g. 'README.md' or 'lib/util.ts'.",
    ),
  content: z
    .string()
    .describe("Full UTF-8 content to write. Will overwrite the file entirely."),
});

const editInputSchema = z.object({
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
});

function countLines(text: string) {
  if (text.length === 0) {
    return 0;
  }

  return text.split("\n").length;
}

async function readFileIfExists(sandbox: Sandbox, absolutePath: string) {
  try {
    return await sandbox.readFile(absolutePath, "utf-8");
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

export const writeTool = tool({
  description: [
    "Write UTF-8 content to a workspace file. Overwrites the file entirely if it exists; creates it (with parent directories) otherwise.",
    "",
    "WHEN TO USE:",
    "- Creating a new file that does not yet exist.",
    "- Completely replacing the contents of a small/medium file after reading it.",
    "- Generating code or configuration from scratch for a task.",
    "",
    "WHEN NOT TO USE:",
    "- Small, localized edits inside an existing file (prefer `edit`).",
    "- Reading files (use `read`).",
    "",
    "IMPORTANT:",
    "- Always read the file first with `read` before overwriting it.",
    "- Never proactively create docs (*.md) unless the user explicitly asks.",
    "- Never write files that contain secrets (.env, credentials, api keys).",
  ].join("\n"),
  inputSchema: writeInputSchema,
  execute: async ({ content, relativePath }, { experimental_context }) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    const workspaceRoot = sandbox.workingDirectory;
    try {
      const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
      const previous = await readFileIfExists(sandbox, absolutePath);

      await sandbox.mkdir(path.dirname(absolutePath), { recursive: true });
      await sandbox.writeFile(absolutePath, content, "utf-8");

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

export const editTool = tool({
  description: [
    "Replace an exact text fragment inside an existing workspace file (search-replace).",
    "",
    "WHEN TO USE:",
    "- Small, precise edits to an existing file you have already read.",
    "- Renaming a symbol within a single file (use `replaceAll: true`).",
    "- Changing a specific block that matches byte-for-byte what `read` returned.",
    "",
    "WHEN NOT TO USE:",
    "- Creating new files (use `write`).",
    "- Large structural rewrites (use `write`).",
    "- Multi-file refactors (call this tool multiple times, once per file).",
    "",
    "USAGE:",
    "- `oldString` must match EXACTLY, including indentation and trailing whitespace.",
    "- By default `oldString` must appear exactly once; otherwise set `replaceAll: true`.",
    "- Never include line-number prefixes (`42: `) from the read output.",
  ].join("\n"),
  inputSchema: editInputSchema,
  execute: async (
    { newString, oldString, relativePath, replaceAll = false },
    { experimental_context },
  ) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    const workspaceRoot = sandbox.workingDirectory;
    try {
      const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);

      if (oldString === newString) {
        return toolErr("oldString and newString are identical; nothing to do.");
      }

      const previous = await readFileIfExists(sandbox, absolutePath);

      if (previous === null) {
        return toolErr(
          `File not found: ${relativePath}. Use write to create a new file.`,
        );
      }

      if (!previous.includes(oldString)) {
        return toolErr(
          "oldString was not found. Check whitespace/indentation and ensure the text matches read output byte-for-byte.",
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

      await sandbox.writeFile(absolutePath, nextContent, "utf-8");

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
