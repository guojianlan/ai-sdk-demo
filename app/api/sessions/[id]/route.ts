import { deleteThread, getThread, updateThreadTitle } from "@/lib/persistence";

/**
 * GET    /api/sessions/[id]      —— 取单个 thread 元数据（不含 messages）
 * PATCH  /api/sessions/[id]      —— 改 title。body: { title: string }
 * DELETE /api/sessions/[id]      —— 永久删除（messages + jsonl + summary + runtime + threads）
 *
 * 需要 messages 走 GET /api/chat/history?id=<id>，那条已经存在不动。
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const normalized = id?.trim();
  if (!normalized) {
    return new Response("missing id", { status: 400 });
  }
  const thread = getThread(normalized);
  if (!thread) {
    return new Response("thread not found", { status: 404 });
  }
  return Response.json({ thread });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const normalized = id?.trim();
  if (!normalized) {
    return new Response("missing id", { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
  } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return new Response("title is required", { status: 400 });
  }

  if (!getThread(normalized)) {
    return new Response("thread not found", { status: 404 });
  }
  updateThreadTitle(normalized, title);
  return Response.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const normalized = id?.trim();
  if (!normalized) {
    return new Response("missing id", { status: 400 });
  }
  await deleteThread(normalized);
  return Response.json({ ok: true });
}
