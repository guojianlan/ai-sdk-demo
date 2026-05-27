# Remove Workflow DevKit and Build Native Flow Canvas

## Summary

We should remove Vercel Workflow DevKit from the chat runtime, but keep AI SDK, the agent/tool loop, sandbox access, hooks, compaction, and persisted chat history.

The word "workflow" currently means two different things in this project:

- Runtime dependency: the `workflow` npm package, `withWorkflow`, `"use workflow"`, `start(runAgentWorkflow)`, `getRun()`, and the `/.well-known/workflow/v1/flow` internal endpoints.
- Product feature: a user-created visual flow canvas where nodes run prompts, emit JSON, pass that JSON to downstream nodes, and preserve per-node chat/thinking/output for inspection.

The runtime dependency is the part that is getting in the way. The product feature should be implemented as our own persisted flow system, not by keeping Workflow DevKit.

## Current Dependency Audit

### What does not depend on Workflow DevKit

These should survive the removal:

- AI SDK chat and agent primitives:
  - `@ai-sdk/react` `useChat` in `app/page.tsx`.
  - `ToolLoopAgent` in `lib/chat-agent/builder.ts`.
  - `createUIMessageStreamResponse` and UIMessage streaming in chat API routes.
- Sandbox:
  - `connectSandbox()` in `lib/sandbox/factory.ts`.
  - `LocalSandbox` in `lib/sandbox/local/index.ts`.
  - OS-level command wrapping through `@anthropic-ai/sandbox-runtime` in `lib/sandbox/local/asrt.ts`.
  - Tool access through `experimental_context.sandbox`.
- Workspace tools:
  - read, grep, glob, shell, write/edit, memory_write, update_plan, spawn_agent, and interactive tools.
- Permission and hook system:
  - project/global settings loading.
  - PreToolUse/PostToolUse/Stop hooks.
  - approval policy and permission mode logic.
- Compaction and active context:
  - `thread_active_context`.
  - deterministic fallback compaction.
  - token budget stop behavior.
- Chat transcript persistence:
  - `threads`, `messages`, `thread_summaries`, JSONL mirrors.

### What currently depends on Workflow DevKit

These must be replaced:

- `next.config.ts`
  - `withWorkflow(nextConfig)`.
- `tsconfig.json`
  - `workflow` TypeScript plugin.
- `package.json`
  - `workflow` dependency.
- `app/workflows/chat.ts`
  - `"use workflow"`.
  - `"use step"`.
  - `getWorkflowMetadata()`.
  - `getWritable()`.
  - `getRun()`.
- `app/api/chat/route.ts`
  - `start(runAgentWorkflow, [...])`.
  - `getRun()` reconciliation.
  - `x-workflow-run-id`.
- `app/api/chat/[chatId]/stream/route.ts`
  - resume by Workflow run id.
- `app/api/chat/[chatId]/stop/route.ts`
  - cancel by Workflow run id.
- `lib/persistence/runtime.ts`
  - `active_stream_id` currently stores a Workflow run id.
- `lib/workflow-readable.ts`
  - mostly stream repair utilities; can be renamed and kept if still useful.
- comments and docs that call the backend chat loop a workflow.

## Capability Impact

### Sandbox

Safe to keep.

The sandbox is injected by AI SDK `prepareCall`, not by Workflow DevKit. `createChatAgent()` calls `connectSandbox({ type: "local", workingDirectory })` and passes the sandbox through `experimental_context`. The tools retrieve it through `getWorkspaceToolContext()`.

Removing Workflow DevKit does not remove:

- workspace path containment;
- command timeout;
- stdout/stderr truncation;
- ASRT command wrapping when `SANDBOX_ENABLED=true`;
- future ability to swap local sandbox for a remote sandbox implementation.

### Retry

Needs replacement, but the current dependency is smaller than it looks.

