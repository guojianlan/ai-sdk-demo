import { globalRegistry } from "@/lib/tooling";

import { interactiveTools } from "@/lib/tools/interactive";
import { lintTools } from "@/lib/tools/lint";
import { planTools } from "@/lib/tools/plan";
import { subagentTools } from "@/lib/tools/subagent";
import { workspaceTools } from "@/lib/tools/workspace";
import { writeTools } from "@/lib/tools/write";

/**
 * 仓库 tool 注册中心。
 *
 * 这个文件 import 一次就把所有业务 tool 注册进 `globalRegistry`。
 * 任何调 `globalRegistry.pick(...)` / `globalRegistry.byKind(...)` 的代码，
 * 必须先 import 这个 module 触发副作用（路由 / source resolver / 测试代码）。
 *
 * 推荐做法：在 `lib/agent/source.ts` 顶部 `import "@/lib/tools"`，让 source
 * resolver 启动期就把 registry 填满。
 */

globalRegistry.register(
  ...workspaceTools,
  ...writeTools,
  ...subagentTools,
  ...interactiveTools,
  ...lintTools,
  ...planTools,
);

export { globalRegistry };
