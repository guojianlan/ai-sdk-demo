import { execFile } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { rgPath } from "@vscode/ripgrep";

const execFileAsync = promisify(execFile);

// 大型生成目录和依赖目录通常噪声很多，也会拖慢遍历速度。
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

export type WorkspaceDescriptor = {
  root: string;
  name: string;
  description: string;
  isCurrentProject: boolean;
};

export type WorkspaceEntry = {
  path: string;
  type: "file" | "directory";
  size: number | null;
};

export type WorkspaceSearchResult = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

/**
 * 工作区选择器从一个可配置的父目录开始扫描，
 * 这样可以枚举同级项目，而不用把机器相关路径写死在代码里。
 */
export function getWorkspaceBaseDir() {
  return process.env.WORKSPACE_BASE_DIR ?? path.resolve(process.cwd(), "..");
}

function getWorkspaceName(root: string) {
  return path.basename(root) || root;
}

function getWorkspaceDescription(root: string, isCurrentProject: boolean) {
  if (isCurrentProject) {
    return `当前运行中的项目：${root}`;
  }

  const baseDir = getWorkspaceBaseDir();
  const relative = path.relative(baseDir, root);

  if (relative && !relative.startsWith("..")) {
    return `位于 ${relative}`;
  }

  return root;
}

/**
 * 列出当前项目以及配置根目录下的同级目录。
 * 这个结果会在发起聊天请求之前用于“选择工作区”的界面。
 */
export async function listAvailableWorkspaces(): Promise<WorkspaceDescriptor[]> {
  const baseDir = getWorkspaceBaseDir();
  const currentProjectRoot = process.cwd();
  const workspaceMap = new Map<string, WorkspaceDescriptor>();

  workspaceMap.set(currentProjectRoot, {
    root: currentProjectRoot,
    name: getWorkspaceName(currentProjectRoot),
    description: getWorkspaceDescription(currentProjectRoot, true),
    isCurrentProject: true,
  });

  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const root = path.resolve(baseDir, entry.name);
      workspaceMap.set(root, {
        root,
        name: entry.name,
        description: getWorkspaceDescription(root, root === currentProjectRoot),
        isCurrentProject: root === currentProjectRoot,
      });
    }
  } catch {
    // Fall back to just the current project.
  }

  return [...workspaceMap.values()].sort((left, right) => {
    if (left.isCurrentProject && !right.isCurrentProject) {
      return -1;
    }

    if (!left.isCurrentProject && right.isCurrentProject) {
      return 1;
    }

    return left.name.localeCompare(right.name, "zh-CN");
  });
}

/**
 * 既支持绝对路径，也支持相对于工作区根目录的路径，
 * 然后统一校验目标是否存在且确实是目录。
 */
export async function normalizeWorkspaceRoot(input: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Workspace path is required.");
  }

  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(getWorkspaceBaseDir(), trimmed);

  const stats = await fs.stat(candidate).catch(() => null);

  if (!stats) {
    throw new Error(`Workspace does not exist: ${candidate}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${candidate}`);
  }

  return candidate;
}

/**
 * 将用户传入的相对路径解析到选中的工作区内部，
 * 并拒绝任何通过 ".." 逃逸工作区根目录的访问。
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  relativePath = ".",
) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, absolutePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path is outside the selected workspace.");
  }

  return absolutePath;
}

function shouldIgnoreEntry(name: string) {
  return IGNORED_DIRECTORY_NAMES.has(name);
}

/**
 * 用于 UI 和工具调用的受限目录遍历。
 * depth 和 limit 两个限制可以让返回结果更稳定，避免把大量无关内容塞给模型。
 */
