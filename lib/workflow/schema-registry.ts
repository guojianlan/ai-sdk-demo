import { z } from "zod";

/**
 * 输出 schema 注册表。
 *
 * 节点定义里 `outputSchemaKey: string` 引用的就是这里的 key。
 * 之所以不直接在节点定义里存 `z.ZodType` 实例，是因为：
 * 1. Zod schema 有 method（.parse / .safeParse），序列化容易丢
 * 2. 注册表集中放，方便后期把工作流定义搬到 DB / JSON 时只改一处
 *
 * 增加新 schema：在下方 `schemas` 对象里加一对 `key: zodSchema`。
 *
 * MVP 阶段先放 bug-fix 工作流要用的那几个；后续工作流多了再考虑按文件拆分。
 */

// ---------- bug-fix 工作流相关 schema ----------

const bugFixInputSchema = z.object({
  bugReport: z
    .string()
    .min(10)
    .describe("用户对 bug 的描述（症状、复现路径、期望行为）"),
});

const diagnoseOutputSchema = z.object({
  rootCause: z.string().describe("一句话说清根因"),
  affectedFiles: z
    .array(z.string())
    .describe("受影响的文件 workspace-relative path 列表"),
  evidence: z
    .array(
      z.object({
        file: z.string(),
        snippet: z.string().describe("从源码摘录的关键片段"),
        explanation: z.string().describe("为什么这段是问题所在"),
      }),
    )
    .describe("支撑根因判断的证据"),
});

const proposeFixOutputSchema = z.object({
  summary: z.string().describe("修复方案的一句话总结"),
  patches: z
    .array(
      z.object({
        file: z
          .string()
          .describe("workspace-relative path"),
        oldSnippet: z
          .string()
          .describe("要被替换的现有代码（必须和源文件 byte-for-byte 一致）"),
        newSnippet: z.string().describe("替换后的新代码"),
        rationale: z.string().describe("为什么这样改"),
      }),
    )
    .min(1)
    .describe("具体修复 patches，按文件粒度组织"),
});

const humanApprovalOutputSchema = z.object({
  approved: z.boolean(),
  comment: z.string().optional().describe("用户附加的评论（可选）"),
});

const applyPatchOutputSchema = z.object({
  appliedFiles: z.array(z.string()),
  skippedFiles: z
    .array(z.object({ file: z.string(), reason: z.string() }))
    .default([]),
});

const verifyOutputSchema = z.object({
  lintPassed: z.boolean(),
  lintOutput: z.string().describe("lint 的 stdout/stderr 摘要（截断版）"),
});

const reportOutputSchema = z.object({
  markdown: z.string().describe("完整的 markdown 报告"),
});

// ---------- 注册表 ----------

const schemas = {
  "bug-fix.input": bugFixInputSchema,
  "bug-fix.diagnose.output": diagnoseOutputSchema,
  "bug-fix.propose-fix.output": proposeFixOutputSchema,
  "bug-fix.human-approval.output": humanApprovalOutputSchema,
  "bug-fix.apply-patch.output": applyPatchOutputSchema,
  "bug-fix.verify.output": verifyOutputSchema,
  "bug-fix.report.output": reportOutputSchema,
} as const;

export type SchemaKey = keyof typeof schemas;

export function getSchema(key: string): z.ZodType<unknown> {
  if (!(key in schemas)) {
    throw new Error(
      `Unknown schema key '${key}'. Registered: ${Object.keys(schemas).join(", ")}`,
    );
  }
  return schemas[key as SchemaKey] as z.ZodType<unknown>;
}
