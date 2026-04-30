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
import { globalRegistry } from "@/lib/tooling";
// 副作用 import：触发 lib/tools/index.ts 注册全部业务 tool 到 globalRegistry。
// 必须放在 globalRegistry.pick(...) 之前。
import "@/lib/tools";

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

  const clarificationGate = [
    "CLARIFICATION GATE (apply on EVERY turn, BEFORE you do anything else — including tool calls or long prose):",
    "",
    "1. SELF-CHECK (always): am I about to commit to a specific choice on the user's behalf — a design, a library, an approach, a scope, a style? If YES → STOP. Call `ask_choice` with your pick as `recommendedId` and up to 5 options. Listing A/B/C/D in plain text when you should be calling `ask_choice` is WRONG — you are denying the user a choice while pretending to offer one.",
    "",
    "2. VAGUENESS CHECK: is the user's request short, casual, or missing concrete parameters? (e.g. '帮我改一下 X', 'help me with Y', '弄一下 Z', '优化一下', '看看能不能...'). If YES → DEFAULT to clarifying before acting. Different users write prompts at wildly different specificity levels; your job is to normalize them into a clear plan, not to guess the gap and run forward. Small prompts should NOT produce wildly different outcomes depending on how the model guesses. Prefer one round of `ask_question` / `ask_choice` over guessing.",
    "",
    "3. PRECONDITION CHECK: intent is clear, but the preconditions to act on it — which file, which strategy, which tradeoff to favor, which external constraint — may be missing. If a precondition is missing AND you cannot discover it yourself via workspace tools, STOP and clarify.",
    "",
    "4. CONFIDENCE CHECK (larger tasks only): for any task estimated to take more than ~3 steps, or touching files the user didn't explicitly name, run a confidence check before committing. If confidence is low (fuzzy scope, branching paths, missing context), clarify FIRST. The user would rather answer one up-front question than watch you undo half of your work.",
    "",
    "5. PICK THE RIGHT INTERACTIVE TOOL based on the SHAPE of the gap:",
    "   - `ask_question` → open-ended unknowns: scope, preference, constraint, or intent.",
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
    "   - the answer is in the workspace (use `search_code` / `list_files` / `read_file` instead);",
    "   - the task is small and easily reversible (single-file rename, one-line fix) — just do it and state your assumption;",
    "   - there is a single obviously-right answer — just do that;",
    "   - the user explicitly told you to pick (\"你来决定\", \"you choose\") — respect that.",
  ];

  const modeRules = hasWorkspaceTools
    ? [
        ...clarificationGate,
        "",
        "WORKSPACE USAGE (after the clarification gate is satisfied):",
        "- You have access to workspace inspection tools in this mode.",
        "- Start by inspecting the workspace with tools before you explain the project.",
        "- Read the smallest useful set of files first, then expand only if needed.",
        "- Treat build output, dependency folders, and generated files as low priority unless the user asks for them.",
        "- For questions that clearly need reading many files to answer (e.g. 'how does auth work', 'what is the architecture of module X'), prefer delegating to `explore_workspace` — it runs in an isolated context and returns only a short summary, keeping this conversation lean. Don't use it for single-file lookups.",
        "- For edits: always read the target file before calling `write_file` or `edit_file`, and keep the scope tight (one concern per edit).",
        "",
        "PLAN TRACKING (`update_plan`):",
        "- For any multi-step task (>= 3 steps), call `update_plan` EARLY — right after the clarification gate is satisfied, before diving into the first tool call — to commit to an initial plan. Each step should be one concrete action, not a category.",
        "- Call `update_plan` AGAIN whenever real state changes: a step finishes → status=done; you hit an obstacle → status=blocked + note; the plan itself needs to grow or shrink → send the updated full list.",
        "- Send the WHOLE list every time (snapshot, not diff). Keep step `id` stable across updates — don't rename.",
        "- Do NOT use update_plan for trivial single-step work (one-line fix, single file rename). It's for tasks where tracking progress helps the user understand what's happening.",
        "- Typically only one step should be `in_progress` at a time.",
      ]
    : [
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
  bypassPermissions: z.boolean().default(false),
});

/**
 * 主聊天的静态工具集。MCP 动态工具由路由在请求时合并。
 *
 * 从 globalRegistry pick：所有 tool 在 `lib/tools/` 下用 `defineTool` 注册一处，
 * 这里只列名字。注意：interactive / update_plan 在所有 access mode 下都可用
 * （`no-tools` 模式也允许追问 + plan 进度），见 `route.ts` 里的 mode 分支。
 */
export const projectEngineerStaticToolset: ToolSet = globalRegistry.pick([
  // workspace readonly
  "list_files",
  "search_code",
  "read_file",
  // write
  "write_file",
  "edit_file",
  // subagent
  "explore_workspace",
  // interactive
  "ask_question",
  "ask_choice",
  "show_reference",
  // plan tracking
  "update_plan",
]);

/**
 * 用上面这套 persona / rules / schema / toolset 构造一个主聊天 agent。
 * 路由只负责决定 "这次请求加哪些额外工具"（MCP / 无）+ MCP 清理闭包。
 */
export function createProjectEngineerAgent(params: {
  tools: ToolSet;
  onFinish?: () => void | Promise<void>;
  /** P4-b：压缩过的老对话摘要（可选）。 */
  conversationSummary?: string | null;
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
      bypassPermissions: options.bypassPermissions,
    }),
    tools: params.tools,
    stepLimit: 16,
    onFinish: params.onFinish,
    conversationSummary: params.conversationSummary,
  });
}
