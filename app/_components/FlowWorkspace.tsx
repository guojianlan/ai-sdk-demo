"use client";

import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  type Connection,
  type CoordinateExtent,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnConnect,
  type OnNodeDrag,
  type OnSelectionChangeFunc,
  type SelectionDragHandler,
} from "@xyflow/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  archiveFlowOnApi,
  createFlowEdgeOnApi,
  createFlowNodeOnApi,
  createFlowOnApi,
  deleteFlowEdgeOnApi,
  deleteFlowNodeOnApi,
  fetchFlowRunDetail,
  fetchFlowRuns,
  fetchFlowGraph,
  fetchFlows,
  fetchTranscriptMessages,
  runFlowOnApi,
  updateFlowOnApi,
  updateFlowEdgeOnApi,
  updateFlowNodeOnApi,
  type FlowDefinition,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowNodeRun,
  type FlowNodeType,
  type FlowRun,
  type FlowRunWithNodes,
} from "@/app/_lib/flows";
import { formatTimestamp, type WorkspaceOption } from "@/app/_lib/chat-session";

import { Eyebrow } from "./Eyebrow";

const NODE_TYPES: FlowNodeType[] = [
  "agent",
  "prompt",
  "transform",
  "condition",
  "end",
];

const CANVAS_WIDTH = 2400;
const CANVAS_HEIGHT = 1600;
const NODE_WIDTH = 192;
const FLOW_EXTENT: CoordinateExtent = [
  [0, 0],
  [CANVAS_WIDTH, CANVAS_HEIGHT],
];
const FLOW_NODE_TYPES = {
  flowNode: FlowNodeCard,
} satisfies NodeTypes;

type NodePositionPatch = {
  nodeId: string;
  position: { x: number; y: number };
};

type FlowCanvasNodeData = {
  node: FlowNode;
  nodeRun?: FlowNodeRun;
};

type FlowCanvasNode = Node<FlowCanvasNodeData, "flowNode">;

type FlowCanvasEdgeData = {
  edge: FlowEdge;
};

type FlowCanvasEdge = Edge<FlowCanvasEdgeData, "smoothstep">;

