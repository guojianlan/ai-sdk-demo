import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * 验证 P9 hook 系统覆盖到 subagent —— runSubAgent 构造 ToolLoopAgent 时塞进去的
 * `tools.write` 应该是被 wrapToolsetWithHooks 包过的：当 `.agents/settings.json`
 * 打开 dotenv-blocklist 后，子 agent 内部调 write `.env` 必须收 toolErr。
 *
 * 不跑真模型 —— mock 掉 `ai` 包的 ToolLoopAgent 构造函数，拦截传进来的 `tools`，
 * 直接调它的 execute 断言行为。这跟"模型究竟会不会调 write"无关；我们只关心
 * 接线是否正确，而接线正确 = wrapped tool 拿到了 hook 决策。
 */

vi.mock("ai", async () => {
  const real = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...real,
    ToolLoopAgent: vi.fn(function (this: unknown, config: unknown) {
      capturedConfigs.push(config);
      // 返回 stub —— runSubAgent 后面 .generate 不会跑到（fn return value），
      // 但为了 typecheck 还是给个 generate。
      return {
        config,
        generate: vi
          .fn()
          .mockResolvedValue({ text: "stub", steps: [] }),
      } as unknown as InstanceType<typeof real.ToolLoopAgent>;
    }),
  };
});

// 顺序：上面的 vi.mock 自动 hoist 到文件顶；这里再 import 才会拿到 mock 版。
const capturedConfigs: unknown[] = [];

let runSubAgent: (typeof import("@/lib/subagents/sub-agent"))["runSubAgent"];

beforeAll(async () => {
  ({ runSubAgent } = await import("@/lib/subagents/sub-agent"));
});

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-hooks-"));
  await fs.mkdir(path.join(dir, ".git"));
  return dir;
}

async function writeSettings(
  dir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const target = path.join(dir, ".agents", "settings.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf-8");
}

describe("runSubAgent —— 子 agent 也走 hook 流水线", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await makeProject();
    capturedConfigs.length = 0;
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("settings 开启 dotenv-blocklist → subagent 的 write tool 拒写 .env", async () => {
    await writeSettings(tmpProject, {
      hooks: { PreToolUse: [{ name: "dotenv-blocklist" }] },
    });

    await runSubAgent({
      prompt: "(test) doesn't actually run a real model",
      workspaceRoot: tmpProject,
      workspaceName: "tmp",
      depth: 1,
    });

    expect(capturedConfigs).toHaveLength(1);
    const config = capturedConfigs[0] as {
      tools: Record<
        string,
        { execute?: (input: unknown, options: unknown) => Promise<unknown> }
      >;
    };
    const writeTool = config.tools.write;
    expect(typeof writeTool.execute).toBe("function");

    const result = await writeTool.execute!(
      { relativePath: ".env", content: "secret" },
      {},
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("dotenv-blocklist");
  });

  it("settings 不开 dotenv-blocklist → subagent 的 write tool 不被拦（但下层 execute 没真跑，会因 sandbox 缺失抛/失败，关键是没被 hook deny）", async () => {
    // 不写 settings.json，dotenv hook 不挂

    await runSubAgent({
      prompt: "(test) doesn't actually run a real model",
      workspaceRoot: tmpProject,
      workspaceName: "tmp",
      depth: 1,
    });

    expect(capturedConfigs).toHaveLength(1);
    const config = capturedConfigs[0] as {
      tools: Record<
        string,
        { execute?: (input: unknown, options: unknown) => Promise<unknown> }
      >;
    };
    const writeTool = config.tools.write;

    // 跑一遍 execute —— hook 不拦了，但缺乏真 experimental_context，会落到底层
    // approvedTool 的 execute，最终从 sandbox/permissions 那条路径返回某种 result。
    // 我们要的关键证据：返回值里不应包含 "dotenv-blocklist"（说明 hook 没参与）。
    let result: unknown;
    try {
      result = await writeTool.execute!(
        { relativePath: ".env", content: "secret" },
        { experimental_context: {} },
      );
    } catch (err) {
      result = { thrown: err instanceof Error ? err.message : String(err) };
    }
    expect(JSON.stringify(result)).not.toContain("dotenv-blocklist");
  });
});
