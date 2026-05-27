/**
 * 持久化层对外入口。
 *
 * 用法：
 *   import { upsertThread, saveMessages, loadThread, listThreads }
 *     from "@/lib/persistence";
 *
 * 注意：这一层**只能在服务端代码里用**（API 路由 / server actions / lib 内）。
 * better-sqlite3 是 native module，绝对不能 import 进 client component——
 * Next.js bundler 会报错。如果要给前端用，请通过 `app/api/sessions/*` 路由暴露。
 */

// thread CRUD
export {
  upsertThread,
  getThread,
  loadThread,
  listThreads,
  archiveThread,
  unarchiveThread,
  updateThreadTitle,
  updateThreadPermissionMode,
  updateThreadPlanMode,
  deleteThread,
  type Thread,
} from "./store";

// messages（SQLite + JSONL 镜像）
export { saveMessages, loadMessages, deleteMessages } from "./messages";

// compaction summary
export {
  saveSummary,
  loadSummary,
  deleteSummary,
  type ThreadSummary,
} from "./summaries";

// active compacted model context
export {
  saveActiveContext,
  loadActiveContext,
  deleteActiveContext,
  type ThreadActiveContext,
} from "./active-context";

// active chat runtime state
export {
  getActiveStreamId,
  setActiveStreamId,
  compareAndSetActiveStreamId,
  deleteRuntimeState,
} from "./runtime";

// native flow canvas
export {
  listFlows,
  createFlow,
  getFlowWithGraph,
  createFlowNode,
  createFlowEdge,
  createFlowRun,
  updateFlowRun,
  createFlowNodeRun,
  updateFlowNodeRun,
  listFlowRuns,
  getFlowRunWithNodes,
  type FlowDefinition,
  type FlowNode,
  type FlowEdge,
  type FlowNodeType,
  type FlowWithGraph,
  type FlowRun,
  type FlowNodeRun,
  type FlowRunStatus,
  type FlowRunWithNodes,
} from "./flows";

// JSONL 类型（给将来 memory 管线用）
export type { SessionLine, SessionMetaPayload } from "./jsonl";