Workflow DevKit currently gives step-level replay/retry semantics around `"use step"`. In practice, the chat runtime already has explicit guards that matter more for this app:

- outer step limit;
- token budget check before each model call;
- deterministic compaction fallback;
- no-output handling for empty model streams;
- per-step message snapshot persistence;
- active stream conflict prevention;
- memory extraction retry caps.

After removal, we should implement our own small retry policy where it is actually needed:

- LLM stream retry: retry before first UI chunk only; never replay after visible output has started.
- Tool retry: default no automatic retry for mutating tools; optional retry only for explicitly safe/idempotent reads.
- Flow node retry: each visual flow node can have retry settings, but default should be conservative.
- Memory extraction/consolidation retry: keep the existing retry counters.

### Resume

This is the biggest behavior change.

Workflow DevKit currently lets the frontend reconnect to a running Workflow stream via run id. Without it, we have two choices:

1. MVP: no durable live-stream resume after dev server restart. Persist completed step snapshots, return 204 for missing active streams, and let the next user message continue from saved active context.
2. Better local runtime: maintain an in-process stream registry keyed by `chatId`/`runId`, backed by SQLite status rows. Reconnect works while the same Next process is alive; restart clears running streams.

Given the current dev-local product shape, choose option 2. This matches what we already do conceptually: boot clears stale `active_stream_id` because Workflow run ids are not truly durable across local dev restarts anyway.

### Stop / Cancel

Replace Workflow run cancellation with a local `AbortController` registry.

The chat API should create a local run record:

```ts
type ActiveChatRun = {
  id: string;
  chatId: string;
  controller: AbortController;
  readable: ReadableStream<ChatUIMessageChunk>;
  status: "running" | "finished" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};
```

`POST /api/chat/[chatId]/stop` should look up the active run and call `controller.abort()`.

### Active Context / Compaction

Keep it.

This logic should move out of `app/workflows/chat.ts` into a normal server helper, for example:

- `lib/chat-agent/run-loop.ts`
- `lib/chat-agent/stream-runtime.ts`
- `lib/chat-agent/compaction-guard.ts`

The main invariant remains:

- full UI transcript is for display;
- active context is the model input source after compaction;
- the route must never feed an over-budget full transcript into the model.

## Target Chat Runtime Without Workflow DevKit

### Proposed modules

- `lib/chat-agent/run-loop.ts`
  - Owns the multi-step loop currently in `runAgentWorkflow`.
  - Calls `agent.stream()` one model/tool step at a time.
  - Saves assistant snapshots after each step.
  - Runs stop hooks.
  - Handles token budget checks and mid-turn compaction.

- `lib/chat-agent/run-step.ts`
  - Builds tools, hooks, MCP tools, and the `ToolLoopAgent`.
  - Executes one AI SDK step.
  - Streams UIMessage chunks into a writer.

- `lib/chat-agent/active-runs.ts`
  - In-process registry of active chat runs.
  - Provides create/get/cancel/cleanup operations.
  - Uses `AbortController`.

- `lib/chat-agent/stream-utils.ts`
  - Renamed from `lib/workflow-readable.ts`.
  - Keeps chunk ordering/dropping helpers if still needed.

### New `/api/chat` flow

1. Validate request and workspace.
2. Save incoming user/human-response messages.
3. Build model-visible messages from active context plus new tail messages.
4. Run pre-turn compaction if needed.
5. Claim an active local run id with compare-and-set.
6. Create a `ReadableStream`.
7. Start `runChatAgentLoop()` asynchronously.
8. Return `createUIMessageStreamResponse({ stream })`.
9. On finish/error/cancel, persist final state and clear active run id.

### New `/api/chat/[chatId]/stream` flow

1. Read active run id from SQLite.
2. Check the in-process registry.
3. If found and running, return its readable stream.
4. If not found, clear stale active id and return 204.

### New `/api/chat/[chatId]/stop` flow

