import { expect, test } from "./fixtures";

/**
 * 流式中刷新 → 重新水合 → assistant 内容仍在/继续完成。
 *
 * 验证两条链路：
 * 1. /api/chat/history 拿到截至刷新时刻保存的消息（saveMessages 每步落库）
 * 2. /api/chat/{id}/stream reconnect 把还没结束的流接回 useChat
 *
 * 用一个会让模型说一段话的 prompt（不要工具，不要长推理），刷新点选在用户消息可见、
 * engineer 气泡可能刚开始之间。
 */
test("reload mid-stream restores the conversation", async ({ page }) => {
  await page.goto("/");

  const textarea = page.getByPlaceholder("例如：这个项目的入口在哪里？");
  await expect(textarea).toBeEnabled({ timeout: 10_000 });

  const PROMPT =
    "请直接回答（不要使用任何工具）：用 5 句话描述什么是 TypeScript 的泛型。";
  await textarea.fill(PROMPT);
  await page.getByRole("button", { name: /^发送$/ }).click();

  // user 气泡先确认
  await expect(page.getByText("[ YOU ]").first()).toBeVisible({ timeout: 10_000 });

  // 拿到 ?session=<id>，刷新后还在同一会话
  await expect(page).toHaveURL(/\?session=[0-9a-f-]{36}/, { timeout: 10_000 });
  const urlBeforeReload = page.url();

  // 不等流完成就刷新；如果模型秒回，刷新后就走 history 水合也算正常 case
  await page.reload();
  await expect(page).toHaveURL(urlBeforeReload);

  // user 消息应该来自 /api/chat/history（不是 localStorage 里的 hydratedMessages）
  await expect(page.getByText("[ YOU ]").first()).toBeVisible({ timeout: 10_000 });
  // PROMPT 在 sidebar 预览和消息气泡里都会出现；只断言至少有一处可见即可
  await expect(page.getByText(PROMPT, { exact: false }).first()).toBeVisible();

  // 等流彻底结束（按钮回「发送」），断言 assistant 气泡有内容
  // reasoning model（gpt-5.5 high）单步慢，给 5 分钟
  const sendButton = page.getByRole("button", { name: /^发送$/ });
  await expect(sendButton).toBeVisible({ timeout: 300_000 });
  await expect(sendButton).toHaveText(/发送/);

  const engineerLabel = page.getByText("[ ENGINEER ]").first();
  await expect(engineerLabel).toBeVisible({ timeout: 60_000 });

  const engineerBubble = engineerLabel.locator(
    "xpath=ancestor::div[contains(@class,'border-l-slate-900')][1]",
  );
  await expect(engineerBubble).toContainText(/\S/);
});
