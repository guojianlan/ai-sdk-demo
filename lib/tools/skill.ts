import fs from "node:fs/promises";

import { tool } from "ai";
import { z } from "zod";

import {
  extractSkillBody,
  substituteArguments,
  type SkillMetadata,
} from "@/lib/skills/types";
import { toolErr, toolOk } from "@/lib/tool-result";

/**
 * `skill` 工具 —— open-agents hybrid 模式的核心。
 *
 * 命名对齐 open-agents `tools/skill.ts`（key: `skill`）。skill discovery / cache /
 * types 仍然在 `lib/skills/`（与 tool 解耦：tool 只负责"按 name 读 body"）。
 *
 * 工作方式：
 * - system prompt 已经把 `name + description` 列给 model 看（buildSkillsSection）；
 * - model 觉得某个 skill 相关时调用本工具，按 name 拉对应 SKILL.md 的 body 回去；
 * - frontmatter 里 `disable-model-invocation: true` 的 skill 拒绝执行（仅响应用户显式 `/x`）。
 *
 * 设计选择：
 * - 走 ToolResult<T>（项目 convention）而不是 open-agents 的 {success, ...}。
 * - 直接 fs.readFile（skill 在仓库内、不会跨 sandbox 边界）。
 * - 在 body 顶部注入 "Skill directory:" 一行，让 model 引用 skill 目录里的
 *   scripts / references 时知道绝对路径（跟 open-agents `injectSkillDirectory` 同效）。
 */

interface SkillToolContext {
  skills?: SkillMetadata[];
}

function getSkillsFromContext(experimental_context: unknown): SkillMetadata[] {
  const ctx = experimental_context as SkillToolContext | undefined;
  return ctx?.skills ?? [];
}

const skillInputSchema = z.object({
  skill: z.string().describe("The skill name to invoke"),
  args: z.string().optional().describe("Optional arguments forwarded to the skill"),
});

export const skillTool = tool({
  description: [
    "Execute a skill within the main conversation.",
    "",
    "When the user's request matches a skill in the 'Available skills' list of your system prompt, invoke this tool BEFORE any other action so the full skill instructions are loaded into context.",
    "",
    "Example:",
    "  User: '/code-review'",
    "  → call skillTool with { skill: 'code-review' }",
    "",
    "Rules:",
    "- Only use skills present in the 'Available skills' list.",
    "- Skills marked `disable-model-invocation: true` will reject your call — only the user can trigger them via `/<name>`.",
    "- Never just announce a skill — always actually call this tool to load it.",
  ].join("\n"),
  inputSchema: skillInputSchema,
  execute: async ({ args, skill }, { experimental_context }) => {
    const skills = getSkillsFromContext(experimental_context);
    const normalized = skill.toLowerCase();
    const found = skills.find((s) => s.name.toLowerCase() === normalized);

    if (!found) {
      const available = skills.map((s) => s.name).join(", ") || "(none)";
      return toolErr(`Skill "${skill}" not found. Available: ${available}`);
    }

    if (found.options.disableModelInvocation) {
      return toolErr(
        `Skill "${skill}" cannot be invoked by the model (disable-model-invocation is set). The user must trigger it explicitly with /${found.name}.`,
      );
    }

    let raw: string;
    try {
      raw = await fs.readFile(found.filePath, "utf-8");
    } catch (error) {
      return toolErr(error);
    }

    const body = extractSkillBody(raw);
    const withDir = `Skill directory: ${found.dir}\n\n${body}`;
    const content = substituteArguments(withDir, args);

    return toolOk({
      name: found.name,
      content,
      dir: found.dir,
    });
  },
});
