import { executeFlowRun } from "@/lib/flows/executor";
import { requireGatewayApiKey } from "@/lib/env";
import {
  createFlowRun,
  getFlowRunWithNodes,
  listFlowRuns,
  updateFlowRun,
} from "@/lib/persistence";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const { flowId } = await params;
  try {
    return Response.json({ runs: listFlowRuns(flowId) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load runs" },
      { status: 404 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const { flowId } = await params;
  let body: { inputJson?: unknown } = {};
  try {
    body = (await request.json()) as { inputJson?: unknown };
  } catch {
    body = {};
  }

  try {
    requireGatewayApiKey();
    const run = createFlowRun({
      flowId,
      input: body.inputJson ?? {},
      status: "running",
    });
    void executeFlowRun({
      flowId,
      input: body.inputJson ?? {},
      runId: run.id,
    }).catch((error) => {
      updateFlowRun(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unable to run flow",
        finishedAt: Date.now(),
      });
    });

    const detail = getFlowRunWithNodes(run.id);
    return Response.json(detail, { status: 202 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to run flow" },
      { status: 400 },
    );
  }
}
