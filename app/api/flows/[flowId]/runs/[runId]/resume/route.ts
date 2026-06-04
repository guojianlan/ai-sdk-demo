import { resumeFlowRun } from "@/lib/flows/executor";
import { requireGatewayApiKey } from "@/lib/env";
import { getFlowRunWithNodes } from "@/lib/persistence";

type ResumeFlowRunBody = {
  decision?: unknown;
  response?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ flowId: string; runId: string }> },
) {
  const { flowId, runId } = await params;
  const detail = getFlowRunWithNodes(runId);
  if (!detail || detail.run.flowId !== flowId) {
    return Response.json({ error: "Flow run not found" }, { status: 404 });
  }

  let body: ResumeFlowRunBody = {};
  try {
    body = (await request.json()) as ResumeFlowRunBody;
  } catch {
    body = {};
  }

  const decision = normalizeDecision(body.decision);
  if (!decision) {
    return Response.json(
      { error: "decision must be approved or rejected" },
      { status: 400 },
    );
  }

  try {
    if (decision === "approved") {
      requireGatewayApiKey();
    }
    const resumed = await resumeFlowRun({
      flowId,
      runId,
      decision,
      response: body.response,
    });
    return Response.json(resumed);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to resume flow run",
      },
      { status: 400 },
    );
  }
}

function normalizeDecision(
  value: unknown,
): "approved" | "rejected" | null {
  if (value === "approved" || value === "approve") return "approved";
  if (value === "rejected" || value === "reject") return "rejected";
  return null;
}
