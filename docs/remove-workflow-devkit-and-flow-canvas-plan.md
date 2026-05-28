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

## 2026-05-28 Update: Flow Uses Chat As Its Execution Substrate

The native Flow Canvas must not grow a second, weaker agent implementation.
The runtime contract is now:

- Flow is the orchestrator: it owns persisted flow definitions, nodes, edges, runs, node runs, branching, and run detail.
- Chat is the execution substrate: agent-capable flow nodes call `runChatAgentLoop()` from `lib/chat-agent/run-loop.ts`.
- Flow node execution defaults to `workspaceAccessMode: "workspace-tools"`, `shellApprovalPolicy: "never"`, `permissionMode: "bypassPermissions"`, and `planMode: false`.
- Bypass still respects the existing permission system: ACL deny rules remain stronger than permission mode, and `allowBypassMode` / `disableBypassPermissionsMode` settings still gate auto-approval.
- Each agent node creates an archived transcript thread with id `flow-node:<nodeRunId>`. The visible Flow UI can load that thread to inspect the node's prompt, tool work, and final output.
- `prompt` nodes are kept for compatibility, but they now follow the same Chat-backed path as the new `agent` node type. They no longer call `generateText()` directly.
- Structured output is parsed from the final assistant text. The node prompt instructs the agent to return final JSON after tool work is done; if parsing fails, the node output falls back to `{ "text": "..." }`.
- Conditions now support `contains`, `gt`, `gte`, `lt`, and `lte` in addition to the previous equality/truthiness operators.
- Image generation is a Chat tool named `image_generation`, not a Flow-only special case. It uses AI SDK `generateImage()` with `gateway.imageModel(env.gateway.imageModelId)`, saves the artifact under the selected workspace, and returns file metadata to the agent.

This keeps the product model aligned with the desired canvas behavior:

```text
Flow Canvas
  -> agent node
  -> Chat agent loop
  -> workspace tools / shell / write-edit / image_generation
  -> final JSON output
  -> downstream node input
```

Important implication: a sample flow that edits `README.md`, reads it back,
branches on content/line count, and generates an image should be built from
agent nodes plus condition nodes. It should not be implemented by adding
hard-coded file or image logic directly into the Flow executor.

### 2026-05-28 UX Correction: Runs Are First-Class Records

A Flow run must be visible immediately after the user clicks Run. The API should
create a persisted run row, return it quickly, then execute the graph in the
background while the UI polls `GET /api/flows/:flowId/runs/:runId`.

Required behavior:

- Every Run click creates one distinct flow run record.
- The run list is clickable; selecting a run switches the side panel into run
  detail mode.
- The canvas derives node status from the selected run:
  - no run selected: idle
  - run active and node has not started: pending
  - node run status `running`: active
  - node run status `succeeded`: done
  - node run status `failed`: failed
  - completed run with no node run: skipped
- Run detail mode shows the flow input/output, per-node input/output/error, and
  the node transcript thread in a Chat-like timeline.
- The transcript can show user prompts, assistant text, and tool call input/output.
  It must not claim to expose hidden chain-of-thought reasoning.

### 2026-05-28 Product Reference Analysis: Coze / n8n Shape

References checked:

- https://aisharenet.com/cozekouzi_mian/
- https://www.1ai.net/en/17951.html
- https://juejin.cn/post/7336841191772143642
- https://juejin.cn/post/7365704703362269184
- https://www.upskillist.com/blog/n8n-review/

Design takeaways:

- Coze treats workflow as a callable function: start input variables, tool/plugin
  blocks, code/transform blocks, LLM blocks, variable/knowledge-base blocks, and
  final output. Our Flow should make each node's input JSON, config, output JSON,
  and downstream handoff visible.
- Coze multi-agent mode reduces prompt complexity by splitting responsibilities
  across nodes/agents. Our `agent` node should remain the first-class AI node,
  while `prompt` stays as a compatibility alias. Each agent node can have its own
  tools, prompt, output schema, timeout, retry, and transcript.
- Coze debugging is node-local: when one node fails, the builder edits that node
  instead of rewriting the whole bot. Our canvas click behavior should therefore
  switch the inspector to the selected node's run record when a run is selected.
- Coze articles repeatedly use plugins and webhook/event triggers as extension
  points. For this project, plugin-like capabilities should first be exposed as
  Chat tools callable by Flow agent nodes. Flow should not create a separate tool
  runtime; it should orchestrate Chat tools.
