import type { WorkspaceOption } from "./chat-session";
import type { UIMessage } from "ai";

export type FlowNodeType = string;
export type FlowTemplateId = "juejin-frontend-document-intake";

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
  | "waiting_for_approval"
  | "skipped";

export type FlowRun = {
  id: string;
  flowId: string;
  status: FlowRunStatus;
  input: unknown;
  output: unknown | null;
  graphSnapshot: FlowRunGraphSnapshot | null;
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

export type FlowGraph = {
  flow: FlowDefinition;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type FlowRunGraphSnapshot = FlowGraph & {
  version: 1;
  capturedAt: number;
};

export type FlowRunWithNodes = {
  run: FlowRun;
  nodeRuns: FlowNodeRun[];
  artifacts: FlowArtifact[];
  items: FlowItem[];
};

export type FlowRunEvent = {
  id: string;
  flowRunId: string;
  nodeRunId: string | null;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: number;
};

export type FlowArtifactKind =
  | "json"
  | "markdown"
  | "text"
  | "image"
  | "html"
  | "patch"
  | "log";

export type FlowArtifact = {
  id: string;
  flowRunId: string;
  nodeRunId: string | null;
  itemId: string | null;
  kind: FlowArtifactKind;
  title: string;
  path: string | null;
  mediaType: string | null;
  metadata: unknown;
  createdAt: number;
};

export type FlowItemStatus =
  | "discovered"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped_duplicate"
  | "skipped_low_value"
  | "waiting_for_approval"
  | "applied"
  | "skipped";

export type FlowItem = {
  id: string;
  flowRunId: string;
  nodeRunId: string | null;
  externalId: string | null;
  status: FlowItemStatus;
  title: string;
  input: unknown;
  output: unknown | null;
  metadata: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export async function fetchFlows(): Promise<FlowDefinition[]> {
  const response = await fetch("/api/flows");
  if (!response.ok) {
    throw new Error("Failed to load flows.");
  }
  const data = (await response.json()) as { flows?: FlowDefinition[] };
  return data.flows ?? [];
}

export async function createFlowOnApi(params: {
  title: string;
  description?: string;
  workspace: WorkspaceOption;
}): Promise<FlowGraph> {
  const response = await fetch("/api/flows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: params.title,
      description: params.description ?? null,
      workspaceRoot: params.workspace.root,
      workspaceName: params.workspace.name,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as FlowGraph;
}

export async function createFlowFromTemplateOnApi(params: {
  templateId: FlowTemplateId;
  title?: string;
  workspace: WorkspaceOption;
}): Promise<FlowGraph> {
  const response = await fetch("/api/flows/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      templateId: params.templateId,
      title: params.title ?? null,
      workspaceRoot: params.workspace.root,
      workspaceName: params.workspace.name,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as FlowGraph;
}

export async function fetchFlowGraph(flowId: string): Promise<FlowGraph> {
  const response = await fetch(`/api/flows/${encodeURIComponent(flowId)}`);
  if (!response.ok) {
    throw new Error("Failed to load flow.");
  }
  return (await response.json()) as FlowGraph;
}

export async function updateFlowOnApi(params: {
  flowId: string;
  title?: string;
  description?: string | null;
}): Promise<FlowDefinition> {
  const response = await fetch(`/api/flows/${encodeURIComponent(params.flowId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: params.title,
      description: params.description,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { flow: FlowDefinition };
  return data.flow;
}

export async function archiveFlowOnApi(
  flowId: string,
): Promise<FlowDefinition> {
  const response = await fetch(`/api/flows/${encodeURIComponent(flowId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { flow: FlowDefinition };
  return data.flow;
}

export async function createFlowNodeOnApi(params: {
  flowId: string;
  type: FlowNodeType;
  title?: string;
  position?: { x: number; y: number };
  config?: unknown;
}): Promise<FlowNode> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/nodes`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: params.type,
        title: params.title,
        position: params.position,
        config: params.config,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { node: FlowNode };
  return data.node;
}

export async function updateFlowNodeOnApi(params: {
  flowId: string;
  nodeId: string;
  title?: string;
  position?: { x: number; y: number };
  config?: unknown;
}): Promise<FlowNode> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/nodes/${encodeURIComponent(
      params.nodeId,
    )}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: params.title,
        position: params.position,
        config: params.config,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { node: FlowNode };
  return data.node;
}

export async function deleteFlowNodeOnApi(params: {
  flowId: string;
  nodeId: string;
}): Promise<FlowNode> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/nodes/${encodeURIComponent(
      params.nodeId,
    )}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { node: FlowNode };
  return data.node;
}

export async function createFlowEdgeOnApi(params: {
  flowId: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition?: unknown | null;
}): Promise<FlowEdge> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/edges`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceNodeId: params.sourceNodeId,
        targetNodeId: params.targetNodeId,
        condition: params.condition ?? null,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { edge: FlowEdge };
  return data.edge;
}

export async function updateFlowEdgeOnApi(params: {
  flowId: string;
  edgeId: string;
  condition?: unknown | null;
}): Promise<FlowEdge> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/edges/${encodeURIComponent(
      params.edgeId,
    )}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        condition: params.condition ?? null,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { edge: FlowEdge };
  return data.edge;
}

export async function deleteFlowEdgeOnApi(params: {
  flowId: string;
  edgeId: string;
}): Promise<FlowEdge> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/edges/${encodeURIComponent(
      params.edgeId,
    )}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { edge: FlowEdge };
  return data.edge;
}

export async function fetchFlowRuns(flowId: string): Promise<FlowRun[]> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(flowId)}/runs`,
  );
  if (!response.ok) {
    throw new Error("Failed to load flow runs.");
  }
  const data = (await response.json()) as { runs?: FlowRun[] };
  return data.runs ?? [];
}

export async function runFlowOnApi(params: {
  flowId: string;
  inputJson: unknown;
}): Promise<FlowRunWithNodes> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputJson: params.inputJson }),
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as FlowRunWithNodes;
}

export async function fetchFlowRunDetail(params: {
  flowId: string;
  runId: string;
}): Promise<FlowRunWithNodes> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/runs/${encodeURIComponent(
      params.runId,
    )}`,
  );
  if (!response.ok) {
    throw new Error("Failed to load flow run.");
  }
  return (await response.json()) as FlowRunWithNodes;
}

export async function fetchFlowRunEvents(params: {
  flowId: string;
  runId: string;
}): Promise<FlowRunEvent[]> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/runs/${encodeURIComponent(
      params.runId,
    )}/events`,
  );
  if (!response.ok) {
    throw new Error("Failed to load flow run events.");
  }
  const data = (await response.json()) as { events?: FlowRunEvent[] };
  return data.events ?? [];
}

export async function resumeFlowRunOnApi(params: {
  flowId: string;
  runId: string;
  decision: "approved" | "rejected";
  response?: unknown;
}): Promise<FlowRunWithNodes> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/runs/${encodeURIComponent(
      params.runId,
    )}/resume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: params.decision,
        response: params.response ?? null,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as FlowRunWithNodes;
}

export async function fetchTranscriptMessages(
  threadId: string,
): Promise<UIMessage[]> {
  const response = await fetch(
    `/api/chat/history?id=${encodeURIComponent(threadId)}`,
  );
  if (!response.ok) {
    throw new Error("Failed to load transcript.");
  }
  const data = (await response.json()) as { messages?: UIMessage[] };
  return data.messages ?? [];
}
