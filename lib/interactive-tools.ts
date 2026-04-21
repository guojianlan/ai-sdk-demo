import { z } from "zod";

import { interactiveTool } from "@/lib/tool-helpers";

/**
 * 交互工具集（P3-c）。
 *
 * 这组工具**没有服务端 execute**——agent 发出 tool-call 后，AI SDK 停在
 * "input-available" 状态等客户端用 `addToolOutput` 回灌结果。
 * 换句话说，这组工具的 output 来自人类大脑，不是代码。
 *
 * 三个起手式：
 * - `ask_question`：开放式追问（"要处理哪个文件？"）
 * - `ask_choice`：多选一（"dev / prod？"）
 * - `show_reference`：展示外链/引用卡，让用户确认看过
 *
 * 要再加交互姿势（比如填表、附件上传、多选），新写一个 `interactiveTool(...)`
 * 放这里，再在 `app/_components/tool-card/interactive-cards.tsx` 的 registry 里加 UI。
 *
 * ⚠ tool name 必须全小写 + 下划线（AI SDK / OpenAI 对 tool name 的要求），
 *   下面的 key 就是 agent 看到的 tool name。
 */

export const askQuestionTool = interactiveTool({
  description: [
    "Ask the user an open-ended clarifying question when you need information to proceed.",
    "",
    "WHEN TO USE:",
    "- The user's request is ambiguous or missing a piece of info you genuinely can't infer or discover.",
    "- You need a human preference/intent that no tool can answer (design choice, business decision, scope).",
    "",
    "WHEN NOT TO USE:",
    "- You can find the answer yourself via workspace tools (search_code, list_files, read_file). Use those instead.",
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

export const askChoiceTool = interactiveTool({
  description: [
    "Ask the user to pick one option from a closed list. Always include your own recommended pick via `recommendedId` so the user can see what you would choose.",
    "",
    "WHEN TO USE:",
    "- You've narrowed the decision to 2–5 concrete options and need the user to pick.",
    "- The options have meaningful tradeoffs that the user should decide (not things you can just benchmark).",
    "",
    "WHEN NOT TO USE:",
    "- More than ~5 options — ask an open-ended question (`ask_question`) instead.",
    "- Only one reasonable option — just do it and mention your choice.",
    "- To confirm an action (\"yes/no\") — prefer `ask_question` with a clear question.",
    "",
    "OUTPUT SHAPE:",
    "- User can either click an option or type a free-form answer (including a shorthand like '1', 'A', or a custom response).",
    "- You receive `{ answer: string }` — parse in-context to figure out which option they meant, or honor custom text if they went off-menu.",
  ].join("\n"),
  inputSchema: z.object({
    question: z
      .string()
      .min(1)
      .describe("The question framing the choice. Plain text, no markdown."),
    options: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .describe("Stable machine-readable id, e.g. 'option-a'."),
          label: z
            .string()
            .min(1)
            .describe("Short human-readable label shown on the button."),
          description: z
            .string()
            .optional()
            .describe(
              "Optional one-line explanation shown below the label.",
            ),
        }),
      )
      .min(2)
      .max(5)
      .describe("The options to pick from. 2–5 items."),
    recommendedId: z
      .string()
      .optional()
      .describe(
        "Your own recommendation: the `id` of the option you'd pick given what you know. Shown in the UI as a 'recommended' badge. ALWAYS set this unless you truly have no lean.",
      ),
    recommendationReason: z
      .string()
      .optional()
      .describe(
        "One short line (<= 80 chars) explaining why you recommend the option above. Shown below the recommended option.",
      ),
  }),
  outputSchema: z.object({
    answer: z
      .string()
      .describe(
        "The user's answer. May be an option id/label (clicked) or free-form text (typed). Interpret in-context.",
      ),
  }),
});

export const showReferenceTool = interactiveTool({
  description: [
    "Show the user a clickable reference card (external link + summary) they should look at before you proceed.",
    "",
    "WHEN TO USE:",
    "- You want to point the user at documentation, an issue, a PR, or a design doc that will inform their next decision.",
    "- You're recommending a library/article and want the user to acknowledge they've seen it.",
    "",
    "WHEN NOT TO USE:",
    "- As a general way to mention a link — put links in plain text instead.",
    "- For workspace files — just reference them with their relative path.",
  ].join("\n"),
  inputSchema: z.object({
    title: z.string().min(1).describe("Short title for the card."),
    url: z.string().url().describe("Absolute URL the user can click."),
    summary: z
      .string()
      .min(1)
      .describe(
        "One- to three-sentence summary of why this link is relevant right now.",
      ),
  }),
  outputSchema: z.object({
    acknowledged: z
      .boolean()
      .describe(
        "Whether the user acknowledged the reference (clicked 'got it'). If false, they dismissed.",
      ),
  }),
});

export const interactiveToolset = {
  ask_question: askQuestionTool,
  ask_choice: askChoiceTool,
  show_reference: showReferenceTool,
};

/** Tool name → AI SDK part-type 前缀映射。前端 registry dispatch 用。 */
export const INTERACTIVE_TOOL_NAMES = Object.keys(
  interactiveToolset,
) as readonly (keyof typeof interactiveToolset)[];
