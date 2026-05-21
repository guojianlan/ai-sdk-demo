import { z } from "zod";

import { env } from "@/lib/env";
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "@/lib/permissions/mode";
import { runSubAgent } from "@/lib/subagents/sub-agent";
import { approvedTool } from "@/lib/tool-helpers";
import { toolErr, toolOk } from "@/lib/tool-result";

import { getWorkspaceToolContext } from "./context";
import {
  DEFAULT_SHELL_APPROVAL_POLICY,
  normalizeShellApprovalPolicy,
  type ShellApprovalPolicy,
} from "./shell-approval";

/**
 * 从 result.steps 抽出每个 tool 用了几次，给 UI 展示 breakdown 用。
 *
 * AI SDK 的 step 类型挺宽泛——`steps[i].toolCalls` 是 tool call 数组，每个有
 * `toolName`。这里只关心 toolName 计数，结果是 `{ read: 5, grep: 3, write: 2 }`
 * 这种形态。
 */
type StepLike = { toolCalls?: Array<{ toolName?: string }> };

function aggregateToolCalls(
  steps: ReadonlyArray<StepLike>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      const name = call.toolName;
      if (typeof name !== "string") continue;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * `spawn_agent` —— 把 well-scoped 子任务派给一个独立的 sub-agent。
 *
 * 历史：从前身 `task` 工具升级而来。`task` 把任务派给只读 explorer subagent，
 * 仅做"代码摸查"。`spawn_agent` 给 subagent 完整的 read+write+shell 工具集，
 * 真能干活——对齐 codex `multi_agents_spec.rs` 的 spawn_agent 设计。
 *
 * 关键不变量：
 * - **ACL 永远生效**：subagent 走相同的 approvedTool 决策树，settings.json 的
 *   deny 规则在 subagent 内仍然第一时间命中
 * - **审批被跳过**：subagent 在 server 后台跑，没有 UI 弹卡。`__subagent` flag
 *   告诉 approvedTool 默认跳审批；这意味着子 agent 的 write/edit/shell 是"自动批准"。
 *   想锁住就靠 ACL settings.json
 * - **不递归 spawn**：v1 子 agent 自己没有 spawn_agent 工具，防 token 失控
 *
 * 路由策略：description 里写清 WHEN TO USE / WHEN NOT TO USE，让父模型自己判断。
 */

const spawnAgentInputSchema = z.object({
  message: z
    .string()
    .min(3)
    .describe(
      "Self-contained sub-task description. Be concrete — subagent cannot ask back. Include the goal, success criteria, and any constraints. E.g. 'Add JSDoc comments to all exports in lib/persistence/*.ts; do not change behavior'.",
    ),
  fork_context: z
    .boolean()
    .optional()
    .describe(
      "If true, the subagent receives this message **plus** a brief excerpt of recent main-conversation context. Default false — subagent runs cleanly with only the message above. Set true only if the sub-task genuinely depends on prior conversation that the message can't fully restate.",
    ),
});

export const spawnAgentTool = approvedTool({
  description: [
    "Spawn an autonomous sub-agent (same toolset as you: read/write/shell) to handle a well-scoped sub-task in isolation. The subagent runs its own loop and returns a concise summary; its tool steps don't pollute your main conversation.",
    "",
    "WHEN TO USE:",
    "- A self-contained sub-task that needs 5+ tool calls (e.g. 'survey how auth works in this codebase', 'add tests for module X', 'investigate this stack trace and report root cause').",
    "- You want to preserve your main context — let the subagent read 30 files, you only see the summary.",
    "- The task is well-scoped enough that you can describe it completely in one message (subagent can't ask you back).",
    "",
    "WHEN NOT TO USE:",
    "- A 1–2 step task — just do it yourself, cheaper and more direct.",
    "- Tasks where the user might want to intervene mid-flight (subagent runs autonomously, no approval prompts).",
    "- Tasks with details that you don't yet know — clarify with `ask_user_question` first.",
    "- Tasks that produce output the user must precisely review (the user only sees a summary, not raw artifacts).",
    "",
    "INPUT:",
    "- message: COMPLETE sub-task description. Subagent can't ask you back, so include goal, scope, constraints.",
    "- fork_context (optional, default false): include main conversation excerpt. Use sparingly.",
    "",
    "OUTPUT:",
    "- summary: subagent's ≤ 800-char summary (what was done, results, any caveats/assumptions).",
    "- stepsUsed: how many tool steps subagent spent.",
    "",
    "SAFETY: subagent inherits your settings.json ACL rules — deny rules still hit. Approvals are auto-granted within the subagent (no UI to ask). Lock down sensitive paths via settings.json deny rules if you want to restrict subagent.",
  ].join("\n"),
  inputSchema: spawnAgentInputSchema,
  name: "spawn_agent",
  getRuleContent: ({ message }) => message,
  getCwd: (ctx) => getWorkspaceToolContext(ctx).sandbox.workingDirectory,
  // 父 agent spawn 子 agent 这一步本身**不弹审批**——spawn 不是直接副作用，真正
  // 改世界的是子 agent 内部的 write/shell。锁那些走 settings.json ACL。
  needsApproval: () => false,
  execute: async (
    { message, fork_context },
    { experimental_context, abortSignal },
  ) => {
    const { sandbox, workspaceName } = getWorkspaceToolContext(
      experimental_context,
    );

    // fork_context: v1 不实现真正的对话上下文转移（涉及 message history 序列化 +
    // token 控制）。先承认收到了 flag 但忽略；子 agent 永远从干净 prompt 起步。
    // TODO: 当父 agent 需要"延续主对话"时再补这个能力。
    void fork_context;

    // 透传父 agent 的 permission 设置，让子 agent 的 approvedTool 决策树跟父保持一致
    const ctx = experimental_context as {
      permissionMode?: PermissionMode;
      shellApprovalPolicy?: ShellApprovalPolicy;
      __subagentDepth?: number;
      __chatId?: string;
    };
    const permissionMode = ctx?.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const shellApprovalPolicy = normalizeShellApprovalPolicy(
      ctx?.shellApprovalPolicy ?? DEFAULT_SHELL_APPROVAL_POLICY,
    );
    const parentChatId = ctx?.__chatId;

    // 深度检查：父 agent 自身不算 subagent（depth=0），spawn 出的子 agent 是 depth=1，
    // 子 agent 再 spawn 出的孙是 depth=2，以此类推。child = parent + 1。
    // 超过 env.subAgentMaxDepth 拒绝，错误信息明确告诉父 agent，让它自己决定怎么办。
    const parentDepth = ctx?.__subagentDepth ?? 0;
    const childDepth = parentDepth + 1;
    if (childDepth > env.subAgentMaxDepth) {
      return toolErr(
        `spawn_agent depth limit reached (${env.subAgentMaxDepth}). ` +
          `Current depth=${parentDepth}; refusing to spawn at depth=${childDepth}. ` +
          `Either complete this sub-task yourself, or break it down and report back to your parent agent.`,
      );
    }

    try {
      const result = await runSubAgent({
        prompt: message,
        workspaceRoot: sandbox.workingDirectory,
        workspaceName,
        permissionMode,
        shellApprovalPolicy,
        depth: childDepth,
        abortSignal,
        parentChatId,
      });

      const toolBreakdown = aggregateToolCalls(
        result.steps as ReadonlyArray<StepLike>,
      );

      return toolOk({
        summary: result.text,
        stepsUsed: result.steps.length,
        toolBreakdown,
        depth: childDepth,
      });
    } catch (error) {
      return toolErr(error);
    }
  },
});
