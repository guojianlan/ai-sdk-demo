import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { env } from "@/lib/env";

import {
  EMPTY_SETTINGS,
  type HooksConfig,
  type Settings,
  settingsSchema,
} from "./types";

/**
 * Settings 加载器 —— 层级查找 + 合并。
 *
 * 查找顺序（最具体 → 最不具体）：
 *   cwd/.agents/settings.json
 *   cwd/../.agents/settings.json
 *   ...（向上直到 $HOME 或 git root，含 git root 那一层）
 *   ~/.local-agent/settings.json   ← 用户全局兜底
 *
 * 合并语义：
 * - `rules`：拼接，**closer-to-cwd 排在前面**（evaluator 按顺序匹配，前面优先）
 * - `allowBypassMode`：**closer wins**（写了就覆盖外层）
 * - `disableBypassPermissionsMode`：**any-level wins**（kill switch，任一层级写了
 *   `"disable"`，结果就是 `"disable"`，项目级反不回来）
 *
 * 设计参考 claude-code 的 settings.json 层级机制 + Git 工具的 `.gitignore` 多层
 * 查找思路。我们没有抄它的 `Tool(pattern)` 字符串语法，改用 zod 对象。
 */

const SETTINGS_FILENAME = "settings.json";
const PROJECT_SETTINGS_DIR = ".agents";

/**
 * 从 startDir 起向上找候选项目级 settings.json 路径。
 * 返回顺序：closest-to-startDir 在前。
 *
 * 终止条件（命中任一即停，**且当前层依然计入**）：
 * - 当前目录是 fs 根（再上没有 parent 了）
 * - 当前目录是 $HOME（避免越过用户主目录乱挖别的项目）
 * - 当前目录是 git root（含 .git 子项 —— 单仓约束在 repo 范围内）
 */
function findProjectSettingsPaths(startDir: string): string[] {
  const result: string[] = [];
  const home = os.homedir();
  let current = path.resolve(startDir);

  // 用一个有上限的循环防御 —— 正常 fs 不会有 64 层，但避免边界 case 死循环。
  for (let depth = 0; depth < 64; depth++) {
    result.push(path.join(current, PROJECT_SETTINGS_DIR, SETTINGS_FILENAME));

    if (current === home) break;

    if (
      fs.existsSync(path.join(current, ".git")) &&
      // depth>0 防止 startDir 本身就是 git root 时立即退出（已经 push 了，再 break）
      // 但其实 push 完就 break 也是对的语义，只是写法上更显式
      true
    ) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break; // fs 根
    current = parent;
  }

  return result;
}

/** 用户全局 settings 路径：`~/.local-agent/settings.json`（依赖 env.storageDir）。 */
function userGlobalSettingsPath(): string {
  return path.join(env.storageDir, SETTINGS_FILENAME);
}

/**
 * 读 + parse 单个文件。任何失败（不存在 / IO / JSON / schema）都返回 null + warn，
 * **绝不抛**。settings 失效绝对不能让整个应用起不来。
 */
