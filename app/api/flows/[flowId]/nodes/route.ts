import {
  createFlowNode,
  type FlowNodeType,
} from "@/lib/persistence";
import { isRegisteredFlowNodeType } from "@/lib/flows/node-registry";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const { flowId } = await params;
  const body = (await request.json()) as {
    type?: unknown;
    title?: unknown;
    position?: unknown;
    config?: unknown;
  };
  const type =
    typeof body.type === "string" && isRegisteredFlowNodeType(body.type)
      ? (body.type as FlowNodeType)
      : "prompt";
  const position = normalizePosition(body.position);

  try {
    const node = createFlowNode({
      flowId,
      type,
      title: typeof body.title === "string" ? body.title : undefined,
      position,
      config: body.config,
    });
    return Response.json({ node }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to create node" },
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
