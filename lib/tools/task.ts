import { tool } from "ai";
import { z } from "zod";

import { explorerAgent } from "@/lib/subagents/explorer";
import { toolErr, toolOk } from "@/lib/tool-result";

import { getWorkspaceToolContext } from "./context";

/**
 * `task` —— 把"摸清一块代码"的发散调查委派给只读 explorer subagent。
 *
 * 命名对齐 open-agents `tools/task.ts`（key: `task`）。subagent 实例本身在
 * `lib/subagents/explorer.ts`，这里只负责把它包装成主 agent 看得见的 tool。
 *
 * 路由策略：在 description 里写清 WHEN TO USE / WHEN NOT TO USE，让主模型自己
 * 判断什么时候用——没有分类器、没有规则兜底。
 */

const taskInputSchema = z.object({
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
});

export const taskTool = tool({
  description: [
    "Delegate a codebase-survey question to the explorer subagent. The explorer runs in its own isolated context, reads many files, and returns ONLY a concise summary to keep your main conversation clean.",
    "",
    "WHEN TO USE:",
    "- The question requires reading 5+ files to answer (e.g. 'how does auth work in this project', 'what's the architecture of module X').",
    "- You want to preserve the main conversation context — don't let 30 read outputs crowd out later discussion.",
    "- The task is 'survey a region of code', not 'modify one line'.",
    "",
    "WHEN NOT TO USE:",
    "- The user is asking about one specific file or one specific line (just read / grep directly).",
    "- You already have the relevant files in your context — just answer from what you know.",
    "- The task needs writing files or running commands (explorer is read-only).",
    "- You only need 1-2 read calls to answer (cheaper to do it yourself).",
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
  inputSchema: taskInputSchema,
  execute: async ({ hint, question }, { experimental_context, abortSignal }) => {
    const { sandbox, workspaceName } = getWorkspaceToolContext(
      experimental_context,
    );

    const prompt = hint
      ? `Question: ${question}\n\nStart hint: ${hint}`
      : question;

    try {
      const result = await explorerAgent.generate({
        prompt,
        // workspaceRoot 通过 sandbox.workingDirectory 取——subagent 内部会再
        // connect 一个自己的 LocalSandbox 实例（避免跨 agent 共享 class 实例）。
        options: { workspaceRoot: sandbox.workingDirectory, workspaceName },
        abortSignal,
      });

      // 从 steps 里抽出 read 过的路径作为透明度指标，
      // 让主 agent / 用户知道 explorer 真的动了手，不是凭空给答案。
      const filesExamined = Array.from(
        new Set(
          result.steps
            .flatMap((step) => step.toolCalls ?? [])
            .filter((call) => call.toolName === "read")
            .map((call) => {
              const input = call.input as { relativePath?: string } | undefined;
              return input?.relativePath;
            })
            .filter((p): p is string => typeof p === "string"),
        ),
      );

      return toolOk({
        summary: result.text,
        filesExamined,
        stepsUsed: result.steps.length,
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});
