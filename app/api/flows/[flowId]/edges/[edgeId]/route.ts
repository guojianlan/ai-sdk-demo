import { deleteFlowEdge } from "@/lib/persistence";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ flowId: string; edgeId: string }> },
) {
  const { flowId, edgeId } = await params;

  try {
    const edge = deleteFlowEdge({ flowId, edgeId });
    return Response.json({ edge });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to delete edge" },
      { status: 400 },
    );
  }
}
