import type { ToolSet } from "ai";
import { z } from "zod";

import {
  buildProjectEngineerDeveloperRules,
  projectEngineerPersona,
} from "@/app/api/chat/agent-config";
import { buildSystemPrompt } from "@/lib/chat-agent/system-prompt";
import {
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import { globalRegistry } from "@/lib/tooling";
// 副作用 import：触发 lib/tools/index.ts 把所有业务 tool 注册进 globalRegistry。
// 必须放在 globalRegistry 任何 .pick() 调用之前。
import "@/lib/tools";
import { renderTemplate, resolveInputs } from "@/lib/workflow/template";
import { getWorkflow } from "@/lib/workflows/bug-fix";
import { normalizeWorkspaceRoot } from "@/lib/workspaces";

/**
 * AgentSource —— "调用 /api/agent/step 的人是谁"。
 *
 * 客户端**不直接传 tool 名 / system prompt**——只传一个 source 标识，服务端按
 * source 自己 lookup 出 tool 集合 + 拼出 system prompt，并执行后续 streamText。
 *
 * 这样客户端不需要知道：
 *   - 服务端有哪些 tool（不再泄露内部 tool registry）
 *   - persona / developer rules / envContext 怎么拼
 *
 * 客户端只需要知道："我现在是主聊天还是工作流的某个节点"。
 *
 * 两种 source：
 * - `chat`         —— 主聊天，按 workspaceAccessMode 决定 tool 集合
 * - `workflow-node`—— 跑某个工作流的某个 agent 节点；tool / instructions 来自节点定义
 */

export const agentSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chat"),
    accessMode: z.enum(["workspace-tools", "no-tools"]).optional(),
  }),
  z.object({
    kind: z.literal("workflow-node"),
    workflowId: z.string().min(1),
    nodeId: z.string().min(1),
  }),
]);
export type AgentSource = z.infer<typeof agentSourceSchema>;

/** workspace 上下文：tool execute 需要这些字段（透传给 experimental_context）。 */
export const workspaceContextSchema = z.object({
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
  bypassPermissions: z.boolean().optional(),
});
export type WorkspaceContextInput = z.infer<typeof workspaceContextSchema>;

/** workflow-node 专属：上游节点输出 + 工作流初始 input。 */
export const workflowNodeContextSchema = z.object({
  workflowInput: z.record(z.string(), z.unknown()),
  upstreamOutputs: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowNodeContextInput = z.infer<typeof workflowNodeContextSchema>;

export type ResolvedAgent = {
  /** 完整 system prompt 字符串。 */
  system: string;
  /** 该 source 实际可用的 tool 集合。 */
  tools: ToolSet;
  /** 透传给 tool execute 的 experimental_context。 */
  experimentalContext: Record<string, unknown>;
  /** 单 turn 的 step 上限（agent 节点配置；chat 走默认）。 */
  maxSteps: number;
};

/** chat 模式下按 access mode 决定可用工具。MCP 不放进来——MCP 是 per-request 子进程。 */
const CHAT_TOOLS_BY_ACCESS_MODE: Record<WorkspaceAccessMode, string[]> = {
  "workspace-tools": [
    "list_files",
    "search_code",
    "read_file",
    "write_file",
    "edit_file",
    "explore_workspace",
    "ask_question",
    "ask_choice",
    "show_reference",
  ],
  "no-tools": ["ask_question", "ask_choice", "show_reference"],
};

const CHAT_DEFAULT_MAX_STEPS = 16;

/**
 * 根据 source 解析出 streamText 跑这一步需要的全套参数。
 *
 * - chat → 用 projectEngineerPersona + buildProjectEngineerDeveloperRules，
 *   buildSystemPrompt 注入 envContext / AGENTS.md
 * - workflow-node → 拿节点定义；用 nodeContext 解析节点 inputs，渲染 instructions 模板
 */
export async function resolveAgentSource(input: {
  source: AgentSource;
  workspaceContext: WorkspaceContextInput;
  nodeContext?: WorkflowNodeContextInput;
}): Promise<ResolvedAgent> {
  const { source, workspaceContext, nodeContext } = input;

  const workspaceRoot = await normalizeWorkspaceRoot(
    workspaceContext.workspaceRoot,
  );
  const workspaceName =
    workspaceContext.workspaceName?.trim() ||
    workspaceRoot.split("/").pop() ||
    workspaceRoot;

  if (source.kind === "chat") {
    const accessMode = normalizeWorkspaceAccessMode(source.accessMode);
    const developerRules = buildProjectEngineerDeveloperRules(
      accessMode,
      workspaceName,
    );
    const system = await buildSystemPrompt({
      persona: projectEngineerPersona,
      developerRules,
      workspaceRoot,
      conversationSummary: null,
    });
    return {
      system,
      tools: globalRegistry.pick(CHAT_TOOLS_BY_ACCESS_MODE[accessMode]),
      experimentalContext: {
        workspaceRoot,
        workspaceName,
        bypassPermissions: workspaceContext.bypassPermissions === true,
      },
      maxSteps: CHAT_DEFAULT_MAX_STEPS,
    };
  }

  // workflow-node
  const workflow = getWorkflow(source.workflowId);
  const node = workflow.nodes.find((n) => n.id === source.nodeId);
  if (!node || node.config.kind !== "agent") {
    throw new Error(
      `workflow-node source: '${source.workflowId}/${source.nodeId}' is not an agent node`,
    );
  }
  if (!nodeContext) {
    throw new Error("workflow-node source requires nodeContext");
  }

  const inputs = resolveInputs(node.inputs, {
    workflow: { input: nodeContext.workflowInput },
    nodes: nodeContext.upstreamOutputs as Record<
      string,
      { output: unknown } | undefined
    >,
  });
  const system = renderTemplate(node.config.instructionsTemplate, inputs);

  return {
    system,
    tools: globalRegistry.pick(node.config.tools),
    experimentalContext: {
      workspaceRoot,
      workspaceName,
      bypassPermissions: node.config.bypassPermissions === true,
    },
    maxSteps: node.config.maxSteps,
  };
}
