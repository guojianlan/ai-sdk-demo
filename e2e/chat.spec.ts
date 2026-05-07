import { expect, test } from "./fixtures";

/**
 * 端到端走一次真实聊天：等 workspace 自动绑定 → 发简单 prompt → 等流式回复。
 *
 * 用「不要使用工具」+ 简单算术降低 tool loop 复杂度，让单测能在 ~30s 内拿到回复。
 * 不去断言模型说了啥，只断言「assistant 气泡出现 + 内含可见文本」。
 */
test("send a simple chat and receive a streamed assistant reply", async ({ page }) => {
  await page.goto("/");

  const textarea = page.getByPlaceholder("例如：这个项目的入口在哪里？");
  await expect(textarea).toBeEnabled({ timeout: 10_000 });

  await textarea.fill(
    "请直接回答，不要使用任何工具：1+1 等于多少？只回答数字。",
  );

  const sendButton = page.getByRole("button", { name: /^发送$/ });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // user 气泡先出现
  await expect(page.getByText("[ YOU ]").first()).toBeVisible({ timeout: 10_000 });

  // engineer 气泡随后出现（流式渲染中）
  const engineerLabel = page.getByText("[ ENGINEER ]").first();
  await expect(engineerLabel).toBeVisible({ timeout: 60_000 });

  // 等到流式结束：发送按钮文本恢复成「发送」（不是「分析中」）
  await expect(sendButton).toBeVisible({ timeout: 90_000 });
  await expect(sendButton).toHaveText(/发送/);

  // assistant 气泡里应该有非空可见文本
  const engineerBubble = engineerLabel.locator(
    "xpath=ancestor::div[contains(@class,'border-l-slate-900')][1]",
  );
  await expect(engineerBubble).toContainText(/\S/);
});
