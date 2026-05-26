import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import { z } from "zod";

import { instrumentModel } from "@/lib/devtools";
import { gateway, gatewayModelId } from "@/lib/gateway";
import {
  buildCommandHookRegistryFromProjectSettings,
  buildHookRegistryFromSettings,
  copyHooksInto,
  defaultHookRegistry,
  HookRegistry,
  wrapToolsetWithHooks,
} from "@/lib/hooks";
import {
  DEFAULT_PERMISSION_MODE,
  loadProjectSettings,
  loadSettings,
  type PermissionMode,
} from "@/lib/permissions";
import { connectSandbox } from "@/lib/sandbox";
import { editTool, writeTool } from "@/lib/tools/write";
import { globTool } from "@/lib/tools/glob";
import { grepTool } from "@/lib/tools/grep";
import { readTool } from "@/lib/tools/read";
import { shellTool } from "@/lib/tools/shell";
import {
  DEFAULT_SHELL_APPROVAL_POLICY,
  type ShellApprovalPolicy,
} from "@/lib/tools/shell-approval";

/**
 * 通用子 agent —— `spawn_agent` 工具的运行引擎。
 *
 * P5 → v3 演进：
 * - v1 (P5)：只读 explorer 升级到 read+write+shell 全能子 agent
 * - v2 (跳过)：单层 spawn，子 agent 不能再嵌套
 * - **v3 (current)**：递归 spawn，配 `env.subAgentMaxDepth` 硬限制（默认 2 层）
 *
 * 关键约束（跟主 agent 的差异）：
 * - **没有 interactive tools**（ask_user_question / ask_choice / show_reference）：
 *   子 agent 在 server 后台跑，没有 UI 通道问用户。需要决策时只能基于上下文自洽
 *   或者把不确定性写进 summary 让父 agent 去问。
 * - **没有 update_plan**：子 agent 的 plan checklist 不进 UI（execute 内部跑），
 *   所以无意义。子 agent 自己 reasoning 就好。
 * - **`__subagent: true` flag**：approvedTool 的 needsApproval 看到这个 flag 会
 *   跳过审批（subagent 没 UI 弹卡）。**ACL deny 仍然第一时间生效**，所以安全护栏在。
 * - **`__subagentDepth: N` flag**：当前子 agent 的深度（1 = 直接 spawn 出的，2 = 子又
 *   spawn 出的孙……）。`spawn_agent` 工具 execute 检查这个值，超过 `env.subAgentMaxDepth`
 *   就拒绝再 spawn。
 *
 * 为什么 spawn_agent 工具是动态 import：
 *   `lib/tools/spawn-agent.ts` 里的 `runSubAgent` 调用回 `lib/subagents/sub-agent.ts`，
 *   静态 import 会让两个模块互为 import 起点，加载顺序坏掉。
 *   解：buildSubAgentToolset 在第一次调用时**动态 import**，之后 ESM 模块缓存命中，
 *   开销可忽略。
 */

let cachedSubAgentToolset: ToolSet | null = null;

async function buildSubAgentToolset(): Promise<ToolSet> {
  if (cachedSubAgentToolset) return cachedSubAgentToolset;
  // 动态 import 破解循环依赖：sub-agent ← spawn-agent ← sub-agent
  const { spawnAgentTool } = await import("@/lib/tools/spawn-agent");
  cachedSubAgentToolset = {
    read: readTool,
    glob: globTool,
    grep: grepTool,
    write: writeTool,
    edit: editTool,
    shell: shellTool,
    spawn_agent: spawnAgentTool,
  };
  return cachedSubAgentToolset;
}

const subAgentPersona = [
  `你是一个子 agent (sub-agent)，被父 agent 调度处理一个 well-scoped 子任务。`,
  ``,
  `任务规则：`,
  `- **完整执行**任务，包括读写文件、跑 shell 命令。结果用一段简洁中文 summary 交回父 agent。`,
  `- 你的工具调用**不进父对话历史**，所以可以放开探索、试错；只有最终 summary 是父 agent 看得到的。`,
  `- 不能反问。任何模糊都基于合理假设做下去，最后在 summary 末尾注明"假设了 X，若不符请告知"。`,
  ``,
  `递归 spawn：`,
  `- 你**可以**再调 spawn_agent 派孙 agent，但当前已经在某个嵌套深度上，再深可能被深度上限拒绝（错误信息会告诉你）。`,
  `- 拒绝你时，把那部分子任务自己做完或者拆细放进 summary，父 agent 会决定怎么处理。`,
  ``,
  `Summary 格式（≤ 800 字）：`,
  `- 一句话答案 / 结论`,
  `- 关键文件 / 路径（如有）`,
  `- 你做了什么改动（如有）—— write / edit / shell 都列上`,
  `- 假设、未尽事项、follow-up 建议（如有）`,
  ``,
  `约束：`,
  `- 最多 100 步工具调用；触顶就把当前能给的结论交回，标注"上限触顶，调查未尽"。`,
  `- 不要复述大块文件内容；要有判断，不是片段堆砌。`,
].join("\n");

