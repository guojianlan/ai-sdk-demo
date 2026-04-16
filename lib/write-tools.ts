import { promises as fs } from "node:fs";
import path from "node:path";

import { tool } from "ai";
import { z } from "zod";

import { resolveWorkspacePath } from "@/lib/workspaces";
import {
  getBypassPermissions,
  getWorkspaceToolContext,
} from "@/lib/workspace-tools";

/**
 * 批准策略回调：
 * - `bypassPermissions === true` → 返回 false → 不需要用户确认，直接执行
 * - 其它情况（包括 undefined） → 返回 true → 弹 approval 卡片
 *
 * 这是一个简单的全局开关。未来想做"条件式批准"——比如只对
 * `node_modules/` / `.git/` 下的写入强制要求批准——可以在这里叠加更多判断。
 */
async function requireApprovalUnlessBypassed(
  _input: unknown,
  { experimental_context }: { experimental_context?: unknown },
) {
  return !getBypassPermissions(experimental_context);
}

/**
 * 写入工具的设计目标：
 * - 所有改动都通过 `needsApproval` 让用户在 UI 上亲自点同意。
 * - 路径解析统一复用 `resolveWorkspacePath`，拒绝任何 ".." 逃逸。
 * - Zod 描述文案强调"先读后改"，降低模型误改的概率。
 *
 * 注意：两个工具的 execute 只会在用户点"同意"之后才会被触发，
 * 因此里面不做额外的审批判断，而是把判断完全交给 AI SDK 的 approval 机制。
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

export const writeFileTool = tool({
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
  needsApproval: requireApprovalUnlessBypassed,
  execute: async (
    { content, relativePath },
    { experimental_context },
  ) => {
    const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
    const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
    const previous = await readFileIfExists(absolutePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    return {
      ok: true,
      path: path.relative(workspaceRoot, absolutePath) || relativePath,
      operation: previous === null ? "created" : "overwritten",
      bytesWritten: Buffer.byteLength(content, "utf8"),
      lines: countLines(content),
      previousLines: previous === null ? 0 : countLines(previous),
    } as const;
  },
});

export const editFileTool = tool({
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
  needsApproval: requireApprovalUnlessBypassed,
  execute: async (
    { newString, oldString, relativePath, replaceAll = false },
    { experimental_context },
  ) => {
    const { workspaceRoot } = getWorkspaceToolContext(experimental_context);
    const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);

    if (oldString === newString) {
      return {
        ok: false,
        error: "oldString and newString are identical; nothing to do.",
      } as const;
    }

    const previous = await readFileIfExists(absolutePath);

    if (previous === null) {
      return {
        ok: false,
        error: `File not found: ${relativePath}. Use write_file to create a new file.`,
      } as const;
    }

    if (!previous.includes(oldString)) {
      return {
        ok: false,
        error:
          "oldString was not found. Check whitespace/indentation and ensure the text matches read_file output byte-for-byte.",
      } as const;
    }

    const occurrences = previous.split(oldString).length - 1;

    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        error: `oldString matched ${occurrences} times. Provide more surrounding context to make it unique, or pass replaceAll: true.`,
        occurrences,
      } as const;
    }

    const nextContent = replaceAll
      ? previous.split(oldString).join(newString)
      : previous.replace(oldString, newString);

    await fs.writeFile(absolutePath, nextContent, "utf8");

    const matchIndex = previous.indexOf(oldString);
    const startLine = previous.slice(0, matchIndex).split("\n").length;

    return {
      ok: true,
      path: path.relative(workspaceRoot, absolutePath) || relativePath,
      operation: "edited",
      replacements: replaceAll ? occurrences : 1,
      startLine,
      removedLines: countLines(oldString),
      addedLines: countLines(newString),
    } as const;
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
