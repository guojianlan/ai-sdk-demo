import { z } from "zod";

/**
 * Skill frontmatter schema —— 跟 open-agents 对齐，方便后续 sync。
 *
 * 字段语义：
 * - `name` / `description`：必填。`description` 直接进 system prompt 让 model 路由。
 * - `disable-model-invocation`：true 表示 model 不能主动调（仅 user 显式 "/x" 触发）。
 * - `user-invocable`：false 表示用户没法 slash command 触发；默认可被用户触发。
 * - `allowed-tools`：逗号分隔，激活该 skill 时声明它"可能"用到哪些 tool。
 *   当前**只解析、未强制**——跟 open-agents 当前状态一致。
 * - `context: "fork"` / `agent`：open-agents 留的扩展位，当前 unused。
 *
 * 参考：tmp/open-agents-main/packages/agent/skills/types.ts
 */
export const skillFrontmatterSchema = z.object({
  name: z.string().min(1, "Skill name cannot be empty"),
  description: z.string().min(1, "Skill description cannot be empty"),
  version: z.string().optional(),
  "disable-model-invocation": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
  "allowed-tools": z.string().optional(),
  context: z.enum(["fork"]).optional(),
  agent: z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

/** 从 frontmatter 派生的运行期 options（kebab → camel）。 */
export interface SkillOptions {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  context?: "fork";
  agent?: string;
}

export function frontmatterToOptions(
  frontmatter: SkillFrontmatter,
): SkillOptions {
  return {
    disableModelInvocation: frontmatter["disable-model-invocation"],
    userInvocable: frontmatter["user-invocable"],
    allowedTools: frontmatter["allowed-tools"]
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    context: frontmatter.context,
    agent: frontmatter.agent,
  };
}

/**
 * 进 system prompt + skill 工具的 metadata。**不含 body**——body 按需读盘，
 * 避免一次性把所有 skill 内容塞进进程内存 / 进 prompt。
 */
export interface SkillMetadata {
  name: string;
  description: string;
  /** SKILL.md 绝对路径，工具按这条路径读 body */
  filePath: string;
  /** 所在 skill 目录（绝对路径），方便 body 中引用 references/scripts */
  dir: string;
  options: SkillOptions;
}

/**
 * 剥掉 SKILL.md 顶部的 YAML frontmatter，返回纯 markdown body。
 * 参考：tmp/open-agents-main/packages/agent/skills/loader.ts
 */
export function extractSkillBody(fileContent: string): string {
  const match = fileContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return fileContent.slice(match[0].length).trim();
  }
  return fileContent.trim();
}

/**
 * 替换 body 中的 `$ARGUMENTS` 占位符。skill 工具调用方传 args 时用得上。
 * 参考：tmp/open-agents-main/packages/agent/skills/loader.ts
 */
export function substituteArguments(body: string, args?: string): string {
  return body.replace(/\$ARGUMENTS/g, args ?? "");
}
