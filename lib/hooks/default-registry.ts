import { toolLoggingHook } from "./builtin/tool-logging";
import { HookRegistry } from "./runtime";

/**
 * `defaultHookRegistry` —— 进程级单例。
 *
 * P9-b 决定：
 * - **`toolLoggingHook` 默认注册**：可观测性是 cheap-and-good，每个 tool 跑完打一行
 *   stdout 不影响行为，方便 e2e + 用户排错。
 * - **`dotenvBlocklistHook` 默认 NOT 注册**：硬 deny 会绕过现有 `env.dotEnvFileApproval`
 *   approval 卡，对单用户学习项目可能太严。P9-c 接 settings.json 之后再决定怎么
 *   声明式开关；想现在就开的项目可以在自己代码里：
 *
 *   ```ts
 *   import { defaultHookRegistry, dotenvBlocklistHook } from "@/lib/hooks";
 *   defaultHookRegistry.register(dotenvBlocklistHook());
 *   ```
 *
 * 单例好处：跨请求复用，新请求不用重 register；坏处是单测要小心 leak，所以单测
 * 一律新建 `new HookRegistry()`，不动这个全局。
 */
export const defaultHookRegistry = new HookRegistry();

defaultHookRegistry.register(toolLoggingHook());
