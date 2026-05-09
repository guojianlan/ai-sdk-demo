import { listThreads, upsertThread } from "@/lib/persistence";

/**
 * GET /api/sessions?workspace=<workspaceRoot>&includeArchived=1
 *
 * 列出会话元数据（id / title / messageCount / created_at / updated_at）。
 * 不返回 messages —— 列表展示不需要，需要时另走 GET /api/chat/history?id=...。
 *
 * Query params:
 *   - workspace        ：仅返回该 workspace 下的会话；不传则全部
 *   - includeArchived  ：`1` / `true` 时含已归档；默认隐藏
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceRoot = url.searchParams.get("workspace")?.trim() || undefined;
  const includeArchivedRaw = url.searchParams.get("includeArchived");
  const includeArchived =
    includeArchivedRaw === "1" || includeArchivedRaw === "true";

  try {
    const threads = listThreads({ workspaceRoot, includeArchived });
    return Response.json({ threads });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "failed to list sessions",
      { status: 500 },
    );
  }
}

/**
 * POST /api/sessions —— 显式创建 thread（picker 提交时打这条）。
 *
 * Body:
 *   - id                    ：前端生成的 chatId（= thread.id）
 *   - workspaceRoot         ：必填
 *   - workspaceName         ：可选
 *   - workspaceAccessMode   ：可选，会话级偏好
 *   - shellApprovalPolicy   ：可选，会话级偏好
 *   - title                 ：可选，前端可后续 PATCH 改名
 *
 * 行为：upsert（id 已存在 → 返回老的，不动字段）。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
    workspaceRoot?: unknown;
    workspaceName?: unknown;
    workspaceAccessMode?: unknown;
    shellApprovalPolicy?: unknown;
    permissionMode?: unknown;
    planMode?: unknown;
    title?: unknown;
  } | null;

  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const workspaceRoot =
    typeof body?.workspaceRoot === "string" ? body.workspaceRoot.trim() : "";
  if (!id) {
    return new Response("id is required", { status: 400 });
  }
  if (!workspaceRoot) {
    return new Response("workspaceRoot is required", { status: 400 });
  }

  try {
    const thread = await upsertThread({
      id,
      workspaceRoot,
      workspaceName:
        typeof body?.workspaceName === "string" ? body.workspaceName : undefined,
      workspaceAccessMode:
        typeof body?.workspaceAccessMode === "string"
          ? body.workspaceAccessMode
          : undefined,
      shellApprovalPolicy:
        typeof body?.shellApprovalPolicy === "string"
          ? body.shellApprovalPolicy
          : undefined,
      permissionMode:
        typeof body?.permissionMode === "string"
          ? body.permissionMode
          : undefined,
      planMode:
        typeof body?.planMode === "boolean" ? body.planMode : undefined,
      title: typeof body?.title === "string" ? body.title : undefined,
    });
    return Response.json({ thread });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "failed to create session",
      { status: 500 },
    );
  }
}
