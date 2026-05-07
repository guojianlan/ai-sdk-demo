import { expect, test } from "./fixtures";

/**
 * 入口冒烟：能加载、能开 picker、ChatInput 自动绑定 workspace 后可用。
 *
 * 不测模型行为，只测「页面没炸 + workspace 流程能走通」。
 *
 * 注意：page.tsx 在 /api/workspaces 返回后会自动给空会话绑第一个 workspace（current project），
 * 所以默认状态下 ChatInput 已经是 enabled、placeholder 是「例如：…」。
 */
test("home page loads and auto-binds the current workspace", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /让 Agent 先理解你的项目/ }),
  ).toBeVisible();

  // /api/workspaces 加载后，第一个 session 自动挂上 current project 工作区
  await expect(
    page.getByPlaceholder("例如：这个项目的入口在哪里？"),
  ).toBeEnabled({ timeout: 10_000 });
});

test("workspace picker opens and can be cancelled", async ({ page }) => {
  await page.goto("/");

  // 通过侧栏「新建」按钮打开 picker
  await page.getByRole("button", { name: /^新建$/ }).click();

  const picker = page.getByRole("dialog");
  await expect(picker).toBeVisible();

  // 候选工作区下拉里至少有一项（来自 /api/workspaces）
  const workspaceSelect = picker.locator("select").first();
  await expect(workspaceSelect.locator("option")).not.toHaveCount(0);

  // 取消关闭
  await picker.getByRole("button", { name: /^取消$/ }).click();
  await expect(picker).toBeHidden();
});
