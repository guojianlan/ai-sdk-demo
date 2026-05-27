import { getFlowWithGraph } from "@/lib/persistence";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const { flowId } = await params;
  const graph = getFlowWithGraph(flowId);
  if (!graph) {
    return Response.json({ error: "Flow not found" }, { status: 404 });
  }
  return Response.json(graph);
}
