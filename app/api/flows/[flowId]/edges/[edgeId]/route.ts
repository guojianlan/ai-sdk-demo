import { deleteFlowEdge, updateFlowEdge } from "@/lib/persistence";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ flowId: string; edgeId: string }> },
) {
  const { flowId, edgeId } = await params;
  const body = (await request.json()) as {
    condition?: unknown;
  };

  try {
    const edge = updateFlowEdge({
      flowId,
      edgeId,
      condition: body.condition ?? null,
    });
    return Response.json({ edge });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to update edge" },
      { status: 400 },
    );
  }
}

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