export async function listWorkspaceEntries(
  workspaceRoot: string,
  relativePath = ".",
  depth = 2,
  limit = 200,
): Promise<WorkspaceEntry[]> {
  const results: WorkspaceEntry[] = [];
  const rootPath = resolveWorkspacePath(workspaceRoot, relativePath);

  async function walk(currentAbsolutePath: string, remainingDepth: number) {
    if (results.length >= limit) {
      return;
    }

    const stats = await fs.stat(currentAbsolutePath);

    if (stats.isFile()) {
      results.push({
        path: path.relative(workspaceRoot, currentAbsolutePath) || ".",
        type: "file",
        size: stats.size,
      });

      return;
    }

    const directoryEntries = await fs.readdir(currentAbsolutePath, {
      withFileTypes: true,
    });

    const sortedEntries = directoryEntries.sort((left, right) => {
      if (left.isDirectory() && !right.isDirectory()) {
        return -1;
      }

      if (!left.isDirectory() && right.isDirectory()) {
        return 1;
      }

      return left.name.localeCompare(right.name, "zh-CN");
    });

    for (const entry of sortedEntries) {
      if (results.length >= limit) {
        break;
      }

      if (shouldIgnoreEntry(entry.name)) {
        continue;
      }

      const nextAbsolutePath = path.join(currentAbsolutePath, entry.name);
      const nextRelativePath = path.relative(workspaceRoot, nextAbsolutePath);

      if (entry.isDirectory()) {
        results.push({
          path: nextRelativePath,
          type: "directory",
          size: null,
        });

        if (remainingDepth > 1) {
          await walk(nextAbsolutePath, remainingDepth - 1);
        }

        continue;
      }

      if (entry.isFile()) {
        const entryStats = await fs.stat(nextAbsolutePath);

        results.push({
          path: nextRelativePath,
          type: "file",
          size: entryStats.size,
        });
      }
    }
  }

  await walk(rootPath, Math.max(1, depth));

  return results;
}

/**
 * 从工作区读取 UTF-8 文本文件，并通过字符上限控制返回体积，
 * 让工具结果保持在模型和流式 UI 都能承受的范围内。
 */
export async function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  maxChars = 16000,
) {
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const buffer = await fs.readFile(absolutePath);
  const maybeBinary = buffer.subarray(0, 1024).includes(0);

  if (maybeBinary) {
    return {
      path: path.relative(workspaceRoot, absolutePath),
      content:
        "[Binary file omitted. Ask for a different text file or inspect a related source file.]",
      truncated: false,
      totalChars: 0,
    };
  }

  const content = buffer.toString("utf8");

  return {
    path: path.relative(workspaceRoot, absolutePath),
    content:
      content.length > maxChars ? `${content.slice(0, maxChars)}\n\n[truncated]` : content,
    truncated: content.length > maxChars,
    totalChars: content.length,
  };
}

/**
 * 简单的 glob → 正则转换。只处理搜索场景里常见的三种：
 * - `*` 匹配除 `/` 外任意字符
 * - `**` 跨目录匹配
 * - 其它元字符原样转义
 * 不追求 gitignore 级别的语义兼容——我们只是给 LLM 一个简单的过滤入口。
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^$()|[\]\\{}]/g, "\\$&");
  const withStars = escaped
    .replace(/\*\*\//g, "§§§GS§§§")
    .replace(/\*\*/g, "§§§GG§§§")
    .replace(/\*/g, "[^/]*");
  const restored = withStars
    .replace(/§§§GS§§§/g, "(?:.*/)?")
    .replace(/§§§GG§§§/g, ".*");
  return new RegExp(`^${restored}$`);
}

/**
 * 朴素的字符串转正则（用于把用户 query 当字面量搜）。
 */
