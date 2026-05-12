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

test("memory pipeline 观测：跑两轮 chat 后 dump MEMORY.md / raw_memories.md", async ({
  page,
}, testInfo) => {
  const storageDir = resolveStorageDir();
  const memoryDir = path.join(storageDir, "memory");
  const memoryIndexPath = path.join(memoryDir, "MEMORY.md");
  const rawMemoriesPath = path.join(memoryDir, "raw_memories.md");
  const rolloutDir = path.join(memoryDir, "rollout_summaries");

  // 跑测前快照——后面对比"这一轮跑出来的"
  const before = {
    memoryIndex: await readIfExists(memoryIndexPath),
    rawMemories: await readIfExists(rawMemoriesPath),
  };
  await testInfo.attach("memory-before.json", {
    body: Buffer.from(
      JSON.stringify(
        {
          storageDir,
          memoryIndexPath,
          rawMemoriesPath,
          memoryIndexBytes: before.memoryIndex?.length ?? 0,
          rawMemoriesBytes: before.rawMemories?.length ?? 0,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });

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

  // 跑测后读
  const after = {
    memoryIndex: await readIfExists(memoryIndexPath),
    rawMemories: await readIfExists(rawMemoriesPath),
  };

  // 把内容贴到报告里供人肉 review
  await testInfo.attach("MEMORY.md.after", {
    body: Buffer.from(after.memoryIndex ?? "(file not found)"),
    contentType: "text/markdown",
  });
  await testInfo.attach("raw_memories.md.after", {
    body: Buffer.from(after.rawMemories ?? "(file not found)"),
    contentType: "text/markdown",
  });

  // rollout summary 目录列表（每个 thread 一份）
  let rolloutListing = "(rollout_summaries dir not found)";
  try {
    const entries = await fs.readdir(rolloutDir);
    rolloutListing = entries.join("\n");

    // 把最近一份 summary 也贴出来
    if (entries.length > 0) {
      const lastEntry = entries.sort().at(-1)!;
      const lastSummary = await readIfExists(path.join(rolloutDir, lastEntry));
      await testInfo.attach(`rollout_${lastEntry}`, {
        body: Buffer.from(lastSummary ?? "(empty)"),
        contentType: "text/markdown",
      });
    }
  } catch {
    // 目录不存在，跳过
  }
  await testInfo.attach("rollout_listing.txt", {
    body: Buffer.from(rolloutListing),
    contentType: "text/plain",
  });

  // Soft 检查：至少 raw_memories.md 或 rollout summary 之一应该有新增内容
  // —— 证明 A2 Phase 1 确实跑了 fire-and-forget（即使没 finish 也至少 wrote 部分）
  const rawGrew =
    (after.rawMemories?.length ?? 0) > (before.rawMemories?.length ?? 0);
  const rolloutExists = rolloutListing !== "(rollout_summaries dir not found)";

  // 不做 hard fail——A2 在某些 LLM 错误 / 短对话场景下可能跳过，这是已知行为
  // 仅 console 输出供 debug，不影响 test pass
  console.log(
    `[memory.spec] rawGrew=${rawGrew} rolloutExists=${rolloutExists} ` +
      `memoryIndexBytes=${after.memoryIndex?.length ?? 0} ` +
      `rawMemoriesBytes=${after.rawMemories?.length ?? 0}`,
  );

  // 唯一的 hard assertion：memoryDir 应该存在（A1 loader 至少跑过）
  // 注：如果整个 memory pipeline 被 memoryEnabled=false 关掉，这条也会失败——属于
  // 正常 surfacing 配置漂移的信号。
  const memoryDirExists = await fs
    .stat(memoryDir)
    .then(() => true)
    .catch(() => false);
  expect(memoryDirExists, "memory dir should be created by A1/A2/A3 pipeline").toBe(
    true,
  );
});
