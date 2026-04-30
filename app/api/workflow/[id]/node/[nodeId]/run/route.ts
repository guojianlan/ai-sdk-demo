import { z } from "zod";

import { runNode } from "@/lib/workflow/node-executors";
import { getSchema } from "@/lib/workflow/schema-registry";
import { normalizeWorkspaceRoot } from "@/lib/workspaces";
import { getWorkflow } from "@/lib/workflows/bug-fix";

/**
 * POST /api/workflow/[id]/node/[nodeId]/run
 *
 * 节点执行入口。前端 WorkflowRunner 按工作流定义顺序对每个节点调一次本路由。
 *
 * 协议：
 *   request body:
 *     - runId: 前端生成的运行 id（仅用于 server log，不持久化）
 *     - workflowInput: 工作流初始 input（每次都传，便于节点拿）
 *     - upstreamOutputs: { [nodeId]: { output } } —— 截至当前节点的所有上游输出
 *     - workspaceRoot / workspaceName
 *     - humanResponse?: 当节点 kind=human 且收到用户回包时传
 *
 *   response: RunNodeResponse
 *     - { status: "done", output, durationMs, stepsUsed? }
 *     - { status: "awaiting-input", payload }
 *     - { status: "error", error }
 *
 * 注意：本路由是**一次性的**——人工审批节点首次调用返 awaiting-input，前端拿到
 * 用户回应后再调一次本路由（带 humanResponse），第二次才返 done。
 */

const requestSchema = z.object({
  runId: z.string().min(1),
  workflowInput: z.record(z.string(), z.unknown()),
  upstreamOutputs: z.record(z.string(), z.unknown()).default({}),
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
  humanResponse: z.unknown().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id: workflowId, nodeId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // 工作流 + 节点查找
  let workflow;
  try {
    workflow = getWorkflow(workflowId);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow not found" },
      { status: 404 },
    );
  }
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return Response.json(
      { error: `Node '${nodeId}' not found in workflow '${workflowId}'` },
      { status: 404 },
    );
  }

  // workspaceRoot 校验（reject `..` 逃逸）
  let workspaceRoot: string;
  try {
    workspaceRoot = await normalizeWorkspaceRoot(data.workspaceRoot);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid workspace" },
      { status: 400 },
    );
  }

  // 工作流首节点会带入 workflowInput——校验一次（按工作流 inputSchemaKey）
  if (workflow.nodes[0].id === node.id) {
    try {
      getSchema(workflow.inputSchemaKey).parse(data.workflowInput);
    } catch (error) {
      return Response.json(
        {
          error: `Workflow input failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 400 },
      );
    }
  }

  console.log(
    `[workflow] run=${data.runId} workflow=${workflowId} node=${nodeId} hasHumanResponse=${data.humanResponse !== undefined}`,
  );

  const response = await runNode(node, {
    runId: data.runId,
    workflowInput: data.workflowInput,
    upstreamOutputs: data.upstreamOutputs,
    workspaceRoot,
    workspaceName: data.workspaceName,
    humanResponse: data.humanResponse,
  });

  return Response.json(response);
}