function escapeLiteral(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 纯 Node 的代码搜索兜底。
 *
 * 当系统里没装 ripgrep 时（`spawn rg ENOENT`），就用这个实现。
 * 性能不如 rg，但胜在零外部依赖，开箱即用。
 *
 * 策略：
 * - 递归遍历 workspaceRoot，跳过 IGNORED_DIRECTORY_NAMES 里的目录
 * - smart-case：query 里有大写字母 → 大小写敏感；否则忽略大小写
 * - 每个文件最多 1 个匹配（mimic rg 的 --max-count=1 per-file 风格，让结果在多个文件上铺开）
 * - 单文件 > 1MB 或首 1KB 出现 NUL 字节 → 当作二进制跳过
 * - 命中 `maxResults` 就提前 return，不跑完全盘
 */
async function searchWorkspaceWithNode(
  workspaceRoot: string,
  query: string,
  maxResults: number,
  glob?: string,
): Promise<WorkspaceSearchResult[]> {
  const caseInsensitive = !/[A-Z]/.test(query);
  const pattern = new RegExp(
    escapeLiteral(query),
    caseInsensitive ? "i" : "",
  );
  const globRegex = glob ? globToRegex(glob) : null;
  const results: WorkspaceSearchResult[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) {
        return;
      }
      if (shouldIgnoreEntry(entry.name)) {
        continue;
      }

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relPath = path.relative(workspaceRoot, full);
      if (globRegex && !globRegex.test(relPath)) {
        continue;
      }

      let buffer: Buffer;
      try {
        const stats = await fs.stat(full);
        if (stats.size > 1024 * 1024) {
          continue;
        }
        buffer = await fs.readFile(full);
      } catch {
        continue;
      }

      // 朴素二进制检测：首 1KB 出现 NUL 字节则认为是二进制。
      if (buffer.subarray(0, Math.min(1024, buffer.length)).includes(0)) {
        continue;
      }

      const content = buffer.toString("utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = pattern.exec(lines[i]);
        if (!match) {
          continue;
        }
        results.push({
          path: relPath,
          line: i + 1,
          column: match.index + 1,
          preview: lines[i].slice(0, 200).trim(),
        });
        break; // 每个文件只记 1 条，尽量在不同文件之间铺开结果。
      }
    }
  }

  await walk(workspaceRoot);
  return results;
}

/**
 * 代码搜索。
 * 优先用 ripgrep（中大型仓库上快得多），失败回落到纯 Node 实现（无外部依赖）。
 * workspaceRoot 固定作为 cwd / 遍历根，保证搜索范围始终限制在当前项目内。
 */
export async function searchWorkspace(
  workspaceRoot: string,
  query: string,
  maxResults = 20,
  glob?: string,
): Promise<WorkspaceSearchResult[]> {
  const args = [
    "--line-number",
    "--column",
    "--smart-case",
    "--hidden",
    "--glob",
    "!.git",
    "--glob",
    "!node_modules",
    "--glob",
    "!.next",
    "--glob",
    "!dist",
    "--glob",
    "!build",
    "--max-count",
    String(Math.max(1, Math.min(maxResults, 50))),
  ];

  if (glob) {
    args.push("--glob", glob);
  }

  args.push(query, ".");

  try {
    // rgPath 由 @vscode/ripgrep 在 npm install 时下载到 node_modules 下，
    // 不依赖系统 PATH。任何拉下仓库的机器 npm install 后都能直接搜。
    const { stdout } = await execFileAsync(rgPath, args, {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024 * 4,
    });

    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/);

        if (!match) {
          return null;
        }

        return {
          path: match[1],
          line: Number(match[2]),
          column: Number(match[3]),
          preview: match[4].trim(),
        } satisfies WorkspaceSearchResult;
      })
      .filter((result): result is WorkspaceSearchResult => result !== null);
  } catch (error) {
    // rg 退出码 1 表示没命中，直接返回空。
    const numericCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : null;
    if (numericCode === 1) {
      return [];
    }

    // 按理说走不到这里 —— @vscode/ripgrep 在 npm install 时把二进制放到了 node_modules/。
    // 但万一 postinstall 下载被防火墙挡了 / 平台不支持 / 权限出问题，这个兜底能让
    // 搜索仍然工作，而不是整个对话链路报 500。
    const stringCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;
    if (stringCode === "ENOENT") {
      console.warn(
        "[searchWorkspace] @vscode/ripgrep binary not found at",
        rgPath,
        "— falling back to Node-based search. 检查 npm install 日志里有没有 postinstall 错误。",
      );
      return searchWorkspaceWithNode(workspaceRoot, query, maxResults, glob);
    }

    throw error;
  }
}
