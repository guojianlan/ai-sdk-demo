import { archiveThread, getThread, unarchiveThread } from "@/lib/persistence";

/**
 * POST   /api/sessions/[id]/archive    —— 归档（list 默认筛掉）
 * DELETE /api/sessions/[id]/archive    —— 取消归档
 *
 * Archive 跟 delete 不同：archive 只动 archived_at 字段，messages / jsonl 都保留。
 * delete 才是不可逆清盘。
 */

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const normalized = id?.trim();
  if (!normalized) {
    return new Response("missing id", { status: 400 });
  }
  if (!getThread(normalized)) {
    return new Response("thread not found", { status: 404 });
  }
  archiveThread(normalized);
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
  if (!getThread(normalized)) {
    return new Response("thread not found", { status: 404 });
  }
  unarchiveThread(normalized);
  return Response.json({ ok: true });
}
