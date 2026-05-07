import { test as base, expect, type ConsoleMessage } from "@playwright/test";

/**
 * 共享 fixture：给每个 test 配一个 console 监听器，跑完自动断言「没有 error / 没有
 * page 异常」。这样 UI 跑出 TypeError 的时候不会被静默吞掉。
 *
 * 用法：
 *   import { test, expect } from "./fixtures";
 *   test("...", async ({ page, consoleSink }) => { ... });
 *
 * 默认行为：在 test body 跑完之后自动 assertNoErrors。如果某个 test 故意制造
 * console error，就在 body 里调 `consoleSink.allow(/pattern/)` 把它白名单掉。
 */

export type ConsoleSink = {
  errors: { text: string; location?: string }[];
  pageErrors: Error[];
  /** 加一条白名单 regex；命中的 console error 不算失败。 */
  allow(pattern: RegExp): void;
  /** 立刻断言——不等 fixture teardown。 */
  assertNoErrors(): void;
};

export const test = base.extend<{ consoleSink: ConsoleSink }>({
  consoleSink: async ({ page }, use, testInfo) => {
    const errors: ConsoleSink["errors"] = [];
    const pageErrors: Error[] = [];
    const allowList: RegExp[] = [
      // Next.js dev overlay 的 fast-refresh 噪音，跟我们无关
      /\[Fast Refresh\]/i,
    ];

    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (allowList.some((r) => r.test(text))) return;
      const loc = msg.location();
      errors.push({
        text,
        location: loc?.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
      });
    };

    const onPageError = (err: Error) => {
      if (allowList.some((r) => r.test(err.message))) return;
      pageErrors.push(err);
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    const sink: ConsoleSink = {
      errors,
      pageErrors,
      allow(pattern) {
        allowList.push(pattern);
      },
      assertNoErrors() {
        const lines = [
          ...errors.map((e) => `  console.error: ${e.text}${e.location ? ` (@${e.location})` : ""}`),
          ...pageErrors.map((e) => `  pageerror: ${e.message}`),
        ];
        if (lines.length > 0) {
          throw new Error(`Browser reported ${lines.length} error(s):\n${lines.join("\n")}`);
        }
      },
    };

    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture `use`, not React `use`
    await use(sink);

    page.off("console", onConsole);
    page.off("pageerror", onPageError);

    // 跑完自动断言一次；如果想自定义 allow，在 test body 里调 sink.allow()
    if (testInfo.status === "passed") {
      sink.assertNoErrors();
    }
  },
});

export { expect };
