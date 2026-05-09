import { z } from "zod";

/**
 * PermissionMode —— 会话级权限模式。三档对齐 claude-code（去掉 `plan`，
 * 因为我们的 plan 走独立 `/api/plan` 路由 + `update_plan` 执行期跟踪，不需要
 * 再做"权限锁"形态的 plan 模式；详见对话决策记录）。
 *
 * - `default`：现有行为不变。每个工具按自己的 needsApproval 决定是否弹审批，
 *   shell 看 session 的 shellApprovalPolicy，write/edit 看 .env 文件白名单等。
 *
 * - `acceptEdits`：write/edit 自动过审批（不弹卡），shell 仍然按原逻辑审批。
 *   适用场景：用户已经看过 plan / 已经决定让 agent 自由写文件的环节。
 *
 * - `bypassPermissions`：所有工具自动过。**最危险，受 settings.json 双闸控制**：
 *   1. 项目 / 用户级 settings 必须显式 `allowBypassMode: true`，否则切换被拒
 *   2. 任一层级 settings 写了 `disableBypassPermissionsMode: "disable"` →
 *      永久禁用，连 1 都覆盖不掉（kill switch）
 *
 * ACL（rules）跟 mode 协同：**ACL deny 永远优先于 mode**。即使 mode = bypass，
 * ACL 命中 deny 仍然拦下来——这是 settings.json 设计的"组织 / 安全护栏"语义。
 * mode 只能在"没规则匹配"那条路径上自动放行。
 *
 * 决策树（B2 在 tool-helpers.ts 里实现）：
 *   1. ACL evaluator → deny / allow / ask / null
 *   2. deny  → 拦
 *   3. allow → 过
 *   4. ask   → 弹审批
 *   5. null  → 看 mode：
 *        - bypassPermissions（且双闸放行）→ 过
 *        - acceptEdits + tool ∈ {write, edit} → 过
 *        - 其它 → 落回 tool 自己的 needsApproval
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
] as const;

export const permissionModeSchema = z.enum(PERMISSION_MODES);

export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/**
 * 健壮转换：unknown → PermissionMode。
 * 任意非法值 → DEFAULT。绝不抛——这条路径常见于"老 thread 没这个字段"或者
 * 前端传错，我们只想优雅降级。
 */
export function normalizePermissionMode(value: unknown): PermissionMode {
  const result = permissionModeSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_PERMISSION_MODE;
}
