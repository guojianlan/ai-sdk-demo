import { wrapLanguageModel } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { devToolsMiddleware } from "@ai-sdk/devtools";

import { env } from "@/lib/env";
import { loggingMiddleware } from "@/lib/middleware/logging";

/**
 * 给 LLM 模型叠一层或多层可观测性 middleware。
 *
 * 目前叠两层（内到外：先跑 logging，再跑 devtools）：
 * - `loggingMiddleware` —— 自写，往 stdout 打一行简明日志（P2-c 的学习成果）
 * - `devToolsMiddleware` —— 官方 `@ai-sdk/devtools`，往 .devtools/ 持久化给 Web UI
 *
 * 两者关注点正交：logging 给"终端里瞄一眼"，devtools 给"Web UI 里翻详情"，
 * 不冲突，可以同时开。都受 `NODE_ENV !== "production"` 门控。
 */
const enabled = !env.isProduction;

export function instrumentModel(model: LanguageModelV3): LanguageModelV3 {
  if (!enabled) {
    return model;
  }

  return wrapLanguageModel({
    model,
    // `middleware` 支持数组；按顺序 compose：数组靠前的在外层。
    // 我们把 logging 放在最外层，所以它看到的是"整体耗时"（含 devtools 的写文件 overhead）。
    middleware: [loggingMiddleware(), devToolsMiddleware()],
  });
}
