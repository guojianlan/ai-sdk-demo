import { promises as fs } from "node:fs";
import path from "node:path";

import { env } from "@/lib/env";

/**
 * Session primer —— 会话启动时塞给模型的"入场简报"。
 *
 * 设计照搬 codex（tmp/codex-main）的两块：
 * 1. <environment_context> XML 块：cwd / shell / date / timezone
 * 2. user_instructions：从项目根向下收集 AGENTS.md（及 override）并拼接
 *
 * 关键常量与行为都和 codex 对齐：
 * - 默认项目根 marker 是 `.git`
 * - 总预算上限 32 KiB（超出就按顺序截断）
 * - 文件名优先级：AGENTS.override.md > AGENTS.md > 额外 fallback
 * - 每个目录只取第一个匹配
 * - 收集顺序：project root → cwd（外层规则先，内层覆盖）
 *
 * 与 codex 的差异：
 * - codex 把 primer 作为 user role 消息注入（它的协议没有独立 system prompt）；
 *   我们放进 AI SDK 的 `instructions`（即 system prompt），语义等价、结构更简单。
 * - codex 是 Rust，这里是 TS；没有保留它的 sandbox / fs trait 抽象，直接用 node:fs。
 */

export const DEFAULT_PROJECT_ROOT_MARKERS = [".git"] as const;
export const DEFAULT_PROJECT_DOC_FILENAME = "AGENTS.md";
export const LOCAL_PROJECT_DOC_FILENAME = "AGENTS.override.md";
export const PROJECT_DOC_MAX_BYTES = 32 * 1024;

export type SessionPrimerOptions = {
  /** 工作区根目录（绝对路径）。 */
  workspaceRoot: string;
  /** 覆盖当前日期，便于测试 / 快照。ISO-8601 日期字符串。 */
  currentDate?: string;
  /** 覆盖时区名。默认读取当前运行环境。 */
  timezone?: string;
  /** 覆盖 shell 名（只取 basename）。默认读 $SHELL。 */
  shell?: string;
  /** 覆盖项目根 marker。空数组 = 禁用向上搜索（等价于 cwd 即 root）。 */
  projectRootMarkers?: readonly string[];
  /**
   * 覆盖候选文件名（按优先级）。默认顺序：
   *   AGENTS.override.md → AGENTS.md → 用户额外 fallback
   * 每个目录只会取到第一个命中的文件。
   */
  candidateFilenames?: readonly string[];
  /** 总预算（字节）。默认 32 KiB。传 0 禁用 user_instructions 收集。 */
  maxTotalBytes?: number;
};

export type SessionPrimerSource = {
  /** 文件绝对路径。 */
  absolutePath: string;
  /** 相对 workspaceRoot 的显示路径（用于 section header）。 */
  displayPath: string;
  /** 字节大小（截断前）。 */
  sizeBytes: number;
  /** 是否被截断。 */
  truncated: boolean;
};

export type SessionPrimer = {
  /** `<environment_context>…</environment_context>` XML 文本。 */
  environmentContext: string;
  /** 拼接好的 user_instructions 文本；没有任何 AGENTS.md 时为 null。 */
  userInstructions: string | null;
  /** 被使用的文档源（按收集顺序）。 */
  sources: SessionPrimerSource[];
  /** 合并后的完整字符串，可直接 prepend 到 system prompt。 */
  combined: string;
};

function currentDateIso() {
  return new Date().toISOString().slice(0, 10);
}

function detectShell() {
  return env.shellName;
}

function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * 构造 <environment_context> XML。
 * 手拼字符串而非用 XML 库，和 codex 同样的理由：字段少、结构固定、性能好。
 */
function buildEnvironmentContext(
  workspaceRoot: string,
  options: SessionPrimerOptions,
) {
  const shell = options.shell ?? detectShell();
  const currentDate = options.currentDate ?? currentDateIso();
  const timezone = options.timezone ?? detectTimezone();

  const lines = [
    "<environment_context>",
    `  <cwd>${workspaceRoot}</cwd>`,
    `  <shell>${shell}</shell>`,
    `  <current_date>${currentDate}</current_date>`,
    `  <timezone>${timezone}</timezone>`,
    "</environment_context>",
  ];

  return lines.join("\n");
}

