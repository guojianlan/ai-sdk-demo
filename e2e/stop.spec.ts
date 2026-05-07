import { expect, test } from "./fixtures";

/**
 * 流式中点 SessionHeader 上的「停止」→ 状态回归 idle、按钮文本不再是「分析中」。
 *
 * 用一个会让模型说很多句话的 prompt 给我们足够时间去点 stop（30 句中文，~10s+）。
 * 不强求模型停在哪个字——只要按钮回到「发送」、停止按钮消失即可视为流被取消。
 */
test("stop button cancels an in-flight stream", async ({ page }) => {
  await page.goto("/");

  const textarea = page.getByPlaceholder("例如：这个项目的入口在哪里？");
  await expect(textarea).toBeEnabled({ timeout: 10_000 });

  const PROMPT =
    "请用 30 句话非常详细地解释什么是 TypeScript 的泛型，每句尽量长。不要使用任何工具。";
  await textarea.fill(PROMPT);
  await page.getByRole("button", { name: /^发送$/ }).click();

  // 等到 SessionHeader 的「停止」按钮出现（说明 isStreaming = true）
  const stopButton = page.getByRole("button", { name: "停止" });
  await expect(stopButton).toBeVisible({ timeout: 30_000 });

  // 点停止
  await stopButton.click();

  // 停止按钮应该消失
  await expect(stopButton).toBeHidden({ timeout: 30_000 });

  // 发送按钮应该回到「发送」（不是「分析中」）
  const sendButton = page.getByRole("button", { name: /^发送$/ });
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toHaveText(/发送/);
});
