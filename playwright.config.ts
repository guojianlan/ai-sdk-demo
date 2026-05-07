import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config — 真实环境跑（不 mock 模型）。
 *
 * 关键决策：
 * - webServer 复用 `npm run dev`，端口 3000；首跑会等 next 起来再开始测试。
 * - 单个测试 timeout 给到 120s：聊天链路要走真实 LLM + tool loop，慢一点正常。
 * - workers=1：dev server 是单实例，串行避免 chat-store SQLite 写入打架。
 * - reuseExistingServer：本地反复跑测试时不重复拉起 dev server。
 */
export default defineConfig({
  testDir: "./e2e",
  // 整体上限 15 分钟：reasoning model（mimo 等）+ Task Persistence prompt 之后
  // 单步可能 30-60s，approval 流要跑「调 write → pause → 用户决定 → 模型继续」
  // 整套。具体场景的等待还在各 spec 里用 explicit toBeVisible({ timeout }) 控制。
  timeout: 900_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
