import { assemblePromptLayers } from "@/lib/prompt-layers";
import { buildSessionPrimer } from "@/lib/session-primer";

/**
 * buildSystemPrompt —— 构造 system instructions 的唯一入口。
 *
 * 先用 session-primer 读出环境上下文（cwd / shell / date / timezone）和工作区 AGENTS.md，
 * 再通过 `assemblePromptLayers` 把四层（persona / developerRules / envContext / userInstructions）
 * 拼成最终字符串。
 *
 * 两条 chat 路由都从这一个函数取 system prompt。
 * - `persona`：稳定身份（路由级常量）
 * - `developerRules`：运行期规则（依赖当前 access mode / tool mode / 工作区名）
 * - `workspaceRoot`：已 normalize 过的绝对路径
 */
export async function buildSystemPrompt(input: {
  persona: string;
  developerRules: string;
  workspaceRoot: string;
}): Promise<string> {
  const primer = await buildSessionPrimer({
    workspaceRoot: input.workspaceRoot,
  });

  return assemblePromptLayers({
    persona: input.persona,
    developerRules: input.developerRules,
    environmentContext: primer.environmentContext,
    userInstructions: primer.userInstructions,
  });
}
