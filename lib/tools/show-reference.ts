import { z } from "zod";

import { interactiveTool } from "@/lib/tool-helpers";

/**
 * `show_reference` —— 给用户展示一张引用卡（标题 + URL + 摘要），等用户「看过/跳过」。
 *
 * open-agents 没有这个工具，是我们项目自家加的。
 */
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
