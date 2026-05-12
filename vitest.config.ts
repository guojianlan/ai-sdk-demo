import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest 配置：仅扫 `tests/` 下的 `*.test.ts`。
 *
 * 为啥不扫 `e2e/`：那是 Playwright 的 spec（用 `@playwright/test`），跑得起来但
 * 接口不匹配。两个 runner 各管各的；`npm run test` 跑 vitest 单测，
 * `npm run test:e2e` 跑 Playwright。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
});
