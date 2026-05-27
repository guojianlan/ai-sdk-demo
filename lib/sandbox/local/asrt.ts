import os from "node:os";
import path from "node:path";

import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import { env } from "@/lib/env";

/**
 * ASRT (Anthropic Sandbox Runtime) 适配器 —— 给 `LocalSandbox.exec()` 套一层
 * OS 级沙箱。底层 macOS 用 `sandbox-exec`，Linux 用 `bubblewrap` —— 跟 claude-code
 * 的运行时同根（`@anthropic-ai/sandbox-runtime` 是 claude-code 用的同一个 npm 包）。
 *
 * 设计要点：
 * - **单例 + 懒初始化**：`SandboxManager` 是包导出的全局实例；首次 `wrapCommand`
 *   调用时才 `initialize()`。后续直接复用。
 * - **失败软回退**：Linux 没装 bwrap、macOS 启动 proxy 失败、Windows 平台等情况
 *   —— 不抛错，记一行 warn，`wrapCommand` 直接返回原命令，`LocalSandbox.exec()`
 *   按原路径跑。这样开关打开但环境不齐时不会整个 chat 崩。
 * - **clean shutdown**：进程退出时 `reset()` 关掉 ASRT 起的 proxy 子进程，避免
 *   Next.js dev server 重启时残留。
 *
 * 配置策略（默认值，env 可覆盖）：
 * - filesystem.allowWrite = `["${cwd}", "/tmp", "${HOME}/.npm", "${HOME}/.cache"]`
 *   —— 工作区可写、临时目录可写、包管理器缓存可写
 * - filesystem.denyRead = `["${HOME}/.ssh", "${HOME}/.aws", "${HOME}/.config/gh"]`
 *   —— 这些通常不进 dev chat run，硬挡
 * - network.allowedDomains = `env.sandbox.allowedDomains`
 *   —— 默认空 = 全 deny。npm install / git push 这类要联网的，用户在 .env.local
 *   里自己加白名单
 */

type AsrtState =
  | { status: "uninitialized" }
  | { status: "initializing"; promise: Promise<void> }
  | { status: "ready" }
  | { status: "disabled"; reason: string };

let state: AsrtState = { status: "uninitialized" };

function buildConfig(workspaceRoot: string): SandboxRuntimeConfig {
  const home = os.homedir();
  return {
    network: {
      allowedDomains: env.sandbox.allowedDomains,
      deniedDomains: [],
    },
    filesystem: {
      // read：默认放行，我们只显式 deny 几个高敏感目录
      denyRead: [
        path.join(home, ".ssh"),
        path.join(home, ".aws"),
        path.join(home, ".config", "gh"),
      ],
      allowRead: [],
      // write：默认全拒绝，显式开几个洞
      allowWrite: [
        workspaceRoot,
        "/tmp",
        path.join(home, ".npm"),
        path.join(home, ".cache"),
      ],
      denyWrite: [],
    },
  };
}

async function ensureInitialized(workspaceRoot: string): Promise<void> {
  if (state.status === "ready" || state.status === "disabled") return;
  if (state.status === "initializing") {
    await state.promise;
    return;
  }

  if (!SandboxManager.isSupportedPlatform()) {
    state = {
      status: "disabled",
      reason: `platform ${process.platform} not supported by ASRT`,
    };
    return;
  }

  const promise = (async () => {
    try {
      await SandboxManager.initialize(buildConfig(workspaceRoot));
      // initialize 成功不代表沙箱真生效（依赖检查可能挂在 Linux）。
      if (!SandboxManager.isSandboxingEnabled()) {
        state = {
          status: "disabled",
          reason:
            "ASRT initialized but sandboxing not enabled (missing bwrap on Linux?)",
        };
        return;
      }
      state = { status: "ready" };
      // 进程退出时尽量清理 proxy 子进程
      const cleanup = () => {
        SandboxManager.reset().catch(() => {
          /* swallow */
        });
      };
      process.once("exit", cleanup);
      process.once("SIGTERM", cleanup);
      process.once("SIGINT", cleanup);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[asrt] initialization failed, falling back to soft sandbox: ${reason}`,
      );
      state = { status: "disabled", reason };
    }
  })();

  state = { status: "initializing", promise };
  await promise;
}

/**
 * 把一条 shell 命令包成 OS 沙箱可执行的命令字符串。
 * 沙箱不可用（开关关 / 平台不支持 / 初始化失败）→ 原样返回，由调用方继续走软沙箱。
 */
export async function wrapCommandForSandbox(
  command: string,
  workspaceRoot: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!env.sandbox.enabled) return command;
  await ensureInitialized(workspaceRoot);
  if (state.status !== "ready") return command;

  try {
    return await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      undefined,
      abortSignal,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[asrt] wrapWithSandbox failed, running unwrapped: ${reason}`);
    return command;
  }
}

/** 给上层做诊断/调试用，知道沙箱当前是否真在生效。 */
export function getSandboxStatus(): {
  configured: boolean;
  active: boolean;
  reason?: string;
} {
  return {
    configured: env.sandbox.enabled,
    active: state.status === "ready",
    reason: state.status === "disabled" ? state.reason : undefined,
  };
}
