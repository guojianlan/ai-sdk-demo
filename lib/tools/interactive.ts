import { z } from "zod";

import { defineTool } from "@/lib/tooling";

/**
 * 交互工具集 —— `kind: "interactive"`，**不传 execute**：抽象层会让 AI SDK 把
 * tool-call 直接回传给客户端等用户填，runner 通过 `onAwaitingInteractive` 暂停
 * 并把用户输入打成 `tool-result` part 拼回 messages。
 *
 * 三个起手式：
 * - `ask_question`    开放追问（"要处理哪个文件？"）
 * - `ask_choice`      多选一（"dev / prod？"）
 * - `show_reference`  展示外链/引用卡，让用户确认看过
 *
 * 加新姿势：调 `defineTool({ kind: "interactive", ... })`，定义好 input/output
 * schema 即可；客户端 UI 负责渲染并通过 `submitToolResult(toolCallId, output)`
 * 把用户输入回灌。当前 ClientHome 的 AgentInteractiveCard 用一刀切的"文本框 +
 * { answer }"，如果新工具需要别的 UI 形态，要同时扩前端 dispatcher。
 */

export const askQuestionTool = defineTool({
  name: "ask_question",
  kind: "interactive",
  displayName: "ask question",
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

export const askChoiceTool = defineTool({
  name: "ask_choice",
  kind: "interactive",
  displayName: "ask choice",
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

export const showReferenceTool = defineTool({
  name: "show_reference",
  kind: "interactive",
  displayName: "show reference",
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

export const interactiveTools = [
  askQuestionTool,
  askChoiceTool,
  showReferenceTool,
];

/** 工具名 → AI SDK part-type 前缀映射。前端 registry dispatch 用。 */
export const INTERACTIVE_TOOL_NAMES = interactiveTools.map((t) => t.name);
