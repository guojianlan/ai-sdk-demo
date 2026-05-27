import { cancelActiveChatRun } from "@/lib/chat-agent/active-runs";
import {
  compareAndSetActiveStreamId,
  finishChatRunRecord,
  getActiveStreamId,
} from "@/lib/persistence";

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
    cancelActiveChatRun(runId);
  } catch {
    // If the run is already gone, clearing our pointer is still correct.
  }

  compareAndSetActiveStreamId(normalized, runId, null);
  try {
    finishChatRunRecord({ id: runId, status: "cancelled" });
  } catch {
    // Stale active_stream_id rows can predate persisted chat run records.
  }
  return Response.json({ stopped: true, runId });
}
