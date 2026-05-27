import type { WorkspaceOption } from "./chat-session";

export type FlowNodeType = "start" | "prompt" | "transform" | "condition" | "end";

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

export type FlowGraph = {
  flow: FlowDefinition;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

export type FlowRunWithNodes = {
  run: FlowRun;
  nodeRuns: FlowNodeRun[];
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

export async function fetchFlowGraph(flowId: string): Promise<FlowGraph> {
  const response = await fetch(`/api/flows/${encodeURIComponent(flowId)}`);
  if (!response.ok) {
    throw new Error("Failed to load flow.");
  }
  return (await response.json()) as FlowGraph;
}

export async function createFlowNodeOnApi(params: {
  flowId: string;
  type: FlowNodeType;
  title?: string;
  position?: { x: number; y: number };
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
      }),
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
}): Promise<FlowEdge> {
  const response = await fetch(
    `/api/flows/${encodeURIComponent(params.flowId)}/edges`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceNodeId: params.sourceNodeId,
        targetNodeId: params.targetNodeId,
      }),
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
