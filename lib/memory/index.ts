/**
 * Memory 子系统的对外入口。所有调用方走 `import { ... } from "@/lib/memory"`。
 *
 * 当前 (A1)：只读取 MEMORY.md 注入 system prompt。
 * 未来：
 *   A2/A3：rollout JSONL → topic.md 抽取 + topic.md → MEMORY.md 整合
 *   A4：`memory_write` tool 让 agent 主动写 memory
 */

export {
  getMemoryDir,
  getMemoryIndexPath,
  getRawMemoriesPath,
  getRolloutSummariesDir,
  getRolloutSummaryPath,
} from "./paths";
export { loadGlobalMemory, type LoadedMemory } from "./loader";
export {
  writeMemoryTopic,
  type MemoryType,
  type WriteMemoryArgs,
  type WriteMemoryResult,
} from "./writer";
export {
  EXTRACTION_RETRY_CAP,
  CONSOLIDATION_RETRY_CAP,
  deleteConsolidationState,
  deleteExtractionState,
  getConsolidationState,
  getExtractionState,
  recordConsolidationFailure,
  recordConsolidationSuccess,
  recordExtractionFailure,
  recordExtractionSuccess,
  type ConsolidationState,
  type ExtractionState,
} from "./state";
export { runPhase1ForThread, type Phase1Result } from "./extractor";
export { runPhase2Consolidation, type Phase2Result } from "./consolidator";
