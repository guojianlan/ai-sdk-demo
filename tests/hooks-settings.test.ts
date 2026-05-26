import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCommandHookRegistryFromProjectSettings,
  buildHookRegistryFromSettings,
  listKnownHookNames,
  wrapToolsetWithHooks,
} from "@/lib/hooks";
import {
  loadProjectSettings,
  loadSettings,
  type Settings,
} from "@/lib/permissions";
import { toolOk } from "@/lib/tool-result";

/**
 * P9-c done 标准证明 —— settings.json 能开关 dotenv 黑名单。
 *
 * 用 tmp 目录 fixture 跑（不 mock fs）：写一个 `.git` marker + `.agents/settings.json`，
 * 调 `loadSettings(tempDir)` → `buildHookRegistryFromSettings(settings)` → 把 registry
 * 套在合成 write 工具上跑一遍 execute，断言 deny / 放行。
 */

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-settings-"));
  // .git marker 让 settings layer 查找在这一层就停
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

function makeWriteTool(spy: () => unknown) {
  return {
    description: "fake write",
    inputSchema: { _zod: true } as unknown,
    execute: async (input: unknown, _options: unknown) => {
      void input;
      void _options;
      return spy();
    },
  };
}

describe("buildHookRegistryFromSettings", () => {
  it("known name 'dotenv-blocklist' under PreToolUse 注册成功并能 deny .env 写入", async () => {
    const settings: Settings = {
      rules: [],
      hooks: {
        PreToolUse: [{ name: "dotenv-blocklist" }],
      },
    };
    const reg = buildHookRegistryFromSettings(settings);
    expect(reg.list("PreToolUse")).toHaveLength(1);

    const exec = vi.fn(() => toolOk({ wrote: true }));
    const wrapped = wrapToolsetWithHooks({ write: makeWriteTool(exec) }, reg);

    const result = await wrapped.write.execute!({ relativePath: ".env" }, {});
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("dotenv-blocklist");
    expect(exec).not.toHaveBeenCalled();
  });

  it("unknown name → warn + skip（不抛）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const settings: Settings = {
      rules: [],
      hooks: {
        PreToolUse: [{ name: "no-such-hook" }],
      },
    };
    const reg = buildHookRegistryFromSettings(settings);
    expect(reg.list("PreToolUse")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`unknown hook name "no-such-hook"`),
    );
    warn.mockRestore();
  });

  it("把 hook 挂错事件桶 → warn + skip", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const settings: Settings = {
      rules: [],
      // dotenv-blocklist 实际是 PreToolUse hook；这里硬塞到 PostToolUse
      hooks: {
        PostToolUse: [{ name: "dotenv-blocklist" }],
      },
    };
    const reg = buildHookRegistryFromSettings(settings);
    expect(reg.list("PostToolUse")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`refusing to register under PostToolUse`),
    );
    warn.mockRestore();
  });

  it("空 settings / 没 hooks 字段 → 空 registry", () => {
    expect(buildHookRegistryFromSettings({ rules: [] }).list("PreToolUse")).toHaveLength(0);
    expect(
      buildHookRegistryFromSettings({ rules: [], hooks: {} }).list("PreToolUse"),
    ).toHaveLength(0);
  });

  it("listKnownHookNames 包含 dotenv-blocklist + tool-logging", () => {
    const names = listKnownHookNames().map((e) => e.name);
    expect(names).toContain("dotenv-blocklist");
    expect(names).toContain("tool-logging");
  });
});

describe("settings.json 端到端：开关 dotenv-blocklist", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await makeProject();
  });
  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  async function runWriteWithCurrentSettings(): Promise<unknown> {
    const settings = loadSettings(tmpProject);
    const reg = buildHookRegistryFromSettings(settings);
    const wrapped = wrapToolsetWithHooks(
      { write: makeWriteTool(() => toolOk({ wrote: true })) },
      reg,
    );
    return wrapped.write.execute!({ relativePath: ".env" }, {});
  }

  it("settings 开启 dotenv hook → 写 .env 被 deny", async () => {
    await writeSettings(tmpProject, {
      hooks: { PreToolUse: [{ name: "dotenv-blocklist" }] },
    });
    const result = await runWriteWithCurrentSettings();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("dotenv-blocklist");
  });

  it("settings 不开 dotenv hook → 写 .env 放行", async () => {
    // 没 settings.json：根本没有 hook
    const result = await runWriteWithCurrentSettings();
    expect(result).toEqual(toolOk({ wrote: true }));
  });

  it("settings 改成空 hooks {} → 不开启任何 hook，写 .env 放行", async () => {
    await writeSettings(tmpProject, { hooks: {} });
    const result = await runWriteWithCurrentSettings();
    expect(result).toEqual(toolOk({ wrote: true }));
  });

  it("项目级 settings 可以声明 command Stop hook", async () => {
    await writeSettings(tmpProject, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "npm run lint",
                timeout: 120,
              },
            ],
          },
        ],
      },
    });

    const settings = loadProjectSettings(tmpProject);
    const reg = buildCommandHookRegistryFromProjectSettings(settings, {
      cwd: tmpProject,
    });

    expect(reg.list("Stop")).toHaveLength(1);
    expect(reg.list("Stop")[0].name).toContain("Stop:command:0:npm run lint");
  });
});
