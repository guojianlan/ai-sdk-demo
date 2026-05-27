import { getFlowRunWithNodes } from "@/lib/persistence";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ flowId: string; runId: string }> },
) {
  const { flowId, runId } = await params;
  const detail = getFlowRunWithNodes(runId);
  if (!detail || detail.run.flowId !== flowId) {
    return Response.json({ error: "Flow run not found" }, { status: 404 });
  }
  return Response.json(detail);
}
