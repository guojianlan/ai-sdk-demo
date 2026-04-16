import { z } from "zod";

/**
 * Plan 的 Zod schema —— 独立文件，零服务端依赖。
 *
 * 客户端（PlanCard.tsx 的 `experimental_useObject`）和服务端（plan-generator.ts 的
 * `streamObject`）都需要引用同一份 schema。如果 schema 定义在 plan-generator.ts 里，
 * 客户端会通过 import 链拉到 `@ai-sdk/devtools` → `node:fs`，导致 Next.js 构建报错。
 *
 * 抽成独立文件后，客户端只依赖 `zod`（纯浏览器安全），服务端同样 import 这里的 schema
 * 然后自己带上 instrumentModel / gateway 等服务端专用模块。
 */

export const planSchema = z.object({
  overview: z
    .string()
    .describe("一句话概述这个任务要做的核心改动（≤ 60 字中文）。"),
  steps: z
    .array(
      z.object({
        title: z.string().describe("一句话说清这一步要干什么（祈使句）。"),
        reason: z
          .string()
          .describe("为什么这一步必要，一句话解释（不要重复 title）。"),
        filesToTouch: z
          .array(z.string())
          .describe("这一步会动到的文件（workspace-relative 路径）。"),
        risk: z
          .enum(["low", "medium", "high"])
          .describe(
            "变更风险级别：low=局部改动；medium=影响相邻模块；high=大面积改动或涉及持久化/迁移。",
          ),
      }),
    )
    .min(2)
    .max(8)
    .describe("按执行顺序列出的步骤，2-8 步。"),
});

export type Plan = z.infer<typeof planSchema>;
