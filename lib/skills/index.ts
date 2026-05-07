export {
  discoverSkills,
  defaultSkillDirectories,
  parseSkillFrontmatter,
} from "./discover";
export { getSkills, invalidateSkillsCache } from "./cache";
// `skillTool` 已搬到 `lib/tools/skill.ts`（统一进 lib/tools/）。
// 通过 `lib/tools` barrel 取，或直接 `lib/tools/skill`。
export {
  extractSkillBody,
  frontmatterToOptions,
  skillFrontmatterSchema,
  substituteArguments,
  type SkillFrontmatter,
  type SkillMetadata,
  type SkillOptions,
} from "./types";
