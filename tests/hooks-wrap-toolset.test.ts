import { describe, expect, it, vi } from "vitest";

import {
  defineHook,
  HookRegistry,
  wrapToolsetWithHooks,
} from "@/lib/hooks";
import { toolOk } from "@/lib/tool-result";

/**
 * P9-b wrap-toolset 行为覆盖。
 *
 * 用纯 plain object 模拟 tool（实际上 AI SDK 的 tool() 也是返回 plain object）：
 * 关键就是 `{ execute, ...meta }` 这套形态。
 */

function makeTool(executeImpl: (input: unknown) => unknown) {
  return {
    description: "fake",
    inputSchema: { _zod: true } as unknown,
    execute: async (input: unknown, _options: unknown) => {
      void _options;
      return executeImpl(input);
    },
  };
}

describe("wrapToolsetWithHooks", () => {
  it("deny 短路：返回 toolErr，底层 execute 不被调用，但 PostToolUse 不跑", async () => {
    const reg = new HookRegistry();
    const postSpy = vi.fn();
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "block-write",
        handler: () => ({ decision: "deny", reason: "blocked" }),
      }),
    );
    reg.register(
      defineHook({
        event: "PostToolUse",
        name: "post-watch",
        handler: postSpy,
      }),
    );

    const executeImpl = vi.fn(() => toolOk({ wrote: true }));
    const wrapped = wrapToolsetWithHooks({ write: makeTool(executeImpl) }, reg);

    const result = await wrapped.write.execute!({ relativePath: "x.txt" }, {});
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("block-write");
    expect((result as { error: string }).error).toContain("blocked");
    expect(executeImpl).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("updatedInput 透传给底层 execute", async () => {
    const reg = new HookRegistry();
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "redirect",
        handler: () => ({
          updatedInput: { relativePath: "redirected/path.txt" },
        }),
      }),
    );

    const seen: unknown[] = [];
    const wrapped = wrapToolsetWithHooks(
      {
        write: makeTool((input) => {
          seen.push(input);
          return toolOk({ wrote: true });
        }),
      },
      reg,
    );
    await wrapped.write.execute!({ relativePath: "original.txt" }, {});
    expect(seen).toEqual([{ relativePath: "redirected/path.txt" }]);
  });

  it("PostToolUse 永远跑：execute 抛错也喂 hook，并把异常重新抛给调用方", async () => {
    const reg = new HookRegistry();
    const postReceived: unknown[] = [];
    reg.register(
      defineHook({
        event: "PostToolUse",
        name: "record",
        handler: (payload) => {
          postReceived.push(payload.result);
        },
      }),
    );

    const wrapped = wrapToolsetWithHooks(
      {
        write: makeTool(() => {
          throw new Error("disk full");
        }),
      },
      reg,
    );

    await expect(
      wrapped.write.execute!({ relativePath: "a.txt" }, {}),
    ).rejects.toThrow("disk full");
    expect(postReceived).toEqual([{ ok: false, error: "disk full" }]);
  });

  it("interactive tool（无 execute）原样透传，不挂 hook", async () => {
    const reg = new HookRegistry();
    const pre = vi.fn();
    reg.register(
      defineHook({
        event: "PreToolUse",
        name: "should-not-fire",
        handler: pre,
      }),
    );

    const interactive = { description: "ask", inputSchema: {} };
    const wrapped = wrapToolsetWithHooks({ ask_user_question: interactive }, reg);
    expect(wrapped.ask_user_question).toBe(interactive);
    expect(pre).not.toHaveBeenCalled();
  });

  it("PostToolUse hook 拿到 toolName / 入参 / 成功结果 / duration", async () => {
    const reg = new HookRegistry();
    const captured: Array<Record<string, unknown>> = [];
    reg.register(
      defineHook({
        event: "PostToolUse",
        name: "capture",
        handler: (payload) => {
          captured.push({
            toolName: payload.toolName,
            input: payload.input,
            result: payload.result,
            hasDuration: typeof payload.durationMs === "number",
          });
        },
      }),
    );

    const wrapped = wrapToolsetWithHooks(
      { write: makeTool(() => toolOk({ wrote: true })) },
      reg,
      { sessionId: "session-x" },
    );
    await wrapped.write.execute!({ relativePath: "f.txt" }, {});
    expect(captured).toEqual([
      {
        toolName: "write",
        input: { relativePath: "f.txt" },
        result: toolOk({ wrote: true }),
        hasDuration: true,
      },
    ]);
  });

  it("PostToolUse contexts 通过回调暴露给调用方", async () => {
    const reg = new HookRegistry();
    reg.register(
      defineHook({
        event: "PostToolUse",
        name: "context-producer",
        handler: () => ({
          additionalContexts: ["tool observed foo"],
          systemMessage: "system note from tool hook",
        }),
      }),
    );

    const seen: Array<{
      additionalContexts: string[];
      systemMessages: string[];
    }> = [];
    const wrapped = wrapToolsetWithHooks(
      { read: makeTool(() => toolOk({ content: "foo" })) },
      reg,
      {
        onPostToolUseResult: (post) => {
          seen.push({
            additionalContexts: post.additionalContexts,
            systemMessages: post.systemMessages,
          });
        },
      },
    );

    await wrapped.read.execute!({ relativePath: "f.txt" }, {});
    expect(seen).toEqual([
      {
        additionalContexts: ["tool observed foo"],
        systemMessages: ["system note from tool hook"],
      },
    ]);
  });
});