- n8n's strength is an always-visible node canvas with real logic: branching,
  retries, error handling, execution logs, and self-hosted control. Our MVP should
  favor a dense builder surface over a marketing page: list tab, detail/edit tab,
  canvas, inspector, run list, and per-node execution detail.
- n8n-style run history is essential. A Run click must create a durable execution
  record, update node states (`等待中` -> `执行中` -> `已完成` / `失败`), and leave
  a replayable log after completion.
- Long-running workflow output should not be hidden behind a blank button state.
  Even if a node is still running, its `transcriptThreadId` should be persisted
  as soon as it exists so the UI can show the active chat/tool trace.

Current UX target:

- The Flow page is a two-tab surface:
  - `流程列表`: discover/select/create flows.
  - `查看与修改`: edit the selected flow directly, with a full-screen/90% modal
    option for focused editing.
- The editor is a three-zone builder:
  - canvas: nodes, edges, pan, zoom, status badges.
  - inspector: config or run detail.
  - run record list: each click selects one execution snapshot.
- Clicking a node while a run is selected should show the selected node's run
  detail first. Double-clicking can still open a larger node detail dialog.
- The right inspector must be its own scroll container in both inline detail mode
  and the 90% modal, so lower config/output/transcript content is reachable.

### 2026-05-28 Image Capability Decision

The local OpenAI-compatible gateway at `OPENAI_COMPAT_BASE_URL` exposes
`gpt-image-2`, and a direct `/v1/images/generations` request with that model
returns `b64_json` successfully. The previous sample Flow failed because the
default image model was still `gpt-image-1`, which the gateway rejected.

Decision:

- Default `OPENAI_COMPAT_IMAGE_MODEL` fallback should be `gpt-image-2`.
- Keep the existing `image_generation` Chat tool as the runtime integration point.
  It already acts like a plugin capability from the agent's perspective: the
  agent calls it with JSON input, waits for the result, and receives a saved
  artifact path.
- Do not add a Flow-only image special case. If we later add a broader plugin
  system, image generation can be one registered external tool, but the execution
  contract should still be: Flow agent node -> Chat agent loop -> tool call ->
  tool result -> final JSON.

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
- Added editable edge conditions:
  - added `PATCH /api/flows/[flowId]/edges/[edgeId]`;
  - added persistence support for updating `flow_edges.condition_json`;
  - the Edge Inspector can edit and save condition JSON;
  - saved conditions immediately update the selected edge and dashed conditional-edge styling.
- Added a canvas minimap:
  - the minimap renders the full canvas, nodes, edges, selected node/edge, and current viewport rectangle;
  - clicking or dragging on the minimap recenters the main canvas viewport at that canvas coordinate;
  - minimap navigation works with the existing pan/zoom state instead of changing persisted node coordinates.
- Added flow definition management:
  - added `PATCH /api/flows/[flowId]` for title and description updates;
  - added `DELETE /api/flows/[flowId]` as archive semantics backed by `flows.archived_at`;
  - the Flow Details inspector can edit title/description and archive the active flow;
  - archived flows are preserved in SQLite but hidden from `GET /api/flows` and the Flows list.
- Added richer canvas selection:
  - nodes now maintain a multi-select state in addition to the primary inspector node;
  - modifier-clicking nodes adds them to the current selection;
  - modifier-dragging empty canvas space draws a selection rectangle and selects intersecting nodes;
  - dragging any selected node moves the selected group together;
  - group drags persist each moved node through the existing node `PATCH` route.
- Added node run detail inspection:
  - the Node Inspector now exposes a `Detail` action for the selected node;
  - double-clicking a node on the canvas opens the same detail view;
  - the detail view shows the current active run state, node config, input, output, trace, error, and transcript;
  - hidden reasoning remains excluded because only the existing persisted trace and safe transcript are displayed.
- Added direct canvas edge creation and clearer routing:
  - nodes now expose a right-side output port and left-side input anchor;
  - dragging from an output port to another node creates an edge through the existing `POST /api/flows/[flowId]/edges` route;
  - while dragging, the canvas shows a dashed preview connection and highlights the current target node;
  - persisted edges now render as curved paths with arrowheads instead of plain straight lines;
  - the existing toolbar-based source/target connector remains available for condition JSON entry.
