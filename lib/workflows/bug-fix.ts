import type { WorkflowDefinition } from "@/lib/workflow/types";

/**
 * Bug 自动修复工作流（MVP 6 节点）。
 *
 * 用户场景：用户描述一个 bug → 工作流定位 → 提案 → 用户审批 → 落地 → 验证 → 报告。
 *
 * 节点链：
 *   diagnose (agent, 只读工具)
 *     → propose-fix (structured, 不带工具)
 *     → human-approval (human, 用户审批)
 *     → apply-patch (agent, edit_file/write_file，bypass approval)
 *     → verify (agent, run_lint，bypass approval)
 *     → report (agent, 无工具)
 *
 * 取舍：
 * - apply-patch 用 agent 而不是直接 tool：patches 是数组，需要循环调用 edit_file，
 *   交给小 agent 处理比写"批量 apply"工具更通用（也方便处理 oldSnippet 不匹配
 *   时的微调）。
 * - apply-patch 节点的 bypassPermissions=true：人工审批已经在 human-approval 节点
 *   做过了，这里再弹卡是噪音。
 * - human-approval 拒绝时的处理：runner（前端）见到 output.approved === false 就
 *   把工作流标为 "rejected" 完成，不再推进 4-6 节点。这是 MVP 的"硬编码分支"。
 *
 * 后续可扩展：
 * - propose-fix 加 max_patches 上限；超过就拆成两轮
 * - verify 加 run_test 工具
 * - 失败重试：agent 节点配置 retry 次数
 */

