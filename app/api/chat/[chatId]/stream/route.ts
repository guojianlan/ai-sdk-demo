import {
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
  type UIMessage,
} from "ai";
import { getRun } from "workflow/api";

import {
  compareAndSetActiveStreamId,
  getActiveStreamId,
} from "@/lib/chat-store";
import {
  createCancelableReadableStream,
  dropReasoningChunks,
  orderStatefulUIMessageChunks,
} from "@/lib/workflow-readable";

/**
 * GET /api/chat/[chatId]/stream
 *
 * AI SDK v6 的 DefaultChatTransport.reconnectToStream 默认打这条路径。
 * 在 SQLite 里找对应 chatId 的 active workflow run：
 *   - 找到 → 把"已累积 chunks + 后续 live chunks"作为 SSE 返回，客户端无缝续看
 *   - 没找到（流已结束或根本没开过）→ 204 No Content，前端 resumeStream() 就当无事发生
 */
type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

export async function GET(
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
    return new Response(null, { status: 204 });
  }

  try {
    const run = getRun(runId);
    const status = await run.status;
    if (status !== "running" && status !== "pending") {
      compareAndSetActiveStreamId(normalized, runId, null);
      return new Response(null, { status: 204 });
    }

    return createUIMessageStreamResponse({
      stream: createCancelableReadableStream(
        orderStatefulUIMessageChunks(
          dropReasoningChunks(run.getReadable<ChatUIMessageChunk>()),
        ),
      ),
      headers: { "x-workflow-run-id": runId },
    });
  } catch {
    compareAndSetActiveStreamId(normalized, runId, null);
    return new Response(null, { status: 204 });
  }
}