function readAndParseSettings(filePath: string): Settings | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    console.warn(
      `[permissions] cannot read ${filePath}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[permissions] invalid JSON in ${filePath}: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return null;
  }

  const result = settingsSchema.safeParse(parsedJson);
  if (!result.success) {
    console.warn(
      `[permissions] schema mismatch in ${filePath}: ${result.error.message}`,
    );
    return null;
  }

  return result.data;
}

/**
 * 把 override 合并到 base 上。`override` 是更具体的（closer-to-cwd）。
 *
 * - rules：override 在前，base 在后（evaluator 头取胜，所以更具体的优先）
 * - allowBypassMode：override 没写就继承 base
 * - disableBypassPermissionsMode：任一层 "disable" 就 sticky
 */
function mergeSettings(base: Settings, override: Settings): Settings {
  const disableSticky =
    base.disableBypassPermissionsMode === "disable" ||
    override.disableBypassPermissionsMode === "disable";

  return {
    rules: [...override.rules, ...base.rules],
    allowBypassMode: override.allowBypassMode ?? base.allowBypassMode,
    disableBypassPermissionsMode: disableSticky ? "disable" : undefined,
    // memoryEnabled：closer-wins。override 显式写了（true / false）就用 override；
    // 没写（undefined）就继承 base。最终 undefined 由消费层（isMemoryEnabled）按
    // 默认 true 处理。漏写这一行 → user-global 设的 false 在合并时被丢，bug。
    memoryEnabled: override.memoryEnabled ?? base.memoryEnabled,
    // hooks：按事件分组分别拼接，跟 rules 一样 closer-to-cwd 在前。
    // 任一层没写整个 hooks 字段就直接传另一层；两层都写时按事件分别 concat。
    hooks: mergeHooksConfig(base.hooks, override.hooks),
  };
}

/**
 * 合并两层 `hooks` 配置：override（更具体）在前、base（更外层）在后。
 * 任一层为 undefined 就直接返回另一层（避免造空对象增噪音）。
 *
 * 单个事件桶用数组拼接：同一个 hook name 在两层都写了也都会被注册，loader 之后
 * 会去掉重复（同一个 factory 实例化两次没意义，但行为上 idempotent）。
 */
function mergeHooksConfig(
  base: HooksConfig | undefined,
  override: HooksConfig | undefined,
): HooksConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  const events: Array<keyof HooksConfig> = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ];
  const out: HooksConfig = {};
  for (const event of events) {
    const o = override[event];
    const b = base[event];
    if (o && b) out[event] = [...o, ...b];
    else if (o) out[event] = o;
    else if (b) out[event] = b;
  }
  return out;
}

/**
 * 主入口：从 cwd（默认 process.cwd()）加载并合并所有层级的 settings。
 *
 * 没有任何文件存在 → 返回 EMPTY_SETTINGS（不抛）。
 *
 * **不缓存**：settings.json 修改后需要立即生效（开发体验）；调用频率不高
 * （每次 chat 请求一次），磁盘读 + JSON.parse 成本可忽略。如果将来跑高频
 * （per-tool-call），再加 mtime-based 缓存。
 */
export function loadSettings(cwd: string = process.cwd()): Settings {
  // 处理顺序：从最不具体到最具体（每次合并 override 是更具体的那一份）
  let merged: Settings = EMPTY_SETTINGS;

  // 1. 用户全局（最不具体）
  const userSettings = readAndParseSettings(userGlobalSettingsPath());
  if (userSettings) merged = mergeSettings(merged, userSettings);

  // 2. 项目层级，从 farthest 到 closest（closest 最后合，最具体）
  const projectPaths = findProjectSettingsPaths(cwd);
  for (let i = projectPaths.length - 1; i >= 0; i--) {
    const projSettings = readAndParseSettings(projectPaths[i]);
    if (projSettings) merged = mergeSettings(merged, projSettings);
  }

  return merged;
}

/**
 * 只加载项目层级 settings，不包含用户全局 settings。
 *
 * 用途：command hooks 这类能执行本地命令的能力必须由项目显式启用，不能从
 * `~/.local-agent/settings.json` 全局继承到所有仓库。
 */
export function loadProjectSettings(cwd: string = process.cwd()): Settings {
  let merged: Settings = EMPTY_SETTINGS;
  const projectPaths = findProjectSettingsPaths(cwd);
  for (let i = projectPaths.length - 1; i >= 0; i--) {
    const projSettings = readAndParseSettings(projectPaths[i]);
    if (projSettings) merged = mergeSettings(merged, projSettings);
  }
  return merged;
}

/**
 * 调试 / 内省用：返回所有"被检查过的候选路径"（不管文件是否存在）。
 * UI 想给"当前生效的 settings 来自哪里"提示时可以用。
 */
export function listSettingsCandidatePaths(
  cwd: string = process.cwd(),
): { source: "project" | "user-global"; path: string; exists: boolean }[] {
  const out: {
    source: "project" | "user-global";
    path: string;
    exists: boolean;
  }[] = [];
  for (const p of findProjectSettingsPaths(cwd)) {
    out.push({ source: "project", path: p, exists: fs.existsSync(p) });
  }
  const userPath = userGlobalSettingsPath();
  out.push({
    source: "user-global",
    path: userPath,
    exists: fs.existsSync(userPath),
  });
  return out;
}
