import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "./fixtures";

/**
 * Memory pipeline 端到端"观测性"测试。
 *
 * 目标：跑两轮真实 chat → 触发 A2 Phase 1 抽取 → 把 MEMORY.md / raw_memories.md
 * 落盘内容附到测试报告里，供人肉评判抽取质量。
 *
 * 跟一般断言式测试的区别：
 *   - **不做内容断言**——抽取质量是质性判断，不是 boolean
 *   - **附 testInfo.attach** 把文件内容贴到 trace/report 里，跑完 `npx playwright
 *     show-report` 能直接看
 *   - **soft 检查**：A2 是 fire-and-forget，等不到完成是常态；只要文件结构
 *     存在 / 看起来在工作就行
 *
 * 注意事项：
 *   - 这个 spec 会**写入用户真实** `~/.local-agent/memory/`（除非通过
 *     `AGENT_STORAGE_DIR` 环境变量隔离）。跟现有 e2e 一致——它们走真实 LLM +
 *     真实 chat-store 时也是这么做的。
 *   - A2 Phase 1 是 **fire-and-forget**：当前 POST 抽的是**上一轮**的 transcript。
 *     所以我们要发两次 chat：第一次给 memory-worthy 内容，第二次触发对第一次
 *     的抽取。
 */

function resolveStorageDir(): string {
  return (
    process.env.AGENT_STORAGE_DIR ?? path.join(os.homedir(), ".local-agent")
  );
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 隔离 storage 下 sessions 列表是空的，page.tsx 不会自动绑 workspace —— textarea
 * placeholder 会停在「请先为这个会话选择工作区」。先走一次"新建会话"流程创建
 * 一个绑了 workspace 的 session，后续 chat 就能正常发了。
 */
async function ensureWorkspaceBound(
  page: import("@playwright/test").Page,
): Promise<void> {
  const readyPlaceholder = page.getByPlaceholder(
    "例如：这个项目的入口在哪里？",
  );
  if (await readyPlaceholder.isVisible().catch(() => false)) return;

  // 等 /api/workspaces 拉回再点"新建"——picker 用 lazy init `workspaces[0]?.root`，
  // 如果 mount 时 list 还没 load，selectedWorkspaceRoot 会停在空字符串，submit
  // 按钮永远 disabled。
  await expect(page.getByText(/\d+\s*available/i)).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: /^新建$/ }).click();
  const picker = page.getByRole("dialog");
  await expect(picker).toBeVisible();
  // 显式 selectOption 触发 onChange，避免 lazy init 留下的空 selectedWorkspaceRoot
  const select = picker.locator("select").first();
  await expect(select.locator("option")).not.toHaveCount(0);
  const firstValue = await select
    .locator("option")
    .first()
    .getAttribute("value");
  if (firstValue) {
    await select.selectOption(firstValue);
  }
  const submitButton = picker.getByRole("button", { name: /创建并进入/ });
  await expect(submitButton).toBeEnabled({ timeout: 5_000 });
  await submitButton.click();
  await expect(picker).toBeHidden();
  await expect(readyPlaceholder).toBeEnabled({ timeout: 10_000 });
}

async function sendChat(
  page: import("@playwright/test").Page,
  message: string,
): Promise<void> {
  const textarea = page.getByPlaceholder("例如：这个项目的入口在哪里？");
  await expect(textarea).toBeEnabled({ timeout: 10_000 });
  await textarea.fill(message);

  const sendButton = page.getByRole("button", { name: /^发送$/ });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // 等流式结束：发送按钮恢复成「发送」
  await expect(sendButton).toBeVisible({ timeout: 120_000 });
  await expect(sendButton).toHaveText(/发送/, { timeout: 120_000 });
}

/**
 * 把 memory 三件套（MEMORY.md / raw_memories.md / rollout summaries）attach
 * 到 testInfo report 里。各 test 共用，行为是"快照 + 贴报告 + 不做内容硬断言"。
 */
async function dumpMemoryToReport(
  testInfo: import("@playwright/test").TestInfo,
  attachmentPrefix: string,
): Promise<{
  memoryIndexBytes: number;
  rawMemoriesBytes: number;
  rolloutEntries: string[];
}> {
  const storageDir = resolveStorageDir();
  const memoryDir = path.join(storageDir, "memory");
  const memoryIndexPath = path.join(memoryDir, "MEMORY.md");
  const rawMemoriesPath = path.join(memoryDir, "raw_memories.md");
  const rolloutDir = path.join(memoryDir, "rollout_summaries");

  const memoryIndex = await readIfExists(memoryIndexPath);
  const rawMemories = await readIfExists(rawMemoriesPath);

  await testInfo.attach(`${attachmentPrefix}-MEMORY.md`, {
    body: Buffer.from(memoryIndex ?? "(file not found)"),
    contentType: "text/markdown",
  });
  await testInfo.attach(`${attachmentPrefix}-raw_memories.md`, {
    body: Buffer.from(rawMemories ?? "(file not found)"),
    contentType: "text/markdown",
  });

  let rolloutEntries: string[] = [];
  try {
    rolloutEntries = (await fs.readdir(rolloutDir)).sort();
    if (rolloutEntries.length > 0) {
      const lastEntry = rolloutEntries.at(-1)!;
      const lastSummary = await readIfExists(path.join(rolloutDir, lastEntry));
      await testInfo.attach(`${attachmentPrefix}-rollout-${lastEntry}`, {
        body: Buffer.from(lastSummary ?? "(empty)"),
        contentType: "text/markdown",
      });
    }
  } catch {
    // 目录还没生成
  }
  await testInfo.attach(`${attachmentPrefix}-rollout-listing.txt`, {
    body: Buffer.from(rolloutEntries.join("\n") || "(none)"),
    contentType: "text/plain",
  });

  return {
    memoryIndexBytes: memoryIndex?.length ?? 0,
    rawMemoriesBytes: rawMemories?.length ?? 0,
    rolloutEntries,
  };
}

