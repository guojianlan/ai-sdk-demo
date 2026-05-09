import {
  deleteConsolidationState,
  getConsolidationState,
  runPhase2Consolidation,
} from "@/lib/memory";

/**
 * POST /api/memory/consolidate
 *
 * 手动触发 Phase 2 整合 —— 兜底用，因为正常情况下 Phase 1 写完 raw 会自动 fire-and-forget Phase 2。
 *
 * Query / body 参数：
 *   - `force=1`：删 consolidation state（清掉 last_raw_hash + retry_count），强制重跑
 *     即使 raw 内容没变。retry cap 触顶后用这个解锁。
 *
 * 这个端点**同步等 Phase 2 完成**（跟自动触发的 fire-and-forget 不同），
 * 让用户能立刻看到结果。
 *
 * 不接收 chatId / workspaceRoot —— Phase 2 是用户全局的（一份 MEMORY.md），
 * settings 用 process.cwd() 兜底（dev 环境通常 = 主项目）。
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  if (force) {
    deleteConsolidationState();
  }

  const before = getConsolidationState();
  const result = await runPhase2Consolidation({});

  return Response.json({
    before: {
      lastRawHash: before.lastRawHash,
      lastPhase2At: before.lastPhase2At,
      retryCount: before.retryCount,
    },
    result,
  });
}

/**
 * GET /api/memory/consolidate
 *
 * 看当前整合器状态，不触发整合。
 */
export async function GET() {
  return Response.json({ state: getConsolidationState() });
}
