import { describe, expect, it, vi } from "vitest";

import { defineHook, HookRegistry, runHooks } from "@/lib/hooks";

/**
 * P9-a hook runtime 行为覆盖。
 *
 * 这里测的是"事件模型"本身：注册/匹配/优先级/deny 短路/异常超时隔离/上下文合并。
 * 真实事件接入（PreToolUse/PostToolUse 嵌进 ToolLoopAgent）是 P9-b 的活儿，
 * 这里只用合成 payload 走 runtime。
 */

const PRE_TOOL: { event: "PreToolUse"; toolName: string; input: unknown } = {
  event: "PreToolUse",
  toolName: "write_file",
  input: { path: "./.env", content: "secret" },
};

describe("HookRegistry + runHooks", () => {
  it("matcher 命中才执行；不命中跳过", async () => {
    const reg = new HookRegistry();
    const called: string[] = [];

    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "write-only",
        matcher: "^write_file$",
        handler: () => {
          called.push("write-only");
        },
      }),
    );
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "shell-only",
        matcher: "^shell$",
        handler: () => {
          called.push("shell-only");
        },
      }),
    );
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "no-matcher",
        handler: () => {
          called.push("no-matcher");
        },
      }),
    );

    await runHooks(reg, "PreToolUse", PRE_TOOL);
    expect(called).toEqual(["write-only", "no-matcher"]);
  });

  it("deny 短路：后续 hook 不再执行；deniedBy + reason 报上来", async () => {
    const reg = new HookRegistry();
    const tail = vi.fn();

    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "dotenv-blocklist",
        handler: () => ({ decision: "deny", reason: "保护 .env" }),
      }),
    );
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "should-not-run",
        handler: tail,
      }),
    );

    const result = await runHooks(reg, "PreToolUse", PRE_TOOL);
    expect(result.decision).toBe("deny");
    expect(result.deniedBy).toBe("dotenv-blocklist");
    expect(result.reason).toBe("保护 .env");
    expect(tail).not.toHaveBeenCalled();
  });

  it("注册顺序 = 优先级；updatedInput last-write-wins", async () => {
    const reg = new HookRegistry();
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "first",
        handler: () => ({ updatedInput: { path: "/safe/a.txt" } }),
      }),
    );
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "second",
        handler: () => ({ updatedInput: { path: "/safe/b.txt" } }),
      }),
    );

    const result = await runHooks(reg, "PreToolUse", PRE_TOOL);
    expect(result.updatedInput).toEqual({ path: "/safe/b.txt" });
    expect(result.decision).toBeUndefined();
  });

  it("异常隔离：throw 的 hook 被吞掉、不影响后续 hook 与聚合结果", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = new HookRegistry();

    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "boom",
        handler: () => {
          throw new Error("kaboom");
        },
      }),
    );
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "context-injector",
        handler: () => ({ additionalContexts: ["from-tail"] }),
      }),
    );

    const result = await runHooks(reg, "PreToolUse", PRE_TOOL);
    expect(result.additionalContexts).toEqual(["from-tail"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    warn.mockRestore();
  });

  it("超时隔离：handler 永远 hang 也只是被跳过，不阻塞后续", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = new HookRegistry();

    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "slowpoke",
        handler: () => new Promise<never>(() => {}),
      }),
    );
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "fast-follower",
        handler: () => ({ additionalContexts: ["after-timeout"] }),
      }),
    );

    const result = await runHooks(reg, "PreToolUse", PRE_TOOL, { timeoutMs: 10 });
    expect(result.additionalContexts).toEqual(["after-timeout"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    warn.mockRestore();
  });

  it("additionalContexts 多 hook 合并；systemMessage 累加；ask 不短路", async () => {
    const reg = new HookRegistry();
    reg.register(
      defineHook({
        event: "UserPromptSubmit",
        name: "primer-a",
        handler: () => ({
          additionalContexts: ["ctx-a"],
          systemMessage: "sys-a",
          decision: "ask",
          reason: "please confirm",
        }),
      }),
    );
    reg.register(
      defineHook({
        event: "UserPromptSubmit",
        name: "primer-b",
        handler: () => ({
          additionalContexts: ["ctx-b1", "ctx-b2"],
          systemMessage: "sys-b",
        }),
      }),
    );

    const result = await runHooks(reg, "UserPromptSubmit", {
      event: "UserPromptSubmit",
      prompt: "hello",
    });
    expect(result.additionalContexts).toEqual(["ctx-a", "ctx-b1", "ctx-b2"]);
    expect(result.systemMessages).toEqual(["sys-a", "sys-b"]);
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("please confirm");
  });
});
