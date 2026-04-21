import * as activeStreams from "@/lib/active-streams";

/**
 * GET /api/chat/[chatId]/stream
 *
 * AI SDK v6 的 DefaultChatTransport.reconnectToStream 默认打这条路径。
 * 在 active-streams 注册表里找对应 chatId 的半成品流：
 *   - 找到 → 把"已累积 chunks + 后续 live chunks"作为 SSE 返回，客户端无缝续看
 *   - 没找到（流已结束或根本没开过）→ 204 No Content，前端 resumeStream() 就当无事发生
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await params;
  const normalized = chatId?.trim();
  if (!normalized) {
    return new Response("missing chatId", { status: 400 });
  }

  const stream = activeStreams.subscribe(normalized);
  if (!stream) {
    return new Response(null, { status: 204 });
  }

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
