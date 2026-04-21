import path from "node:path";

import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { z } from "zod";

import { buildSystemPrompt } from "@/lib/chat-agent/system-prompt";
import { normalizeWorkspaceRoot } from "@/lib/workspaces";

/**
 * chat-agent builder —— 两条 chat 路由共用的 agent 构造 pipeline。
 *
 * 把这段以前在两个路由里重复 60% 的流程抽成一个函数：
 *   1. 接收 callOptions（包含 workspaceRoot / workspaceName + 路由特有字段）
 *   2. normalizeWorkspaceRoot 校验路径
 *   3. 通过 `buildDeveloperRules` 钩子拿到当前 mode 对应的 developer rules
 *   4. 通过 `buildSystemPrompt` 合成完整 system prompt
 *   5. 通过 `buildExperimentalContext` 钩子填 tool 运行时需要的 context
 *   6. 构造并返回 `ToolLoopAgent`
 *
 * 两条路由的差异收敛成钩子参数：persona 字符串、developer rules 构造器、
 * experimental_context 构造器、tools 集合、stepCount、callOptionsSchema、model。
 */

/** chat 路由都有的两个 option 字段；其它字段由路由自己在 schema 里扩展。 */
export type ChatBaseOptions = {
  workspaceRoot: string;
  workspaceName?: string;
};

export type BuildDeveloperRulesContext<Options> = {
  options: Options;
  workspaceName: string;
};

export type BuildExperimentalContextArgs<Options> = {
  options: Options;
  workspaceRoot: string;
  workspaceName: string;
};

export type ChatAgentConfig<
  Options extends ChatBaseOptions,
  Tools extends ToolSet,
> = {
  model: LanguageModelV3;
  /** 稳定身份字符串，也作为 `instructions` 的 fallback。 */
  persona: string;
  /** Zod schema，调用层验证 options。 */
  callOptionsSchema: z.ZodType<Options>;
  /** 根据当前 call options 构造 developer rules 文本。 */
  buildDeveloperRules: (ctx: BuildDeveloperRulesContext<Options>) => string;
  /** 根据当前 call options 构造 tools 运行时需要的 experimental_context。 */
  buildExperimentalContext: (
    ctx: BuildExperimentalContextArgs<Options>,
  ) => Record<string, unknown>;
  /** 已经 resolve 好的工具集（动态 tool 如 MCP 由调用方在传入前合并）。 */
  tools: Tools;
  /** stopWhen 的步数上限。 */
  stepLimit: number;
  /** agent loop 结束时触发（MCP 子进程清理等）。 */
  onFinish?: () => void | Promise<void>;
};

export function createChatAgent<
  Options extends ChatBaseOptions,
  Tools extends ToolSet,
>(config: ChatAgentConfig<Options, Tools>): ToolLoopAgent<Options, Tools> {
  return new ToolLoopAgent<Options, Tools>({
    model: config.model,
    instructions: config.persona,
    stopWhen: stepCountIs(config.stepLimit),
    callOptionsSchema: config.callOptionsSchema,
    tools: config.tools,
    prepareCall: async ({ options, ...settings }) => {
      // AI SDK 的 prepareCall 把 options 标成可选（即使我们传了 callOptionsSchema
      // 令 CALL_OPTIONS 非 never）；运行期 callOptionsSchema 会保证一定有值，
      // 所以这里显式收窄而不是做 runtime check。
      if (!options) {
        throw new Error(
          "chat-agent builder: call options are required (schema should enforce this).",
        );
      }

      const workspaceRoot = await normalizeWorkspaceRoot(options.workspaceRoot);
      const workspaceName =
        options.workspaceName?.trim() || path.basename(workspaceRoot);

      const developerRules = config.buildDeveloperRules({
        options,
        workspaceName,
      });

      const instructions = await buildSystemPrompt({
        persona: config.persona,
        developerRules,
        workspaceRoot,
      });

      return {
        ...settings,
        instructions,
        experimental_context: config.buildExperimentalContext({
          options,
          workspaceRoot,
          workspaceName,
        }),
      };
    },
    onFinish: config.onFinish
      ? async () => {
          await config.onFinish?.();
        }
      : undefined,
  });
}
