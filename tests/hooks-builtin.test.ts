import { describe, expect, it, vi } from "vitest";

import {
  dotenvBlocklistHook,
  HookRegistry,
  runHooks,
  toolLoggingHook,
  wrapToolsetWithHooks,
} from "@/lib/hooks";
import { toolErr, toolOk } from "@/lib/tool-result";

/**
 * 内置 hook 行为：dotenv 黑名单 + tool 日志。
 *
 * dotenv 用 `runHooks` 直接喂合成 payload，避免依赖 wrap-toolset。
 * 日志 hook 用一个真包过的假工具跑一遍 execute，确保挂在 PostToolUse 切点上。
 */

describe("dotenvBlocklistHook", () => {
  const reg = new HookRegistry();
  reg.register(dotenvBlocklistHook());

  it("命中 .env / .env.local 等：deny", async () => {
    for (const p of [".env", ".env.local", "config/.env.production", ".envrc"]) {
      const result = await runHooks(reg, "PreToolUse", {
        event: "PreToolUse",
        toolName: "write",
        input: { relativePath: p },
      });
      expect(result.decision, `path=${p}`).toBe("deny");
      expect(result.deniedBy).toBe("dotenv-blocklist");
    }
  });

  it("非 .env 路径：放过", async () => {
    const result = await runHooks(reg, "PreToolUse", {
      event: "PreToolUse",
      toolName: "write",
      input: { relativePath: "src/app.ts" },
    });
    expect(result.decision).toBeUndefined();
  });

  it("matcher 限定 write/edit/read 三个工具；其它工具名不受影响", async () => {
    const result = await runHooks(reg, "PreToolUse", {
      event: "PreToolUse",
      toolName: "shell",
      input: { relativePath: ".env" }, // shell 不会有这字段，但即使有也不该 deny
    });
    expect(result.decision).toBeUndefined();
  });

  it("input 缺 relativePath 字段：放过（避免误伤 shape 不同的工具）", async () => {
    const result = await runHooks(reg, "PreToolUse", {
      event: "PreToolUse",
      toolName: "read",
      input: { something: "else" },
    });
    expect(result.decision).toBeUndefined();
  });
});

describe("toolLoggingHook (PostToolUse)", () => {
  it("每次 tool 跑完打一行 `[hooks] post tool=... ok=... duration=...ms`", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const reg = new HookRegistry();
    reg.register(toolLoggingHook());

    const wrapped = wrapToolsetWithHooks(
      {
        write: {
          description: "fake",
          inputSchema: {},
          execute: async () => toolOk({ wrote: true }),
        },
      },
      reg,
    );
    await wrapped.write.execute!({ relativePath: "x.txt" }, {});

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^\[hooks\] post tool=write ok=true duration=\d+ms$/);
    log.mockRestore();
  });

  it("toolErr 结果按 ok=false 记录", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const reg = new HookRegistry();
    reg.register(toolLoggingHook());

    const wrapped = wrapToolsetWithHooks(
      {
        broken: {
          description: "fake",
          inputSchema: {},
          execute: async () => toolErr("boom"),
        },
      },
      reg,
    );
    await wrapped.broken.execute!({}, {});

    const line = log.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^\[hooks\] post tool=broken ok=false duration=\d+ms$/);
    log.mockRestore();
  });
});
