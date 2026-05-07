import { expect, test } from "./fixtures";

/**
 * Plan mode：开 Plan toggle → 发送变成「生成 Plan」→ PlanCard 模态弹出
 * → 等结构化输出 streaming 完成（出现「接受并执行」按钮）→ 点丢弃。
 *
 * 不点「接受并执行」是因为那会触发一次正常 chat，让测试时长翻倍；plan card
 * 自身的渲染 + /api/plan 流式产出 step 已经覆盖到核心链路。
 */
test("plan mode generates a plan and lets the user discard it", async ({
  page,
}) => {
  await page.goto("/");

  const textarea = page.getByPlaceholder("例如：这个项目的入口在哪里？");
  await expect(textarea).toBeEnabled({ timeout: 10_000 });

  // 打开 Plan toggle
  await page.getByText("Plan", { exact: true }).first().click();

  // 发送按钮文本应该变成「生成 Plan」
  const planSubmit = page.getByRole("button", { name: /生成 Plan/ });
  await expect(planSubmit).toBeVisible();

  await textarea.fill("给这个项目加一个 /healthz 健康检查 API。");
  await planSubmit.click();

  // PlanCard 模态框（aria-label="Plan review"）
  const planDialog = page.getByRole("dialog", { name: "Plan review" });
  await expect(planDialog).toBeVisible({ timeout: 10_000 });

  // 等流式产出的 plan 转入 review 状态：「接受并执行」按钮变 enabled。
  // reasoning model（gpt-5.5 high / mimo）走 streamObject 比较慢，给 4 分钟。
  const acceptButton = planDialog.getByRole("button", { name: /接受并执行/ });
  await expect(acceptButton).toBeEnabled({ timeout: 240_000 });

  // 至少有一个 step 行
  await expect(planDialog.locator("ol > li")).not.toHaveCount(0);

  // 丢弃，关闭模态
  await planDialog.getByRole("button", { name: /^丢弃$/ }).click();
  await expect(planDialog).toBeHidden();
});