/**
 * 从 cwd 向上找项目根 —— 第一个包含任意 marker 的目录即为根。
 * 找不到 → 返回 workspaceRoot 自身。
 * markers 为空数组时禁用向上搜索（等价于 cwd 即 root）。
 */
async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
): Promise<string> {
  if (markers.length === 0) {
    return cwd;
  }

  let dir = path.resolve(cwd);
  while (true) {
    for (const marker of markers) {
      try {
        await fs.stat(path.join(dir, marker));
        return dir;
      } catch {
        // marker not present, try next
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return cwd;
    }
    dir = parent;
  }
}

/**
 * 生成从 projectRoot 向下到 cwd（inclusive）的目录列表。
 * 顺序：project root 在前，cwd 在最后 —— 匹配 codex 的"外层规则先"语义。
 */
function walkDownDirs(projectRoot: string, cwd: string): string[] {
  const dirs: string[] = [];
  let cursor = path.resolve(cwd);
  const normalizedRoot = path.resolve(projectRoot);

  while (true) {
    dirs.unshift(cursor);
    if (cursor === normalizedRoot) {
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return dirs;
}

async function isRegularFile(filePath: string) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * 对每个目录按候选文件名顺序尝试，**每个目录只取一个命中**。
 * 返回按收集顺序排列的绝对路径数组。
 */
async function collectDocPaths(
  searchDirs: string[],
  candidateFilenames: readonly string[],
): Promise<string[]> {
  const found: string[] = [];

  for (const dir of searchDirs) {
    for (const filename of candidateFilenames) {
      const candidate = path.join(dir, filename);
      if (await isRegularFile(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }

  return found;
}

/**
 * 逐份读取 doc，按剩余预算截断。空白文档被跳过（trim 后为空）。
 */
async function readDocsWithBudget(
  paths: string[],
  workspaceRoot: string,
  maxTotalBytes: number,
): Promise<{ sources: SessionPrimerSource[]; sections: string[] }> {
  const sources: SessionPrimerSource[] = [];
  const sections: string[] = [];
  let remaining = maxTotalBytes;

  for (const absolutePath of paths) {
    if (remaining <= 0) {
      break;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absolutePath);
    } catch {
      continue;
    }

    const originalSize = buffer.length;
    let truncated = false;
    if (buffer.length > remaining) {
      buffer = buffer.subarray(0, remaining);
      truncated = true;
    }

    const text = buffer.toString("utf8");
    if (text.trim().length === 0) {
      continue;
    }

    const displayPath = path.relative(workspaceRoot, absolutePath) || ".";
    const header = `# AGENTS.md instructions for ${displayPath || path.basename(absolutePath)}`;
    sections.push(`${header}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`);

    sources.push({
      absolutePath,
      displayPath,
      sizeBytes: originalSize,
      truncated,
    });

    remaining -= buffer.length;
  }

  return { sources, sections };
}

export async function buildSessionPrimer(
  options: SessionPrimerOptions,
): Promise<SessionPrimer> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const markers = options.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS;
  const candidateFilenames = options.candidateFilenames ?? [
    LOCAL_PROJECT_DOC_FILENAME,
    DEFAULT_PROJECT_DOC_FILENAME,
  ];
  const maxTotalBytes = options.maxTotalBytes ?? PROJECT_DOC_MAX_BYTES;

  const environmentContext = buildEnvironmentContext(workspaceRoot, options);

  let userInstructions: string | null = null;
  let sources: SessionPrimerSource[] = [];

  if (maxTotalBytes > 0) {
    const projectRoot = await findProjectRoot(workspaceRoot, markers);
    const searchDirs = walkDownDirs(projectRoot, workspaceRoot);
    const docPaths = await collectDocPaths(searchDirs, candidateFilenames);
    const { sources: readSources, sections } = await readDocsWithBudget(
      docPaths,
      workspaceRoot,
      maxTotalBytes,
    );

    sources = readSources;
    if (sections.length > 0) {
      userInstructions = sections.join("\n\n");
    }
  }

  const combined = userInstructions
    ? `${environmentContext}\n\n${userInstructions}`
    : environmentContext;

  return {
    environmentContext,
    userInstructions,
    sources,
    combined,
  };
}
