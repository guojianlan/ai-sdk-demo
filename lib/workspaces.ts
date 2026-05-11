import { promises as fs } from "node:fs";
import path from "node:path";

import { rgPath } from "@vscode/ripgrep";

import { env } from "@/lib/env";
import { truncateMiddle } from "@/lib/output-truncation";
import type { Sandbox } from "@/lib/sandbox/interface";

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
  return env.workspaceBaseDir;
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
 * 检测路径是否指向 `.env` 系列文件（`.env`、`.env.local`、`.env.production`、`.envrc`…）。
 *
 * 命名对齐 open-agents `tools/path-security.ts:isDotEnvFilePath`。
 * 用途：read/write/edit 工具在 `needsApproval` 里调用——命中 → 弹审批，
 * 让用户对"模型读/写敏感文件"有最后一道确认。**不是硬拒绝**，因为有些场景
 * 用户确实想看 .env.example、修 .env.local 等。
 *
 * 只看 basename，跨目录都管：`config/.env.local` 也会命中。
 */
export function isDotEnvFilePath(filePath: string): boolean {
  const basename = path
    .basename(filePath.replaceAll("\\", "/"))
    .toLowerCase();
  return basename.startsWith(".env");
}

/**
 * 从工作区读取 UTF-8 文本文件，并通过字符上限控制返回体积，
 * 让工具结果保持在模型和流式 UI 都能承受的范围内。
 *
 * P5: 改走 sandbox.readFile。
 *
 * 二进制检测的妥协：sandbox.readFile 只返回 string（utf-8 解码后）。原本用
 * `buffer.subarray(0, 1024).includes(0)` 检 NUL 字节，现在只能检字符串里的
 * `\u0000`——utf-8 解码会把 0x00 字节保留为 U+0000 字符，所以对二进制文件
 * 仍然能命中（首 1024 字符里通常会有）。比 buffer 检测稍弱但够用。
 */
