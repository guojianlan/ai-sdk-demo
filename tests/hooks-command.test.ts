import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commandHook } from "@/lib/hooks/command";
import {
  buildCommandHookRegistryFromProjectSettings,
  buildHookRegistryFromSettings,
  HookRegistry,
  runHooks,
} from "@/lib/hooks";
import type { Settings } from "@/lib/permissions";

describe("command hooks", () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-command-"));
  });

  afterEach(async () => {
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it("executes a command hook with event JSON on stdin and parses JSON stdout", async () => {
    const reg = new HookRegistry();
    reg.register(
      commandHook({
        event: "Stop",
        name: "stop-check",
        command: `node -e 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{const input=JSON.parse(raw);console.log(JSON.stringify({additionalContexts:["event="+input.hook_event_name,"cwd="+input.cwd]}));})'`,
        cwd: tmpProject,
        timeoutSec: 5,
      }),
    );

    const result = await runHooks(reg, "Stop", {
      event: "Stop",
      sessionId: "chat-1",
    });

    expect(result.decision).toBeUndefined();
    expect(result.additionalContexts).toEqual([
      "event=Stop",
      `cwd=${tmpProject}`,
    ]);
  });

  it("blocks when a command exits non-zero", async () => {
    const reg = new HookRegistry();
    reg.register(
      commandHook({
        event: "Stop",
        name: "lint",
        command: `node -e 'console.error("lint failed");process.exit(1)'`,
        cwd: tmpProject,
        timeoutSec: 5,
      }),
    );

    const result = await runHooks(reg, "Stop", {
      event: "Stop",
      sessionId: "chat-1",
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("lint failed");
    expect(result.additionalContexts).toEqual([
      "Hook command failed: lint failed",
    ]);
  });

  it("registers command groups from project settings", () => {
    const settings: Settings = {
      rules: [],
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "npm run lint",
                timeout: 120,
                statusMessage: "Running lint before completion",
              },
            ],
          },
        ],
      },
    };

    const reg = buildCommandHookRegistryFromProjectSettings(settings, {
      cwd: tmpProject,
    });

    expect(reg.list("Stop")).toHaveLength(1);
    expect(reg.list("Stop")[0].name).toContain("Stop:command:0:npm run lint");
  });

  it("keeps command declarations out of the named in-process hook registry", () => {
    const settings: Settings = {
      rules: [],
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "npm run lint",
              },
            ],
          },
        ],
      },
    };

    const reg = buildHookRegistryFromSettings(settings);

    expect(reg.list("Stop")).toHaveLength(0);
  });
});
