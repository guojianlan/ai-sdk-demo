import { WORKFLOWS } from "@/lib/workflows/bug-fix";

/**
 * GET /api/workflow/list
 *
 * 返回所有可用工作流的概览（id / label / description / 节点数）。
 * 前端用这个填工作流选择菜单。
 *
 * 完整定义（含 instructionsTemplate、tools 等）按需通过额外的 GET 路由返回，
 * 避免把所有 prompt 文本一次性传给前端（MVP 阶段直接 inline 也够用，待后续按需拆）。
 */
export function GET() {
  const summaries = Object.values(WORKFLOWS).map((wf) => ({
    id: wf.id,
    label: wf.label,
    description: wf.description ?? null,
    nodeCount: wf.nodes.length,
    nodes: wf.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      description: n.description ?? null,
    })),
  }));

  return Response.json({ workflows: summaries });
}
