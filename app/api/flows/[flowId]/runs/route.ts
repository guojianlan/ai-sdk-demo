import { executeFlow } from "@/lib/flows/executor";
import { requireGatewayApiKey } from "@/lib/env";
import { listFlowRuns } from "@/lib/persistence";

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
    const run = await executeFlow({
      flowId,
      input: body.inputJson ?? {},
    });
    return Response.json(run, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to run flow" },
      { status: 400 },
    );
  }
}
