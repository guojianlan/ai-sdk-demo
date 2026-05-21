import { type LoadedMemory } from "@/lib/memory";
import { assemblePromptLayers } from "@/lib/prompt-layers";
import { buildSessionPrimer } from "@/lib/session-primer";
import type { SkillMetadata } from "@/lib/skills";

/**
 * buildSystemPrompt —— 构造 system instructions 的唯一入口。
 *
 * 先用 session-primer 读出环境上下文（cwd / shell / date / timezone）和工作区 AGENTS.md，
 * 再通过 `assemblePromptLayers` 把 5-7 层（persona / developerRules / envContext /
 * userInstructions [+ availableSkills] [+ conversationSummary]）拼成最终字符串。
 *
 * - `persona`：稳定身份（路由级常量）
 * - `developerRules`：运行期规则（依赖当前 access mode / tool mode / 工作区名）
 * - `workspaceRoot`：已 normalize 过的绝对路径
 * - `skills`（可选）：当前可用 skill 列表，由调用方从 `getSkills()` 拿；只把
 *   names + descriptions 进 prompt，body 由 `skill` 工具按需拉
 * - `conversationSummary`（可选）：P4-b compaction 的 handoff 摘要；没压过就传 null
 */
export async function buildSystemPrompt(input: {
  persona: string;
  developerRules: string;
  workspaceRoot: string;
  skills?: SkillMetadata[] | null;
  conversationSummary?: string | null;
  /** 跨对话长期记忆（A1）。null = 没启用 / 没文件。 */
  globalMemory?: LoadedMemory | null;
  /**
   * P9-c：UserPromptSubmit / SessionStart hook 返回的 `additionalContexts`
   * 和 `systemMessage` 合在一起的字符串数组。每条作为独立段落 append 到
   * 最终 prompt 末尾（一个 `# Hook context` section 内）。
   * 不传或空数组 → 这层不出现。
   */
  hookContexts?: string[] | null;
}): Promise<string> {
  const primer = await buildSessionPrimer({
    workspaceRoot: input.workspaceRoot,
  });

  // 摘要层要给模型一句引导：说清楚"这是上一段对话的摘要，不是本轮输入"，
  // 否则模型有时会把摘要里的 "user asked X" 当成用户又问了一次。
  const summarySection = input.conversationSummary
    ? [
        "The conversation has been compacted. The section below summarizes earlier messages that are no longer in the message history. Treat it as handoff context — the user has NOT just said these things in the current turn.",
        "",
        input.conversationSummary.trim(),
      ].join("\n")
    : null;

  const skillsSection = buildSkillsSection(input.skills ?? null);
  const memorySection = buildGlobalMemorySection(input.globalMemory ?? null);

  const base = assemblePromptLayers({
    persona: input.persona,
    developerRules: input.developerRules,
    environmentContext: primer.environmentContext,
    globalMemory: memorySection,
    userInstructions: primer.userInstructions,
    availableSkills: skillsSection,
    conversationSummary: summarySection,
  });

  const hookSection = buildHookContextSection(input.hookContexts ?? null);
  if (!hookSection) return base;
  return `${base}\n\n${hookSection}`;
}

/**
 * 把 P9-c hook 收集到的 contexts / systemMessages 渲染成 system prompt 段落。
 *
 * 每条作为独立 `- ...` 列表项放在 `# Hook context` 下面 —— 这是个临时层（每次
 * 请求新算），不进 prompt-layers 是有意的：prompt-layers 是稳定 7 层，hook 层
 * 跟随请求生命周期波动，让它单独存在更清楚。
 */
function buildHookContextSection(contexts: string[] | null): string | null {
  if (!contexts || contexts.length === 0) return null;
  const cleaned = contexts.map((c) => c.trim()).filter((c) => c.length > 0);
  if (cleaned.length === 0) return null;
  return ["# Hook context", "", ...cleaned.map((c) => `- ${c}`)].join("\n");
}

