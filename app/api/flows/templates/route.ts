import { createFlowFromTemplate } from "@/lib/persistence";
import type { FlowTemplateId } from "@/lib/flows/templates";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    templateId?: unknown;
    title?: unknown;
    workspaceRoot?: unknown;
    workspaceName?: unknown;
  };

  const templateId =
    typeof body.templateId === "string"
      ? (body.templateId as FlowTemplateId)
      : "juejin-frontend-document-intake";
  const workspaceRoot =
    typeof body.workspaceRoot === "string" ? body.workspaceRoot.trim() : "";
  const workspaceName =
    typeof body.workspaceName === "string" ? body.workspaceName.trim() : null;

  if (!workspaceRoot) {
    return Response.json({ error: "workspaceRoot is required" }, { status: 400 });
  }

  try {
    const graph = createFlowFromTemplate({
      templateId,
      title: typeof body.title === "string" ? body.title : null,
      workspaceRoot,
      workspaceName,
    });
    return Response.json(graph, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to create flow template",
      },
      { status: 400 },
    );
  }
}

