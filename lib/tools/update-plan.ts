import { tool } from "ai";
import { z } from "zod";

import { toolOk } from "@/lib/tool-result";

/**
 * `update_plan` —— 让 agent 在执行期维护一份**结构化、实时更新**的任务 plan。
 * 每次调用 = 一次快照（完整步骤列表），不是 diff。
 *
 * 命名 + schema 对齐 codex 的 `update_plan`（原 open-agents 那套 `todo_write`
 * 多了 id / goal / note 三个字段，实测 LLM 偶尔忘记 id 跨快照稳定，且我们的 UI
 * 没用上 id 做 reconciliation —— 收益不抵成本，简化掉）。
 *
 * Schema：
 *   { explanation?: string, plan: [{ step: string, status: pending|in_progress|completed }] }
 *
 * 跟 plan mode（`/api/plan` 路由）的区别：
 * - `/api/plan`：用户在开动前生成的**静态提案**，review 后当 markdown 发给 agent
 * - `update_plan`：**执行期的活对象**，agent 自己随着工作进度改 step.status
 *
 * 存储：plan state 就存在 UI message 的 `tool-update_plan` part 的 `input` 字段里，
 * DB 自动持久化。前端读最新一次 update_plan 的 input 作为"当前 plan 视图"。
 *
 * 不做 diff 是故意的——"全量快照 + 每次重写"比 "diff 累加" 对 LLM 更友好，
 * 它不用记"我之前说过啥要改啥"，每次把完整现状重新发一遍即可。
 */

/**
 * 三态机：对齐 codex / open-agents 的 plan tool 设计。
 * - 不放 `blocked` / `skipped`：那两个状态给了模型"自己标记跳过然后默认溜走"
 *   的逃路，破坏 Task Persistence。遇到真做不动的步骤，模型应该 `ask_user_question`
 *   找用户决定下一步，而不是悄悄 self-record blocked 就过。
 */
export const planEntryStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);

export type PlanEntryStatus = z.infer<typeof planEntryStatusSchema>;

export const planEntrySchema = z.object({
  step: z
    .string()
    .min(1)
    .describe(
      "One-line imperative title of this step. Be concrete (e.g. 'Read app/layout.tsx', not 'Investigate layout').",
    ),
  status: planEntryStatusSchema.describe(
    "Current status. `pending` = not started, `in_progress` = currently working on (only ONE step at a time), `completed` = finished.",
  ),
});

export type PlanEntry = z.infer<typeof planEntrySchema>;

export const updatePlanInputSchema = z.object({
  explanation: z
    .string()
    .optional()
    .describe(
      "Optional one-line note explaining what changed in this snapshot — e.g. 'starting step 2', 'rescoped after finding X'. Skip if redundant.",
    ),
  plan: z
    .array(planEntrySchema)
    .min(1)
    .max(12)
    .describe(
      "The CURRENT FULL list of plan entries. Send the whole list every call — not a diff. Typically 3–7 items.",
    ),
});

export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

export const updatePlanTool = tool({
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
    "- `explanation` (optional): a one-line note about what changed in this snapshot (e.g. 'starting step 2', 'rescoped after finding X').",
    "- `plan[]`: each entry has `step` (one-line imperative title) and `status` (`pending` / `in_progress` / `completed`).",
    "- Only ONE step should be `in_progress` at a time.",
    "",
    "DISCIPLINE:",
    "- Send the WHOLE list every time — the tool does not merge deltas.",
    "- Keep step ORDER stable across snapshots — the UI tracks position by index.",
    "- If you hit an obstacle, do NOT silently skip the step. Either keep it `in_progress` and call `ask_user_question` to resolve, or — if you've genuinely completed the underlying intent in a different way — mark it `completed` and use `explanation` to note what was actually done.",
  ].join("\n"),
  inputSchema: updatePlanInputSchema,
  // 服务端 execute 是一个 no-op：plan state 本身就活在 tool call 的 input 里，
  // 持久化靠 DB，UI 渲染也只读 input。execute 只是返回一个简短 ack 让 agent 的
  // tool loop 能推进到下一步。
  execute: async (input) => {
    const completedCount = input.plan.filter(
      (s) => s.status === "completed",
    ).length;
    const inProgressCount = input.plan.filter(
      (s) => s.status === "in_progress",
    ).length;
    return toolOk({
      acknowledged: true as const,
      stepCount: input.plan.length,
      completedCount,
      inProgressCount,
    });
  },
});