- Resolved the local active chat run durability boundary:
  - added a persisted `chat_runs` registry for chat run metadata and status;
  - `/api/chat` now records each run as `running`, then finalizes it as `finished`, `failed`, or `cancelled`;
  - `/api/chat/[chatId]/stop` finalizes the active run as `cancelled`;
  - reconnect paths mark stale active pointers as `interrupted` when no live in-process run exists;
  - process boot marks any leftover `running` rows as `interrupted` and clears `active_stream_id`;
  - added `GET /api/chat/[chatId]/runs` for local inspection of persisted chat run records;
  - live chunk replay remains intentionally same-process only because the readable stream and subscribers are process resources.

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
- API smoke: patched an edge condition to `{ "path": "$.route", "equals": "yes" }`, verified the PATCH response, and verified the persisted SQLite-backed graph read returned the same condition.
- Playwright smoke: selected an edge, edited the Edge Inspector condition to `{ "path": "$.route", "equals": "ui" }`, clicked `Save Edge`, verified `GET /api/flows/[flowId]` returned the saved condition, verified conditional edge styling rendered, and captured `/tmp/ai-sdk-demo-flow-edge-edit-ui.png`.
- Browser smoke on `127.0.0.1:3002`: opened Flows, loaded `Minimap QA flow`, verified the minimap rendered nodes/edges/current viewport, clicked the minimap near a far-away node, verified the main canvas transform updated and the far node became visible, and captured `/tmp/ai-sdk-demo-flow-minimap-ui.png`.
- API smoke: created a flow, patched title/description, archived it through `DELETE /api/flows/[flowId]`, and verified it no longer appeared in `GET /api/flows`.
- Playwright smoke: edited title/description in Flow Details, verified `GET /api/flows/[flowId]` returned the saved metadata, clicked Archive, verified the flow disappeared from the UI and `GET /api/flows`, and captured `/tmp/ai-sdk-demo-flow-details-ui.png`.
- `npx tsc --noEmit` after adding canvas multi-select and group dragging.
- `npm run lint` after adding canvas multi-select and group dragging.
- Playwright smoke: opened Flows on `127.0.0.1:3002`, selected two nodes with a selection rectangle, dragged the selected group, verified both nodes persisted their new positions through `GET /api/flows/[flowId]`, archived the temporary flow, and captured `/tmp/ai-sdk-demo-flow-multiselect-ui.png`.
- `npx tsc --noEmit` after adding node run detail inspection.
- `npm run lint` after adding node run detail inspection.
- Playwright smoke: created and ran a default `Start -> End` flow, opened Flows on `127.0.0.1:3002`, double-clicked the Start node, verified the detail view showed run status and persisted input/output content, closed the detail view, archived the temporary flow, and captured `/tmp/ai-sdk-demo-flow-node-detail-ui.png`.
- `npx tsc --noEmit` after adding port drag edge creation and curved edge paths.
- `npm run lint` after adding port drag edge creation and curved edge paths.
- Playwright smoke: created a flow plus `Port Target`, opened Flows on `127.0.0.1:3002`, dragged from the Start output port onto the target node, verified `GET /api/flows/[flowId]` persisted the new `Start -> Port Target` edge, archived the temporary flow, and captured `/tmp/ai-sdk-demo-flow-port-connect-ui.png`.
- `npx tsc --noEmit` after adding persisted chat run records.
- `npm run lint` after adding persisted chat run records.
- API smoke: created a synthetic persisted `running` chat run and active stream pointer, called `GET /api/chat/[chatId]/stream`, verified the endpoint returned `204`, verified `GET /api/chat/[chatId]/runs` reported the run as `interrupted`, then cleaned up the temporary runtime rows.
- Source review: checked Coze/n8n reference articles and recorded the current product target as `流程列表` plus `查看与修改`, with Coze-style node-local debugging and n8n-style durable execution records.
- Direct gateway smoke: `GET /v1/models` showed `gpt-image-2`; direct `/v1/images/generations` with `gpt-image-2` returned one `b64_json` image result.
- Browser smoke on `127.0.0.1:3002`: opened Flows, selected `env-docker README 图像测试流`, verified `查看与修改` renders the editor directly, clicked `读取 README`, verified `运行详情` is active, verified selected-node run detail is visible, and verified the right inspector scrolls independently (`scrollHeight` > `clientHeight`).
- API smoke: ran `env-docker README 图像测试流` after switching the image fallback model to `gpt-image-2`; the run succeeded and returned `.flow-artifacts/images/flow-readme-demo.png`.
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build` passed; Turbopack reported existing broad dynamic filesystem tracing warnings around skill discovery / command hooks, but production compilation completed successfully.

Remaining:
- No known plan items remain open in this document. Completion still requires a final audit against the original user-facing product goal and current code.