export const bugFixWorkflow: WorkflowDefinition = {
  id: "bug-fix",
  label: "Bug 自动修复",
  description: "描述 bug，agent 定位 → 提案 → 你审批 → 落地 → 验证 → 报告",
  inputSchemaKey: "bug-fix.input",
  nodes: [
    {
      id: "diagnose",
      kind: "agent",
      label: "定位 bug",
      description: "用工作区只读工具找出 bug 根因",
      inputs: {
        bugReport: "workflow.input.bugReport",
      },
      outputSchemaKey: "freeform",
      config: {
        kind: "agent",
        instructionsTemplate: [
          "你是一个资深工程师，任务是定位用户描述的 bug。",
          "",
          "用户的 bug 报告：",
          "---",
          "{{bugReport}}",
          "---",
          "",
          "工作流程：",
          "1. 用 list_files 摸清项目结构（如果还不熟）",
          "2. 用 search_code / read_file 定位相关源码",
          "3. 复杂的代码模块用 explore_workspace 让子 agent 帮你深入摸索",
          "4. 找到根因后停下来，不要尝试修复（修复是后续节点的工作）",
          "",
          "最终输出（纯文本，不需要 JSON）：",
          "- 一段简明的根因说明（2-4 句）",
          "- 受影响的文件列表（workspace-relative 路径）",
          "- 关键证据（贴 1-3 段源码片段，每段配 1 句解释为什么是问题）",
          "",
          "限制：",
          "- 不要写文件、不要跑命令——本节点是只读调查",
          "- 找不到根因也要给出'最可能的几个方向 + 还需要哪些信息'，不要瞎猜",
        ].join("\n"),
        tools: ["list_files", "search_code", "read_file", "explore_workspace"],
        maxSteps: 12,
        bypassPermissions: false,
      },
    },
    {
      id: "propose-fix",
      kind: "structured",
      label: "提案修复方案",
      description: "基于诊断输出，生成结构化的 patch 方案",
      inputs: {
        diagnosis: "nodes.diagnose.output",
        bugReport: "workflow.input.bugReport",
      },
      outputSchemaKey: "bug-fix.propose-fix.output",
      config: {
        kind: "structured",
        instructionsTemplate: [
          "你的任务：把上一节点的诊断结果，转化成可以直接 apply 的具体 patch。",
          "",
          "用户原始 bug 报告：",
          "{{bugReport}}",
          "",
          "诊断结果（来自 diagnose 节点）：",
          "{{diagnosis}}",
          "",
          "要求：",
          "- 输出 1-5 个 patch，每个 patch 改一个文件的一段连续代码",
          "- oldSnippet 必须是源文件里**实际存在的 byte-for-byte** 文本（含缩进 / 空白）；模型如果记不准就保守一点，宁愿少改也别瞎写",
          "- newSnippet 写完整的替换内容（不要 diff 风格的 +/-）",
          "- rationale 用 1-2 句解释为什么这样改能修 bug",
          "- summary 用一句话总结整组 patch 的意图",
          "",
          "范围控制：只修这次诊断指出的 bug；不要顺手做无关重构 / 风格清理。",
          "",
          "输出 schema 已在系统中绑定，只需返回符合 schema 的 JSON。",
        ].join("\n"),
        outputSchemaKey: "bug-fix.propose-fix.output",
      },
    },
    {
      id: "human-approval",
      kind: "human",
      label: "人工审批",
      description: "你审核修复方案，通过 / 拒绝",
      inputs: {
        proposal: "nodes.propose-fix.output",
      },
      outputSchemaKey: "bug-fix.human-approval.output",
      config: {
        kind: "human",
        promptTemplate:
          "请审核以下修复方案。点击通过 = 进入 apply-patch；拒绝 = 中止工作流。\n\n{{proposal}}",
        uiKind: "approval",
      },
    },
    {
      id: "apply-patch",
      kind: "agent",
      label: "应用 patch",
      description: "把审批通过的 patch 落地到文件",
      inputs: {
        patches: "nodes.propose-fix.output",
      },
      outputSchemaKey: "freeform",
      config: {
        kind: "agent",
        instructionsTemplate: [
          "你的任务：把以下 patches 一个一个 apply 到对应文件。",
          "",
          "Patches（来自 propose-fix 节点，已经过用户审批）：",
          "{{patches}}",
          "",
          "工作流程：",
          "1. 对每个 patch：先 read_file 读出当前内容，确认 oldSnippet 仍存在",
          "2. 调 edit_file，oldString=patch.oldSnippet，newString=patch.newSnippet",
          "3. 如果 edit_file 报错（oldSnippet 不匹配），用 read_file 看一下当前实际内容，必要时调整 oldSnippet 的边界再试一次",
          "4. 全部 patch 处理完后，用一段中文文字总结：哪些文件成功改了 / 哪些跳过了 / 跳过的原因",
          "",
          "限制：",
          "- 只允许修 patches 列表里出现过的文件，不要顺手改别的",
          "- 不要做 patches 里没有的改动",
          "- 写入工具会自动批准（本节点已在工作流层做过人工审批），不会再弹卡",
        ].join("\n"),
        tools: ["read_file", "edit_file", "write_file"],
        maxSteps: 12,
        bypassPermissions: true,
      },
    },
    {
      id: "verify",
      kind: "agent",
      label: "验证 (lint)",
      description: "跑 npm run lint 验证改动没破坏其它代码",
      inputs: {},
      outputSchemaKey: "freeform",
      config: {
        kind: "agent",
        instructionsTemplate: [
          "你的任务：用 run_lint 工具跑一次 lint，把结果用一段中文文字总结给用户。",
          "",
          "工作流程：",
          "1. 调 run_lint（无需参数）",
          "2. 看 passed 字段：true → 写'lint 通过'；false → 把 output 里前几个错误的关键行节选出来，标注文件和行号",
          "3. 如果 lint 失败但失败和我们的改动无关（比如是 tmp/ 目录里历史问题），明确指出",
          "",
          "限制：",
          "- 只调一次 run_lint；不要重复跑",
          "- 不要尝试自己修 lint 错误（那是另一轮工作流的事）",
        ].join("\n"),
        tools: ["run_lint"],
        maxSteps: 3,
        bypassPermissions: true,
      },
    },
    {
      id: "report",
      kind: "agent",
      label: "总结报告",
      description: "把整个修复过程写成 markdown 报告",
      inputs: {
        bugReport: "workflow.input.bugReport",
        diagnosis: "nodes.diagnose.output",
        proposal: "nodes.propose-fix.output",
        applyResult: "nodes.apply-patch.output",
        verifyResult: "nodes.verify.output",
      },
      outputSchemaKey: "freeform",
      config: {
        kind: "agent",
        instructionsTemplate: [
          "你的任务：把这次 bug 修复的全过程写成一段简洁的 markdown 报告。",
          "",
          "原始 bug 报告：",
          "{{bugReport}}",
          "",
          "诊断：",
          "{{diagnosis}}",
          "",
          "修复方案：",
          "{{proposal}}",
          "",
          "应用结果：",
          "{{applyResult}}",
          "",
          "验证结果：",
          "{{verifyResult}}",
          "",
          "报告结构（用 markdown）：",
          "## 问题",
          "## 根因",
          "## 修复",
          "## 验证",
          "## 后续建议（如有）",
          "",
          "限制：",
          "- 不要复制粘贴大段代码；要的是结论 + 关键文件名",
          "- 整体长度控制在 250-400 字",
          "- 不调用任何工具，纯文字输出",
        ].join("\n"),
        tools: [],
        maxSteps: 1,
        bypassPermissions: false,
      },
    },
  ],
};

/**
 * 工作流注册表。
 *
 * 后续如果要加新工作流（例如 "release-notes-from-prs", "code-review"），
 * 在 `lib/workflows/` 加文件，然后注册到这里。
 */
export const WORKFLOWS = {
  "bug-fix": bugFixWorkflow,
} as const;

export type WorkflowId = keyof typeof WORKFLOWS;

export function getWorkflow(id: string): WorkflowDefinition {
  if (!(id in WORKFLOWS)) {
    throw new Error(
      `Unknown workflow '${id}'. Registered: ${Object.keys(WORKFLOWS).join(", ")}`,
    );
  }
  return WORKFLOWS[id as WorkflowId];
}