1. Read active run id from SQLite.
2. Cancel the active run through `AbortController`.
3. Clear active id.
4. Return `{ stopped: true }`.

## Native Flow Canvas Product

## Product Goal

Add a new top-level tab for user-created flows:

- list all flows;
- create a flow;
- open a flow editor;
- create/edit nodes on an infinite canvas;
- connect nodes to define execution order;
- each node receives input JSON plus prompt;
- each node runs an AI SDK chat/agent call;
- each node emits structured JSON and optional visible text;
- downstream nodes receive upstream JSON;
- clicking a node opens the full node run detail: prompt, input JSON, model messages, tool calls, reasoning-safe trace, output JSON, errors, and timing.

This should be our own product feature. Do not use Workflow DevKit for this.

## UX Shape

### App navigation

Add a compact tab switcher near the existing left sidebar header:

- `Chat`
- `Flows`

The current chat UI remains the default. `Flows` opens the new flow management surface.

### Flow list

The first Flows screen should show:

- flow title;
- description;
- updated time;
- node count;
- last run status;
- workspace binding;
- create button.

Actions:

- create flow;
- open flow;
- duplicate flow;
- archive/delete flow later.

### Flow editor

The editor has three zones:

- left: flow list or compact flow metadata;
- center: infinite canvas;
- right: inspector panel.

Canvas features for MVP:

- pan;
- zoom;
- add node;
- drag node;
- connect nodes;
- delete selected node/edge;
- run selected node;
- run from start;
- run entire flow;
- show node status.

Node types:

- Start node: defines initial input schema and initial prompt/input.
- Prompt node: calls AI SDK and produces JSON.
- Transform node: maps/filters previous JSON without model call.
- Condition node: chooses next edge based on JSON path/expression.
- End node: stores final output.

### Node inspector

Clicking a node should show:

- node name;
- node type;
- prompt template;
- input mapping;
- expected output JSON schema;
- retry policy;
- timeout;
- last status;
- last input JSON;
- last output JSON;
- errors;
- link to full run detail.

### Node run detail

For each node execution, preserve:

- input JSON;
- rendered prompt;
- model messages;
- tool calls and outputs;
- visible assistant text;
- structured JSON output;
- token estimate/usage if available;
- start/end timestamps;
- status and error.

Reasoning note: store and show safe trace/output, not hidden chain-of-thought. If AI SDK emits reasoning chunks and we decide to display them, keep the same policy as chat: visible reasoning summaries only, not private reasoning.

## Flow Execution Model

### Core concepts

```ts
type FlowDefinition = {
  id: string;
  title: string;
  description: string | null;
  workspaceRoot: string;
  workspaceName: string | null;
  createdAt: number;
  updatedAt: number;
};

type FlowNode = {
  id: string;
  flowId: string;
  type: "start" | "prompt" | "transform" | "condition" | "end";
  title: string;
  position: { x: number; y: number };
  config: unknown;
};

type FlowEdge = {
  id: string;
  flowId: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition: unknown | null;
};

type FlowRun = {
  id: string;
  flowId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  inputJson: unknown;
  outputJson: unknown | null;
  startedAt: number;
  finishedAt: number | null;
};

type FlowNodeRun = {
  id: string;
  flowRunId: string;
  nodeId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  inputJson: unknown;
  outputJson: unknown | null;
  traceJson: unknown | null;
  transcriptThreadId: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};
```

### Execution rules

1. A flow run starts at the Start node.
2. Each node receives a JSON object.
3. Prompt nodes render a prompt from node config plus input JSON.
4. Prompt nodes call AI SDK and must produce structured JSON.
5. Output JSON is persisted on the node run.
6. Outgoing edges decide downstream nodes.
7. The run ends when all reachable End nodes complete, or a fatal node error occurs.

### Structured output

For prompt nodes, prefer structured output enforcement:

