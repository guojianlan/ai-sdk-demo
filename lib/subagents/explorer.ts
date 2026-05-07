import { stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";

import { instrumentModel } from "@/lib/devtools";
import { gateway, gatewayModelId } from "@/lib/gateway";
import { connectSandbox } from "@/lib/sandbox";
import {
  type WorkspaceToolContext,
} from "@/lib/tools/context";
import { globTool } from "@/lib/tools/glob";
import { grepTool } from "@/lib/tools/grep";
import { readTool } from "@/lib/tools/read";

/**
 * Explorer subagent —— 专职"摸清一块代码"的只读子 agent。
 *
 * 为什么单独搞一个 agent 而不是主 agent 多绕几圈？
 * - 当用户问"这个项目怎么做鉴权"这种**发散型**问题时，模型可能要读 20-30 个文件。
 *   把这些 read 的输出全塞进主 context，会把后续对话空间挤掉。
 * - 让 explorer 独立跑，内部 context 随便膨胀，**最终只把一段 ≤ 500 字摘要
 *   交回主 agent**，主 context 只增长 ~500 字。
 *
 * 这里只负责构造 subagent 实例。把它包装成 `task` tool 暴露给主 agent 的部分
 * 在 `lib/tools/task.ts`（命名对齐 open-agents `tools/task.ts`）。
 *
 * 核心 AI SDK 概念：
 * - `ToolLoopAgent` 可以用 `.generate({ prompt, options })` 在任意位置一次性跑到底，
 *   返回 `{ text, steps, usage, ... }`。
 * - 外层把这个 `.generate()` 调用包在一个 `tool({ execute })` 里，就得到了
 *   "把 subagent 暴露成一个工具"的效果，模型自己决定什么时候用。
 */

const explorerPersona = [
  `你是一个代码调查员（explorer subagent）。主 agent 把「摸清一块代码」的任务交给你。`,
  ``,
  `任务：`,
  `- 只做调查，不做改动。只能用 glob / grep / read 这三个只读工具。`,
  `- 先用 glob 或 grep 摸方向，再 read 取证。不要硬猜结论。`,
  `- 最终用一段 ≤ 500 字中文摘要回答主 agent 传来的问题，并列出你读过的关键文件（workspace-relative 路径）。`,
  ``,
  `约束：`,
  `- 你不能反问。遇到模糊先做合理假设，最后在摘要末尾注明「假设 X，若不是请澄清」。`,
  `- 不要复述文件内容；回答要有你的判断，不是文件片段堆砌。`,
  `- 最多跑 100 步工具调用；到上限还没答清，就把当前能给出的结论交回并标注「调查未尽」。`,
].join("\n");

const explorerCallOptionsSchema = z.object({
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
});

export const explorerAgent = new ToolLoopAgent({
  model: instrumentModel(gateway.chatModel(gatewayModelId)),
  instructions: explorerPersona,
  // 100 步对齐 open-agents SUBAGENT_STEP_LIMIT。
  // 远超普通调查需求（典型 5-15 步即可），上限主要防失控；正常任务远不会触顶。
  stopWhen: stepCountIs(100),
  callOptionsSchema: explorerCallOptionsSchema,
  prepareCall: async ({ options, ...settings }) => {
    // Subagent 跑在它自己的 ToolLoopAgent 里，必须有自己的 sandbox 实例（class
    // 不能跨 callOptions 序列化）。这里基于 workspaceRoot 现场 connect 一个 local
    // sandbox——LocalSandbox 是纯 wrapper，开销可忽略。
    const sandbox = await connectSandbox({
      type: "local",
      workingDirectory: options.workspaceRoot,
    });
    return {
      ...settings,
      experimental_context: {
        sandbox,
        workspaceName: options.workspaceName ?? "",
      } satisfies WorkspaceToolContext,
    };
  },
  // 直接组合 read / glob / grep —— 不走 `@/lib/tools` barrel，因为 barrel
  // 会拉到 `task.ts`，而 `task.ts` 又 import 本文件，触发循环初始化。
  tools: { read: readTool, glob: globTool, grep: grepTool },
});