export function FlowWorkspace({
  workspaces,
  workspacesLoading,
}: {
  workspaces: WorkspaceOption[];
  workspacesLoading: boolean;
}) {
  const [flows, setFlows] = useState<FlowDefinition[]>([]);
  const [activeFlowId, setActiveFlowId] = useState("");
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [titleDraft, setTitleDraft] = useState("新流程");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [nodeType, setNodeType] = useState<FlowNodeType>("agent");
  const [edgeSource, setEdgeSource] = useState("");
  const [edgeTarget, setEdgeTarget] = useState("");
  const [edgeConditionDraft, setEdgeConditionDraft] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [activeRun, setActiveRun] = useState<FlowRunWithNodes | null>(null);
  const [inputDraft, setInputDraft] = useState("{\n  \"topic\": \"hello\"\n}");
  const [running, setRunning] = useState(false);
  const [savingNode, setSavingNode] = useState(false);
  const [savingEdge, setSavingEdge] = useState(false);
  const [savingFlow, setSavingFlow] = useState(false);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorFullscreen, setEditorFullscreen] = useState(false);

  const effectiveWorkspaceRoot = workspaceRoot || workspaces[0]?.root || "";
  const selectedWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.root === effectiveWorkspaceRoot) ??
      workspaces[0],
    [effectiveWorkspaceRoot, workspaces],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchFlows()
      .then((items) => {
        if (cancelled) return;
        setFlows(items);
        setActiveFlowId((current) => current || items[0]?.id || "");
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeFlowId) {
      return;
    }
    let cancelled = false;
    void fetchFlowGraph(activeFlowId)
      .then((nextGraph) => {
        if (cancelled) return;
        setGraph(nextGraph);
        setEdgeSource(nextGraph.nodes[0]?.id ?? "");
        setEdgeTarget(nextGraph.nodes[1]?.id ?? nextGraph.nodes[0]?.id ?? "");
        setSelectedNodeId(nextGraph.nodes[0]?.id ?? "");
        setSelectedNodeIds(nextGraph.nodes[0] ? [nextGraph.nodes[0].id] : []);
        setSelectedEdgeId("");
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeFlowId]);

  useEffect(() => {
    if (!activeFlowId) {
      setRuns([]);
      setActiveRun(null);
      return;
    }
    let cancelled = false;
    void fetchFlowRuns(activeFlowId)
      .then((items) => {
        if (cancelled) return;
        setRuns(items);
        const latest = items[0];
        if (!latest) {
          setActiveRun(null);
          return;
        }
        return fetchFlowRunDetail({
          flowId: activeFlowId,
          runId: latest.id,
        }).then((detail) => {
          if (!cancelled) setActiveRun(detail);
        });
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "运行记录加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeFlowId]);

  async function handleCreateFlow() {
    if (!selectedWorkspace) return;
    setError("");
    try {
      const created = await createFlowOnApi({
        title: titleDraft,
        workspace: selectedWorkspace,
      });
      setFlows((current) => [created.flow, ...current]);
      setActiveFlowId(created.flow.id);
      setGraph(created);
      setRuns([]);
      setActiveRun(null);
      setSelectedNodeId(created.nodes[0]?.id ?? "");
      setSelectedNodeIds(created.nodes[0] ? [created.nodes[0].id] : []);
      setSelectedEdgeId("");
      setEditorOpen(true);
      setEditorFullscreen(false);
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "创建流程失败",
      );
    }
  }

  async function handleAddNode() {
    if (!graph) return;
    setError("");
    try {
      const nextIndex = graph.nodes.length;
      const node = await createFlowNodeOnApi({
        flowId: graph.flow.id,
        type: nodeType,
        position: {
          x: 240 + nextIndex * 120,
          y: 120 + (nextIndex % 3) * 120,
        },
      });
      setGraph({ ...graph, nodes: [...graph.nodes, node] });
      setEdgeTarget(node.id);
      setSelectedNodeId(node.id);
      setSelectedNodeIds([node.id]);
      setSelectedEdgeId("");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "添加节点失败");
    }
  }

  async function handleRunFlow() {
    if (!graph) return;
    setError("");
    setRunning(true);
    try {
      const parsedInput = parseJsonDraft(inputDraft);
      const detail = await runFlowOnApi({
        flowId: graph.flow.id,
        inputJson: parsedInput,
      });
      setActiveRun(detail);
      setRuns((current) => [
        detail.run,
        ...current.filter((run) => run.id !== detail.run.id),
      ]);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "运行流程失败");
    } finally {
      setRunning(false);
    }
  }

  async function handleSelectRun(runId: string) {
    if (!graph) return;
    setError("");
    try {
      const detail = await fetchFlowRunDetail({
        flowId: graph.flow.id,
        runId,
      });
      setActiveRun(detail);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "运行详情加载失败");
    }
  }

  async function handleConnectNodes() {
    if (!graph || !edgeSource || !edgeTarget) return;
    setError("");
    try {
      const edge = await createFlowEdgeOnApi({
        flowId: graph.flow.id,
        sourceNodeId: edgeSource,
        targetNodeId: edgeTarget,
        condition: edgeConditionDraft.trim()
          ? parseConfigJson(edgeConditionDraft, "连线条件")
          : null,
      });
      const nextGraph = await fetchFlowGraph(graph.flow.id);
      setGraph(nextGraph);
      setEdgeSource(edge.sourceNodeId);
      setEdgeTarget(edge.targetNodeId);
      setSelectedNodeId("");
      setSelectedNodeIds([]);
      setSelectedEdgeId(edge.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "连接节点失败");
    }
  }

  async function handleConnectNodePair(params: {
    sourceNodeId: string;
    targetNodeId: string;
  }) {
    if (!graph) return;
    setError("");
    try {
      const edge = await createFlowEdgeOnApi({
        flowId: graph.flow.id,
        sourceNodeId: params.sourceNodeId,
        targetNodeId: params.targetNodeId,
        condition: null,
      });
      const nextGraph = await fetchFlowGraph(graph.flow.id);
      setGraph(nextGraph);
      setEdgeSource(edge.sourceNodeId);
      setEdgeTarget(edge.targetNodeId);
      setSelectedNodeId("");
      setSelectedNodeIds([]);
      setSelectedEdgeId(edge.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "连接节点失败");
    }
  }

  function handleSelectNodes(nodeIds: string[], primaryNodeId?: string) {
    setSelectedEdgeId("");
    setSelectedNodeIds(nodeIds);
    setSelectedNodeId(primaryNodeId ?? nodeIds[0] ?? "");
  }

  async function handleSaveNode(params: {
    nodeId: string;
    title: string;
    config: unknown;
  }) {
    if (!graph) return;
    setError("");
    setSavingNode(true);
    try {
      const node = await updateFlowNodeOnApi({
        flowId: graph.flow.id,
        nodeId: params.nodeId,
        title: params.title,
        config: params.config,
      });
      setGraph({
        ...graph,
        nodes: graph.nodes.map((item) => (item.id === node.id ? node : item)),
      });
      setSelectedNodeId(node.id);
      setSelectedNodeIds((current) =>
        current.includes(node.id) ? current : [node.id],
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存节点失败");
    } finally {
      setSavingNode(false);
    }
  }

  function handlePreviewNodePositions(patches: NodePositionPatch[]) {
    setGraph((current) => {
      if (!current) return current;
      const positionByNodeId = new Map(
        patches.map((patch) => [patch.nodeId, patch.position]),
      );
      return {
        ...current,
        nodes: current.nodes.map((node) =>
          positionByNodeId.has(node.id)
            ? { ...node, position: positionByNodeId.get(node.id) ?? node.position }
            : node,
        ),
      };
    });
  }

  async function handleCommitNodePositions(patches: NodePositionPatch[]) {
    if (!graph) return;
    setError("");
    try {
      const nodes = await Promise.all(
        patches.map((patch) =>
          updateFlowNodeOnApi({
            flowId: graph.flow.id,
            nodeId: patch.nodeId,
            position: patch.position,
          }),
        ),
      );
      setGraph((current) => {
        if (!current) return current;
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        return {
          ...current,
          nodes: current.nodes.map((item) =>
            nodeById.get(item.id) ?? item,
          ),
        };
      });
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存节点位置失败",
      );
    }
  }

  async function handleDeleteNode(nodeId: string) {
    if (!graph) return;
    setError("");
    try {
      await deleteFlowNodeOnApi({
        flowId: graph.flow.id,
        nodeId,
      });
      const remainingNodes = graph.nodes.filter((node) => node.id !== nodeId);
      const remainingEdges = graph.edges.filter(
        (edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId,
      );
      setGraph({
        ...graph,
        nodes: remainingNodes,
        edges: remainingEdges,
      });
      setSelectedNodeId(remainingNodes[0]?.id ?? "");
      setSelectedNodeIds((current) => {
        const remainingIds = new Set(remainingNodes.map((node) => node.id));
        const next = current.filter((nodeId) => remainingIds.has(nodeId));
        return next.length > 0 ? next : remainingNodes[0] ? [remainingNodes[0].id] : [];
      });
      setSelectedEdgeId("");
      setEdgeSource(remainingNodes[0]?.id ?? "");
      setEdgeTarget(remainingNodes[1]?.id ?? remainingNodes[0]?.id ?? "");
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "删除节点失败",
      );
    }
  }

  async function handleDeleteEdge(edgeId: string) {
    if (!graph) return;
    setError("");
    try {
      await deleteFlowEdgeOnApi({
        flowId: graph.flow.id,
        edgeId,
      });
      setGraph({
        ...graph,
        edges: graph.edges.filter((edge) => edge.id !== edgeId),
      });
      setSelectedEdgeId("");
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "删除连线失败",
      );
    }
  }

  async function handleSaveEdge(params: {
    edgeId: string;
    condition: unknown | null;
  }) {
    if (!graph) return;
    setError("");
    setSavingEdge(true);
    try {
      const edge = await updateFlowEdgeOnApi({
        flowId: graph.flow.id,
        edgeId: params.edgeId,
        condition: params.condition,
      });
      setGraph({
        ...graph,
        edges: graph.edges.map((item) => (item.id === edge.id ? edge : item)),
      });
      setSelectedEdgeId(edge.id);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存连线失败");
    } finally {
      setSavingEdge(false);
    }
  }

  async function handleSaveFlow(params: {
    title: string;
    description: string | null;
  }) {
    if (!graph) return;
    setError("");
    setSavingFlow(true);
    try {
      const flow = await updateFlowOnApi({
        flowId: graph.flow.id,
        title: params.title,
        description: params.description,
      });
      setGraph({ ...graph, flow });
      setFlows((current) =>
        current.map((item) => (item.id === flow.id ? flow : item)),
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存 flow 失败");
    } finally {
      setSavingFlow(false);
    }
  }

  async function handleArchiveFlow() {
    if (!graph) return;
    setError("");
    setSavingFlow(true);
    try {
      const archived = await archiveFlowOnApi(graph.flow.id);
      setFlows((current) => current.filter((flow) => flow.id !== archived.id));
      setGraph(null);
      setRuns([]);
      setActiveRun(null);
      setSelectedNodeId("");
      setSelectedNodeIds([]);
      setSelectedEdgeId("");
      const nextFlowId = flows.find((flow) => flow.id !== archived.id)?.id ?? "";
      setActiveFlowId(nextFlowId);
    } catch (archiveError) {
      setError(
        archiveError instanceof Error ? archiveError.message : "归档 flow 失败",
      );
    } finally {
      setSavingFlow(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden px-5 py-6 sm:px-8 lg:px-10">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Eyebrow>流程</Eyebrow>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
            流程画布
          </h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(160px,1fr)_minmax(180px,1fr)_auto]">
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            className="h-10 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-slate-900"
            placeholder="流程名称"
          />
          <select
            value={effectiveWorkspaceRoot}
            onChange={(event) => setWorkspaceRoot(event.target.value)}
            className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-slate-900"
            disabled={workspacesLoading || workspaces.length === 0}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.root} value={workspace.root}>
                {workspace.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleCreateFlow}
            disabled={!selectedWorkspace}
            className="h-10 rounded-md border border-slate-900 bg-slate-900 px-4 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-white disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200"
          >
            创建
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-slate-200 pr-4">
          <div className="mb-3 flex items-center justify-between">
            <Eyebrow>全部流程 · {flows.length}</Eyebrow>
          </div>
          <div className="space-y-2">
            {flows.map((flow) => (
              <button
                key={flow.id}
                type="button"
                onClick={() => {
                  setActiveFlowId(flow.id);
                  setEditorOpen(true);
                }}
                className={[
                  "w-full rounded-md border px-3 py-3 text-left transition-colors",
                  flow.id === activeFlowId
                    ? "border-slate-900 border-l-[3px]"
                    : "border-slate-200 hover:border-slate-400",
                ].join(" ")}
              >
                <div className="truncate text-sm font-medium text-slate-900">
                  {flow.title}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                  {flow.workspaceName || "工作区"} ·{" "}
                  {formatTimestamp(new Date(flow.updatedAt).toISOString())}
                </div>
              </button>
            ))}
            {flows.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                暂无流程
              </div>
            )}
          </div>
        </div>

        {activeFlowId && graph ? (
          <div className="flex min-h-0 flex-col justify-between rounded-md border border-slate-200 bg-white p-5">
            <div>
              <Eyebrow>当前流程</Eyebrow>
              <h3 className="mt-2 text-xl font-semibold text-slate-900">
                {graph.flow.title}
              </h3>
              <p className="mt-2 text-sm text-slate-600">
                {graph.nodes.length} 个节点 · {graph.edges.length} 条连线 ·{" "}
                {graph.flow.workspaceName || "工作区"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="mt-4 h-10 w-fit rounded-md border border-slate-900 bg-slate-900 px-4 text-sm font-medium text-white"
            >
              打开编辑器
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm text-slate-500">
            创建或选择一个流程
          </div>
        )}
      </div>

      {editorOpen && activeFlowId && graph && (
        <FlowEditorDialog
          title={graph.flow.title}
          fullscreen={editorFullscreen}
          onToggleFullscreen={() => setEditorFullscreen((current) => !current)}
          onClose={() => setEditorOpen(false)}
        >
          <FlowEditor
            graph={graph}
            nodeType={nodeType}
            edgeSource={edgeSource}
            edgeTarget={edgeTarget}
            edgeConditionDraft={edgeConditionDraft}
            onNodeTypeChange={setNodeType}
            onEdgeSourceChange={setEdgeSource}
            onEdgeTargetChange={setEdgeTarget}
            onEdgeConditionDraftChange={setEdgeConditionDraft}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            selectedEdgeId={selectedEdgeId}
            onSelectedNodesChange={handleSelectNodes}
            onSelectedEdgeChange={(edgeId) => {
              setSelectedEdgeId(edgeId);
              setSelectedNodeId("");
              setSelectedNodeIds([]);
            }}
            runs={runs}
            activeRun={activeRun}
            inputDraft={inputDraft}
            running={running}
            savingFlow={savingFlow}
            savingNode={savingNode}
            savingEdge={savingEdge}
            onInputDraftChange={setInputDraft}
            onAddNode={() => void handleAddNode()}
            onConnectNodes={() => void handleConnectNodes()}
            onConnectNodePair={(params) => void handleConnectNodePair(params)}
            onRunFlow={() => void handleRunFlow()}
            onSelectRun={(runId) => void handleSelectRun(runId)}
            onSaveFlow={(params) => void handleSaveFlow(params)}
            onArchiveFlow={() => void handleArchiveFlow()}
            onSaveNode={(params) => void handleSaveNode(params)}
            onPreviewNodePositions={handlePreviewNodePositions}
            onCommitNodePositions={(patches) =>
              void handleCommitNodePositions(patches)
            }
            onSaveEdge={(params) => void handleSaveEdge(params)}
            onDeleteNode={(nodeId) => void handleDeleteNode(nodeId)}
            onDeleteEdge={(edgeId) => void handleDeleteEdge(edgeId)}
          />
        </FlowEditorDialog>
      )}
    </div>
  );
}

