import { getRun } from "workflow/api";

import {
  compareAndSetActiveStreamId,
  getActiveStreamId,
} from "@/lib/chat-store";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await params;
  const normalized = chatId?.trim();
  if (!normalized) {
    return new Response("missing chatId", { status: 400 });
  }

  const runId = getActiveStreamId(normalized);
  if (!runId) {
    return Response.json({ stopped: false });
  }

  try {
    await getRun(runId).cancel();
  } catch {
    // If the run is already gone, clearing our pointer is still correct.
  }

  compareAndSetActiveStreamId(normalized, runId, null);
  return Response.json({ stopped: true, runId });
}
