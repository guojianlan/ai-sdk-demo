/**
 * Permission 子系统的对外入口。所有调用方走 `import { ... } from "@/lib/permissions"`，
 * 不直接 import 子文件——便于将来重构内部布局。
 */

export {
  EMPTY_SETTINGS,
  type PermissionBehavior,
  type PermissionRule,
  type Settings,
  isBypassModeAllowed,
  isMemoryEnabled,
  permissionBehaviorSchema,
  permissionRuleSchema,
  settingsSchema,
} from "./types";

export { listSettingsCandidatePaths, loadSettings } from "./settings";

export { evaluatePermission, ruleMatches } from "./evaluate";

export {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  PERMISSION_MODES,
  permissionModeSchema,
  type PermissionMode,
} from "./mode";
