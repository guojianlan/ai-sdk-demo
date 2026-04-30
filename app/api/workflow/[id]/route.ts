import { getWorkflow } from "@/lib/workflows/bug-fix";

/**
 * GET /api/workflow/[id]
 *
 * 返回单个工作流的完整定义。前端 WorkflowRunner 加载工作流时拉一次，
 * 后续渲染 / 节点推进都基于这份定义快照。
 *
 * 注意：节点定义里的 Zod schema（outputSchemaKey）只把 key 字符串发给前端，
 * 实际 schema 不出网。前端只需要 key 来识别"该用哪种审批 UI / 输出渲染"，
 * 真正的校验都在服务端节点执行器里做。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const workflow = getWorkflow(id);
    return Response.json(workflow);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Not found" },
      { status: 404 },
    );
  }
}
