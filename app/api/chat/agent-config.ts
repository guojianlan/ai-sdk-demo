import type { ToolSet } from "ai";
import { z } from "zod";

import { createChatAgent } from "@/lib/chat-agent/builder";
import {
  DEFAULT_WORKSPACE_ACCESS_MODE,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import { instrumentModel } from "@/lib/devtools";
import { env } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import type { SkillMetadata } from "@/lib/skills";
import {
  DEFAULT_SHELL_APPROVAL_POLICY,
  interactiveToolset,
  planToolset,
  shellToolset,
  SHELL_APPROVAL_POLICIES,
  skillToolset,
  subagentToolset,
  workspaceToolset,
  writeToolset,
  type ShellApprovalPolicy,
} from "@/lib/tools";

/**
 * 主聊天路由的"不变部分"：persona、developer rules、callOptions schema、静态工具集。
 * 把这些从 route.ts 拆出来，让 POST handler 只剩下请求处理 + agent 构造。
 */

export const projectEngineerPersona = [
  "You are a senior software engineer helping the user understand the selected workspace.",
  "Always ground your answer in the workspace files rather than assumptions.",
  "Use the available tools to inspect directories, search code, and read files before making architectural claims.",
  "When you reference a file, mention the workspace-relative path in your answer.",
  "If you do not have enough evidence from the files yet, say so and inspect more files.",
  "Prefer concise, practical explanations with an engineering focus: architecture, data flow, responsibilities, risks, and next steps.",
].join("\n");

export function buildProjectEngineerDeveloperRules(
  workspaceAccessMode: WorkspaceAccessMode,
  workspaceName: string,
): string {
  const hasWorkspaceTools = workspaceAccessMode === "workspace-tools";

  // Task Persistence —— 抄 open-agents `system-prompt.ts` 的 CORE 段。这是「不能
  // 提前 end turn」的硬契约，比单点提醒（"finished step → mark done"）效果好很多：
  // 把"完工"与"结束回合"绑定，模型只能等所有 in_progress / pending 都收成
  // completed 才能停。
  const taskPersistence = [
    "TASK PERSISTENCE:",
    "- You MUST iterate and keep going until the problem is solved. Do not end your turn prematurely.",
    "- When you say \"Next I will do X\" or \"Now I will do Y\", you MUST actually do X or Y. Never describe what you would do and then end your turn instead of doing it.",
    "- When you create a todo list (via `todo_write`), you MUST complete every item before finishing. Only terminate when all items are `completed`. NEVER end your turn while any step is still `in_progress` or `pending` — if you've actually done the work, send one more `todo_write` snapshot reflecting reality FIRST.",
    "- If you encounter an error, debug it. If the fix introduces new errors, fix those too. Continue until everything passes.",
    "- If the user's request is \"resume\", \"continue\", or \"try again\", check the todo list for the last incomplete item and continue from there without asking what to do next.",
    "- If you genuinely cannot proceed (missing info, blocked on a decision only the user can make), call `ask_user_question` to surface the obstacle — do NOT silently end your turn.",
    "- IMPORTANT: if the user rejects an approval (write / edit / shell), treat that as an explicit \"don't do this\" — do NOT retry the same operation. Acknowledge the rejection briefly and either ask what to do instead via `ask_user_question`, or end your turn cleanly. Re-issuing a rejected operation violates Persistence (you'd be ignoring the user's signal, not iterating toward the goal).",
  ];

  const clarificationGate = [
    "CLARIFICATION GATE (apply on EVERY turn, BEFORE you do anything else — including tool calls or long prose):",
    "",
    "1. SELF-CHECK (always): am I about to commit to a specific choice on the user's behalf — a design, a library, an approach, a scope, a style? If YES → STOP. Call `ask_choice` with your pick as `recommendedId` and up to 5 options. Listing A/B/C/D in plain text when you should be calling `ask_choice` is WRONG — you are denying the user a choice while pretending to offer one.",
    "",
    "2. VAGUENESS CHECK: is the user's request short, casual, or missing concrete parameters? (e.g. '帮我改一下 X', 'help me with Y', '弄一下 Z', '优化一下', '看看能不能...'). If YES → DEFAULT to clarifying before acting. Different users write prompts at wildly different specificity levels; your job is to normalize them into a clear plan, not to guess the gap and run forward. Small prompts should NOT produce wildly different outcomes depending on how the model guesses. Prefer one round of `ask_user_question` / `ask_choice` over guessing.",
    "",
    "3. PRECONDITION CHECK: intent is clear, but the preconditions to act on it — which file, which strategy, which tradeoff to favor, which external constraint — may be missing. If a precondition is missing AND you cannot discover it yourself via workspace tools, STOP and clarify.",
    "",
    "4. CONFIDENCE CHECK (larger tasks only): for any task estimated to take more than ~3 steps, or touching files the user didn't explicitly name, run a confidence check before committing. If confidence is low (fuzzy scope, branching paths, missing context), clarify FIRST. The user would rather answer one up-front question than watch you undo half of your work.",
    "",
    "5. PICK THE RIGHT INTERACTIVE TOOL based on the SHAPE of the gap:",
    "   - `ask_user_question` → open-ended unknowns: scope, preference, constraint, or intent.",
    "   - `ask_choice` → the gap is picking one of 2–5 concrete named paths. ALWAYS set `recommendedId` with your own recommendation and add a short `recommendationReason`.",
    "   - `show_reference` → an external URL (docs / issue / PR / spec) whose content would change the next step.",
    "",
    "6. SHAPE PATTERNS that almost always want `ask_choice` (not forcing — these are defaults the user can still override):",
    "   - 'X 还是 Y' / 'X 还是 Y 还是 Z [好/比较好/哪个]'",
    "   - 'X or Y' / 'which is better, X or Y'",
    "   - 'what [theme/style/library/framework/approach] should I use'",
    "   - user asks you to pick BETWEEN named options — treat as a choice question, not a recommendation request.",
    "",
    "7. DO NOT CLARIFY when:",
    "   - the answer is in the workspace (use `grep` / `glob` / `read` instead);",
    "   - the task is small and easily reversible (single-file rename, one-line fix) — just do it and state your assumption;",
    "   - there is a single obviously-right answer — just do that;",
    "   - the user explicitly told you to pick (\"你来决定\", \"you choose\") — respect that.",
  ];

  const modeRules = hasWorkspaceTools
    ? [
        ...taskPersistence,
        "",
        ...clarificationGate,
        "",
        "WORKSPACE USAGE (after the clarification gate is satisfied):",
        "- You have access to workspace inspection tools in this mode.",
        "- Start by inspecting the workspace with tools before you explain the project.",
        "- Read the smallest useful set of files first, then expand only if needed.",
        "- Treat build output, dependency folders, and generated files as low priority unless the user asks for them.",
        "- For questions that clearly need reading many files to answer (e.g. 'how does auth work', 'what is the architecture of module X'), prefer delegating to `task` — it runs in an isolated context and returns only a short summary, keeping this conversation lean. Don't use it for single-file lookups.",
        "- For edits: always read the target file before calling `write` or `edit`, and keep the scope tight (one concern per edit).",
        "",
        "SHELL (`shell`):",
        "- Use `shell` for project-level commands you can't satisfy with file/grep/glob tools: running tests, build, typecheck, git status/diff/log, package manager queries.",
        "- Prefer the dedicated tools when they apply — `read` instead of `cat`, `grep` instead of shelling out to `rg`, `glob` instead of `find`/`ls -R`.",
        "- The user has set a `shellApprovalPolicy` for this session: known-safe read-only commands run without asking; everything else may pop an approval card. If the user rejects, treat that as an explicit \"don't do this\" — do NOT retry the same command (see TASK PERSISTENCE).",
        "- Do NOT run interactive commands (vim, less, top, ssh) — there is no TTY. Don't spawn long-running servers (`next dev`, etc.) — they outlive the chat.",
        "- Don't compose with shell metacharacters that produce side-effects (`>`, `>>`, `2>&1`, command substitution, backgrounding `&`) — they're blocked by the safety check anyway.",
        "",
        "PLAN TRACKING (`todo_write`):",
        "- For any multi-step task (>= 3 steps), call `todo_write` EARLY — right after the clarification gate is satisfied, before diving into the first tool call — to commit to an initial plan. Each step should be one concrete action, not a category.",
        "- Mark a step `in_progress` BEFORE you begin work on it; mark it `completed` IMMEDIATELY after finishing, not in batches.",
        "- Only ONE step should be `in_progress` at a time.",
        "- Send the WHOLE list every time (snapshot, not diff). Keep step `id` stable across updates — don't rename.",
        "- Status values: `pending` / `in_progress` / `completed` only. If a step turns out infeasible, do NOT silently skip it — call `ask_user_question` to resolve, or mark it `completed` with a `note` explaining what was actually done in its place.",
        "- See TASK PERSISTENCE above: don't end your turn with any step still `pending` or `in_progress`.",
      ]
    : [
        ...taskPersistence,
        "",
        ...clarificationGate,
        "",
        "ACCESS LIMITATIONS (after the clarification gate is satisfied):",
        "- You know which workspace was selected, but you cannot inspect its files in this mode.",
        "- Never claim that you listed directories, searched code, or read a file.",
        "- If the user asks for project-specific facts, explain that workspace access is disabled and ask them to switch to the workspace-tools mode.",
      ];

  return [
    `Workspace display name: ${workspaceName}`,
    `Access mode: ${workspaceAccessMode}`,
    "",
    "Behavior rules for this workspace:",
    ...modeRules,
  ].join("\n");
}

export const projectEngineerCallOptionsSchema = z.object({
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
  workspaceAccessMode: z
    .enum(["workspace-tools", "no-tools"])
    .default(DEFAULT_WORKSPACE_ACCESS_MODE),
  shellApprovalPolicy: z
    .enum(SHELL_APPROVAL_POLICIES as unknown as [ShellApprovalPolicy, ...ShellApprovalPolicy[]])
    .default(DEFAULT_SHELL_APPROVAL_POLICY),
});

/**
 * 工作区 + 写入 + shell + 子 agent + 交互 + plan + skill 七套自家工具集。
 * MCP 动态工具由路由在请求时合并。
 *
 * 注意：
 * - interactiveToolset 在所有 access mode 下都可用（即使 `no-tools` 模式也允许 agent 追问）
 * - planToolset（todo_write）同样通用——多步任务的进度展示即使没工具也有价值
 * - skillToolset（skill）是 hybrid skill 系统的入口；workflow 在创建 agent 时通过
 *   experimental_context.skills 注入当前可用 skill 列表，工具按 name 读 SKILL.md body
 * - shellToolset（shell）只在 workspace-tools mode 挂；no-tools mode 下不暴露
 *   （workflow 那一侧组合 toolset 时会按 access mode 过滤）
 */
export const projectEngineerStaticToolset = {
  ...workspaceToolset,
  ...writeToolset,
  ...shellToolset,
  ...subagentToolset,
  ...interactiveToolset,
  ...planToolset,
  ...skillToolset,
};

/**
 * 用上面这套 persona / rules / schema / toolset 构造一个主聊天 agent。
 * 路由只负责决定 "这次请求加哪些额外工具"（MCP / 无）+ MCP 清理闭包。
 *
 * skills 由 workflow 在创建 agent 时通过 `getSkills()` 取出后传入，作为 system prompt
 * 的一层 + skill 工具运行时 context；不传或空数组 = skill 系统未启用。
 */
export function createProjectEngineerAgent(params: {
  tools: ToolSet;
  onFinish?: () => void | Promise<void>;
  /** P4-b：压缩过的老对话摘要（可选）。 */
  conversationSummary?: string | null;
  /** 当前会话可用 skill 列表（只 metadata，body 按需读盘）。 */
  skills?: SkillMetadata[] | null;
}) {
  return createChatAgent({
    model: instrumentModel(gateway.chatModel(env.gateway.modelId)),
    persona: projectEngineerPersona,
    callOptionsSchema: projectEngineerCallOptionsSchema,
    buildDeveloperRules: ({ options, workspaceName }) =>
      buildProjectEngineerDeveloperRules(
        options.workspaceAccessMode,
        workspaceName,
      ),
    buildExperimentalContext: ({ options, workspaceRoot, workspaceName }) => ({
      workspaceRoot,
      workspaceName,
      workspaceAccessMode: options.workspaceAccessMode,
      shellApprovalPolicy: options.shellApprovalPolicy,
    }),
    tools: params.tools,
    onFinish: params.onFinish,
    conversationSummary: params.conversationSummary,
    skills: params.skills,
  });
}
