import { z } from "zod";

import { interactiveTool } from "@/lib/tool-helpers";

/**
 * `ask_choice` —— 多选一（带推荐）。
 *
 * open-agents 没有这个工具，是我们项目自家加的。命名沿用 `ask_choice`，跟
 * `ask_user_question` 摆在 `lib/tools/` 同一目录里方便发现。
 */
export const askChoiceTool = interactiveTool({
  description: [
    "Ask the user to pick one option from a closed list. Always include your own recommended pick via `recommendedId` so the user can see what you would choose.",
    "",
    "WHEN TO USE:",
    "- You've narrowed the decision to 2–5 concrete options and need the user to pick.",
    "- The options have meaningful tradeoffs that the user should decide (not things you can just benchmark).",
    "",
    "WHEN NOT TO USE:",
    "- More than ~5 options — ask an open-ended question (`ask_user_question`) instead.",
    "- Only one reasonable option — just do it and mention your choice.",
    "- To confirm an action (\"yes/no\") — prefer `ask_user_question` with a clear question.",
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