test("身份 + 偏好 类记忆：dump 后人肉 review", async ({ page }, testInfo) => {
  const memoryDir = path.join(resolveStorageDir(), "memory");

  const before = await dumpMemoryToReport(testInfo, "before");

  await page.goto("/");
  await ensureWorkspaceBound(page);

  // 第一轮：给一段 memory-worthy 内容（用户身份 + 偏好 + 项目背景）
  await sendChat(
    page,
    [
      "请直接回答，不要使用任何工具。",
      "我叫 Lin，是一名 senior TypeScript 工程师，做了 8 年。",
      "我在这个仓库（ai-sdk-demo）学习 Vercel AI SDK v6，最终想做成自己的 agent dev flow。",
      "我偏好简洁直接的回答，不要冗长解释。",
      "请用一句话回复：明白了。",
    ].join("\n"),
  );

  // 第二轮：触发 A2 抽取（A2 抽的是上一轮 transcript，所以一定要发第二条）
  await sendChat(
    page,
    "请直接回答，不要使用任何工具。1+1 等于多少？只回答数字。",
  );

  // A2 是 fire-and-forget——给它一点时间真的写盘
  await page.waitForTimeout(15_000);

  const after = await dumpMemoryToReport(testInfo, "after");

  const rawGrew = after.rawMemoriesBytes > before.rawMemoriesBytes;
  const rolloutExists = after.rolloutEntries.length > 0;

  console.log(
    `[memory.spec/identity] rawGrew=${rawGrew} rolloutExists=${rolloutExists} ` +
      `memoryIndexBytes=${after.memoryIndexBytes} ` +
      `rawMemoriesBytes=${after.rawMemoriesBytes}`,
  );

  // 唯一的 hard assertion：memoryDir 应该存在（A1 loader 至少跑过）
  // 注：如果整个 memory pipeline 被 memoryEnabled=false 关掉，这条也会失败——属于
  // 正常 surfacing 配置漂移的信号。
  const memoryDirExists = await fs
    .stat(memoryDir)
    .then(() => true)
    .catch(() => false);
  expect(
    memoryDirExists,
    "memory dir should be created by A1/A2/A3 pipeline",
  ).toBe(true);
});

/**
 * 第二个观测 spec：覆盖**技术决策类**记忆抽取。
 *
 * 上一个 spec 测了"身份 / 偏好 / 项目目标"——抽取器命中率很高、scope tag 也准。
 * 但 codex 风格 memory pipeline 真正难的是**判断什么算"决策"**：
 *   - "我们用 SQLite 而不是 IndexedDB，因为单进程够用" ← 应该抽
 *   - "我现在饿了" ← 不该抽
 *   - "这个 PR 要在周四前 merge" ← 项目状态，可抽
 *
 * 跑串行（playwright.config.ts `fullyParallel: false, workers: 1`），共享同一个
 * AGENT_STORAGE_DIR；这个 spec 之后看 MEMORY.md，应该能看到第一个 spec 的"身份/偏好"
 * **加上**本 spec 新抽出来的"决策"条目—— Phase 2 consolidator 的 merge 行为
 * 在此被天然验证。
 */
test("技术决策类记忆：dump 后人肉 review", async ({ page }, testInfo) => {
  const before = await dumpMemoryToReport(testInfo, "before");

  await page.goto("/");
  await ensureWorkspaceBound(page);

  // 第一轮：抛三条明确的技术决策 + 一条噪音 + 一条无关琐事
  await sendChat(
    page,
    [
      "请直接回答，不要使用任何工具。我整理一下这个项目的几个技术决策：",
      "1. 我们决定用 SQLite 持久化聊天历史，而不是 IndexedDB，因为是单进程 dev server 部署。",
      "2. 我们用 search-replace 风格的 edit 工具（open-agents 思路），而不是 codex 的 apply_patch—— P1-a 选型时为了节约学习时间。",
      "3. context compaction 用 LLM 摘要 + role=system UIMessage 标注，不是简单 token 截断—— 摘要进 system prompt 而不进 message history。",
      "另外随便提一下：我现在有点饿，待会儿要去吃饭——这是噪音。",
      "请用一句话回复：知道了。",
    ].join("\n"),
  );

  // 第二轮触发 A2 抽取
  await sendChat(
    page,
    "请直接回答，不要使用任何工具。3 乘 7 等于多少？只回答数字。",
  );

  await page.waitForTimeout(15_000);

  const after = await dumpMemoryToReport(testInfo, "after");

  const rawGrew = after.rawMemoriesBytes > before.rawMemoriesBytes;
  const rolloutGrew = after.rolloutEntries.length > before.rolloutEntries.length;

  console.log(
    `[memory.spec/decisions] rawGrew=${rawGrew} rolloutGrew=${rolloutGrew} ` +
      `memoryIndexBytes=${after.memoryIndexBytes} ` +
      `rawMemoriesBytes=${after.rawMemoriesBytes}`,
  );

  // 软断言：rolloutEntries 应该至少有一条（A2 一定跑出了 summary）
  expect(
    after.rolloutEntries.length,
    "Phase 1 should have written at least one rollout summary",
  ).toBeGreaterThan(0);
});
