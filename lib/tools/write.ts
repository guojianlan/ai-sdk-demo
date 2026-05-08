import path from "node:path";

import { z } from "zod";

import { env } from "@/lib/env";
import type { Sandbox } from "@/lib/sandbox/interface";
import { approvedTool } from "@/lib/tool-helpers";
import { toolErr, toolOk } from "@/lib/tool-result";
import { isDotEnvFilePath, resolveWorkspacePath } from "@/lib/workspaces";

import { getWorkspaceToolContext } from "./context";

/**
 * `write` + `edit` —— 写入工具。命名对齐 open-agents `tools/write.ts`，
 * 一个文件 export 两个工具（write 整文件覆盖，edit search-replace）。
 *
 * 审批策略：默认免审批（跟 open-agents / codex 对齐：普通写文件不弹卡，直接落盘）。
 * 例外——命中 `.env` 系列文件时强制弹审批，避免模型不小心写入/覆盖凭据文件
 * （对齐 open-agents `write.ts:44, 148`）。
 *
 * 其它安全靠两条：
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

function splitDiffLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function truncateDiff(diff: string, maxLines = 240): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) {
    return diff;
  }
  return [
    ...lines.slice(0, maxLines),
    `... diff truncated (${lines.length - maxLines} more lines)`,
  ].join("\n");
}

function buildContentDiff(filePath: string, before: string, after: string) {
  if (before === after) {
    return "";
  }

  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const contextBefore = Math.min(prefix, 3);
  const oldStart = prefix - contextBefore;
  const newStart = prefix - contextBefore;
  const oldEnd = beforeLines.length - suffix;
  const newEnd = afterLines.length - suffix;
  const contextAfter = Math.min(suffix, 3);

  const oldRangeCount = oldEnd - oldStart + contextAfter;
  const newRangeCount = newEnd - newStart + contextAfter;
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart + 1},${Math.max(oldRangeCount, 0)} +${newStart + 1},${Math.max(newRangeCount, 0)} @@`,
  ];

  for (const line of beforeLines.slice(oldStart, prefix)) {
    lines.push(` ${line}`);
  }
  for (const line of beforeLines.slice(prefix, oldEnd)) {
    lines.push(`-${line}`);
  }
  for (const line of afterLines.slice(prefix, newEnd)) {
    lines.push(`+${line}`);
  }
  for (const line of beforeLines.slice(oldEnd, oldEnd + contextAfter)) {
    lines.push(` ${line}`);
  }

  return truncateDiff(lines.join("\n"));
}

async function getGitDiffForPath(
  sandbox: Sandbox,
  relativePath: string,
): Promise<string | null> {
  const result = await sandbox.exec(
    `git diff --no-ext-diff --no-color -- ${shellQuote(relativePath)}`,
    sandbox.workingDirectory,
    10_000,
  );

  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    return null;
  }

  return truncateDiff(result.stdout.trimEnd());
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

export const writeTool = approvedTool({
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
    "- Never write files that contain secrets (.env, credentials, api keys); writes to `.env*` paths require explicit user approval.",
  ].join("\n"),
  inputSchema: writeInputSchema,
  needsApproval: ({ relativePath }) =>
    env.dotEnvFileApproval && isDotEnvFilePath(relativePath),
  execute: async ({ content, relativePath }, { experimental_context }) => {
    const { sandbox } = getWorkspaceToolContext(experimental_context);
    const workspaceRoot = sandbox.workingDirectory;
    try {
      const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
      const previous = await readFileIfExists(sandbox, absolutePath);

      await sandbox.mkdir(path.dirname(absolutePath), { recursive: true });
      await sandbox.writeFile(absolutePath, content, "utf-8");
      const relativeOutputPath =
        path.relative(workspaceRoot, absolutePath) || relativePath;
      const gitDiff = await getGitDiffForPath(sandbox, relativeOutputPath);
      const contentDiff = buildContentDiff(
        relativeOutputPath,
        previous ?? "",
        content,
      );

      return toolOk({
        path: relativeOutputPath,
        operation: (previous === null ? "created" : "overwritten") as
          | "created"
          | "overwritten",
        bytesWritten: Buffer.byteLength(content, "utf8"),
        lines: countLines(content),
        previousLines: previous === null ? 0 : countLines(previous),
        diff: gitDiff ?? contentDiff,
        diffSource: gitDiff ? "git" : "content",
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});

export const editTool = approvedTool({
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
    "- Edits to `.env*` paths require explicit user approval.",
  ].join("\n"),
  inputSchema: editInputSchema,
  needsApproval: ({ relativePath }) =>
    env.dotEnvFileApproval && isDotEnvFilePath(relativePath),
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
      const relativeOutputPath =
        path.relative(workspaceRoot, absolutePath) || relativePath;
      const gitDiff = await getGitDiffForPath(sandbox, relativeOutputPath);
      const contentDiff = buildContentDiff(
        relativeOutputPath,
        previous,
        nextContent,
      );

      const matchIndex = previous.indexOf(oldString);
      const startLine = previous.slice(0, matchIndex).split("\n").length;

      return toolOk({
        path: relativeOutputPath,
        operation: "edited" as const,
        replacements: replaceAll ? occurrences : 1,
        startLine,
        removedLines: countLines(oldString),
        addedLines: countLines(newString),
        diff: gitDiff ?? contentDiff,
        diffSource: gitDiff ? "git" : "content",
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});
