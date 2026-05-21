import { defineHook } from "../define";
import type { PostToolUsePayload, RegisteredHook } from "../types";

/**
 * `toolLoggingHook` —— P9-b 首发内置 hook 之二。
 *
 * 每次 tool 跑完往 stdout 写一行结构化日志：
 *
 *   `[hooks] post tool=write ok=true duration=12ms`
 *
 * 字段对齐 roadmap "model / tool / duration / ok"，但 model name 不在 PostToolUse
 * payload 里（需要从 ctx 取且当前没传），暂时省略，等 P9-c 把模型信息穿进 ctx
 * 再补。够现在 e2e 验证用就行——主要是让"hook 真的跑了"留下可观测痕迹。
 *
 * `ok` 判定逻辑：
 * - 自家 `ToolResult<T>` 形状（含 `ok` 字段）→ 直接读
 * - 其它形状（MCP 工具 / shell 工具）→ 默认按 ok 计；execute 抛错被 wrap-toolset
 *   塞成 `{ok:false,error}` 喂 hook 那条 case 也是按 ok 字段读
 */

const HOOK_NAME = "tool-logging";

function isOk(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return true;
  if (!("ok" in result)) return true;
  return (result as { ok: unknown }).ok === true;
}

export function toolLoggingHook(
  opts: { matcher?: string; name?: string } = {},
): RegisteredHook<"PostToolUse"> {
  return defineHook<"PostToolUse">({
    event: "PostToolUse",
    name: opts.name ?? HOOK_NAME,
    matcher: opts.matcher, // 默认 undefined = 所有工具
    handler: (payload: PostToolUsePayload) => {
      const ok = isOk(payload.result);
      // 单行 stdout：便于直接 grep `[hooks] post tool=write`。
      console.log(
        `[hooks] post tool=${payload.toolName} ok=${ok} duration=${payload.durationMs}ms`,
      );
    },
  });
}
