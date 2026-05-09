import {
  deleteThread,
  getThread,
  updateThreadPermissionMode,
  updateThreadPlanMode,
  updateThreadTitle,
} from "@/lib/persistence";
import {
  normalizePermissionMode,
  permissionModeSchema,
} from "@/lib/permissions";

/**
 * GET    /api/sessions/[id]      —— 取单个 thread 元数据（不含 messages）
 * PATCH  /api/sessions/[id]      —— 改 title / permissionMode / planMode（互斥，三选一）
 *                                   body: { title?: string }
 *                                       | { permissionMode: "default"|"acceptEdits"|"bypassPermissions" }
 *                                       | { planMode: boolean }
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
    permissionMode?: unknown;
    planMode?: unknown;
  } | null;

  if (!getThread(normalized)) {
    return new Response("thread not found", { status: 404 });
  }

  // permissionMode 优先：UI 切模式时单独打这条 PATCH，title/planMode 不带。
  if (body?.permissionMode !== undefined) {
    const parsed = permissionModeSchema.safeParse(body.permissionMode);
    if (!parsed.success) {
      return new Response(
        `invalid permissionMode (must be one of default / acceptEdits / bypassPermissions)`,
        { status: 400 },
      );
    }
    updateThreadPermissionMode(normalized, normalizePermissionMode(parsed.data));
    return Response.json({ ok: true });
  }

  if (body?.planMode !== undefined) {
    if (typeof body.planMode !== "boolean") {
      return new Response("planMode must be boolean", { status: 400 });
    }
    updateThreadPlanMode(normalized, body.planMode);
    return Response.json({ ok: true });
  }

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) {
    return new Response("title, permissionMode, or planMode is required", {
      status: 400,
    });
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
