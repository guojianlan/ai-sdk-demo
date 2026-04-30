import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "@/lib/tooling";
import { resolveWorkspacePath } from "@/lib/workspaces";

/**
 * 写入工具集 —— write_file / edit_file。
 *
 * 用 `defineTool({ kind: "mutating", ... })`：抽象层自动按 bypassPermissions 决定
 * 是否弹审批，自动把抛错包成 `{ ok: false, error }`，业务永远不再调
 * `getWorkspaceToolContext` / `toolOk` / `toolErr`。
 */

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

async function readFileIfExists(absolutePath: string): Promise<string | null> {
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

// ---------- write_file ----------

export const writeFileTool = defineTool({
  name: "write_file",
  kind: "mutating",
  displayName: "write file",
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
  inputSchema: z.object({
    relativePath: z
      .string()
      .min(1)
      .describe(
        "File path relative to the workspace root, e.g. 'README.md' or 'lib/util.ts'.",
      ),
    content: z
      .string()
      .describe(
        "Full UTF-8 content to write. Will overwrite the file entirely.",
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "Short, human-readable reason for this write. Shown in the approval UI.",
      ),
  }),
  execute: async ({ content, relativePath }, { workspace }) => {
    const absolutePath = resolveWorkspacePath(workspace.root, relativePath);
    const previous = await readFileIfExists(absolutePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    return {
      path: path.relative(workspace.root, absolutePath) || relativePath,
      operation: (previous === null ? "created" : "overwritten") as
        | "created"
        | "overwritten",
      bytesWritten: Buffer.byteLength(content, "utf8"),
      lines: countLines(content),
      previousLines: previous === null ? 0 : countLines(previous),
    };
  },
});

// ---------- edit_file ----------

export const editFileTool = defineTool({
  name: "edit_file",
  kind: "mutating",
  displayName: "edit file",
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
  inputSchema: z.object({
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
  }),
  execute: async (
    { newString, oldString, relativePath, replaceAll = false },
    { workspace },
  ) => {
    const absolutePath = resolveWorkspacePath(workspace.root, relativePath);

    // 业务级"非异常失败"：业务直接 throw，让抽象层包成 error；模型看 error 字段
    // 就明白哪里出错。比包成 `{ ok: false, ... }` 简单。
    if (oldString === newString) {
      throw new Error("oldString and newString are identical; nothing to do.");
    }

    const previous = await readFileIfExists(absolutePath);
    if (previous === null) {
      throw new Error(
        `File not found: ${relativePath}. Use write_file to create a new file.`,
      );
    }
    if (!previous.includes(oldString)) {
      throw new Error(
        "oldString was not found. Check whitespace/indentation and ensure the text matches read_file output byte-for-byte.",
      );
    }

    const occurrences = previous.split(oldString).length - 1;
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `oldString matched ${occurrences} times. Provide more surrounding context to make it unique, or pass replaceAll: true. (occurrences: ${occurrences})`,
      );
    }

    const nextContent = replaceAll
      ? previous.split(oldString).join(newString)
      : previous.replace(oldString, newString);

    await fs.writeFile(absolutePath, nextContent, "utf8");

    const matchIndex = previous.indexOf(oldString);
    const startLine = previous.slice(0, matchIndex).split("\n").length;

    return {
      path: path.relative(workspace.root, absolutePath) || relativePath,
      operation: "edited" as const,
      replacements: replaceAll ? occurrences : 1,
      startLine,
      removedLines: countLines(oldString),
      addedLines: countLines(newString),
    };
  },
});

export const writeTools = [writeFileTool, editFileTool];