- define output schema in the node config;
- validate model output before passing to the next node;
- if invalid, mark node failed and show validation errors;
- later add repair/retry behavior as an explicit node setting.

### Chat linkage

Every prompt node run can create or reference a hidden chat thread:

- `thread_id` stores the per-node transcript.
- The node detail panel can render the same `MessageBubble` components used by chat.
- This gives the user the "click node and inspect the whole chat thinking/output" behavior.

The transcript should be scoped to that node run, not mixed into the main Chat tab.

## Persistence Plan

Add migrations after the current schema:

- `flows`
- `flow_nodes`
- `flow_edges`
- `flow_runs`
- `flow_node_runs`
- optional `flow_node_run_events` for streaming/status timeline

Keep flow state in SQLite first. Avoid storing it only in localStorage.

Potential schema:

```sql
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  workspace_root TEXT NOT NULL,
  workspace_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE flow_nodes (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  position_x REAL NOT NULL,
  position_y REAL NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE flow_edges (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  condition_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE flow_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE flow_node_runs (
  id TEXT PRIMARY KEY,
  flow_run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  trace_json TEXT,
  transcript_thread_id TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
```

## API Plan

Flow definition:

- `GET /api/flows`
- `POST /api/flows`
- `GET /api/flows/[flowId]`
- `PATCH /api/flows/[flowId]`
- `DELETE /api/flows/[flowId]`

Canvas editing:

- `POST /api/flows/[flowId]/nodes`
- `PATCH /api/flows/[flowId]/nodes/[nodeId]`
- `DELETE /api/flows/[flowId]/nodes/[nodeId]`
- `POST /api/flows/[flowId]/edges`
- `PATCH /api/flows/[flowId]/edges/[edgeId]`
- `DELETE /api/flows/[flowId]/edges/[edgeId]`

Execution:

- `POST /api/flows/[flowId]/runs`
- `GET /api/flows/[flowId]/runs`
- `GET /api/flows/[flowId]/runs/[runId]`
- `POST /api/flows/[flowId]/runs/[runId]/stop`
- `GET /api/flows/[flowId]/runs/[runId]/stream`

Node inspection:

- `GET /api/flows/[flowId]/runs/[runId]/nodes/[nodeRunId]`
- `GET /api/flows/[flowId]/runs/[runId]/nodes/[nodeRunId]/transcript`

## UI Implementation Plan

### Phase 1: Shell and persistence

- Add `Chat | Flows` top-level tabs.
- Add flow list UI.
- Add create flow modal.
- Add SQLite migrations and CRUD routes.
- No canvas execution yet.

### Phase 2: Canvas MVP

- Add a flow editor view.
- Add nodes and edges.
- Save node positions/config.
- Add inspector panel.
- Allow manual graph editing.

Implementation options:

- Use a canvas/graph library if we want a mature infinite-canvas editor quickly.
- Or build a simple MVP with absolute-positioned nodes, CSS transforms for pan/zoom, and SVG edges.

Recommendation: start with a minimal custom canvas if we want tight control and low dependency surface; move to a graph library only if edge routing, minimap, selection boxes, and complex interactions become costly.

### Phase 3: Node execution

- Implement Start, Prompt, and End nodes.
- Prompt node calls AI SDK and requires JSON output.
- Persist `flow_runs` and `flow_node_runs`.
- Show run status on the canvas.
- Click node to inspect run details.

### Phase 4: Flow control

- Add Transform node.
- Add Condition node.
- Add branch selection and simple JSON-path expressions.
- Add per-node retry and timeout settings.

### Phase 5: Deep integration with chat agent

- Let a prompt node choose between:
  - simple structured model call;
  - full workspace agent with tools/sandbox;
  - read-only agent;
  - no-tool model call.
- Store each prompt node's transcript as a separate thread.
- Reuse chat message rendering for node transcript inspection.

## Removal Plan for Workflow DevKit

### Step 1: Extract the chat loop

