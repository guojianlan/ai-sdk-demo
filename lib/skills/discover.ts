import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  frontmatterToOptions,
  skillFrontmatterSchema,
  type SkillFrontmatter,
  type SkillMetadata,
} from "./types";

/**
 * Skill discovery —— 扫 `.agents/skills/<name>/SKILL.md`，解析 frontmatter，返回 metadata。
 *
 * 设计选择：
 * - 不引入 gray-matter / js-yaml 依赖。frontmatter 只用 key:value 简单格式，
 *   照搬 open-agents 那个 50 行 mini parser 就够了。
 * - skill 定义来自当前应用仓库的 `.agents/skills`，不是用户选择的 workspace，
 *   所以 discovery 直接用 fs/promises 读本仓文件，不走 workspace sandbox。
 * - 单层扫描：只看 `<root>/<skill-name>/SKILL.md`，不递归。避免误读子目录里
 *   的 `references/foo.md`。
 *
 * 参考：tmp/open-agents-main/packages/agent/skills/discovery.ts
 */

/** 跟 open-agents 对齐的内置命令名，skill 不能 shadow 这些（无法触发）。 */
const BUILTIN_COMMANDS = new Set(["model", "resume", "new"]);

/** SKILL.md 的两种文件名变体，大写优先。 */
const SKILL_FILENAMES = ["SKILL.md", "skill.md"] as const;

/**
 * 简易 YAML frontmatter parser。
 * 支持：`key: value` / `key: "quoted"` / `key: 'quoted'` / `key: true|false`
 * 不支持：multi-line / nested / list。
 *
 * 跟 open-agents discovery.ts:25-75 1:1 对齐。
 */
export function parseSkillFrontmatter(
  content: string,
): { success: true; data: SkillFrontmatter } | { success: false; error: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    return { success: false, error: "No frontmatter found" };
  }

  const yaml = match[1];
  const parsed: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value: string | boolean = trimmed.slice(colonIndex + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/\\'/g, "'");
    } else if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    }

    parsed[key] = value;
  }

  const result = skillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true, data: result.data };
}

async function findSkillFile(skillDir: string): Promise<string | null> {
  for (const filename of SKILL_FILENAMES) {
    const candidate = path.join(skillDir, filename);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * 扫指定目录列表里的 skill。每个 dir 下只看一层子目录里的 SKILL.md / skill.md。
 *
 * 重名处理：跨目录同名时**先到先得**（顺序按 `directories` 参数）。
 *
 * @param directories skills 根目录列表（多源时可传多个，本仓库只用 `.agents/skills`）
 * @returns 解析成功的 SkillMetadata 列表
 */
export async function discoverSkills(
  directories: string[],
): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];
  const seenNames = new Set<string>();

  for (const dir of directories) {
    let entries: Dirent<string>[];
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      entries = await fs.readdir(dir, {
        withFileTypes: true,
        encoding: "utf-8",
      });
    } catch {
      // 目录不存在 / 没权限，跳过
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(dir, entry.name);
      const skillFile = await findSkillFile(skillDir);
      if (!skillFile) continue;

      let content: string;
      try {
        content = await fs.readFile(skillFile, "utf-8");
      } catch {
        continue;
      }

      const result = parseSkillFrontmatter(content);
      if (!result.success) {
        // 不报死亡错误：skill 的存在不该把整个 chat 拖挂。打 warn 让开发者修。
        console.warn(
          `[skills] skipping ${skillFile}: invalid frontmatter — ${result.error}`,
        );
        continue;
      }

      const frontmatter = result.data;

      if (BUILTIN_COMMANDS.has(frontmatter.name.toLowerCase())) {
        console.warn(
          `[skills] skipping ${skillDir}: name "${frontmatter.name}" shadows builtin command.`,
        );
        continue;
      }

      const normalized = frontmatter.name.toLowerCase();
      if (seenNames.has(normalized)) {
        console.warn(
          `[skills] skipping ${skillDir}: duplicate skill name "${frontmatter.name}".`,
        );
        continue;
      }
      seenNames.add(normalized);

      skills.push({
        name: frontmatter.name,
        description: frontmatter.description,
        filePath: skillFile,
        dir: skillDir,
        options: frontmatterToOptions(frontmatter),
      });
    }
  }

  return skills;
}

/**
 * 默认 skill 根目录。CWD 相对：本仓库的 `.agents/skills`。
 * 如果以后要支持 user-level / org-level 多源，扩展这个数组即可。
 */
export function defaultSkillDirectories(): string[] {
  return [path.resolve(process.cwd(), ".agents/skills")];
}
