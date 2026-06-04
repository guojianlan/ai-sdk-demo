import {
  getFlowRunWithNodes,
  listFlowRunEvents,
} from "@/lib/persistence";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ flowId: string; runId: string }> },
) {
  const { flowId, runId } = await params;
  const detail = getFlowRunWithNodes(runId);
  if (!detail || detail.run.flowId !== flowId) {
    return Response.json({ error: "Flow run not found" }, { status: 404 });
  }

  try {
    return Response.json({ events: listFlowRunEvents(runId) });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load flow run events",
      },
      { status: 400 },
    );
  }
}
