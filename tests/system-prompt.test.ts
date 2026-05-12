import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSystemPrompt } from "@/lib/chat-agent/system-prompt";

/**
 * `buildSystemPrompt` 是 chat 路由 system instructions 的唯一入口。它把
 * persona / developerRules / env-context / AGENTS.md / skills / memory /
 * compaction-summary 七层拼成最终发给模型的 system prompt。
 *
 * 这组 snapshot 测试是为了：
 *   1. 拼装顺序 / 分隔符 / 每层标题 regression 防护——任何一层加/去/换名都会
 *      让 snapshot diff 显眼地翻
 *   2. 把"system prompt 实际长啥样"以可读的字符串形式留在仓库里，让人肉
 *      review 不用启动 dev 服务器开 devtools 翻
 *
 * 非确定性归一化：
 *   - `<cwd>` 写入临时 fixture 目录路径——snapshot 前替换为 `<FIXTURE_ROOT>`
 *   - `<current_date>` / `<shell>` / `<timezone>` —— 通过 fakeTimers + env
 *     固定，剩余漂移在 normalize 里兜底
 */

const FIXTURE_DATE = "2026-05-12T00:00:00.000Z";

async function makeFixtureWorkspace(agentsMd: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-sdk-demo-prompt-"));
  // `.git` 让 session-primer 把 dir 当成 project root
  await writeFile(path.join(dir, ".git"), "");
  await writeFile(path.join(dir, "AGENTS.md"), agentsMd);
  return dir;
}

function normalize(prompt: string, fixtureRoot: string): string {
  const tzRegex = /<timezone>[^<]+<\/timezone>/g;
  const shellRegex = /<shell>[^<]+<\/shell>/g;
  return prompt
    .replaceAll(fixtureRoot, "<FIXTURE_ROOT>")
    .replace(tzRegex, "<timezone>NORMALIZED</timezone>")
    .replace(shellRegex, "<shell>NORMALIZED</shell>");
}

describe("buildSystemPrompt", () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXTURE_DATE));
    fixtureRoot = await makeFixtureWorkspace(
      [
        "# Fixture Project",
        "",
        "Treat all TypeScript code as authoritative.",
        "Run `npm test` before claiming a task is done.",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("拼装基线：persona + developerRules + env + AGENTS.md", async () => {
    const prompt = await buildSystemPrompt({
      persona: "You are a project engineer.",
      developerRules: "## Rules\n\n- Be concise.\n- Use tools when uncertain.",
      workspaceRoot: fixtureRoot,
    });
    expect(normalize(prompt, fixtureRoot)).toMatchSnapshot();
  });

  it("可选层：传入 skills 时插 Available skills 段落", async () => {
    const prompt = await buildSystemPrompt({
      persona: "You are a project engineer.",
      developerRules: "## Rules\n\n- Be concise.",
      workspaceRoot: fixtureRoot,
      skills: [
        {
          name: "browse",
          description: "Headless browser for QA testing.",
          filePath: "/fake/skills/browse/SKILL.md",
          dir: "/fake/skills/browse",
          options: { userInvocable: true, disableModelInvocation: false },
        },
        {
          name: "qa",
          description: "End-to-end QA + auto-fix loop.",
          filePath: "/fake/skills/qa/SKILL.md",
          dir: "/fake/skills/qa",
          options: { userInvocable: true, disableModelInvocation: true },
        },
      ],
    });
    expect(normalize(prompt, fixtureRoot)).toMatchSnapshot();
  });

  it("可选层：传入 conversationSummary 时插 handoff 段", async () => {
    const prompt = await buildSystemPrompt({
      persona: "You are a project engineer.",
      developerRules: "## Rules\n\n- Be concise.",
      workspaceRoot: fixtureRoot,
      conversationSummary: [
        "## USER'S CORE REQUEST",
        "Refactor the auth middleware.",
        "",
        "## COMPLETED",
        "- Read lib/auth.ts",
      ].join("\n"),
    });
    expect(normalize(prompt, fixtureRoot)).toMatchSnapshot();
  });

  it("可选层：传入 globalMemory 时插 long-term memory 段", async () => {
    const prompt = await buildSystemPrompt({
      persona: "You are a project engineer.",
      developerRules: "## Rules\n\n- Be concise.",
      workspaceRoot: fixtureRoot,
      globalMemory: {
        content: "- User prefers terse responses.\n- User is a senior engineer.",
        byteSize: 64,
        truncated: false,
        source: "/fake/MEMORY.md",
      },
    });
    expect(normalize(prompt, fixtureRoot)).toMatchSnapshot();
  });
});
