import { streamObject } from "ai";

import { instrumentModel } from "@/lib/devtools";
import { gateway, gatewayModelId } from "@/lib/gateway";
import { planSchema } from "@/lib/plan-schema";

/**
 * Plan 生成器 —— 演示 AI SDK 的 `streamObject` + Zod schema。
 *
 * 为什么要独立一个 generator：有些任务不适合"直接开聊"，比如一次性需求量大的
 * 重构（"把 localStorage 换成 IndexedDB"）。先让模型吐一份结构化 plan，
 * 用户过一遍 / 编辑 / 接受，然后带着这份 plan 去执行，比直接聊天靠谱得多。
 *
 * 这是 `generateObject` / `streamObject` 相对 `ToolLoopAgent` 的关键区别：
 * - ToolLoopAgent：循环调 tool，无固定输出结构；用于"做事"。
 * - generateObject / streamObject：单次调用，输出**严格符合 Zod schema**；用于"想事"。
 */

// planSchema 和 Plan 类型定义在 lib/plan-schema.ts（客户端安全，无 node:fs 依赖），
// 服务端和客户端各自从那里 import，避免客户端 import 链拉到 @ai-sdk/devtools。
export { planSchema, type Plan } from "@/lib/plan-schema";

const planPersona = [
  `你是一个高级软件工程师，帮用户把任务拆成可执行的步骤。`,
  ``,
  `要求：`,
  `- 步骤按执行顺序排列。前置步骤在前，依赖它的步骤在后。`,
  `- 每一步要"可验证"——做完能让人一眼看出改完没。`,
  `- filesToTouch 给具体路径，不要给目录。不清楚具体文件时，给最可能的路径并在 reason 里说明"可能还涉及..."。`,
  `- risk 判断要严格：改单个纯函数是 low；动 API 契约或 localStorage/DB schema 是 high。`,
  `- overview 要聚焦"什么变了"，不要写"我会帮你..."这种开场白。`,
  ``,
  `禁止事项：`,
  `- 不要反问用户。信息不够就按合理假设生成，并在 overview 里注明"假设 X"。`,
  `- 不要输出 schema 之外的任何内容。`,
].join("\n");

/**
 * 启动一次 plan 的流式生成。
 * @param task 用户描述的任务（自然语言）
 * @param workspaceContext 可选的工作区上下文，用来给模型一些项目相关线索
 */
export function streamPlan({
  task,
  workspaceContext,
}: {
  task: string;
  workspaceContext?: { name?: string; root?: string };
}) {
  const contextLine = workspaceContext?.name
    ? `\n\n当前工作区：${workspaceContext.name}${
        workspaceContext.root ? ` (${workspaceContext.root})` : ""
      }。`
    : "";

  const prompt = `任务：\n${task}${contextLine}`;

  return streamObject({
    model: instrumentModel(gateway.chatModel(gatewayModelId)),
    schema: planSchema,
    system: planPersona,
    prompt,
  });
}