- Move `runAgentLoop`, `runAgentStep`, compaction guard, and persistence helpers out of `app/workflows/chat.ts`.
- Remove `"use workflow"` and `"use step"` directives.
- Replace `getWritable()` with a writer passed into the loop.
- Replace `workflowRunId` with a local `runId`.

### Step 2: Add active local run registry

- Implement `lib/chat-agent/active-runs.ts`.
- Store `runId -> AbortController/readable/status`.
- Keep SQLite `active_stream_id`, but reinterpret it as a local chat run id.
- Rename comments from Workflow run id to active run id.

### Step 3: Rewrite chat routes

- `POST /api/chat` starts a local run instead of `start(runAgentWorkflow)`.
- `GET /api/chat/[chatId]/stream` reconnects to the local run registry.
- `POST /api/chat/[chatId]/stop` aborts through the local registry.

### Step 4: Remove Workflow DevKit wiring

- Delete `app/workflows/chat.ts`.
- Remove `workflow` from dependencies.
- Remove `withWorkflow()` from `next.config.ts`.
- Remove `workflow` plugin from `tsconfig.json`.
- Rename `lib/workflow-readable.ts` if still used.
- Update docs/comments/log prefixes from `workflow/chat` to `chat/run`.

### Step 5: Verify regressions

- `npm run lint`
- `npx tsc --noEmit`
- `npm run test`
- targeted Playwright:
  - page opens;
  - workspace picker works;
  - chat can send a message;
  - stop button cancels a running stream;
  - stream endpoint returns 204 when no run exists;
  - server-side tool loop does not create duplicate assistant messages.

## Recommended Order

Do not build the Flow Canvas on top of the existing Workflow DevKit runtime.

Recommended order:

1. Remove Workflow DevKit from chat runtime while keeping AI SDK and sandbox.
2. Stabilize chat loop, stop, resume, compaction, and tests.
3. Add Flows tab and flow CRUD.
4. Add canvas editor.
5. Add prompt-node execution and node run details.
6. Add branching, retries, and richer node types.

This keeps the new product feature clean: a flow is a first-class persisted product object, not an accidental wrapper around a third-party durable function runtime.

## Acceptance Criteria

### Workflow DevKit removal

- No `workflow` dependency in `package.json`.
- No `withWorkflow()` in Next config.
- No `workflow` TS plugin.
- No `app/workflows` runtime entrypoint.
- No requests to `/.well-known/workflow/v1/flow` during chat.
- Chat still supports:
  - AI SDK streaming;
  - tool calls;
  - sandboxed workspace tools;
  - approval/client continuation;
  - stop;
  - active-context compaction;
  - message persistence.

### Flow Canvas MVP

- User can switch from Chat to Flows.
- User can list and create flows.
- User can open a flow editor.
- User can add nodes and connect them.
- User can run a Start -> Prompt -> End flow.
- Prompt node receives JSON input and emits valid JSON output.
- Clicking a node shows node config, last input, last output, error, and safe trace.
- Flow definitions and run history survive page refresh.

## Implementation Progress

### 2026-05-27

Completed:

- Removed Workflow DevKit from the chat runtime path:
  - removed `workflow` from `package.json` / `package-lock.json`;
  - removed `withWorkflow()` from `next.config.ts`;
  - removed the `workflow` TypeScript plugin from `tsconfig.json`;
  - deleted `app/workflows/chat.ts`;
  - deleted the old workflow stream/pause helper files.
- Replaced Workflow run ids with local chat run ids:
  - added `lib/chat-agent/active-runs.ts`;
  - added replayable in-process stream buffering for reconnect while the same Next process is alive;
  - updated `/api/chat`, `/api/chat/[chatId]/stream`, and `/api/chat/[chatId]/stop`.
