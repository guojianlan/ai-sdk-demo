import {
  createFlow,
  listFlows,
} from "@/lib/persistence";

export async function GET() {
  return Response.json({ flows: listFlows() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    title?: unknown;
    description?: unknown;
    workspaceRoot?: unknown;
    workspaceName?: unknown;
  };

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const workspaceRoot =
    typeof body.workspaceRoot === "string" ? body.workspaceRoot.trim() : "";
  const workspaceName =
    typeof body.workspaceName === "string" ? body.workspaceName.trim() : null;

  if (!workspaceRoot) {
    return Response.json({ error: "workspaceRoot is required" }, { status: 400 });
  }

  const graph = createFlow({
    title: title || "Untitled flow",
    description:
      typeof body.description === "string" ? body.description.trim() : null,
    workspaceRoot,
    workspaceName,
  });

  return Response.json(graph, { status: 201 });
}
