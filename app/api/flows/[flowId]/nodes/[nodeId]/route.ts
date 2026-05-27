import { updateFlowNode } from "@/lib/persistence";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ flowId: string; nodeId: string }> },
) {
  const { flowId, nodeId } = await params;
  const body = (await request.json()) as {
    title?: unknown;
    position?: unknown;
    config?: unknown;
  };

  try {
    const node = updateFlowNode({
      flowId,
      nodeId,
      title: typeof body.title === "string" ? body.title : undefined,
      position: normalizePosition(body.position),
      config: body.config,
    });
    return Response.json({ node });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to update node" },
      { status: 400 },
    );
  }
}

function normalizePosition(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as { x?: unknown; y?: unknown };
  if (typeof maybe.x !== "number" || typeof maybe.y !== "number") {
    return undefined;
  }
  return { x: maybe.x, y: maybe.y };
}
