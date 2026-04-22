import { tool } from "ai";
import { z } from "zod";

import { toolOk } from "@/lib/tool-result";

/**
 * P3-c 后续：`update_plan` 工具，给 agent 在执行期维护一份 **结构化、实时更新**
 * 的任务 plan。每次调用 = 一次快照（完整步骤列表），不是 diff。
 *
 * 和 Plan mode（P2-b 的 `/api/plan`）的区别：
 * - Plan mode：用户在开动前生成的**静态提案**，review 后当 markdown 发给 agent
 * - update_plan：**执行期的活对象**，agent 自己随着工作进度改 step.status / 加步骤
 *
 * 存储：plan state 就存在 UI message 的 `tool-update_plan` part 的 `input` 字段里，
 * P3-b 的 DB 自动持久化。前端读最新一次 update_plan 的 input 作为"当前 plan 视图"。
 *
 * 不做 diff 是故意的——"全量快照 + 每次重写"比 "diff 累加" 对 LLM 更友好，
 * 它不用记"我之前说过啥要改啥"，每次把完整现状重新发一遍即可。codex 的同名工具
 * 就是这个设计。
 */

export const planStepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "blocked",
  "skipped",
]);

export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

export const planStepSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Stable short id for this step. Pick something semantic like 'collect-files' or 'step-1'. MUST be consistent across update_plan calls — don't rename ids between snapshots.",
    ),
  title: z
    .string()
    .min(1)
    .describe("One-line imperative title of the step. Be concrete."),
  status: planStepStatusSchema.describe(
    "Current status. `pending` = not started, `in_progress` = currently working on, `done` = finished, `blocked` = can't proceed (add a note), `skipped` = deliberately not doing (add a note).",
  ),
  note: z
    .string()
    .optional()
    .describe(
      "Optional one-liner attached to this step. Use for: why blocked, what was actually done if nontrivial, why skipped.",
    ),
});

export type PlanStep = z.infer<typeof planStepSchema>;

export const updatePlanInputSchema = z.object({
  goal: z
    .string()
    .min(1)
    .describe(
      "The overall task this plan addresses. Short, user-facing. Keep this stable across updates unless the goal itself changes.",
    ),
  steps: z
    .array(planStepSchema)
    .min(1)
    .max(12)
    .describe(
      "The CURRENT FULL list of steps. Send the whole list every time you call this tool — not a diff. Typically 3–7 items.",
    ),
});

export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

export const updatePlanTool = tool({
  description: [
    "Maintain a live, structured plan the user can see in the UI while you work. Each call is a SNAPSHOT of the whole plan (not a delta).",
    "",
    "WHEN TO USE:",
    "- Multi-step tasks (>= 3 distinct steps). Call this EARLY (right after clarification, before diving into tools) to commit to a plan.",
    "- Call AGAIN whenever state changes: a step finishes → status=done; you hit an obstacle → status=blocked + note; the plan itself needs adjusting (add/remove/reorder steps) → send the updated full list.",
    "- Do not update the plan for trivial reasons (like reordering a note). Each call shows in the chat history, so avoid noise.",
    "",
    "WHEN NOT TO USE:",
    "- Trivial one-step tasks (one-line fix, single read, single rename).",
    "- Before the CLARIFICATION GATE is satisfied — don't commit to a plan until you know what you're building.",
    "- For open-ended exploratory questions where there's no linear plan.",
    "",
    "FIELDS:",
    "- `goal`: the overall task (one line).",
    "- `steps[]`: each has `id` (stable across updates!), `title`, `status`, optional `note`.",
    "- Status values: pending / in_progress / done / blocked / skipped.",
    "",
    "DISCIPLINE:",
    "- Keep `id` stable across updates — don't rename step-1 to step-a between snapshots, the UI uses ids to track which step is which.",
    "- Typically only one step should be `in_progress` at a time.",
    "- Send the WHOLE list every time — the tool does not merge deltas.",
  ].join("\n"),
  inputSchema: updatePlanInputSchema,
  // 服务端 execute 是一个 no-op：plan state 本身就活在 tool call 的 input 里，
  // 持久化靠 P3-b 的 DB，UI 渲染也只读 input。execute 只是返回一个简短 ack
  // 让 agent 的 tool loop 能推进到下一步。
  execute: async (input) => {
    const doneCount = input.steps.filter((s) => s.status === "done").length;
    const inProgressCount = input.steps.filter(
      (s) => s.status === "in_progress",
    ).length;
    return toolOk({
      acknowledged: true as const,
      stepCount: input.steps.length,
      doneCount,
      inProgressCount,
    });
  },
});

export const planToolset = {
  update_plan: updatePlanTool,
};
