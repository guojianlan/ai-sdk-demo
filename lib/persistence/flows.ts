import { randomUUID } from "node:crypto";

import { getDb } from "./db";

export type FlowDefinition = {
  id: string;
  title: string;
  description: string | null;
  workspaceRoot: string;
  workspaceName: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

export type FlowNodeType =
  | "start"
  | "agent"
  | "prompt"
  | "transform"
  | "condition"
  | "end";

export type FlowNode = {
  id: string;
  flowId: string;
  type: FlowNodeType;
  title: string;
  position: { x: number; y: number };
  config: unknown;
  createdAt: number;
  updatedAt: number;
};

export type FlowEdge = {
  id: string;
  flowId: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition: unknown | null;
  createdAt: number;
  updatedAt: number;
};

export type FlowRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type FlowRun = {
  id: string;
  flowId: string;
  status: FlowRunStatus;
  input: unknown;
  output: unknown | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type FlowNodeRun = {
  id: string;
  flowRunId: string;
  nodeId: string;
  status: FlowRunStatus;
  input: unknown;
  output: unknown | null;
  trace: unknown | null;
  transcriptThreadId: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type FlowWithGraph = {
  flow: FlowDefinition;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type FlowRunWithNodes = {
  run: FlowRun;
  nodeRuns: FlowNodeRun[];
};

type FlowRow = {
  id: string;
  title: string;
  description: string | null;
  workspace_root: string;
  workspace_name: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type FlowNodeRow = {
  id: string;
  flow_id: string;
  type: string;
  title: string;
  position_x: number;
  position_y: number;
  config_json: string;
  created_at: number;
  updated_at: number;
};

type FlowEdgeRow = {
  id: string;
  flow_id: string;
  source_node_id: string;
  target_node_id: string;
  condition_json: string | null;
  created_at: number;
  updated_at: number;
};

type FlowRunRow = {
  id: string;
  flow_id: string;
  status: string;
  input_json: string;
  output_json: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

type FlowNodeRunRow = {
  id: string;
  flow_run_id: string;
  node_id: string;
  status: string;
  input_json: string;
  output_json: string | null;
  trace_json: string | null;
  transcript_thread_id: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

function rowToFlow(row: FlowRow): FlowDefinition {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    workspaceRoot: row.workspace_root,
    workspaceName: row.workspace_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function rowToNode(row: FlowNodeRow): FlowNode {
  return {
    id: row.id,
    flowId: row.flow_id,
    type: normalizeNodeType(row.type),
    title: row.title,
    position: { x: row.position_x, y: row.position_y },
    config: parseJson(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: FlowEdgeRow): FlowEdge {
  return {
    id: row.id,
    flowId: row.flow_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    condition: row.condition_json ? parseJson(row.condition_json, null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFlowRun(row: FlowRunRow): FlowRun {
  return {
    id: row.id,
    flowId: row.flow_id,
    status: normalizeRunStatus(row.status),
    input: parseJson(row.input_json, {}),
    output: row.output_json ? parseJson(row.output_json, null) : null,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToNodeRun(row: FlowNodeRunRow): FlowNodeRun {
  return {
    id: row.id,
    flowRunId: row.flow_run_id,
    nodeId: row.node_id,
    status: normalizeRunStatus(row.status),
    input: parseJson(row.input_json, {}),
    output: row.output_json ? parseJson(row.output_json, null) : null,
    trace: row.trace_json ? parseJson(row.trace_json, null) : null,
    transcriptThreadId: row.transcript_thread_id,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function listFlows(): FlowDefinition[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM flows
        WHERE archived_at IS NULL
        ORDER BY updated_at DESC`,
    )
    .all() as FlowRow[];
  return rows.map(rowToFlow);
}

export function createFlow(opts: {
  title: string;
  description?: string | null;
  workspaceRoot: string;
  workspaceName?: string | null;
}): FlowWithGraph {
  const now = Date.now();
  const flowId = randomUUID();
  const startId = randomUUID();
  const endId = randomUUID();
  const db = getDb();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO flows
         (id, title, description, workspace_root, workspace_name,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      flowId,
      opts.title.trim() || "Untitled flow",
      opts.description ?? null,
      opts.workspaceRoot,
      opts.workspaceName ?? null,
      now,
      now,
    );

    insertNode({
      id: startId,
      flowId,
      type: "start",
      title: "Start",
      x: 120,
      y: 180,
      config: { input: {} },
      now,
    });
    insertNode({
      id: endId,
      flowId,
      type: "end",
      title: "End",
      x: 720,
      y: 180,
      config: {},
      now,
    });
    insertEdge({
      id: randomUUID(),
      flowId,
      sourceNodeId: startId,
      targetNodeId: endId,
      condition: null,
      now,
    });
  })();

  const graph = getFlowWithGraph(flowId);
  if (!graph) {
    throw new Error("Created flow could not be loaded.");
  }
  return graph;
}

export function getFlowWithGraph(flowId: string): FlowWithGraph | null {
  const flowRow = getDb()
    .prepare(`SELECT * FROM flows WHERE id = ? AND archived_at IS NULL`)
    .get(flowId) as FlowRow | undefined;
  if (!flowRow) return null;

  const nodeRows = getDb()
    .prepare(`SELECT * FROM flow_nodes WHERE flow_id = ? ORDER BY created_at ASC`)
    .all(flowId) as FlowNodeRow[];
  const edgeRows = getDb()
    .prepare(`SELECT * FROM flow_edges WHERE flow_id = ? ORDER BY created_at ASC`)
    .all(flowId) as FlowEdgeRow[];

  return {
    flow: rowToFlow(flowRow),
    nodes: nodeRows.map(rowToNode),
    edges: edgeRows.map(rowToEdge),
  };
}

export function updateFlow(opts: {
  flowId: string;
  title?: string;
  description?: string | null;
}): FlowDefinition {
  assertFlowExists(opts.flowId);
  const current = getFlow(opts.flowId);
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE flows
       SET title = ?,
           description = ?,
           updated_at = ?
       WHERE id = ? AND archived_at IS NULL`,
    )
    .run(
      opts.title === undefined
        ? current.title
        : opts.title.trim() || "Untitled flow",
      opts.description === undefined ? current.description : opts.description,
      now,
      opts.flowId,
    );
  return getFlow(opts.flowId);
}

export function archiveFlow(flowId: string): FlowDefinition {
  assertFlowExists(flowId);
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE flows
       SET archived_at = ?,
           updated_at = ?
       WHERE id = ? AND archived_at IS NULL`,
    )
    .run(now, now, flowId);
  return getFlow(flowId, { includeArchived: true });
}

export function createFlowNode(opts: {
  flowId: string;
  type: FlowNodeType;
  title?: string;
  position?: { x: number; y: number };
  config?: unknown;
}): FlowNode {
  assertFlowExists(opts.flowId);
  const now = Date.now();
  const id = randomUUID();
  insertNode({
    id,
    flowId: opts.flowId,
    type: opts.type,
    title: opts.title?.trim() || defaultNodeTitle(opts.type),
    x: opts.position?.x ?? 360,
    y: opts.position?.y ?? 180,
    config: opts.config ?? defaultNodeConfig(opts.type),
    now,
  });
  touchFlow(opts.flowId, now);
  return getFlowNode(id);
}

export function updateFlowNode(opts: {
  flowId: string;
  nodeId: string;
  title?: string;
  position?: { x: number; y: number };
  config?: unknown;
}): FlowNode {
  assertFlowExists(opts.flowId);
  const current = getFlowNode(opts.nodeId);
  if (current.flowId !== opts.flowId) {
    throw new Error("Flow node not found.");
  }

  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE flow_nodes
       SET title = ?,
           position_x = ?,
           position_y = ?,
           config_json = ?,
           updated_at = ?
       WHERE id = ? AND flow_id = ?`,
    )
    .run(
      opts.title === undefined
        ? current.title
        : opts.title.trim() || defaultNodeTitle(current.type),
      opts.position?.x ?? current.position.x,
      opts.position?.y ?? current.position.y,
      JSON.stringify(opts.config === undefined ? current.config : opts.config),
      now,
      opts.nodeId,
      opts.flowId,
    );
  touchFlow(opts.flowId, now);
  return getFlowNode(opts.nodeId);
}

export function deleteFlowNode(opts: {
  flowId: string;
  nodeId: string;
}): FlowNode {
  assertFlowExists(opts.flowId);
  const current = getFlowNode(opts.nodeId);
  if (current.flowId !== opts.flowId) {
    throw new Error("Flow node not found.");
  }
  if (current.type === "start" || current.type === "end") {
    throw new Error("Start and End nodes cannot be deleted.");
  }

  const now = Date.now();
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM flow_edges
        WHERE flow_id = ?
          AND (source_node_id = ? OR target_node_id = ?)`,
    ).run(opts.flowId, opts.nodeId, opts.nodeId);
    db.prepare(`DELETE FROM flow_nodes WHERE id = ? AND flow_id = ?`).run(
      opts.nodeId,
      opts.flowId,
    );
    touchFlow(opts.flowId, now);
  })();
  return current;
}

export function createFlowEdge(opts: {
  flowId: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition?: unknown | null;
}): FlowEdge {
  if (opts.sourceNodeId === opts.targetNodeId) {
    throw new Error("Cannot connect a node to itself.");
  }
  assertFlowExists(opts.flowId);
  assertNodeInFlow(opts.flowId, opts.sourceNodeId);
  assertNodeInFlow(opts.flowId, opts.targetNodeId);
  removeDefaultStartEndEdge({
    flowId: opts.flowId,
    sourceNodeId: opts.sourceNodeId,
    targetNodeId: opts.targetNodeId,
  });

  const duplicate = getDb()
    .prepare(
      `SELECT * FROM flow_edges
        WHERE flow_id = ?
          AND source_node_id = ?
          AND target_node_id = ?`,
    )
    .get(opts.flowId, opts.sourceNodeId, opts.targetNodeId) as
    | FlowEdgeRow
    | undefined;
  if (duplicate) return rowToEdge(duplicate);

  const now = Date.now();
  const id = randomUUID();
  insertEdge({
    id,
    flowId: opts.flowId,
    sourceNodeId: opts.sourceNodeId,
    targetNodeId: opts.targetNodeId,
    condition: opts.condition ?? null,
    now,
  });
  touchFlow(opts.flowId, now);
  return getFlowEdge(id);
}

export function updateFlowEdge(opts: {
  flowId: string;
  edgeId: string;
  condition?: unknown | null;
}): FlowEdge {
  assertFlowExists(opts.flowId);
  const current = getFlowEdge(opts.edgeId);
  if (current.flowId !== opts.flowId) {
    throw new Error("Flow edge not found.");
  }

  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE flow_edges
       SET condition_json = ?,
           updated_at = ?
       WHERE id = ? AND flow_id = ?`,
    )
    .run(
      stringifyNullable(
        opts.condition === undefined ? current.condition : opts.condition,
      ),
      now,
      opts.edgeId,
      opts.flowId,
    );
  touchFlow(opts.flowId, now);
  return getFlowEdge(opts.edgeId);
}

export function deleteFlowEdge(opts: {
  flowId: string;
  edgeId: string;
}): FlowEdge {
  assertFlowExists(opts.flowId);
  const current = getFlowEdge(opts.edgeId);
  if (current.flowId !== opts.flowId) {
    throw new Error("Flow edge not found.");
  }

  const now = Date.now();
  getDb()
    .prepare(`DELETE FROM flow_edges WHERE id = ? AND flow_id = ?`)
    .run(opts.edgeId, opts.flowId);
  touchFlow(opts.flowId, now);
  return current;
}

export function createFlowRun(opts: {
  flowId: string;
  input: unknown;
  status?: FlowRunStatus;
}): FlowRun {
  assertFlowExists(opts.flowId);
  const now = Date.now();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO flow_runs
         (id, flow_id, status, input_json, output_json, error, started_at,
          finished_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)`,
    )
    .run(
      id,
      opts.flowId,
      opts.status ?? "running",
      JSON.stringify(opts.input ?? {}),
      now,
    );
  touchFlow(opts.flowId, now);
  return getFlowRun(id);
}

export function updateFlowRun(
  runId: string,
  patch: {
    status?: FlowRunStatus;
    output?: unknown | null;
    error?: string | null;
    finishedAt?: number | null;
  },
): FlowRun {
  const current = getFlowRun(runId);
  getDb()
    .prepare(
      `UPDATE flow_runs
       SET status = ?,
           output_json = ?,
           error = ?,
           finished_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.status ?? current.status,
      patch.output === undefined
        ? current.output == null
          ? null
          : JSON.stringify(current.output)
        : patch.output == null
          ? null
          : JSON.stringify(patch.output),
      patch.error === undefined ? current.error : patch.error,
      patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      runId,
    );
  return getFlowRun(runId);
}

export function createFlowNodeRun(opts: {
  flowRunId: string;
  nodeId: string;
  input: unknown;
  status?: FlowRunStatus;
}): FlowNodeRun {
  assertFlowRunExists(opts.flowRunId);
  const now = Date.now();
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO flow_node_runs
         (id, flow_run_id, node_id, status, input_json, output_json,
          transcript_thread_id, error, started_at, finished_at, trace_json)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)`,
    )
    .run(
      id,
      opts.flowRunId,
      opts.nodeId,
      opts.status ?? "running",
      JSON.stringify(opts.input ?? {}),
      now,
    );
  return getFlowNodeRun(id);
}

export function updateFlowNodeRun(
  nodeRunId: string,
  patch: {
    status?: FlowRunStatus;
    output?: unknown | null;
    trace?: unknown | null;
    transcriptThreadId?: string | null;
    error?: string | null;
    finishedAt?: number | null;
  },
): FlowNodeRun {
  const current = getFlowNodeRun(nodeRunId);
  getDb()
    .prepare(
      `UPDATE flow_node_runs
       SET status = ?,
           output_json = ?,
           trace_json = ?,
           transcript_thread_id = ?,
           error = ?,
           finished_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.status ?? current.status,
      stringifyNullable(
        patch.output === undefined ? current.output : patch.output,
      ),
      stringifyNullable(patch.trace === undefined ? current.trace : patch.trace),
      patch.transcriptThreadId === undefined
        ? current.transcriptThreadId
        : patch.transcriptThreadId,
      patch.error === undefined ? current.error : patch.error,
      patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      nodeRunId,
    );
  return getFlowNodeRun(nodeRunId);
}

export function listFlowRuns(flowId: string): FlowRun[] {
  assertFlowExists(flowId);
  const rows = getDb()
    .prepare(
      `SELECT * FROM flow_runs
        WHERE flow_id = ?
        ORDER BY started_at DESC`,
    )
    .all(flowId) as FlowRunRow[];
  return rows.map(rowToFlowRun);
}

export function getFlowRunWithNodes(runId: string): FlowRunWithNodes | null {
  const runRow = getDb()
    .prepare(`SELECT * FROM flow_runs WHERE id = ?`)
    .get(runId) as FlowRunRow | undefined;
  if (!runRow) return null;

  const nodeRows = getDb()
    .prepare(
      `SELECT * FROM flow_node_runs
        WHERE flow_run_id = ?
        ORDER BY started_at ASC`,
    )
    .all(runId) as FlowNodeRunRow[];

  return {
    run: rowToFlowRun(runRow),
    nodeRuns: nodeRows.map(rowToNodeRun),
  };
}

function insertNode(opts: {
  id: string;
  flowId: string;
  type: FlowNodeType;
  title: string;
  x: number;
  y: number;
  config: unknown;
  now: number;
}) {
  getDb()
    .prepare(
      `INSERT INTO flow_nodes
         (id, flow_id, type, title, position_x, position_y, config_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.flowId,
      opts.type,
      opts.title,
      opts.x,
      opts.y,
      JSON.stringify(opts.config ?? {}),
      opts.now,
      opts.now,
    );
}

function insertEdge(opts: {
  id: string;
  flowId: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition: unknown | null;
  now: number;
}) {
  getDb()
    .prepare(
      `INSERT INTO flow_edges
         (id, flow_id, source_node_id, target_node_id, condition_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.flowId,
      opts.sourceNodeId,
      opts.targetNodeId,
      opts.condition == null ? null : JSON.stringify(opts.condition),
      opts.now,
      opts.now,
    );
}

function getFlowNode(nodeId: string): FlowNode {
  const row = getDb()
    .prepare(`SELECT * FROM flow_nodes WHERE id = ?`)
    .get(nodeId) as FlowNodeRow | undefined;
  if (!row) throw new Error("Flow node not found.");
  return rowToNode(row);
}

function getFlow(
  flowId: string,
  opts: { includeArchived?: boolean } = {},
): FlowDefinition {
  const row = getDb()
    .prepare(
      opts.includeArchived
        ? `SELECT * FROM flows WHERE id = ?`
        : `SELECT * FROM flows WHERE id = ? AND archived_at IS NULL`,
    )
    .get(flowId) as FlowRow | undefined;
  if (!row) throw new Error("Flow not found.");
  return rowToFlow(row);
}

function getFlowEdge(edgeId: string): FlowEdge {
  const row = getDb()
    .prepare(`SELECT * FROM flow_edges WHERE id = ?`)
    .get(edgeId) as FlowEdgeRow | undefined;
  if (!row) throw new Error("Flow edge not found.");
  return rowToEdge(row);
}

function getFlowRun(runId: string): FlowRun {
  const row = getDb()
    .prepare(`SELECT * FROM flow_runs WHERE id = ?`)
    .get(runId) as FlowRunRow | undefined;
  if (!row) throw new Error("Flow run not found.");
  return rowToFlowRun(row);
}

function getFlowNodeRun(nodeRunId: string): FlowNodeRun {
  const row = getDb()
    .prepare(`SELECT * FROM flow_node_runs WHERE id = ?`)
    .get(nodeRunId) as FlowNodeRunRow | undefined;
  if (!row) throw new Error("Flow node run not found.");
  return rowToNodeRun(row);
}

function assertFlowExists(flowId: string) {
  const exists = getDb()
    .prepare(`SELECT 1 FROM flows WHERE id = ? AND archived_at IS NULL`)
    .get(flowId);
  if (!exists) throw new Error("Flow not found.");
}

function assertFlowRunExists(runId: string) {
  const exists = getDb()
    .prepare(`SELECT 1 FROM flow_runs WHERE id = ?`)
    .get(runId);
  if (!exists) throw new Error("Flow run not found.");
}

function assertNodeInFlow(flowId: string, nodeId: string) {
  const exists = getDb()
    .prepare(`SELECT 1 FROM flow_nodes WHERE flow_id = ? AND id = ?`)
    .get(flowId, nodeId);
  if (!exists) throw new Error("Flow node not found.");
}

function removeDefaultStartEndEdge(opts: {
  flowId: string;
  sourceNodeId: string;
  targetNodeId: string;
}) {
  const source = getFlowNode(opts.sourceNodeId);
  const target = getFlowNode(opts.targetNodeId);
  const shouldRemoveDefault =
    (source.type === "start" && target.type !== "end") ||
    (source.type !== "start" && target.type === "end");

  if (!shouldRemoveDefault) return;

  const startNode = getDb()
    .prepare(`SELECT * FROM flow_nodes WHERE flow_id = ? AND type = 'start'`)
    .get(opts.flowId) as FlowNodeRow | undefined;
  const endNode = getDb()
    .prepare(`SELECT * FROM flow_nodes WHERE flow_id = ? AND type = 'end'`)
    .get(opts.flowId) as FlowNodeRow | undefined;
  if (!startNode || !endNode) return;

  getDb()
    .prepare(
      `DELETE FROM flow_edges
        WHERE flow_id = ?
          AND source_node_id = ?
          AND target_node_id = ?`,
    )
    .run(opts.flowId, startNode.id, endNode.id);
}

function touchFlow(flowId: string, updatedAt: number) {
  getDb()
    .prepare(`UPDATE flows SET updated_at = ? WHERE id = ?`)
    .run(updatedAt, flowId);
}

function normalizeNodeType(type: string): FlowNodeType {
  if (
    type === "start" ||
    type === "agent" ||
    type === "prompt" ||
    type === "transform" ||
    type === "condition" ||
    type === "end"
  ) {
    return type;
  }
  return "prompt";
}

function normalizeRunStatus(status: string): FlowRunStatus {
  if (
    status === "queued" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  ) {
    return status;
  }
  return "failed";
}

function defaultNodeTitle(type: FlowNodeType): string {
  switch (type) {
    case "start":
      return "Start";
    case "agent":
      return "Agent";
    case "prompt":
      return "Prompt";
    case "transform":
      return "Transform";
    case "condition":
      return "Condition";
    case "end":
      return "End";
  }
}

function defaultNodeConfig(type: FlowNodeType): unknown {
  if (type === "agent" || type === "prompt") {
    return {
      prompt: "Use the workspace tools when needed, then return the next JSON object.",
      outputSchema: {
        type: "object",
        additionalProperties: true,
      },
      retry: {
        maxAttempts: 3,
      },
      timeoutMs: 60_000,
      permissionMode: "bypassPermissions",
    };
  }
  if (type === "condition") {
    return {
      condition: {
        path: "$.ok",
        equals: true,
      },
    };
  }
  if (type === "start") {
    return { input: {} };
  }
  if (type === "transform") {
    return {
      inputMapping: {},
      outputPath: "$",
    };
  }
  return {};
}

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyNullable(value: unknown | null): string | null {
  return value == null ? null : JSON.stringify(value);
}