- Preserved the important chat behavior:
  - AI SDK `useChat` / `ToolLoopAgent` remain in use;
  - sandbox injection still happens in `createChatAgent().prepareCall`;
  - the backend outer loop, compaction, stop hooks, tool filtering, MCP tool merge, message persistence, and active context all moved into normal server code.
- Removed the generated Workflow DevKit endpoint surface:
  - deleted source files under `app/.well-known/workflow/v1`;
  - after clearing `.next`, `GET /.well-known/workflow/v1/flow` returns `404`.
- Started the native Flow Canvas product:
  - added SQLite tables for `flows`, `flow_nodes`, `flow_edges`, `flow_runs`, and `flow_node_runs`;
  - added `GET/POST /api/flows`;
  - added `GET /api/flows/[flowId]`;
  - added node and edge creation routes;
  - added a `Chat | Flows` tab switcher;
  - added a Flows list/create surface;
  - added a basic canvas that can show nodes and edges, add nodes, and connect nodes.
- Added native flow execution:
  - added `trace_json` on `flow_node_runs`;
  - added persistence helpers for flow runs and node runs;
  - added `lib/flows/executor.ts`;
  - prompt nodes use AI SDK `generateText()` with `Output.json()`;
  - prompt node retry uses AI SDK `maxRetries`, derived from node config `retry.maxAttempts`;
  - start/end nodes pass JSON through, transform/condition nodes are pass-through for the MVP;
  - node runs persist input, output, status, error, timing, and reasoning-safe trace.
  - when a user connects a middle node into the default `Start -> End` graph, the default direct edge is removed so the prompt node is not bypassed.
- Added execution APIs:
  - `GET /api/flows/[flowId]/runs`;
  - `POST /api/flows/[flowId]/runs`;
  - `GET /api/flows/[flowId]/runs/[runId]`.
- Extended the Flows tab:
  - added run input JSON editor;
  - added Run action;
  - added run history;
  - added node status badges;
  - clicking a node opens an inspector with config, last input/output, trace, and error.
- Added editable prompt node configuration:
  - added `PATCH /api/flows/[flowId]/nodes/[nodeId]`;
  - added persistence support for updating node title, position, and config;
  - inspector can edit node title, prompt template, output JSON schema, retry attempts, and timeout;
  - non-prompt nodes can edit raw config JSON.
- Added prompt output schema validation:
  - prompt nodes with `outputSchema` now use AI SDK `generateText()` with `Output.object({ schema: jsonSchema(...) })`;
  - schema is also included in the rendered prompt for OpenAI-compatible providers that do not fully enforce response format;
  - schema, timeout, retry count, model, usage, prompt, and safe visible messages are persisted in node trace.
- Added flow-control semantics:
  - all non-start nodes support `inputMapping`, where `$.path` values are read from upstream JSON and plain strings remain literals;
  - transform nodes now map/filter upstream JSON without a model call and can optionally select an `outputPath`;
  - condition nodes can evaluate a configured condition and emit `{ condition, input }`;
  - edges can store JSON conditions such as `{ "path": "$.condition", "equals": true }`;
  - conditional outgoing edges select matching branches, and merge nodes no longer wait for unselected sibling branches.
- Extended the editor configuration surface:
  - prompt, transform, and condition nodes expose input mapping in the inspector;
  - transform nodes expose output path editing;
  - condition nodes expose condition JSON editing;
  - the connect toolbar can attach an edge condition JSON object.
- Added prompt node transcript linkage:
  - every successful prompt node run creates a hidden archived chat thread;
  - `flow_node_runs.transcript_thread_id` stores that thread id;
  - the transcript reuses the existing `threads` / `messages` persistence and `/api/chat/history?id=...` reader;
  - the node inspector loads and displays the prompt node user prompt and visible assistant output;
  - hidden reasoning is not stored; the transcript contains only safe visible prompt/output content.
