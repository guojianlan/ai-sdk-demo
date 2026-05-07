import { tool } from "ai";
import { z } from "zod";

import { toolOk } from "@/lib/tool-result";

/**
 * `todo_write` —— 给 agent 在执行期维护一份**结构化、实时更新**的任务 plan。
 * 每次调用 = 一次快照（完整步骤列表），不是 diff。
 *
 * 命名对齐 open-agents `tools/todo.ts`（key: `todo_write`）。
 *
 * 和 Plan mode（`/api/plan`）的区别：
 * - Plan mode：用户在开动前生成的**静态提案**，review 后当 markdown 发给 agent
 * - todo_write：**执行期的活对象**，agent 自己随着工作进度改 step.status / 加步骤
 *
 * 存储：plan state 就存在 UI message 的 `tool-todo_write` part 的 `input` 字段里，
 * DB 自动持久化。前端读最新一次 todo_write 的 input 作为"当前 plan 视图"。
 *
 * 不做 diff 是故意的——"全量快照 + 每次重写"比 "diff 累加" 对 LLM 更友好，
 * 它不用记"我之前说过啥要改啥"，每次把完整现状重新发一遍即可。
 */

/**
 * 三态机：对齐 codex / open-agents 的 plan tool 设计。
 * - 不放 `blocked` / `skipped`：那两个状态给了模型「自己标记跳过然后默认溜走」
 *   的逃路，破坏 Task Persistence。遇到真做不动的步骤，模型应该 `ask_user_question`
 *   找用户决定下一步，而不是悄悄 self-record blocked 就过。
 */
export const planStepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);

export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

export const planStepSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Stable short id for this step. Pick something semantic like 'collect-files' or 'step-1'. MUST be consistent across todo_write calls — don't rename ids between snapshots.",
    ),
  title: z
    .string()
    .min(1)
    .describe("One-line imperative title of the step. Be concrete."),
  status: planStepStatusSchema.describe(
    "Current status. `pending` = not started, `in_progress` = currently working on (only ONE step at a time), `completed` = finished.",
  ),
  note: z
    .string()
    .optional()
    .describe(
      "Optional one-liner attached to this step. Use to record what was actually done if nontrivial, or to note unresolved obstacles before calling `ask_user_question`.",
    ),
});

export type PlanStep = z.infer<typeof planStepSchema>;

export const todoWriteInputSchema = z.object({
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

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;

export const todoWriteTool = tool({
  description: [
    "Maintain a live, structured plan the user can see in the UI while you work. Each call is a SNAPSHOT of the whole plan (not a delta).",
    "",
    "WHEN TO USE:",
    "- Multi-step tasks (>= 3 distinct steps). Call this EARLY (right after clarification, before diving into tools) to commit to a plan.",
    "- Call AGAIN whenever state changes: a step starts → status=in_progress (mark BEFORE you begin work); a step finishes → status=completed (mark IMMEDIATELY, not in batches); the plan itself needs adjusting (add/remove/reorder steps) → send the updated full list.",
    "- Do not update the plan for trivial reasons. Each call shows in the chat history, so avoid noise.",
    "",
    "WHEN NOT TO USE:",
    "- Trivial one-step tasks (one-line fix, single read, single rename).",
    "- Before the CLARIFICATION GATE is satisfied — don't commit to a plan until you know what you're building.",
    "- For open-ended exploratory questions where there's no linear plan.",
    "",
    "FIELDS:",
    "- `goal`: the overall task (one line).",
    "- `steps[]`: each has `id` (stable across updates!), `title`, `status`, optional `note`.",
    "- Status values: `pending` / `in_progress` / `completed`. Only ONE step should be `in_progress` at a time.",
    "",
    "DISCIPLINE:",
    "- Keep `id` stable across updates — don't rename step-1 to step-a between snapshots, the UI uses ids to track which step is which.",
    "- Send the WHOLE list every time — the tool does not merge deltas.",
    "- If you hit an obstacle, do NOT silently skip the step. Either keep it `in_progress` and call `ask_user_question` to resolve, or — if you've genuinely completed the underlying intent in a different way — mark it `completed` with a `note` explaining what was actually done.",
  ].join("\n"),
  inputSchema: todoWriteInputSchema,
  // 服务端 execute 是一个 no-op：plan state 本身就活在 tool call 的 input 里，
  // 持久化靠 DB，UI 渲染也只读 input。execute 只是返回一个简短 ack 让 agent 的
  // tool loop 能推进到下一步。
  execute: async (input) => {
    const completedCount = input.steps.filter(
      (s) => s.status === "completed",
    ).length;
    const inProgressCount = input.steps.filter(
      (s) => s.status === "in_progress",
    ).length;
    return toolOk({
      acknowledged: true as const,
      stepCount: input.steps.length,
      completedCount,
      inProgressCount,
    });
  },
});
