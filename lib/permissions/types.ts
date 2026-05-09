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
