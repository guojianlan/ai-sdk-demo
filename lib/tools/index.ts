/**
 * 工具集 barrel —— 统一从这里 export 所有自家工具及组合后的 toolset。
 *
 * 命名 / 文件布局对齐 open-agents `packages/agent/tools/*.ts`：
 *   read · write · edit · glob · grep · todo_write · task · skill ·
 *   ask_user_question · ask_choice · show_reference
 *
 * （ask_choice / show_reference 是我们自家的，open-agents 没对应物。
 *  weather MCP tools 在请求时由 chat workflow 动态合并进来，不在此处。）
 */

import { askChoiceTool } from "./ask-choice";
import { askUserQuestionTool } from "./ask-user-question";
import { editTool, writeTool } from "./write";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { shellTool } from "./shell";
import { showReferenceTool } from "./show-reference";
import { skillTool } from "./skill";
import { taskTool } from "./task";
import { todoWriteTool } from "./todo";

// 单个工具：调用方按需 import 也走这个文件，保留 barrel 一致性。
export {
  askChoiceTool,
  askUserQuestionTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  shellTool,
  showReferenceTool,
  skillTool,
  taskTool,
  todoWriteTool,
  writeTool,
};

// Toolset 分组——按"用途 + access mode"组合。
// chat workflow 根据 access mode 决定挂哪几组（参考 app/workflows/chat.ts）。

/** 只读工作区工具：read / glob / grep。workspace-tools mode 下挂上。 */
export const workspaceToolset = {
  read: readTool,
  glob: globTool,
  grep: grepTool,
} as const;

/** 写入工具：write / edit。在 workspace-tools mode 下挂上，直接落盘（无审批）。 */
export const writeToolset = {
  write: writeTool,
  edit: editTool,
} as const;

/**
 * Shell 工具：在 workspace 下跑非交互 bash 命令。审批走 session 配置的
 * shellApprovalPolicy（never / untrusted / always）。
 */
export const shellToolset = {
  shell: shellTool,
} as const;

/** 子 agent 工具：把"摸清一块代码"委派给只读 explorer subagent。 */
export const subagentToolset = {
  task: taskTool,
} as const;

/** 进度追踪工具：todo_write（live plan snapshot）。所有 access mode 都挂。 */
export const planToolset = {
  todo_write: todoWriteTool,
} as const;

/**
 * 交互工具：跟用户要输入/选择/确认。所有 access mode 都挂——`no-tools` 模式
 * 也允许 agent 追问。
 *
 * 注意：这里第一个 key 是 `ask_user_question`（对齐 open-agents），剩下两个
 * （`ask_choice` / `show_reference`）是我们自家加的。
 */
export const interactiveToolset = {
  ask_user_question: askUserQuestionTool,
  ask_choice: askChoiceTool,
  show_reference: showReferenceTool,
} as const;

/** Skill 系统的 hybrid 入口：按 name 加载 SKILL.md body 回模型。 */
export const skillToolset = {
  skill: skillTool,
} as const;

// 共享 context helper（任意工具的 sandbox/workspaceName/shell-approval-policy 提取）。
export {
  getShellApprovalPolicy,
  getWorkspaceToolContext,
  type WorkspaceToolContext,
} from "./context";

// Shell 审批策略类型 + 默认值 + 安全命令判定，方便 UI / route / 测试 import。
export {
  DEFAULT_SHELL_APPROVAL_POLICY,
  SHELL_APPROVAL_POLICIES,
  isKnownSafeCommand,
  normalizeShellApprovalPolicy,
  shellNeedsApproval,
  type ShellApprovalPolicy,
} from "./shell-approval";

// re-export plan/todo schema，UI 端的 UpdatePlanCard 之前从 lib/plan-tools.ts 拿，
// 现在统一走 lib/tools 这个 barrel。
export {
  planStepSchema,
  planStepStatusSchema,
  todoWriteInputSchema,
  type PlanStep,
  type PlanStepStatus,
  type TodoWriteInput,
} from "./todo";
