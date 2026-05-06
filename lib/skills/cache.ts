import { defaultSkillDirectories, discoverSkills } from "./discover";
import type { SkillMetadata } from "./types";

/**
 * 进程内 skills 缓存。
 *
 * 现在为啥这么简单：
 * - 单进程 dev，磁盘扫一次就够了。
 * - 缓存的是 metadata（name + description + path），**不是 body**——body 永远
 *   按需读盘，避免 stale。
 * - 没引入 sessionId 维度：所有 session 共用同一份 skill 列表，省事。如果以后
 *   要按 workspace/用户隔离 skill，再加。
 *
 * 失效策略：进程重启自然失效。开发期改了 skill frontmatter 想立刻看到新结果，
 * 调 `invalidateSkillsCache()` 或重启 dev server。
 */

let cached: Promise<SkillMetadata[]> | null = null;

export function getSkills(): Promise<SkillMetadata[]> {
  if (!cached) {
    cached = discoverSkills(defaultSkillDirectories());
  }
  return cached;
}

export function invalidateSkillsCache(): void {
  cached = null;
}
