/**
 * 工具集 barrel —— 统一从这里 export 所有自家工具及组合后的 toolset。
 *
 * 命名 / 文件布局：
 *   read · write · edit · glob · grep · update_plan · spawn_agent · skill ·
 *   ask_user_question · ask_choice · show_reference
 *
 * 大部分对齐 open-agents `packages/agent/tools/*.ts`，例外：
 * - `update_plan` 跟着 codex 命名（详见 lib/tools/update-plan.ts 顶部）
 * - `spawn_agent` 跟着 codex 命名（前身 `task`，原本是只读 explorer subagent；
 *   P5 升级到 codex 风格的全能子 agent，详见 lib/tools/spawn-agent.ts 顶部）
 *
 * （ask_choice / show_reference 是我们自家的，open-agents 没对应物。
 *  weather MCP tools 在请求时由 chat loop 动态合并进来，不在此处。）
 */

import { askChoiceTool } from "./ask-choice";
import { askUserQuestionTool } from "./ask-user-question";
import { editTool, writeTool } from "./write";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { imageGenerationTool } from "./image-generation";
import { memoryWriteTool } from "./memory-write";
import { readTool } from "./read";
import { shellTool } from "./shell";
import { showReferenceTool } from "./show-reference";
import { skillTool } from "./skill";
import { spawnAgentTool } from "./spawn-agent";
import { updatePlanTool } from "./update-plan";

// 单个工具：调用方按需 import 也走这个文件，保留 barrel 一致性。
export {
  askChoiceTool,
  askUserQuestionTool,
  editTool,
  globTool,
  grepTool,
  imageGenerationTool,
  memoryWriteTool,
  readTool,
  shellTool,
  showReferenceTool,
  skillTool,
  spawnAgentTool,
  updatePlanTool,
  writeTool,
};

// Toolset 分组——按"用途 + access mode"组合。
// chat loop 根据 access mode 决定挂哪几组（参考 lib/chat-agent/run-loop.ts）。

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

/** 生成型媒体工具：调用配置的图像模型，并把结果落到 workspace artifact 目录。 */
export const mediaToolset = {
  image_generation: imageGenerationTool,
} as const;

/**
 * Shell 工具：在 workspace 下跑非交互 bash 命令。审批走 session 配置的
 * shellApprovalPolicy（never / untrusted / always）。
 */
export const shellToolset = {
  shell: shellTool,
} as const;

/**
 * 子 agent 工具：把 well-scoped 子任务派给独立 sub-agent。
 *
 * P5 升级：原来的 `task` 工具（只读 explorer）替换为 codex 风格的 `spawn_agent`
 * （全能子 agent，含 read/write/shell）。git 历史保留旧版本（commit 之前那次的
 * lib/tools/task.ts 和 lib/subagents/explorer.ts）。
 */
export const subagentToolset = {
  spawn_agent: spawnAgentTool,
} as const;

/** 进度追踪工具：update_plan（live plan snapshot）。所有 access mode 都挂。 */
export const planToolset = {
  update_plan: updatePlanTool,
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

/**
 * Memory 工具集：A4 `memory_write` 让 agent 主动写跨对话长期记忆。
 *
 * **不进 subAgentToolset**：子 agent 是临时执行单元，没必要让它写用户级长期
 * 记忆——主 agent 自己 commit memory 就够了。
 *
 * 项目级 settings.json `memoryEnabled: false` 时，chat loop 会过滤掉这一组。
 */
export const memoryToolset = {
  memory_write: memoryWriteTool,
} as const;

// 共享 context helper（任意工具的 sandbox/workspaceName/shell-approval-policy 提取）。
export {
  getPermissionMode,
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

// re-export plan schema，UI 端的 UpdatePlanCard 之前从 lib/plan-tools.ts 拿，
// 现在统一走 lib/tools 这个 barrel。
export {
  planEntrySchema,
  planEntryStatusSchema,
  updatePlanInputSchema,
  type PlanEntry,
  type PlanEntryStatus,
  type UpdatePlanInput,
} from "./update-plan";