function FlowEditorDialog({
  title,
  fullscreen,
  children,
  onToggleFullscreen,
  onClose,
}: {
  title: string;
  fullscreen: boolean;
  children: ReactNode;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} 流程编辑器`}
    >
      <div
        className={[
          "flex min-h-0 flex-col overflow-hidden border border-slate-900 bg-white shadow-2xl",
          fullscreen
            ? "h-screen w-screen rounded-none"
            : "h-[90vh] w-[90vw] rounded-md",
        ].join(" ")}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">
              {title}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              流程编辑器
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 hover:border-slate-900"
            >
              {fullscreen ? "退出全屏" : "全屏"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border border-slate-900 bg-slate-900 px-3 text-sm text-white"
            >
              关闭
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-4">{children}</div>
      </div>
    </div>
  );
}

function FlowEditor({
  graph,
  nodeType,
  edgeSource,
  edgeTarget,
  edgeConditionDraft,
  onNodeTypeChange,
  onEdgeSourceChange,
  onEdgeTargetChange,
  onEdgeConditionDraftChange,
  selectedNodeId,
  selectedNodeIds,
  selectedEdgeId,
  onSelectedNodesChange,
  onSelectedEdgeChange,
  runs,
  activeRun,
  inputDraft,
  running,
  savingFlow,
  savingNode,
  savingEdge,
  onInputDraftChange,
  onAddNode,
  onConnectNodes,
  onConnectNodePair,
  onRunFlow,
  onSelectRun,
  onSaveFlow,
  onArchiveFlow,
  onSaveNode,
  onPreviewNodePositions,
  onCommitNodePositions,
  onSaveEdge,
  onDeleteNode,
  onDeleteEdge,
}: {
  graph: FlowGraph;
  nodeType: FlowNodeType;
  edgeSource: string;
  edgeTarget: string;
  edgeConditionDraft: string;
  onNodeTypeChange: (type: FlowNodeType) => void;
  onEdgeSourceChange: (id: string) => void;
  onEdgeTargetChange: (id: string) => void;
  onEdgeConditionDraftChange: (value: string) => void;
  selectedNodeId: string;
  selectedNodeIds: string[];
  selectedEdgeId: string;
  onSelectedNodesChange: (ids: string[], primaryNodeId?: string) => void;
  onSelectedEdgeChange: (id: string) => void;
  runs: FlowRun[];
  activeRun: FlowRunWithNodes | null;
  inputDraft: string;
  running: boolean;
  savingFlow: boolean;
  savingNode: boolean;
  savingEdge: boolean;
  onInputDraftChange: (value: string) => void;
  onAddNode: () => void;
  onConnectNodes: () => void;
  onConnectNodePair: (params: {
    sourceNodeId: string;
    targetNodeId: string;
  }) => void;
  onRunFlow: () => void;
  onSelectRun: (runId: string) => void;
  onSaveFlow: (params: { title: string; description: string | null }) => void;
  onArchiveFlow: () => void;
  onSaveNode: (params: {
    nodeId: string;
    title: string;
    config: unknown;
  }) => void;
  onPreviewNodePositions: (patches: NodePositionPatch[]) => void;
  onCommitNodePositions: (patches: NodePositionPatch[]) => void;
  onSaveEdge: (params: { edgeId: string; condition: unknown | null }) => void;
  onDeleteNode: (nodeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
}) {
  const [detailNodeId, setDetailNodeId] = useState("");

  const selectedNode = selectedNodeId
    ? graph.nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  const selectedEdge = selectedEdgeId
    ? graph.edges.find((edge) => edge.id === selectedEdgeId)
    : undefined;
  const selectedNodeRun = selectedNode
    ? activeRun?.nodeRuns.find((run) => run.nodeId === selectedNode.id) ?? null
    : null;
  const detailNode = detailNodeId
    ? graph.nodes.find((node) => node.id === detailNodeId)
    : undefined;
  const detailNodeRun = detailNode
    ? activeRun?.nodeRuns.find((run) => run.nodeId === detailNode.id) ?? null
    : null;
  const nodeTypes = useMemo(() => FLOW_NODE_TYPES, []);

  const nextCanvasNodes = useMemo(
    () =>
      graph.nodes.map((node) =>
        toFlowCanvasNode({
          node,
          nodeRun: activeRun?.nodeRuns.find((run) => run.nodeId === node.id),
        }),
      ),
    [activeRun, graph.nodes],
  );
  const nextCanvasEdges = useMemo(
    () =>
      graph.edges.map((edge) =>
        toFlowCanvasEdge({
          edge,
        }),
      ),
    [graph.edges],
  );
  const canvasSyncKey = useMemo(
    () =>
      JSON.stringify({
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          title: node.title,
          type: node.type,
          x: node.position.x,
          y: node.position.y,
          updatedAt: node.updatedAt,
          runStatus:
            activeRun?.nodeRuns.find((run) => run.nodeId === node.id)?.status ??
            null,
        })),
        edges: graph.edges.map((edge) => ({
          id: edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          condition: edge.condition,
          updatedAt: edge.updatedAt,
        })),
      }),
    [activeRun, graph.edges, graph.nodes],
  );
  const handleSelectionChange: OnSelectionChangeFunc<
    FlowCanvasNode,
    FlowCanvasEdge
  > = useCallback(
    ({ nodes, edges }) => {
      if (nodes.length > 0) {
        const nodeIds = nodes.map((node) => node.id);
        if (
          selectedEdgeId === "" &&
          arraysEqual(nodeIds, selectedNodeIds) &&
          selectedNodeId === nodeIds[nodeIds.length - 1]
        ) {
          return;
        }
        onSelectedNodesChange(nodeIds, nodeIds[nodeIds.length - 1]);
        return;
      }
      if (edges[0]) {
        if (selectedEdgeId === edges[0].id) return;
        onSelectedEdgeChange(edges[0].id);
        return;
      }
      if (selectedEdgeId === "" && selectedNodeIds.length === 0) return;
      onSelectedNodesChange([], undefined);
      onSelectedEdgeChange("");
    },
    [
      onSelectedEdgeChange,
      onSelectedNodesChange,
      selectedEdgeId,
      selectedNodeId,
      selectedNodeIds,
    ],
  );

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      onConnectNodePair({
        sourceNodeId: connection.source,
        targetNodeId: connection.target,
      });
    },
    [onConnectNodePair],
  );

  const commitDraggedNodePositions = useCallback(
    (nodes: FlowCanvasNode[]) => {
      const patches = nodes.map((node) => ({
        nodeId: node.id,
        position: {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        },
      }));
      if (patches.length > 0) {
        onPreviewNodePositions(patches);
        onCommitNodePositions(patches);
      }
    },
    [onCommitNodePositions, onPreviewNodePositions],
  );

  const handleNodeDragStop: OnNodeDrag<FlowCanvasNode> = useCallback(
    (_event, node, nodes) => {
      commitDraggedNodePositions(nodes.length > 0 ? nodes : [node]);
    },
    [commitDraggedNodePositions],
  );

  const handleSelectionDragStop: SelectionDragHandler<FlowCanvasNode> =
    useCallback(
      (_event, nodes) => {
        commitDraggedNodePositions(nodes);
      },
      [commitDraggedNodePositions],
    );

  return (
    <div className="grid min-h-0 gap-4 overflow-hidden 2xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-slate-900">
            {graph.flow.title}
          </div>
          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">
            {graph.nodes.length} 个节点 · {graph.edges.length} 条连线
            {selectedNodeIds.length > 1
              ? ` · 已选择 ${selectedNodeIds.length} 个`
              : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={nodeType}
            onChange={(event) =>
              onNodeTypeChange(event.target.value as FlowNodeType)
            }
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            {NODE_TYPES.map((type) => (
              <option key={type} value={type}>
                {nodeTypeLabel(type)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRunFlow}
            disabled={running}
            className="h-9 rounded-md border border-emerald-700 bg-emerald-700 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
          >
            {running ? "运行中" : "运行"}
          </button>
          <button
            type="button"
            onClick={onAddNode}
            className="h-9 rounded-md border border-slate-900 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-900"
          >
            添加节点
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
        <select
          value={edgeSource}
          onChange={(event) => onEdgeSourceChange(event.target.value)}
          className="h-9 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm"
        >
          {graph.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
            </option>
          ))}
        </select>
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">
          到
        </span>
        <select
          value={edgeTarget}
          onChange={(event) => onEdgeTargetChange(event.target.value)}
          className="h-9 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm"
        >
          {graph.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onConnectNodes}
          className="h-9 rounded-md border border-slate-900 bg-slate-900 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white"
        >
          连接
        </button>
        <input
          value={edgeConditionDraft}
          onChange={(event) => onEdgeConditionDraftChange(event.target.value)}
          className="h-9 min-w-60 flex-1 rounded-md border border-slate-300 bg-white px-2 font-mono text-xs outline-none focus:border-slate-900"
          placeholder='{"path":"$.condition","equals":true}'
        />
      </div>

      <div
        data-flow-canvas-viewport
        className="relative h-[min(62vh,720px)] min-h-[420px] overflow-hidden rounded-md border border-slate-300 bg-slate-50"
      >
        <ReactFlowProvider>
          <ReactFlow
            key={canvasSyncKey}
            defaultNodes={nextCanvasNodes}
            defaultEdges={nextCanvasEdges}
            nodeTypes={nodeTypes}
            onSelectionChange={handleSelectionChange}
            onConnect={handleConnect}
            onNodeDoubleClick={(_event, node) => setDetailNodeId(node.id)}
            onEdgeClick={(_event, edge) => onSelectedEdgeChange(edge.id)}
            onNodeDragStop={handleNodeDragStop}
            onSelectionDragStop={handleSelectionDragStop}
            connectionMode={ConnectionMode.Loose}
            fitView
            fitViewOptions={{ padding: 0.22 }}
            minZoom={0.35}
            maxZoom={1.8}
            nodeExtent={FLOW_EXTENT}
            translateExtent={FLOW_EXTENT}
            selectNodesOnDrag={false}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            deleteKeyCode={null}
            multiSelectionKeyCode={["Meta", "Control", "Shift"]}
            defaultEdgeOptions={{
              type: "smoothstep",
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: "#0f172a",
              },
            }}
            className="flow-canvas"
          >
            <Background
              color="#cbd5e1"
              gap={32}
              size={1}
              variant={BackgroundVariant.Lines}
            />
            <Controls position="top-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeBorderRadius={4}
              nodeStrokeWidth={2}
              nodeColor={(node) => (node.selected ? "#d1fae5" : "#ffffff")}
              nodeStrokeColor={(node) =>
                node.selected ? "#047857" : "#0f172a"
              }
              maskColor="rgba(15, 23, 42, 0.08)"
            />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      </div>

      <FlowInspector
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        nodes={graph.nodes}
        selectedNodeCount={selectedNodeIds.length}
        selectedNodeRun={selectedNodeRun}
        activeRun={activeRun}
        runs={runs}
        flow={graph.flow}
        inputDraft={inputDraft}
        running={running}
        savingFlow={savingFlow}
        savingNode={savingNode}
        savingEdge={savingEdge}
        onInputDraftChange={onInputDraftChange}
        onRunFlow={onRunFlow}
        onSelectRun={onSelectRun}
        onSaveFlow={onSaveFlow}
        onArchiveFlow={onArchiveFlow}
        onSaveNode={onSaveNode}
        onSaveEdge={onSaveEdge}
        onDeleteNode={onDeleteNode}
        onDeleteEdge={onDeleteEdge}
        onOpenNodeDetail={(nodeId) => setDetailNodeId(nodeId)}
      />
      {detailNode && (
        <NodeRunDetailDialog
          node={detailNode}
          nodeRun={detailNodeRun}
          activeRun={activeRun}
          onClose={() => setDetailNodeId("")}
        />
      )}
    </div>
  );
}

function FlowNodeCard({ data, selected }: NodeProps<FlowCanvasNode>) {
  const { node, nodeRun } = data;
  return (
    <div
      data-flow-node
      className={[
        "w-48 rounded-md border bg-white px-3 py-3 text-left shadow-sm transition-colors",
        selected
          ? "border-emerald-700 ring-2 ring-emerald-100"
          : "border-slate-900",
      ].join(" ")}
    >
      {node.type !== "start" && (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          className="!h-3 !w-3 !border-slate-900 !bg-white"
        />
      )}
      {node.type !== "end" && (
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          className="!h-4 !w-4 !border-emerald-700 !bg-white hover:!bg-emerald-50"
        />
      )}
      <div
        className={[
          "absolute inset-y-2 left-0 w-1 rounded-r",
          node.type === "agent"
            ? "bg-violet-600"
            : node.type === "prompt"
            ? "bg-emerald-600"
            : node.type === "condition"
              ? "bg-amber-500"
              : node.type === "transform"
                ? "bg-sky-600"
                : "bg-slate-600",
        ].join(" ")}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
          {nodeTypeLabel(node.type)}
        </div>
        {nodeRun && (
          <span
            className={[
              "rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]",
              nodeRun.status === "succeeded"
                ? "bg-emerald-50 text-emerald-700"
                : nodeRun.status === "failed"
                  ? "bg-rose-50 text-rose-700"
                  : "bg-slate-100 text-slate-600",
            ].join(" ")}
          >
            {runStatusLabel(nodeRun.status)}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-slate-900">
        {node.title}
      </div>
    </div>
  );
}

function toFlowCanvasNode({
  node,
  nodeRun,
}: {
  node: FlowNode;
  nodeRun?: FlowNodeRun;
}): FlowCanvasNode {
  return {
    id: node.id,
    type: "flowNode",
    position: node.position,
    data: { node, nodeRun },
    width: NODE_WIDTH,
    draggable: true,
    connectable: true,
    selectable: true,
  };
}

function toFlowCanvasEdge({
  edge,
}: {
  edge: FlowEdge;
}): FlowCanvasEdge {
  const color = "#0f172a";
  return {
    id: edge.id,
    type: "smoothstep",
    source: edge.sourceNodeId,
    sourceHandle: "out",
    target: edge.targetNodeId,
    targetHandle: "in",
    data: { edge },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color,
    },
    style: {
      stroke: color,
      strokeWidth: 2,
      strokeDasharray: edge.condition ? "5 5" : undefined,
    },
  };
}

function FlowInspector({
  selectedNode,
  selectedEdge,
  nodes,
  selectedNodeCount,
  selectedNodeRun,
  activeRun,
  runs,
  flow,
  inputDraft,
  running,
  savingFlow,
  savingNode,
  savingEdge,
  onInputDraftChange,
  onRunFlow,
  onSelectRun,
  onSaveFlow,
  onArchiveFlow,
  onSaveNode,
  onSaveEdge,
  onDeleteNode,
  onDeleteEdge,
  onOpenNodeDetail,
}: {
  selectedNode: FlowNode | undefined;
  selectedEdge: FlowEdge | undefined;
  nodes: FlowNode[];
  selectedNodeCount: number;
  selectedNodeRun: FlowNodeRun | null;
  activeRun: FlowRunWithNodes | null;
  runs: FlowRun[];
  flow: FlowDefinition;
  inputDraft: string;
  running: boolean;
  savingFlow: boolean;
  savingNode: boolean;
  savingEdge: boolean;
  onInputDraftChange: (value: string) => void;
  onRunFlow: () => void;
  onSelectRun: (runId: string) => void;
  onSaveFlow: (params: { title: string; description: string | null }) => void;
  onArchiveFlow: () => void;
  onSaveNode: (params: {
    nodeId: string;
    title: string;
    config: unknown;
  }) => void;
  onSaveEdge: (params: { edgeId: string; condition: unknown | null }) => void;
  onDeleteNode: (nodeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onOpenNodeDetail: (nodeId: string) => void;
}) {
  const selectedEdgeSource = selectedEdge
    ? nodes.find((node) => node.id === selectedEdge.sourceNodeId)
    : undefined;
  const selectedEdgeTarget = selectedEdge
    ? nodes.find((node) => node.id === selectedEdge.targetNodeId)
    : undefined;

  return (
    <aside className="min-h-0 overflow-y-auto border-l border-slate-200 pl-4">
      <div className="space-y-4">
        <FlowDetailsForm
          key={flow.id}
          flow={flow}
          savingFlow={savingFlow}
          onSaveFlow={onSaveFlow}
          onArchiveFlow={onArchiveFlow}
        />

        <section className="rounded-md border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Eyebrow>运行输入</Eyebrow>
            <button
              type="button"
              onClick={onRunFlow}
              disabled={running}
              className="h-8 rounded-md border border-slate-900 bg-slate-900 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
            >
              {running ? "运行中" : "运行"}
            </button>
          </div>
          <textarea
            value={inputDraft}
            onChange={(event) => onInputDraftChange(event.target.value)}
            spellCheck={false}
            className="h-32 w-full resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-slate-900"
          />
        </section>

        <section className="rounded-md border border-slate-200 p-3">
          <Eyebrow>运行记录 · {runs.length}</Eyebrow>
          <div className="mt-2 space-y-2">
            {runs.slice(0, 6).map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={[
                  "w-full rounded-md border px-2 py-2 text-left text-xs transition-colors",
                  activeRun?.run.id === run.id
                    ? "border-slate-900"
                    : "border-slate-200 hover:border-slate-400",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">
                    {runStatusLabel(run.status)}
                  </span>
                  <span className="font-mono text-[10px] text-slate-500">
                    {formatTimestamp(new Date(run.startedAt).toISOString())}
                  </span>
                </div>
                {run.error && (
                  <div className="mt-1 truncate text-rose-700">{run.error}</div>
                )}
              </button>
            ))}
            {runs.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-300 px-3 py-5 text-center text-sm text-slate-500">
                暂无运行记录
              </div>
            )}
          </div>
        </section>

        {selectedEdge && (
          <section className="rounded-md border border-slate-200 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <Eyebrow>连线配置</Eyebrow>
              <button
                type="button"
                onClick={() => onDeleteEdge(selectedEdge.id)}
                className="h-8 rounded-md border border-rose-700 bg-white px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700 hover:bg-rose-50"
              >
                删除
              </button>
            </div>
            <div className="space-y-2 text-sm text-slate-700">
              <div>
                <span className="font-medium text-slate-900">
                  {selectedEdgeSource?.title ?? "未知"}
                </span>{" "}
                到{" "}
                <span className="font-medium text-slate-900">
                  {selectedEdgeTarget?.title ?? "未知"}
                </span>
              </div>
              <EdgeConfigForm
                key={selectedEdge.id}
                edge={selectedEdge}
                savingEdge={savingEdge}
                onSaveEdge={onSaveEdge}
              />
            </div>
          </section>
        )}

        <section className="rounded-md border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>
              节点配置
              {selectedNodeCount > 1 ? ` · 已选择 ${selectedNodeCount} 个` : ""}
            </Eyebrow>
            {selectedNode && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenNodeDetail(selectedNode.id)}
                  className="h-8 rounded-md border border-slate-900 bg-white px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-900 hover:bg-slate-50"
                >
                  详情
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteNode(selectedNode.id)}
                  disabled={
                    selectedNode.type === "start" || selectedNode.type === "end"
                  }
                  className="h-8 rounded-md border border-rose-700 bg-white px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400 disabled:hover:bg-white"
                >
                  删除
                </button>
              </div>
            )}
          </div>
          {selectedNode ? (
            <div className="mt-3 space-y-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                  {nodeTypeLabel(selectedNode.type)}
                </div>
              </div>
              <NodeConfigForm
                key={selectedNode.id}
                node={selectedNode}
                savingNode={savingNode}
                onSaveNode={onSaveNode}
              />
              <JsonBlock label="配置" value={selectedNode.config} />
              <JsonBlock label="最近输入" value={selectedNodeRun?.input ?? null} />
              <JsonBlock
                label="最近输出"
                value={selectedNodeRun?.output ?? null}
              />
              <JsonBlock label="执行轨迹" value={selectedNodeRun?.trace ?? null} />
              <TranscriptLoader
                key={selectedNodeRun?.transcriptThreadId ?? "empty"}
                threadId={selectedNodeRun?.transcriptThreadId ?? null}
              />
              {selectedNodeRun?.error && (
                <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
                  {selectedNodeRun.error}
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3 text-sm text-slate-500">选择一个节点</div>
          )}
        </section>
      </div>
    </aside>
  );
}

function NodeRunDetailDialog({
  node,
  nodeRun,
  activeRun,
  onClose,
}: {
  node: FlowNode;
  nodeRun: FlowNodeRun | null;
  activeRun: FlowRunWithNodes | null;
  onClose: () => void;
}) {
  return (
    <div
      data-flow-node-detail
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 backdrop-blur-[2px] sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${node.title} node detail`}
    >
      <div className="w-full max-w-5xl rounded-md border border-slate-900 bg-white shadow-xl">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
              节点详情 · {nodeTypeLabel(node.type)}
            </div>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
              {node.title}
            </h3>
            <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <span>节点 {node.id.slice(0, 8)}</span>
              <span>运行 {activeRun?.run.id.slice(0, 8) ?? "无"}</span>
              <span>状态 {runStatusLabel(nodeRun?.status ?? null)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-slate-900 bg-white px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-900 hover:bg-slate-50"
          >
            关闭
          </button>
        </div>

        <div className="grid max-h-[calc(100vh-10rem)] min-h-0 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <section className="rounded-md border border-slate-200 p-3">
              <Eyebrow>运行状态</Eyebrow>
              <dl className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    开始
                  </dt>
                  <dd>
                    {nodeRun
                      ? formatTimestamp(new Date(nodeRun.startedAt).toISOString())
                      : "无"}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    结束
                  </dt>
                  <dd>
                    {nodeRun?.finishedAt
                      ? formatTimestamp(new Date(nodeRun.finishedAt).toISOString())
                      : "无"}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    流程运行
                  </dt>
                  <dd className="font-mono text-xs">
                    {runStatusLabel(activeRun?.run.status ?? null)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                    对话记录
                  </dt>
                  <dd className="font-mono text-xs">
                    {nodeRun?.transcriptThreadId?.slice(0, 8) ?? "无"}
                  </dd>
                </div>
              </dl>
              {nodeRun?.error && (
                <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
                  {nodeRun.error}
                </div>
              )}
            </section>
            <JsonBlock
              label="节点配置"
              value={node.config}
              heightClassName="max-h-80"
            />
            <JsonBlock
              label="输入"
              value={nodeRun?.input ?? null}
              heightClassName="max-h-80"
            />
            <JsonBlock
              label="输出"
              value={nodeRun?.output ?? null}
              heightClassName="max-h-80"
            />
          </div>

          <div className="space-y-4">
            <JsonBlock
              label="执行轨迹"
              value={nodeRun?.trace ?? null}
              heightClassName="max-h-96"
            />
            <section className="rounded-md border border-slate-200 p-3">
              <TranscriptLoader
                key={nodeRun?.transcriptThreadId ?? "detail-empty"}
                threadId={nodeRun?.transcriptThreadId ?? null}
              />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function TranscriptLoader({ threadId }: { threadId: string | null }) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    void fetchTranscriptMessages(threadId)
      .then((nextMessages) => {
        if (cancelled) return;
        setMessages(nextMessages);
        setError("");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setMessages([]);
        setError(
          loadError instanceof Error ? loadError.message : "对话记录加载失败",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return <TranscriptBlock messages={messages} error={error} threadId={threadId} />;
}

function TranscriptBlock({
  messages,
  error,
  threadId,
}: {
  messages: UIMessage[];
  error: string;
  threadId: string | null;
}) {
  if (!threadId) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">
        暂无 transcript
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
        对话记录
      </div>
      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
          {error}
        </div>
      ) : (
        <div className="max-h-80 space-y-2 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
          {messages.map((message) => (
            <div
              key={message.id}
              className="rounded-md border border-slate-200 bg-white p-2"
            >
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                {message.role}
              </div>
              <div className="whitespace-pre-wrap text-xs leading-5 text-slate-800">
                {messageToText(message)}
              </div>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="py-4 text-center text-sm text-slate-500">
              transcript 为空
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FlowDetailsForm({
  flow,
  savingFlow,
  onSaveFlow,
  onArchiveFlow,
}: {
  flow: FlowDefinition;
  savingFlow: boolean;
  onSaveFlow: (params: { title: string; description: string | null }) => void;
  onArchiveFlow: () => void;
}) {
  const [titleDraft, setTitleDraft] = useState(flow.title);
  const [descriptionDraft, setDescriptionDraft] = useState(
    flow.description ?? "",
  );

  function handleSaveFlow() {
    onSaveFlow({
      title: titleDraft,
      description: descriptionDraft.trim() || null,
    });
  }

  return (
    <section className="rounded-md border border-slate-200 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Eyebrow>流程详情</Eyebrow>
        <button
          type="button"
          onClick={onArchiveFlow}
          disabled={savingFlow}
          className="h-8 rounded-md border border-rose-700 bg-white px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700 hover:bg-rose-50 disabled:cursor-wait disabled:border-slate-300 disabled:text-slate-400 disabled:hover:bg-white"
        >
          归档
        </button>
      </div>
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            标题
          </span>
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            描述
          </span>
          <textarea
            value={descriptionDraft}
            onChange={(event) => setDescriptionDraft(event.target.value)}
            className="h-20 w-full resize-none rounded-md border border-slate-300 p-2 text-sm leading-5 outline-none focus:border-slate-900"
          />
        </label>
        <button
          type="button"
          onClick={handleSaveFlow}
          disabled={savingFlow}
          className="h-9 w-full rounded-md border border-slate-900 bg-slate-900 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
        >
          {savingFlow ? "保存中" : "保存流程"}
        </button>
      </div>
    </section>
  );
}

function EdgeConfigForm({
  edge,
  savingEdge,
  onSaveEdge,
}: {
  edge: FlowEdge;
  savingEdge: boolean;
  onSaveEdge: (params: { edgeId: string; condition: unknown | null }) => void;
}) {
  const [conditionDraft, setConditionDraft] = useState(
    JSON.stringify(edge.condition, null, 2),
  );
  const [conditionError, setConditionError] = useState("");

  function handleSaveSelectedEdge() {
    setConditionError("");
    try {
      onSaveEdge({
        edgeId: edge.id,
        condition: parseConfigJson(
          conditionDraft.trim() || "null",
          "连线条件",
        ) as unknown | null,
      });
    } catch (error) {
      setConditionError(
        error instanceof Error ? error.message : "连线条件必须是合法 JSON",
      );
    }
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          条件
        </span>
        <textarea
          value={conditionDraft}
          onChange={(event) => setConditionDraft(event.target.value)}
          spellCheck={false}
          className="h-24 w-full resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-slate-900"
        />
      </label>
      {conditionError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
          {conditionError}
        </div>
      )}
      <button
        type="button"
        onClick={handleSaveSelectedEdge}
        disabled={savingEdge}
        className="h-9 w-full rounded-md border border-slate-900 bg-slate-900 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
      >
        {savingEdge ? "保存中" : "保存连线"}
      </button>
    </div>
  );
}

function NodeConfigForm({
  node,
  savingNode,
  onSaveNode,
}: {
  node: FlowNode;
  savingNode: boolean;
  onSaveNode: (params: {
    nodeId: string;
    title: string;
    config: unknown;
  }) => void;
}) {
  const promptConfig = normalizePromptConfigForForm(node.config);
  const flowConfig = normalizeFlowControlConfigForForm(node.config);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const [promptDraft, setPromptDraft] = useState(promptConfig.prompt);
  const [inputMappingDraft, setInputMappingDraft] = useState(
    JSON.stringify(flowConfig.inputMapping, null, 2),
  );
  const [schemaDraft, setSchemaDraft] = useState(
    JSON.stringify(promptConfig.outputSchema, null, 2),
  );
  const [outputPathDraft, setOutputPathDraft] = useState(flowConfig.outputPath);
  const [conditionDraft, setConditionDraft] = useState(
    JSON.stringify(flowConfig.condition, null, 2),
  );
  const [retryDraft, setRetryDraft] = useState(
    String(promptConfig.retry.maxAttempts),
  );
  const [timeoutDraft, setTimeoutDraft] = useState(
    String(promptConfig.timeoutMs),
  );
  const [configDraft, setConfigDraft] = useState(
    JSON.stringify(node.config ?? {}, null, 2),
  );
  const [configError, setConfigError] = useState("");

  function handleSaveSelectedNode() {
    setConfigError("");
    try {
      const config =
        node.type === "agent" || node.type === "prompt"
          ? buildPromptConfig({
              existing: node.config,
              prompt: promptDraft,
              inputMappingText: inputMappingDraft,
              schemaText: schemaDraft,
              retryText: retryDraft,
              timeoutText: timeoutDraft,
            })
          : node.type === "transform"
            ? buildTransformConfig({
                existing: node.config,
                inputMappingText: inputMappingDraft,
                outputPath: outputPathDraft,
              })
            : node.type === "condition"
              ? buildConditionConfig({
                  existing: node.config,
                  inputMappingText: inputMappingDraft,
                  conditionText: conditionDraft,
                })
              : parseConfigJson(configDraft, "配置");
      onSaveNode({
        nodeId: node.id,
        title: titleDraft,
        config,
      });
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : "节点配置不合法");
    }
  }

  return (
    <>
      <label className="block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          标题
        </span>
        <input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
        />
      </label>
      {node.type === "agent" || node.type === "prompt" ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              提示词
            </span>
            <textarea
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              spellCheck={false}
              className="h-28 w-full resize-none rounded-md border border-slate-300 p-2 text-sm leading-5 outline-none focus:border-slate-900"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              输出结构
            </span>
            <textarea
              value={schemaDraft}
              onChange={(event) => setSchemaDraft(event.target.value)}
              spellCheck={false}
              className="h-32 w-full resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-slate-900"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                重试
              </span>
              <input
                value={retryDraft}
                onChange={(event) => setRetryDraft(event.target.value)}
                inputMode="numeric"
                className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                超时 ms
              </span>
              <input
                value={timeoutDraft}
                onChange={(event) => setTimeoutDraft(event.target.value)}
                inputMode="numeric"
                className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
              />
            </label>
          </div>
        </>
      ) : node.type === "transform" ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              输出路径
            </span>
            <input
              value={outputPathDraft}
              onChange={(event) => setOutputPathDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="$"
            />
          </label>
        </>
      ) : node.type === "condition" ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              条件
            </span>
            <textarea
              value={conditionDraft}
              onChange={(event) => setConditionDraft(event.target.value)}
              spellCheck={false}
              className="h-32 w-full resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-slate-900"
            />
          </label>
        </>
      ) : (
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            配置
          </span>
          <textarea
            value={configDraft}
            onChange={(event) => setConfigDraft(event.target.value)}
            spellCheck={false}
            className="h-32 w-full resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-slate-900"
          />
        </label>
      )}
      {configError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
          {configError}
        </div>
      )}
      <button
        type="button"
        onClick={handleSaveSelectedNode}
        disabled={savingNode}
        className="h-9 w-full rounded-md border border-slate-900 bg-slate-900 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
      >
        {savingNode ? "保存中" : "保存节点"}
      </button>
    </>
  );
}

function InputMappingEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
        输入映射
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="h-24 w-full resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-slate-900"
      />
    </label>
  );
}

function JsonBlock({
  label,
  value,
  heightClassName = "max-h-48",
}: {
  label: string;
  value: unknown;
  heightClassName?: string;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <pre
        className={[
          heightClassName,
          "overflow-auto rounded-md bg-slate-950 p-2 text-xs leading-5 text-slate-100",
        ].join(" ")}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function parseJsonDraft(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("运行输入必须是合法 JSON。");
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function messageToText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n")
    .trim();
}

function parseConfigJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} 必须是合法 JSON。`);
  }
}

function normalizePromptConfigForForm(config: unknown): {
  prompt: string;
  outputSchema: unknown;
  retry: { maxAttempts: number };
  timeoutMs: number;
} {
  const maybe = isRecord(config) ? config : {};
  const retry = isRecord(maybe.retry) ? maybe.retry : {};
  return {
    prompt:
      typeof maybe.prompt === "string"
        ? maybe.prompt
        : "Use the input JSON and return the next JSON object.",
    outputSchema:
      isRecord(maybe.outputSchema) && Object.keys(maybe.outputSchema).length > 0
        ? maybe.outputSchema
        : {
            type: "object",
            additionalProperties: true,
          },
    retry: {
      maxAttempts: normalizeInteger(retry.maxAttempts, 3, 1, 5),
    },
    timeoutMs: normalizeInteger(maybe.timeoutMs, 60_000, 1_000, 300_000),
  };
}

function normalizeFlowControlConfigForForm(config: unknown): {
  inputMapping: unknown;
  outputPath: string;
  condition: unknown;
} {
  const maybe = isRecord(config) ? config : {};
  return {
    inputMapping: isRecord(maybe.inputMapping) ? maybe.inputMapping : {},
    outputPath: typeof maybe.outputPath === "string" ? maybe.outputPath : "$",
    condition:
      maybe.condition === undefined
        ? {
            path: "$.ok",
            equals: true,
          }
        : maybe.condition,
  };
}

function buildPromptConfig(params: {
  existing: unknown;
  prompt: string;
  inputMappingText: string;
  schemaText: string;
  retryText: string;
  timeoutText: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  const inputMapping = parseInputMapping(params.inputMappingText);
  const outputSchema = parseConfigJson(
    params.schemaText.trim() || "{}",
    "Output schema",
  );
  if (!isRecord(outputSchema)) {
    throw new Error("Output schema 必须是 JSON object。");
  }
  return {
    ...existing,
    prompt: params.prompt.trim() || "Use the input JSON and return the next JSON object.",
    inputMapping,
    outputSchema,
    retry: {
      maxAttempts: normalizeInteger(Number(params.retryText), 3, 1, 5),
    },
    timeoutMs: normalizeInteger(Number(params.timeoutText), 60_000, 1_000, 300_000),
  };
}

function buildTransformConfig(params: {
  existing: unknown;
  inputMappingText: string;
  outputPath: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    outputPath: params.outputPath.trim() || "$",
  };
}

function buildConditionConfig(params: {
  existing: unknown;
  inputMappingText: string;
  conditionText: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  const condition = parseConfigJson(
    params.conditionText.trim() || "{}",
    "条件",
  );
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    condition,
  };
}

function parseInputMapping(value: string): Record<string, unknown> {
  const parsed = parseConfigJson(value.trim() || "{}", "输入映射");
  if (!isRecord(parsed)) {
    throw new Error("输入映射必须是 JSON object。");
  }
  return parsed;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeTypeLabel(type: FlowNodeType): string {
  switch (type) {
    case "start":
      return "开始";
    case "agent":
      return "智能体";
    case "prompt":
      return "提示词";
    case "transform":
      return "转换";
    case "condition":
      return "判断";
    case "end":
      return "结束";
  }
}

function runStatusLabel(status: FlowRun["status"] | null): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "skipped":
      return "已跳过";
    default:
      return "未运行";
  }
}
