import { createFlowEdge } from "@/lib/persistence";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const { flowId } = await params;
  const body = (await request.json()) as {
    sourceNodeId?: unknown;
    targetNodeId?: unknown;
    condition?: unknown;
  };
  const sourceNodeId =
    typeof body.sourceNodeId === "string" ? body.sourceNodeId : "";
  const targetNodeId =
    typeof body.targetNodeId === "string" ? body.targetNodeId : "";

  if (!sourceNodeId || !targetNodeId) {
    return Response.json(
      { error: "sourceNodeId and targetNodeId are required" },
      { status: 400 },
    );
  }

  try {
    const edge = createFlowEdge({
      flowId,
      sourceNodeId,
      targetNodeId,
      condition: body.condition ?? null,
    });
    return Response.json({ edge }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to create edge" },
      { status: 400 },
    );
  }
}
