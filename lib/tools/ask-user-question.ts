import { z } from "zod";

import { interactiveTool } from "@/lib/tool-helpers";

/**
 * `ask_user_question` —— 开放式追问。命名对齐 open-agents
 * `tools/ask-user-question.ts`（key: `ask_user_question`）。
 *
 * 这个工具**没有服务端 execute**——agent 发出 tool-call 后，AI SDK 停在
 * "input-available" 状态等客户端用 `addToolOutput` 回灌用户的回答。
 * 换句话说，output 来自人类大脑，不是代码。
 */
export const askUserQuestionTool = interactiveTool({
  description: [
    "Ask the user an open-ended clarifying question when you need information to proceed.",
    "",
    "WHEN TO USE:",
    "- The user's request is ambiguous or missing a piece of info you genuinely can't infer or discover.",
    "- You need a human preference/intent that no tool can answer (design choice, business decision, scope).",
    "",
    "WHEN NOT TO USE:",
    "- You can find the answer yourself via workspace tools (grep, glob, read). Use those instead.",
    "- For small formatting choices you can make a reasonable default for — just do the default and mention it.",
    "- As filler conversation (\"should I continue?\"). Only ask when an answer actually changes your next action.",
  ].join("\n"),
  inputSchema: z.object({
    question: z
      .string()
      .min(1)
      .describe("The question to show to the user. Plain text, no markdown."),
    placeholder: z
      .string()
      .optional()
      .describe(
        "Optional placeholder text for the input (e.g. an example answer).",
      ),
  }),
  outputSchema: z.object({
    answer: z.string().describe("The user's typed answer."),
  }),
});