- Added node and edge deletion:
  - added `DELETE /api/flows/[flowId]/nodes/[nodeId]`;
  - added `DELETE /api/flows/[flowId]/edges/[edgeId]`;
  - deleting a node also deletes connected edges;
  - Start and End nodes are protected from deletion in the API and UI;
  - historical `flow_node_runs` are preserved so old run records are not destroyed by canvas edits;
  - the canvas can select an edge, show its source/target/condition, and delete it from the inspector;
  - the node inspector exposes a guarded delete action for editable nodes.
- Added canvas drag, pan, and zoom:
  - nodes can be dragged inside a larger `2400 x 1600` canvas coordinate space;
  - node positions are previewed immediately and persisted through the existing node `PATCH` route on drag end;
  - edge rendering follows updated node positions because edges are still derived from persisted node coordinates;
  - the canvas supports background drag-to-pan;
  - zoom controls and wheel zoom update both the transformed surface and grid background around the active viewport point.

Verified:

- `npx tsc --noEmit` after adding native flow execution and inspector
- `npm run lint`
- `npx tsc --noEmit`
- `npm run test`
- `git diff --check`
- `GET /` on `127.0.0.1:3002` returns `200`
- `GET /api/chat/smoke-no-active/stream` returns `204`
- `GET /.well-known/workflow/v1/flow` returns `404`
- `GET /api/flows` returns persisted flow data
- Playwright smoke: opened Flows tab, created `Smoke workflow`, added a node, connected nodes, and captured `/tmp/ai-sdk-demo-flows-smoke.png`
- API smoke: created a flow and ran Start -> End; run succeeded with persisted node runs
- API smoke: created Start -> Prompt -> End, prompt node called AI SDK, run succeeded with JSON output
- Playwright smoke: opened Flows tab, created a flow, ran it from the UI, saw node inspector/run status, and captured `/tmp/ai-sdk-demo-flow-run-ui.png`
- API smoke: patched a prompt node title/config, ran Start -> Prompt -> End with an output schema, and received schema-valid JSON output
- Playwright smoke: edited a prompt node title/prompt/schema in the inspector, saved it through the UI, and verified the persisted config through `GET /api/flows/[flowId]`; screenshot captured at `/tmp/ai-sdk-demo-flow-config-ui.png`
- API smoke: ran Start -> Transform -> Condition -> branch -> End, verified mapped JSON output and that only the matched branch executed
- Playwright smoke: edited a transform node input mapping/output path in the inspector, saved it through the UI, and verified the PATCH response; screenshot captured at `/tmp/ai-sdk-demo-flow-mapping-ui.png`
- API smoke: ran a prompt node, verified `transcriptThreadId`, and loaded two transcript messages through `/api/chat/history`
- Playwright smoke: opened a completed prompt node in the Flows inspector and verified transcript output was visible; screenshot captured at `/tmp/ai-sdk-demo-flow-transcript-ui.png`
- API smoke: verified archived transcript threads do not appear in the visible sessions list
- API smoke: created a flow, added a node and edge, deleted the edge, deleted the node, and verified the node and connected edges were absent afterward.
- Browser smoke on `127.0.0.1:3002`: opened Flows, created `UI delete QA flow`, added a Prompt node, connected it, selected and deleted the edge, selected and deleted the Prompt node, and verified the UI returned to `2 nodes · 0 edges` without console errors.
- Browser smoke on `127.0.0.1:3002`: opened Flows, loaded `UI pan zoom QA flow`, dragged the Start node from `{ x: 120, y: 180 }` to `{ x: 200, y: 230 }`, verified the persisted position via `GET /api/flows/[flowId]`, reloaded the page and confirmed the same node position still rendered, zoomed to `110%`, panned the canvas, and captured `/tmp/ai-sdk-demo-flow-pan-zoom-ui.png`.

Remaining:

- Add richer infinite-canvas interactions such as minimap, selection boxes, better edge routing, and edge editing.
- Decide whether local active chat run replay should remain process-local only or become durable across process restarts.
