import fs from "node:fs/promises";
import path from "node:path";

import { expect, test } from "./fixtures";

/**
 * Shell 审批流：触发 shell 调用一个**未知安全**的命令（默认 untrusted 策略下要弹审批）
 * → 点拒绝 → 验证文件没被建（即命令没执行）。
 *
 * 写文件不再走审批（按 open-agents 风格直接落盘），所以这里改测 shell。
 *
 * 真实 LLM 测试。要 mimo 主动用 shell，prompt 显式让它跑一条 mkdir 命令——mkdir
 * 不在 codex 的 ALWAYS_SAFE 集合里，所以 untrusted 策略下会要审批。
 */

const FIXTURE_DIR_RELATIVE = "e2e-tmp-approval-shell-fixture";
const FIXTURE_DIR_ABSOLUTE = path.resolve(process.cwd(), FIXTURE_DIR_RELATIVE);

test.describe("shell approval", () => {
  test.beforeEach(async () => {
    await fs.rm(FIXTURE_DIR_ABSOLUTE, { recursive: true, force: true });
  });

  test.afterEach(async () => {
    await fs.rm(FIXTURE_DIR_ABSOLUTE, { recursive: true, force: true });
  });

  test("rejecting approval prevents the shell command from running", async ({
    page,
  }) => {
    await page.goto("/");

    const textarea = page.getByPlaceholder("例如：这个项目的入口在哪里？");
    await expect(textarea).toBeEnabled({ timeout: 10_000 });

    await textarea.fill(
      `请直接调用 shell 工具运行命令 \`mkdir ${FIXTURE_DIR_RELATIVE}\`，` +
        "不要先用其它工具检查或解释，直接调用 shell。",
    );
    await page.getByRole("button", { name: /^发送$/ }).click();

    // mimo / 推理模型 + 长 prompt 单步可能 30-60s，给 6 分钟上限到点击审批卡。
    const rejectButton = page.getByRole("button", { name: /^拒绝$/ });
    await expect(rejectButton).toBeVisible({ timeout: 360_000 });

    await rejectButton.click();

    // 拒绝后 model 应该回个文本响应就结束。给 6 分钟。
    const sendButton = page.getByRole("button", { name: /^发送$/ });
    await expect(sendButton).toBeVisible({ timeout: 360_000 });
    await expect(sendButton).toHaveText(/发送/);

    // 关键断言：目录没被创建
    await expect(
      fs.access(FIXTURE_DIR_ABSOLUTE).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });
});
