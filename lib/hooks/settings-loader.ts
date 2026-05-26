import type {
  CommandHookGroup,
  HookConfigEntry,
  HookDeclaration,
  HooksConfig,
  Settings,
} from "@/lib/permissions";

import { dotenvBlocklistHook } from "./builtin/dotenv-blocklist";
import { toolLoggingHook } from "./builtin/tool-logging";
import { commandHook } from "./command";
import { HookRegistry } from "./runtime";
import type { HookEvent, RegisteredHook } from "./types";

/**
 * 把 `settings.json` 里 `hooks` 字段还原成可执行的 `HookRegistry`。
 *
 * **核心约束（安全）**：settings.json 只能引用 `HOOK_FACTORIES` 里已声明的 name，
 * 不能直接定义 JS。这跟 Claude Code 外部 command/prompt hook 的设计不同 ——
 * 那条路是 P9-d 的事，本文件只管"按名字开关 in-process named hook"。
 *
 * 设计：每个 factory 同时声明它服务的事件（如 `dotenvBlocklistHook` 是 PreToolUse），
 * settings 里如果把它丢错事件桶（比如挂到 PostToolUse 下）就 warn + skip。
 * 这避免了"用户把 deny-only hook 挂到 PostToolUse、deny 在那个切点上没用"这种
 * 静默失败。
 */

interface HookFactoryEntry {
  /** 这个 hook 服务的事件；settings 必须把它挂在同事件桶下。 */
  event: HookEvent;
  create: (opts: { matcher?: string; name?: string }) => RegisteredHook<HookEvent>;
}

/**
 * 已知 hook 工厂表 —— 内置 hook 的唯一入口。
 * 新增内置 hook 时往这里 append；外部 (P9-d 外部 command) 走另一条路。
 */
const HOOK_FACTORIES: Record<string, HookFactoryEntry> = {
  "dotenv-blocklist": {
    event: "PreToolUse",
    create: (opts) => dotenvBlocklistHook(opts) as unknown as RegisteredHook,
  },
  "tool-logging": {
    event: "PostToolUse",
    create: (opts) => toolLoggingHook(opts) as unknown as RegisteredHook,
  },
};

/**
 * 已知 hook name 列表 —— 给前端 / 配置 UI 提示用。
 * 同步从 `HOOK_FACTORIES` keys 取，单一事实源。
 */
export function listKnownHookNames(): Array<{ name: string; event: HookEvent }> {
  return Object.entries(HOOK_FACTORIES).map(([name, { event }]) => ({
    name,
    event,
  }));
}

/**
 * 把 settings.hooks 解码成可注入到 wrapToolsetWithHooks 的 `HookRegistry`。
 *
 * 行为：
 * - 未知 name → warn 并跳过（settings.json 拼写错误不该让流水线挂掉）
 * - 事件分桶错位（如把 dotenv-blocklist 挂到 PostToolUse）→ warn 并跳过
 * - 同名重复声明 → 都注册（HookRegistry 不做去重，runtime 顺序触发各自跑一遍）
 *
 * 没有 settings.hooks → 返回空 registry（不抛）。
 */
export function buildHookRegistryFromSettings(settings: Settings): HookRegistry {
  const reg = new HookRegistry();
  const cfg = settings.hooks;
  if (!cfg) return reg;

  const events: Array<keyof HooksConfig> = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ];

  for (const event of events) {
    const declarations = cfg[event];
    if (!declarations || declarations.length === 0) continue;
    for (const decl of declarations) {
      if (isNamedHookDeclaration(decl)) {
        registerOne(reg, event, decl);
      }
    }
  }
  return reg;
}

/**
 * 从项目级 settings 构建 command hook registry。
 *
 * 安全边界：调用方必须传入 `loadProjectSettings(cwd)` 的结果，不应传全局合并后的
 * `loadSettings(cwd)`。这样 `~/.local-agent/settings.json` 不能把 command hook
 * 默认注入所有项目。
 */
export function buildCommandHookRegistryFromProjectSettings(
  settings: Settings,
  opts: { cwd: string },
): HookRegistry {
  const reg = new HookRegistry();
  const cfg = settings.hooks;
  if (!cfg) return reg;

  const events: Array<keyof HooksConfig> = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ];

  for (const event of events) {
    const declarations = cfg[event];
    if (!declarations || declarations.length === 0) continue;
    for (const decl of declarations) {
      if (isCommandHookGroup(decl)) {
        registerCommandGroup(reg, event, decl, opts.cwd);
      }
    }
  }

  return reg;
}

function registerOne(
  reg: HookRegistry,
  declaredEvent: HookEvent,
  decl: HookDeclaration,
): void {
  const factory = HOOK_FACTORIES[decl.name];
  if (!factory) {
    console.warn(
      `[hooks/settings] unknown hook name "${decl.name}" under ${declaredEvent}; skipping. Known: ${Object.keys(HOOK_FACTORIES).join(", ") || "(none)"}`,
    );
    return;
  }
  if (factory.event !== declaredEvent) {
    console.warn(
      `[hooks/settings] hook "${decl.name}" is a ${factory.event} hook; refusing to register under ${declaredEvent}`,
    );
    return;
  }
  const hook = factory.create({ matcher: decl.matcher, name: decl.name });
  reg.register(hook);
}

/**
 * 把 `src` 注册表里的所有 hook 复制注册到 `dest`。
 *
 * 用途：workflow 里把 `defaultHookRegistry`（默认挂日志）和 settings-derived
 * registry 合到一个跑流水线 —— 而不是把 default 改成可变全局。
 * 调用顺序：先 default，后 settings → settings 声明的 hook 排在后面跑。
 */
export function copyHooksInto(dest: HookRegistry, src: HookRegistry): void {
  const events: HookEvent[] = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ];
  for (const event of events) {
    for (const hook of src.list(event)) {
      dest.register(hook);
    }
  }
}

function isNamedHookDeclaration(entry: HookConfigEntry): entry is HookDeclaration {
  return "name" in entry;
}

function isCommandHookGroup(entry: HookConfigEntry): entry is CommandHookGroup {
  return "hooks" in entry;
}

function registerCommandGroup(
  reg: HookRegistry,
  event: HookEvent,
  group: CommandHookGroup,
  cwd: string,
): void {
  group.hooks.forEach((handler, index) => {
    reg.register(
      commandHook({
        event,
        matcher: group.matcher,
        command: handler.command,
        timeoutSec: handler.timeout,
        statusMessage: handler.statusMessage,
        cwd,
        name: `${event}:command:${index}:${handler.command}`,
      }),
    );
  });
}