const subAgentCallOptionsSchema = z.object({
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
  /** 父 agent 的 permission mode，子 agent 沿用（决定 mode-based 自动放行行为）。 */
  permissionMode: z.string().optional(),
  /** 父 agent 的 shell 审批策略，子 agent 沿用。 */
  shellApprovalPolicy: z.string().optional(),
  /** 当前 subagent 深度（spawn_agent execute 计算后传入）。 */
  depth: z.number().int().min(1).default(1),
  /** 父 chatId 透传 —— 仅用于 hook payload 的 sessionId，递归 spawn 时也带下去。 */
  chatId: z.string().min(1).optional(),
});

/**
 * 跑一次子 agent。父 agent 的 `spawn_agent` 工具 execute 调这个。
 *
 * @param prompt sub-task 描述（来自父 agent 的 message 字段）
 * @param workspaceRoot 必填，sandbox 在这下面 cwd
 * @param workspaceName UI 展示用名字
 * @param permissionMode / shellApprovalPolicy 父 agent 的 ctx 透传
 * @param depth 当前子 agent 的深度（1 = 直接 spawn 出来；递归调用会增）
 * @param abortSignal 父 agent abort 时透传过来，子 agent 也要停
 */
export async function runSubAgent(args: {
  prompt: string;
  workspaceRoot: string;
  workspaceName: string;
  permissionMode?: PermissionMode;
  shellApprovalPolicy?: ShellApprovalPolicy;
  depth: number;
  abortSignal?: AbortSignal;
  /**
   * 父 agent 的 chatId，仅用作 hook payload 的 sessionId 字段；不传也行（log 行
   * 会少一段标识，但行为不受影响）。一般通过父 `experimental_context.__chatId`
   * 透传，spawn-agent execute 显式传过来。
   */
  parentChatId?: string;
}) {
  const tools = await buildSubAgentToolset();

  // 子 agent 也走 hook —— 跟主 workflow 同一套口径：
  //   default registry（含 toolLogging）+ settings-derived（如开启的 dotenv-blocklist）
  // 不挂 hook 的话 dotenv blocklist 在 child 内部失效、log 行漏掉 child tool call，
  // 安全护栏会出现"父被拦、child 偷偷写"的口径割裂。
  const subagentSettings = loadSettings(args.workspaceRoot);
  const subagentHookRegistry = new HookRegistry();
  copyHooksInto(subagentHookRegistry, defaultHookRegistry);
  copyHooksInto(
    subagentHookRegistry,
    buildHookRegistryFromSettings(subagentSettings),
  );
  copyHooksInto(
    subagentHookRegistry,
    buildCommandHookRegistryFromProjectSettings(
      loadProjectSettings(args.workspaceRoot),
      { cwd: args.workspaceRoot },
    ),
  );
  const hookedTools = wrapToolsetWithHooks(tools, subagentHookRegistry, {
    sessionId: args.parentChatId,
  });

  const subAgent = new ToolLoopAgent({
    model: instrumentModel(gateway.chatModel(gatewayModelId)),
    instructions: subAgentPersona,
    // 100 步对齐 explorer 上限；子 agent 跑越久越费 token，但偶尔大任务确实需要。
    stopWhen: stepCountIs(100),
    callOptionsSchema: subAgentCallOptionsSchema,
    tools: hookedTools,
    prepareCall: async ({ options, ...settings }) => {
      const sandbox = await connectSandbox({
        type: "local",
        workingDirectory: options.workspaceRoot,
      });
      return {
        ...settings,
        experimental_context: {
          sandbox,
          workspaceName: options.workspaceName ?? "",
          // 透传父 agent 的权限设置，让 approvedTool 决策树能拿到（包括 ACL settings）
          permissionMode: (options.permissionMode ??
            DEFAULT_PERMISSION_MODE) as PermissionMode,
          shellApprovalPolicy: (options.shellApprovalPolicy ??
            DEFAULT_SHELL_APPROVAL_POLICY) as ShellApprovalPolicy,
          // 关键 flag：approvedTool needsApproval 看到 __subagent=true 会跳过审批
          __subagent: true,
          // 当前子 agent 的深度。spawn_agent execute 读这个判断是否还能再 spawn。
          __subagentDepth: options.depth,
          // 把父 chatId 继续往下传 —— 递归 spawn 出的孙 agent 的 hook 也能用同一个
          // sessionId 串日志；缺失就不带。
          __chatId: options.chatId,
        },
      };
    },
  });

  return subAgent.generate({
    prompt: args.prompt,
    options: {
      workspaceRoot: args.workspaceRoot,
      workspaceName: args.workspaceName,
      permissionMode: args.permissionMode,
      shellApprovalPolicy: args.shellApprovalPolicy,
      depth: args.depth,
      chatId: args.parentChatId,
    },
    abortSignal: args.abortSignal,
  });
}
