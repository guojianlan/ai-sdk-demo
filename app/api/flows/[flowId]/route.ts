import { archiveFlow, getFlowWithGraph, updateFlow } from "@/lib/persistence";

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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const { flowId } = await params;
  const body = (await request.json()) as {
    title?: unknown;
    description?: unknown;
  };

  try {
    const flow = updateFlow({
      flowId,
      title: typeof body.title === "string" ? body.title : undefined,
      description:
        body.description === null
          ? null
          : typeof body.description === "string"
            ? body.description.trim() || null
            : undefined,
    });
    return Response.json({ flow });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to update flow" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const { flowId } = await params;

  try {
    const flow = archiveFlow(flowId);
    return Response.json({ flow });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to archive flow" },
      { status: 400 },
    );
  }
}
