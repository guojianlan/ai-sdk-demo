import { z } from "zod";

/**
 * Permission ACL —— claude-code 风格的"工具调用准入规则"。
 *
 * 设计：每条规则匹配一个 (tool, optional pattern) 二元组，给出一个 behavior。
 * Evaluator 按 deny > 首个匹配的 allow/ask 顺序裁决；都不匹配 → 落回各 tool
 * 自身的 needsApproval 默认逻辑（C3 接入时实现）。
 *
 * 跟 claude-code 的差异：
 * - 我们用 zod 对象 schema，不解析 `Tool(pattern)` 字符串。简单、可机器校验、
 *   未来想兼容 claude-code 字符串形式时再加一层解析适配器即可。
 * - 不实现 `dontAsk` —— 用户在前面收口讨论里明确不做（保持每次 ask 弹审批）。
 */

export const permissionBehaviorSchema = z.enum(["allow", "deny", "ask"]);
export type PermissionBehavior = z.infer<typeof permissionBehaviorSchema>;

/**
 * 单条规则。
 *
 * - `tool: "shell"` 精确匹配 shell 工具
 * - `tool: "*"` 匹配任意**接入 ACL 的**工具（即 approvedTool 包装的那些：
 *   shell / read / write / edit）。
 *   **不会匹配** glob / grep / update_plan / task / ask_* —— 这些 read-only
 *   或 client-only 工具不走 ACL。这跟 claude-code native 构建一致：那边
 *   glob/grep 直接嵌入 Bash（bfs/ugrep）做实现，本身不是独立可 gate 的工具。
 *   想 gate 类似行为，请规则写在 `tool: "shell"` 上（约束 grep/find/ls 命令）。
 * - `pattern` 省略 → 任意 ruleContent 都命中（适合"整个工具直接 deny"这种）
 * - `pattern` 给出 → 走 glob 匹配 ruleContent（C2 实现），匹配上才命中
 */
export const permissionRuleSchema = z.object({
  tool: z
    .string()
    .min(1)
    .describe(
      "Tool name to match. Use '*' to match all ACL-aware tools (shell / read / write / edit). Search tools (glob / grep) are NOT ACL-gated by design.",
    ),
  pattern: z
    .string()
    .optional()
    .describe(
      "Optional glob pattern matched against the rule content (e.g., shell command, file path). Omit to match any content of the named tool.",
    ),
  behavior: permissionBehaviorSchema,
});

export type PermissionRule = z.infer<typeof permissionRuleSchema>;

/**
 * settings.json 顶层 schema。
 *
 * Bypass 模式相关两个字段（claude-code 风格）：
 * - `allowBypassMode`: 用户级显式同意"允许切到 bypassPermissions 模式"。默认 false。
 *    closer-to-cwd 覆盖 farther（项目级覆盖用户全局级）。
 * - `disableBypassPermissionsMode: "disable"`: 任意层级写了就**永久禁用** bypass，
 *    项目级也覆盖不掉。是组织级 kill switch。
 */
/**
 * Hook 声明 schema（P9-c）—— settings.json 写的"开关哪些 hook"。
 *
 * **重要安全约束**：`name` 引用内部注册表（`lib/hooks/settings-loader.ts` 的
 * `HOOK_FACTORIES`），settings.json **不能定义任意 JS**。这跟 Claude Code 的
 * "外部 command/prompt hook"是两条路：那条是 P9-d 的事，本文件只管 in-process
 * named hook 的声明式开关。
 *
 * `matcher` 是字符串正则，覆盖 hook 内部的默认 matcher（如 dotenv-blocklist 默
 * 认 `^(write|edit|read)$`）。不传 → 用 factory 默认。
 */
export const hookDeclarationSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Name of a hook registered in lib/hooks/settings-loader.ts HOOK_FACTORIES.",
    ),
  matcher: z
    .string()
    .optional()
    .describe(
      "Regex string overriding the hook's default tool-name matcher. Tool events only.",
    ),
});
export type HookDeclaration = z.infer<typeof hookDeclarationSchema>;

export const hooksConfigSchema = z.object({
  PreToolUse: z.array(hookDeclarationSchema).optional(),
  PostToolUse: z.array(hookDeclarationSchema).optional(),
  UserPromptSubmit: z.array(hookDeclarationSchema).optional(),
  SessionStart: z.array(hookDeclarationSchema).optional(),
});
export type HooksConfig = z.infer<typeof hooksConfigSchema>;

export const settingsSchema = z.object({
  rules: z.array(permissionRuleSchema).default([]),
  allowBypassMode: z.boolean().optional(),
  disableBypassPermissionsMode: z.literal("disable").optional(),
  /**
   * 跨对话长期记忆系统总开关。`undefined` / `true` = 启用（默认）；`false` = 关闭。
   * 关闭后两件事一起停：
   *   - A1：MEMORY.md 不再注入 system prompt（loader 返回 null）
   *   - A4：`memory_write` 工具从 toolset 里被过滤掉，agent 看不到
   *
   * 用途：某些项目对 token 敏感 / 不想让 agent 累计长期记忆，在项目级
   * `.agents/settings.json` 写 `"memoryEnabled": false` 即可一键关掉。
   * 跟 rules / bypass 字段一样走层级合并（closer-to-cwd 覆盖外层）。
   */
  memoryEnabled: z.boolean().optional(),
  /**
   * Hook 声明（P9-c）。事件分组，每条 `{ matcher?, name }`。
   * `name` 必须在 `HOOK_FACTORIES` 已注册；未知 name 在 loader 里 warn+skip。
   *
   * 合并策略跟 `rules` 类似：closer-to-cwd 在前（事件分组分别拼接）。
   */
  hooks: hooksConfigSchema.optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** 加载失败 / 文件不存在时返回的空配置。 */
export const EMPTY_SETTINGS: Settings = {
  rules: [],
};

/**
 * Bypass 模式最终判定：先看是否被 kill-switch 永久禁用；否则看 allowBypassMode（默认 false）。
 *
 * 在多个权限层都可能问"我能不能切到 bypass"的时候，统一从这里读，避免散落。
 */
export function isBypassModeAllowed(settings: Settings): boolean {
  if (settings.disableBypassPermissionsMode === "disable") return false;
  return settings.allowBypassMode ?? false;
}

/**
 * Memory 系统是否启用。`undefined` / `true` → 启用（默认）；`false` → 关闭。
 * A1 的 loader 和 A4 的 tool filtering 都从这里读，避免散落。
 */
export function isMemoryEnabled(settings: Settings): boolean {
  return settings.memoryEnabled !== false;
}