/**
 * 把 LoadedMemory 渲染成 system prompt 段落。null → null（这层会被跳过）。
 *
 * 给模型一段引导，说清楚 memory 的语义：
 *   - 这是跨 session 的长期记忆，不是当前对话内容
 *   - 用来回忆用户身份 / 偏好 / 过往决定 / 项目背景
 *   - 找不到对应记忆是正常的（可能是新用户 / 新项目）
 *
 * 截断标记由 loader 已经加在 content 末尾，这里不重复处理。
 */
export function buildGlobalMemorySection(
  memory: LoadedMemory | null,
): string | null {
  if (!memory) return null;
  const intro = [
    "Below is your long-term memory file (cross-session, cross-project). It contains facts the user has shared, preferences, decisions made in earlier conversations, and project background notes.",
    "",
    "Usage:",
    "- Treat it as authoritative reference for who the user is and what they've decided before.",
    "- Don't mention you're reading from \"memory\" — just use the facts naturally.",
    "- If a fact in memory contradicts what the user just said in this turn, trust the current turn (memory may be stale).",
    "- If memory is empty / missing, that's fine — proceed without prior context.",
  ].join("\n");
  return [intro, "", "---", "", memory.content].join("\n");
}

/**
 * 把 skill 列表渲染成 system prompt 段落。返回 null 表示没有可用 skill（这层会被跳过）。
 *
 * 设计考虑：
 * - 每个 skill 一行 `- name: description`，让 model 看一眼就能 skim。
 * - 头部明确告知"调 `skill` 工具拉 body"——避免 model 直接幻觉 skill 内容。
 * - 给一段简短的"何时该调"指南：当用户输 `/<name>` 或问题命中 description 关键词。
 *
 * 参考：tmp/open-agents-main/packages/agent/system-prompt.ts:370-413 buildSkillsPrompt
 */
export function buildSkillsSection(skills: SkillMetadata[] | null): string | null {
  if (!skills || skills.length === 0) return null;

  // user-invocable !== false 的 skill 都允许 slash-command 触发；显式标 false 的就不能
  const userInvocableHint = skills.some(
    (s) => s.options.userInvocable === false,
  )
    ? "- Some skills are not user-invocable (the user cannot trigger them via /<name>); they are auto-applied when relevant."
    : "";

  // disable-model-invocation 的 skill 模型不能主动调，得等用户 /<name>
  const modelGatedHint = skills.some(
    (s) => s.options.disableModelInvocation === true,
  )
    ? '- Skills marked as "model-gated" below cannot be invoked by you directly — wait for the user to type /<name>.'
    : "";

  // 注意：故意分两段拼。前半的 `""` 是有意保留的段内空行；后半的两个可选
  // hint 是条件 line（空了就不要那行）。过去一刀切 `.filter(len>0)` 把段内
  // 空行也滤掉了 —— intro 段落和 "When to invoke:" 列表被挤在一起。
  const introStatic = [
    "Use the `skill` tool to load any of the skills listed below. Each skill is a focused playbook of instructions that extends what you can do in this conversation.",
    "",
    "When to invoke:",
    '- The user types "/<skill-name>" — invoke that skill IMMEDIATELY before any other tool.',
    "- The user's request strongly matches a skill's description — invoke and follow its instructions.",
    "- Otherwise, prefer your standard tools.",
  ];
  const introConditional = [userInvocableHint, modelGatedHint].filter(
    (line) => line.length > 0,
  );
  const intro = [...introStatic, ...introConditional].join("\n");

  const lines = skills.map((s) => {
    const flags: string[] = [];
    if (s.options.disableModelInvocation) flags.push("model-gated");
    if (s.options.userInvocable === false) flags.push("auto-only");
    const suffix = flags.length > 0 ? ` _(${flags.join(", ")})_` : "";
    return `- \`${s.name}\`${suffix}: ${s.description}`;
  });

  return [intro, "", "Available skills:", ...lines].join("\n");
}
