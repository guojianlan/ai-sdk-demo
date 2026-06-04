# Native Flow Canvas Product Plan

Summary: Turn the current Flow canvas from an agent-node chain into a native workflow product that can run repeatable, observable, human-approved automations. The first real use case is a Juejin Frontend intake flow that discovers articles, ingests useful sources into `/Users/apple/Desktop/project/document`, and asks for approval before touching higher-level wiki/topic content.

Context: The current Flow system already has persisted flows, nodes, edges, runs, node runs, event logs, a React Flow editor, and an executor that walks from `start` through connected nodes. The runtime currently supports only `start`, `agent`, `prompt`, `transform`, `condition`, and `end`; agent/prompt nodes call the existing chat agent loop with workspace tools. This is enough for flexible agent orchestration, but not enough for stable arbitrary workflow automation because batch item state, dedicated web/file nodes, approval gates, durable artifacts, strict schemas, retry, pause/resume, and reusable node registration are missing.

System Impact: The source of truth should remain the persisted Flow graph plus run/event tables, but the graph needs to evolve from hard-coded node types into a node registry with typed capabilities. Long-running business state should be represented as run artifacts and item records rather than hidden inside an agent transcript. Human approval should become a first-class run state, not a prompt convention. This keeps the canvas visual, auditable, resumable, and safe for workflows that write into other workspaces.

Approach: Implement the product in phases. First document the architecture and product direction. Then introduce a node registry and artifact/item model behind existing behavior. After that, add purpose-built nodes for browser extraction, foreach/batch processing, file patching, document ingest, and human approval. Use the Juejin Frontend intake workflow as the proving ground, but keep the platform generic enough for other teams and creators.

Changes:
- `docs/native-flow-canvas-product-design.md` - New product and architecture design covering product goal, user model, runtime gaps, target node catalog, Juejin reference workflow, data model, execution lifecycle, safety model, and phased roadmap.
- `PLAN.md` - Current execution plan for the native Flow canvas product work.
- Future code phase: `lib/flows/node-registry.ts` - Add typed node registry and move current node execution behavior into registered handlers.
- Future code phase: `lib/persistence/flows.ts` - Add artifacts/items/approval run state when implementation begins.
- Future code phase: `lib/flows/executor.ts` - Move from hard-coded switch execution toward registry dispatch, real retry, pause/resume, and item-aware batch execution.
- Future code phase: `app/_components/FlowWorkspace.tsx` - Replace fixed node menu/config forms with registry-driven node categories and forms.

Verification:
- Documentation phase: read the new design end to end and confirm it matches the current code paths and product direction.
- First implementation phase: run `npm run lint`; add targeted unit tests for registry dispatch, condition routing, artifact persistence, and item-state transitions.
- End-to-end product check: create a Juejin Frontend intake flow, run it in dry-run mode, inspect candidates/artifacts, approve selected updates, and verify only approved files in `/Users/apple/Desktop/project/document` are changed.
