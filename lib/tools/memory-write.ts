import { z } from "zod";

import { writeMemoryTopic } from "@/lib/memory";
import { approvedTool } from "@/lib/tool-helpers";
import { toolErr, toolOk } from "@/lib/tool-result";

import { getWorkspaceToolContext } from "./context";

/**
 * `memory_write` —— A4：让 agent 主动把跨对话事实写进长期记忆。
 *
 * 写两个文件（详见 lib/memory/writer.ts）：
 *   1. `~/.local-agent/memory/<topic>.md`：主题文件，含 frontmatter
 *   2. `~/.local-agent/memory/MEMORY.md`：索引同步追加 / 更新
 *
 * 跟 A2 抽取器的区别：
 *   - A2：自动 + 后置（chat turn 结束后从 JSONL 抽）
 *   - A4：手动 + 即时（agent 在对话中显式 commit "我记一下"）
 *
 * 启用条件：项目级 settings.json `memoryEnabled: true`（默认）。关掉后这个工具
 * 从 toolset 里被过滤掉，agent 看不到。详见 chat workflow 的 toolset 过滤逻辑。
 *
 * 安全（自动接 ACL + Mode）：
 *   - 走 `approvedTool`，name="memory_write"
 *   - getRuleContent 暴露 topic slug，settings.json 可以这样精确 deny：
 *       `{ "tool": "memory_write", "pattern": "secret-*", "behavior": "deny" }`
 *   - bypass 模式自动过；default 模式弹审批（写用户全局文件，谨慎）
 *   - **不进** subAgentToolset：子 agent 不应该写用户级长期记忆
 */

const memoryWriteInputSchema = z.object({
  topic: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message:
        "topic must be lowercase slug (a-z, 0-9, hyphens), starting with letter/digit",
    })
    .describe(
      "Slug for this memory file. Lowercase + hyphens only, e.g. 'user-preferences', 'auth-architecture-decisions'. One topic per memory_write call — use multiple calls for unrelated facts.",
    ),
  type: z
    .enum(["user", "feedback", "project", "reference"])
    .describe(
      [
        "Memory category. Pick the closest fit:",
        "- user: identity / role / long-term preferences (e.g. 'senior Go engineer, learning Next.js')",
        "- feedback: user corrections to your behavior (e.g. 'don't write trailing summaries')",
        "- project: current project state / decisions / deadlines (e.g. 'auth refactor to JWT, deadline 2026-06')",
        "- reference: external resource pointers (e.g. 'bugs tracked in Linear project INGEST')",
      ].join("\n"),
    ),
  content: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "Markdown body for this memory topic. Should be focused — bullet points or short paragraphs. Avoid duplicating things already obvious from the codebase. Include the *why* not just the *what* for feedback entries.",
    ),
  oneLineSummary: z
    .string()
    .min(1)
    .max(150)
    .describe(
      "≤150 char one-line summary. This goes into the MEMORY.md index, which is what gets injected into future system prompts. Be specific and useful — this is the only thing future-you sees at a glance. e.g. 'Senior Go engineer, learning Next.js / Vercel AI SDK'.",
    ),
});

export const memoryWriteTool = approvedTool({
  description: [
    "Write a fact / preference / decision to your long-term memory (cross-session, cross-project). Future conversations will see this in your system prompt.",
    "",
    "WHEN TO USE:",
    "- The user explicitly says 'remember X' or 'remind me about Y next time'.",
    "- You learn a durable fact about who the user is, how they work, or what they prefer (after they confirm or correct you).",
    "- A project decision is made that affects future turns (e.g. 'we're going with library X, here's why').",
    "- The user gives you feedback on your behavior that you should keep applying.",
    "",
    "WHEN NOT TO USE:",
    "- For ephemeral conversation state — don't memorize 'user just asked about file X'.",
    "- Already covered by `update_plan` (intra-task progress, not long-term knowledge).",
    "- Code patterns / file paths the user can grep for — those don't need memorizing.",
    "- Sensitive values (passwords, tokens, PII) — never write these.",
    "",
    "TYPES (pick one):",
    "- user: identity / role / long-term preferences",
    "- feedback: corrections to your behavior — include the WHY",
    "- project: current state / decisions / deadlines",
    "- reference: external resource pointers (Linear / Slack / docs URLs)",
    "",
    "INPUT:",
    "- topic: lowercase-hyphen slug (e.g. 'user-preferences'). Reuse existing topic to UPDATE; new slug to CREATE.",
    "- content: markdown body — focus on the WHY for feedback / project entries.",
    "- oneLineSummary: ≤150 char hook for the MEMORY.md index (this is what future-you skims).",
    "",
    "OUTPUT:",
    "- filePath: where it was written.",
    "- operation: 'created' or 'updated'.",
    "- indexUpdated: whether MEMORY.md index was successfully refreshed (next chat sees it).",
    "",
    "BEHAVIOR:",
    "- Both the topic file and MEMORY.md index are updated atomically (best-effort — topic file first).",
    "- This tool may require user approval depending on PermissionMode and ACL rules.",
  ].join("\n"),
  inputSchema: memoryWriteInputSchema,
  name: "memory_write",
  // ACL pattern 匹配 topic slug（让用户可以 deny 特定主题，比如 secret-*）
  getRuleContent: ({ topic }) => topic,
  getCwd: (ctx) => getWorkspaceToolContext(ctx).sandbox.workingDirectory,
  // 默认弹审批 —— 写用户全局长期记忆，比写工作区文件更需要明确同意。
  // bypass 模式 / acceptEdits（仅 write/edit）/ ACL allow / settings 主动开启都能跳过。
  needsApproval: () => true,
  execute: async ({ topic, type, content, oneLineSummary }) => {
    try {
      const result = await writeMemoryTopic({
        topic,
        type,
        content,
        oneLineSummary,
      });
      return toolOk(result);
    } catch (error) {
      return toolErr(error);
    }
  },
});
