import { assemblePromptLayers } from "@/lib/prompt-layers";
import { buildSessionPrimer } from "@/lib/session-primer";

/**
 * buildSystemPrompt —— 构造 system instructions 的唯一入口。
 *
 * 先用 session-primer 读出环境上下文（cwd / shell / date / timezone）和工作区 AGENTS.md，
 * 再通过 `assemblePromptLayers` 把 4-5 层（persona / developerRules / envContext /
 * userInstructions [+ conversationSummary]）拼成最终字符串。
 *
 * - `persona`：稳定身份（路由级常量）
 * - `developerRules`：运行期规则（依赖当前 access mode / tool mode / 工作区名）
 * - `workspaceRoot`：已 normalize 过的绝对路径
 * - `conversationSummary`（可选）：P4-b compaction 的 handoff 摘要；没压过就传 null
 */
export async function buildSystemPrompt(input: {
  persona: string;
  developerRules: string;
  workspaceRoot: string;
  conversationSummary?: string | null;
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

  return assemblePromptLayers({
    persona: input.persona,
    developerRules: input.developerRules,
    environmentContext: primer.environmentContext,
    userInstructions: primer.userInstructions,
    conversationSummary: summarySection,
  });
}
