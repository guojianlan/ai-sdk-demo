import { defineHook } from "../define";
import type { PreToolUsePayload, RegisteredHook } from "../types";

import { isDotEnvFilePath } from "@/lib/workspaces";

/**
 * `dotenvBlocklistHook` —— P9-b 首发内置 hook 之一。
 *
 * 命中即 deny（不再走 approval 卡）：write / edit / read 三件武器只要 input 里的
 * 文件路径命中 `.env*`（`.env`、`.env.local`、`.env.production`、`.envrc`…）
 * 就直接拒绝。
 *
 * 跟现有 `env.dotEnvFileApproval` 的关系：
 * - 现有机制是 `needsApproval` 阶段弹审批卡，**默认 ask、用户可批准放行**。
 * - 这个 hook 是 PreToolUse 阶段硬 deny，**没有放行通道**（除非把 hook 摘了）。
 * - P9-c 接 settings.json 之后可声明式开关此 hook；想"严防"用户的项目挂上它，
 *   想"灵活审批"的就让 ACL 老路走。两条道并存，互不打架。
 *
 * matcher 写在工厂里：默认管 write / edit / read 三个工具名（精确匹配）。
 * 调用方想加自定义工具进 deny 列表，自己 `defineHook` 即可。
 */

const DEFAULT_MATCHER = "^(write|edit|read)$";

const HOOK_NAME = "dotenv-blocklist";

function extractRelativePath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const candidate = (input as { relativePath?: unknown }).relativePath;
  return typeof candidate === "string" ? candidate : undefined;
}

export function dotenvBlocklistHook(
  opts: { matcher?: string; name?: string } = {},
): RegisteredHook<"PreToolUse"> {
  return defineHook<"PreToolUse">({
    event: "PreToolUse",
    name: opts.name ?? HOOK_NAME,
    matcher: opts.matcher ?? DEFAULT_MATCHER,
    handler: (payload: PreToolUsePayload) => {
      const relativePath = extractRelativePath(payload.input);
      if (!relativePath) return; // 没路径字段就放过——shell 之类的输入形状不同
      if (!isDotEnvFilePath(relativePath)) return;
      return {
        decision: "deny",
        reason:
          "保护 .env 系列文件：本 hook 默认拒绝 write/edit/read 命中 .env*。需要的话请显式 bypass（移除 hook 或调整 settings.json）。",
      };
    },
  });
}