export async function readWorkspaceFile(
  sandbox: Sandbox,
  relativePath: string,
  maxChars = 16000,
) {
  const workspaceRoot = sandbox.workingDirectory;
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const content = await sandbox.readFile(absolutePath, "utf-8");

  const maybeBinary = content.slice(0, 1024).includes("\u0000");

  if (maybeBinary) {
    return {
      path: path.relative(workspaceRoot, absolutePath),
      content:
        "[Binary file omitted. Ask for a different text file or inspect a related source file.]",
      truncated: false,
      totalChars: 0,
    };
  }

  // codex 风格 middle-truncate：超 maxChars 时保留头+尾，中间换成
  // `[... N bytes omitted ...]` —— 重要尾部信息（文件末尾的 export、
  // 错误堆栈最后一帧等）不会被砍掉。之前用 `slice(0, maxChars) + [truncated]`
  // 头部截断，对长源文件不友好。
  const truncated = content.length > maxChars;
  return {
    path: path.relative(workspaceRoot, absolutePath),
    content: truncated ? truncateMiddle(content, maxChars) : content,
    truncated,
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
 * 当 ripgrep 二进制找不到时（`spawn rg ENOENT`），就用这个实现。
 * 性能不如 rg，但胜在零外部依赖。
 *
 * P5: 改走 sandbox.readdir / sandbox.stat / sandbox.readFile。二进制检测同
 * `readWorkspaceFile`：靠字符串里的 `\u0000` 命中（utf-8 保留 NUL 字节）。
 *
 * 策略：
 * - 递归遍历 workingDirectory，跳过 IGNORED_DIRECTORY_NAMES 里的目录
 * - smart-case：query 里有大写字母 → 大小写敏感；否则忽略大小写
 * - 每个文件最多 1 个匹配（mimic rg 的 --max-count=1 per-file 风格，让结果在多个文件上铺开）
 * - 单文件 > 1MB 或首 1024 字符里有 NUL → 当作二进制跳过
 * - 命中 `maxResults` 就提前 return，不跑完全盘
 */
async function searchWorkspaceWithNode(
  sandbox: Sandbox,
  query: string,
  maxResults: number,
  glob?: string,
): Promise<WorkspaceSearchResult[]> {
  const workspaceRoot = sandbox.workingDirectory;
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

    let entries: Awaited<ReturnType<typeof sandbox.readdir>>;
    try {
      entries = await sandbox.readdir(dir, { withFileTypes: true });
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

      let content: string;
      try {
        const stats = await sandbox.stat(full);
        if (stats.size > 1024 * 1024) {
          continue;
        }
        content = await sandbox.readFile(full, "utf-8");
      } catch {
        continue;
      }

      if (content.slice(0, 1024).includes("\u0000")) {
        continue;
      }

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
 * 单引号 shell 转义：用 `'foo'\\''bar'` 模式包裹任意字符串，绝对安全。
 * 用于把 rgPath / query / glob 拼成单条 command 字符串喂给 sandbox.exec。
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export type WorkspaceGlobMatch = {
  path: string;
  size: number;
  modifiedAt: string;
};

/**
 * 按 glob pattern 找文件（对齐 open-agents `glob` 工具的语义）。
 *
 * - pattern 用 globToRegex 解析（支持 `*` / `**` / 字面量），匹配 path-relative-to-baseDir
 * - 跳过隐藏文件 + IGNORED_DIRECTORY_NAMES
 * - 按 mtime 降序排序，截到 limit 条
 * - 只返回 file，不返回 directory（跟 open-agents 一致：找文件用 glob，列目录另说）
 */
export async function globWorkspace(
  sandbox: Sandbox,
  pattern: string,
  basePath = ".",
  limit = 100,
): Promise<WorkspaceGlobMatch[]> {
  const workspaceRoot = sandbox.workingDirectory;
  const baseAbsolute = resolveWorkspacePath(workspaceRoot, basePath);
  const regex = globToRegex(pattern);
  const matches: { absolutePath: string; size: number; mtimeMs: number }[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof sandbox.readdir>>;
    try {
      entries = await sandbox.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (shouldIgnoreEntry(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const relToBase = path.relative(baseAbsolute, full);
      if (!regex.test(relToBase)) continue;

      try {
        const stats = await sandbox.stat(full);
        matches.push({
          absolutePath: full,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        });
      } catch {
        // permission/race—skip
      }
    }
  }

  await walk(baseAbsolute);

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return matches.slice(0, Math.max(1, limit)).map((m) => ({
    path: path.relative(workspaceRoot, m.absolutePath),
    size: m.size,
    modifiedAt: new Date(m.mtimeMs).toISOString(),
  }));
}

/**
 * 代码搜索。
 * 优先用 ripgrep（中大型仓库上快得多），失败回落到纯 Node 实现（无外部依赖）。
 * sandbox.workingDirectory 固定作为 cwd / 遍历根，保证搜索范围始终限制在当前项目内。
 *
 * P5: 改走 sandbox.exec。command 字符串里的 query / glob 全部经 `shellQuote`，
 * 防止 model 把 shell metachar 注进搜索词。
 */
const RIPGREP_TIMEOUT_MS = 30_000;

export async function searchWorkspace(
  sandbox: Sandbox,
  query: string,
  maxResults = 20,
  glob?: string,
): Promise<WorkspaceSearchResult[]> {
  const workspaceRoot = sandbox.workingDirectory;
  const argParts = [
    shellQuote(rgPath),
    "--line-number",
    "--column",
    "--smart-case",
    "--hidden",
    "--glob",
    shellQuote("!.git"),
    "--glob",
    shellQuote("!node_modules"),
    "--glob",
    shellQuote("!.next"),
    "--glob",
    shellQuote("!dist"),
    "--glob",
    shellQuote("!build"),
    "--max-count",
    String(Math.max(1, Math.min(maxResults, 50))),
  ];

  if (glob) {
    argParts.push("--glob", shellQuote(glob));
  }

  argParts.push(shellQuote(query), ".");

  const command = argParts.join(" ");

  const result = await sandbox.exec(command, workspaceRoot, RIPGREP_TIMEOUT_MS);

  // rg 退出码 1 = 没命中，0 = 有命中，>1 = 错误。null = 进程级错误（spawn 失败 / timeout）。
  if (result.exitCode === 0) {
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
        if (!match) return null;
        return {
          path: match[1],
          line: Number(match[2]),
          column: Number(match[3]),
          preview: match[4].trim(),
        } satisfies WorkspaceSearchResult;
      })
      .filter((entry): entry is WorkspaceSearchResult => entry !== null);
  }

  if (result.exitCode === 1) {
    // rg "no matches" — 正常空结果。
    return [];
  }

  // 进程级错误：spawn 失败（rgPath 不存在 / postinstall 被防火墙挡）/ timeout / 其它。
  // @vscode/ripgrep 在 npm install 时把二进制放进 node_modules/，按理走不到这里。
  // 万一发生：兜底用 Node 实现，让搜索功能不至于整体挂掉。
  console.warn(
    `[searchWorkspace] ripgrep failed (exitCode=${result.exitCode}) — falling back to Node-based search. stderr: ${result.stderr.slice(0, 200)}`,
  );
  return searchWorkspaceWithNode(sandbox, query, maxResults, glob);
}
