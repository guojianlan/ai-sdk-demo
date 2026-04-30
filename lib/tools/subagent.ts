import { stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";

import { instrumentModel } from "@/lib/devtools";
import { gateway, gatewayModelId } from "@/lib/gateway";
import { defineTool } from "@/lib/tooling";
import { workspaceTools } from "@/lib/tools/workspace";

/**
 * Explorer subagent —— 把 ToolLoopAgent 包装成一个普通 tool 暴露给主 agent。
 *
 * 为什么单独搞一个 agent 而不是主 agent 多绕几圈？
 * - 当用户问"这个项目怎么做鉴权"这种**发散型**问题时，模型可能要读 20-30 个文件。
 *   把这些 read_file 的输出全塞进主 context，会把后续对话空间挤掉。
 * - 让 explorer 独立跑，内部 context 随便膨胀，**最终只把一段 ≤ 500 字摘要
 *   交回主 agent**，主 context 只增长 ~500 字。
 *
 * 路由策略（见 description）：模型自决 + prompt 工程，无分类器无规则路由。
 *
 * 抽象层细节：
 * - `kind: "subagent"`：抽象层永不审批
 * - subagent 内部还是用 AI SDK 原生 `ToolLoopAgent`（这是个 SDK-级别的能力，
 *   不是我们的抽象层负责的）。它的 tools 用 `workspaceTools.map(t => t.aiTool)`
 *   从我们的 registry 拿——保持只读 tool 集合的单一真相源。
 */

const explorerPersona = [
  `你是一个代码调查员（explorer subagent）。主 agent 把「摸清一块代码」的任务交给你。`,
  ``,
  `任务：`,
  `- 只做调查，不做改动。只能用 list_files / search_code / read_file 这三个只读工具。`,
  `- 先用 list_files 或 search_code 摸方向，再 read_file 取证。不要硬猜结论。`,
  `- 最终用一段 ≤ 500 字中文摘要回答主 agent 传来的问题，并列出你读过的关键文件（workspace-relative 路径）。`,
  ``,
  `约束：`,
  `- 你不能反问。遇到模糊先做合理假设，最后在摘要末尾注明「假设 X，若不是请澄清」。`,
  `- 不要复述文件内容；回答要有你的判断，不是文件片段堆砌。`,
  `- 最多跑 20 步工具调用；到上限还没答清，就把当前能给出的结论交回并标注「调查未尽」。`,
].join("\n");

const explorerCallOptionsSchema = z.object({
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
});

// subagent 的 tools 是 AI SDK 的 ToolSet 形态——我们的 DefinedTool 列表 .map 出 aiTool
// 拼成对象。reduce 比 Object.fromEntries(map) 一行就完成。
const subagentToolSet = Object.fromEntries(
  workspaceTools.map((t) => [t.name, t.aiTool]),
);

const explorerAgent = new ToolLoopAgent({
  model: instrumentModel(gateway.chatModel(gatewayModelId)),
  instructions: explorerPersona,
  // 20 步够 list_files + search_code 来回 + 5-10 次 read_file + 总结。
  // open-agents 的 SUBAGENT_STEP_LIMIT = 50，我们这个规模一半就够。
  stopWhen: stepCountIs(20),
  callOptionsSchema: explorerCallOptionsSchema,
  prepareCall: async ({ options, ...settings }) => {
    return {
      ...settings,
      experimental_context: {
        workspaceRoot: options.workspaceRoot,
        workspaceName: options.workspaceName ?? "",
        // bypassPermissions: true —— subagent 内部全是 readonly tools，
        // 即使加进来也无审批；保险起见显式设 true 防未来改 workspace tool 的 kind 时漏改。
        bypassPermissions: true,
      },
    };
  },
  tools: subagentToolSet,
});

export const exploreWorkspaceTool = defineTool({
  name: "explore_workspace",
  kind: "subagent",
  displayName: "explore workspace",
  description: [
    "Delegate a codebase-survey question to the explorer subagent. The explorer runs in its own isolated context, reads many files, and returns ONLY a concise summary to keep your main conversation clean.",
    "",
    "WHEN TO USE:",
    "- The question requires reading 5+ files to answer (e.g. 'how does auth work in this project', 'what's the architecture of module X').",
    "- You want to preserve the main conversation context — don't let 30 read_file outputs crowd out later discussion.",
    "- The task is 'survey a region of code', not 'modify one line'.",
    "",
    "WHEN NOT TO USE:",
    "- The user is asking about one specific file or one specific line (just read_file / search_code directly).",
    "- You already have the relevant files in your context — just answer from what you know.",
    "- The task needs writing files or running commands (explorer is read-only).",
    "- You only need 1-2 read_file calls to answer (cheaper to do it yourself).",
    "",
    "INPUT:",
    "- question: a concrete, self-contained question. Explorer cannot ask back, so be explicit.",
    "- hint (optional): where to start looking, if you have a prior.",
    "",
    "OUTPUT:",
    "- summary: explorer's ≤ 500-char Chinese summary grounded in files it actually read.",
    "- filesExamined: list of files it opened (for transparency).",
    "- stepsUsed: how many tool steps it spent.",
    "",
    "IMPORTANT: After receiving the summary, base your final answer on it. Don't re-read the same files yourself unless you specifically need details the summary didn't cover.",
  ].join("\n"),
  inputSchema: z.object({
    question: z
      .string()
      .min(3)
      .describe(
        "The specific question for the explorer to answer. Be as concrete as possible — explorer cannot ask back.",
      ),
    hint: z
      .string()
      .optional()
      .describe(
        "Optional extra hint about where to start looking (e.g., 'likely in lib/auth/*' or 'check middleware files first').",
      ),
  }),
  execute: async ({ hint, question }, { workspace }) => {
    const prompt = hint
      ? `Question: ${question}\n\nStart hint: ${hint}`
      : question;

    const result = await explorerAgent.generate({
      prompt,
      options: { workspaceRoot: workspace.root, workspaceName: workspace.name },
    });

    // 从 steps 里抽出 read_file 过的路径作为透明度指标，
    // 让主 agent / 用户知道 explorer 真的动了手，不是凭空给答案。
    const filesExamined = Array.from(
      new Set(
        result.steps
          .flatMap((step) => step.toolCalls ?? [])
          .filter((call) => call.toolName === "read_file")
          .map((call) => {
            const input = call.input as { relativePath?: string } | undefined;
            return input?.relativePath;
          })
          .filter((p): p is string => typeof p === "string"),
      ),
    );

    return {
      summary: result.text,
      filesExamined,
      stepsUsed: result.steps.length,
    };
  },
});

export const subagentTools = [exploreWorkspaceTool];
