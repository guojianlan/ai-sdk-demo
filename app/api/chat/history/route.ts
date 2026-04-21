import { loadMessages } from "@/lib/chat-store";

/**
 * GET /api/chat/history?id=<sessionId>
 *
 * 返回 DB 里持久化过的消息列表。切 session / 刷新页面时前端用来预热 `useChat({ messages })`。
 * 正在跑的那条半成品不在这里（那条走 resume via GET /api/chat/[chatId]/stream）。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("id")?.trim();
  if (!sessionId) {
    return new Response("missing id query param", { status: 400 });
  }

  try {
    const messages = loadMessages(sessionId);
    return Response.json({ messages });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "failed to load history",
      { status: 500 },
    );
  }
}
