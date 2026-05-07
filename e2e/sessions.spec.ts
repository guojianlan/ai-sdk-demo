import { expect, test } from "./fixtures";

/**
 * 多 session 隔离 + 切换持久：在 A 发消息 → 创建 B → 在 B 发不同消息 → 切回 A
 * → A 看到 A 的消息、看不到 B；B 同理。
 */
test("messages stay scoped per session and persist across switches", async ({
  page,
}) => {
  await page.goto("/");

  const textarea = page.getByPlaceholder("例如：这个项目的入口在哪里？");
  await expect(textarea).toBeEnabled({ timeout: 10_000 });

  // ---- session A: 发一条 ----
  await textarea.fill(
    "请直接回答（不要使用任何工具）：2+3 等于多少？只回答数字。",
  );
  await page.getByRole("button", { name: /^发送$/ }).click();
  await expect(page.getByRole("button", { name: /^发送$/ })).toHaveText(/发送/, {
    timeout: 90_000,
  });
  await expect(page.getByText("[ ENGINEER ]").first()).toBeVisible();

  const sessionAUrl = page.url();
  expect(sessionAUrl).toMatch(/\?session=[0-9a-f-]{36}/);

  // ---- 新建 session B ----
  await page.getByRole("button", { name: /^新建$/ }).click();
  await page.getByRole("button", { name: /创建并进入/ }).click();
  await expect(textarea).toHaveValue("");
  await expect(textarea).toBeEnabled();
  expect(page.url()).not.toBe(sessionAUrl);

  // 在新会话的消息区里看不到 A 的提问（用「2+3」子串）
  await expect(page.locator("section").getByText(/2\+3/)).toHaveCount(0);

  // ---- 在 B 发不同消息，确认 B 自己能跑 ----
  await textarea.fill(
    "请直接回答（不要使用任何工具）：7-1 等于多少？只回答数字。",
  );
  await page.getByRole("button", { name: /^发送$/ }).click();
  await expect(page.getByRole("button", { name: /^发送$/ })).toHaveText(/发送/, {
    timeout: 90_000,
  });
  await expect(page.locator("section").getByText(/7-1/).first()).toBeVisible();
  // B 看到 B 的提问，不看到 A 的
  await expect(page.locator("section").getByText(/2\+3/)).toHaveCount(0);

  // ---- 切回 A：A 的消息应该还在 ----
  await page.locator("aside").getByText(/2\+3/).first().click();
  await expect(page).toHaveURL(sessionAUrl);
  await expect(page.locator("section").getByText(/2\+3/).first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator("section").getByText(/7-1/)).toHaveCount(0);
});
