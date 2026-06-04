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
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  archiveFlowOnApi,
  createFlowEdgeOnApi,
  createFlowFromTemplateOnApi,
  createFlowNodeOnApi,
  createFlowOnApi,
  deleteFlowEdgeOnApi,
  deleteFlowNodeOnApi,
  fetchFlowRunDetail,
  fetchFlowRunEvents,
  fetchFlowRuns,
  fetchFlowGraph,
  fetchFlows,
  fetchTranscriptMessages,
  resumeFlowRunOnApi,
  runFlowOnApi,
  updateFlowOnApi,
  updateFlowEdgeOnApi,
  updateFlowNodeOnApi,
  type FlowArtifact,
  type FlowDefinition,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowNodeRun,
  type FlowNodeType,
  type FlowItem,
  type FlowItemStatus,
  type FlowRun,
  type FlowRunEvent,
  type FlowRunWithNodes,
} from "@/app/_lib/flows";
import { formatTimestamp, type WorkspaceOption } from "@/app/_lib/chat-session";

import { Eyebrow } from "./Eyebrow";

const NODE_TYPES: FlowNodeType[] = [
  "agent",
  "prompt",
  "transform",
  "condition",
  "browser.extractList",
  "browser.extractArticle",
  "document.planUpdate",
  "document.applyPatch",
  "core.foreach",
  "core.join",
  "approval.review",
  "end",
];

const CANVAS_WIDTH = 2400;
const CANVAS_HEIGHT = 1600;
const NODE_WIDTH = 192;
const EMPTY_FLOW_INPUT = "{\n}";
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
  runState: FlowNodeVisualState;
};

type FlowNodeVisualState = "idle" | "pending" | "active" | "done" | "failed" | "skipped";

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
  const [inputDraft, setInputDraft] = useState(EMPTY_FLOW_INPUT);
  const [running, setRunning] = useState(false);
  const [savingNode, setSavingNode] = useState(false);
  const [savingEdge, setSavingEdge] = useState(false);
  const [savingFlow, setSavingFlow] = useState(false);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorFullscreen, setEditorFullscreen] = useState(false);
  const [pageTab, setPageTab] = useState<"list" | "detail">("list");

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
        setInputDraft(formatJsonForTextarea(getDefaultRunInput(nextGraph)));
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
          if (!cancelled) {
            setActiveRun(detail);
          }
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

  useEffect(() => {
    if (!activeFlowId || activeRun?.run.status !== "running") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const detail = await fetchFlowRunDetail({
          flowId: activeFlowId,
          runId: activeRun.run.id,
        });
        if (cancelled) return;
        setActiveRun(detail);
        setRuns((current) =>
          current.map((run) => (run.id === detail.run.id ? detail.run : run)),
        );
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "运行详情加载失败",
          );
        }
      }
    };
    const timer = window.setInterval(() => {
      void refresh();
    }, 1_000);
    void refresh();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeFlowId, activeRun?.run.id, activeRun?.run.status]);

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
      setInputDraft(formatJsonForTextarea(getDefaultRunInput(created)));
      setEditorOpen(true);
      setEditorFullscreen(false);
      setPageTab("detail");
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "创建流程失败",
      );
    }
  }

  async function handleCreateJuejinTemplateFlow() {
    if (!selectedWorkspace) return;
    setError("");
    setSavingFlow(true);
    try {
      const created = await createFlowFromTemplateOnApi({
        templateId: "juejin-frontend-document-intake",
        title:
          titleDraft.trim() && titleDraft.trim() !== "新流程"
            ? titleDraft.trim()
            : "掘金前端文档入库",
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
      setInputDraft(formatJsonForTextarea(getDefaultRunInput(created)));
      setEditorOpen(true);
      setEditorFullscreen(false);
      setPageTab("detail");
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "创建模板失败",
      );
    } finally {
      setSavingFlow(false);
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
      setInputDraft(formatJsonForTextarea(detail.run.input));
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

  async function handleResumeFlowRun(decision: "approved" | "rejected") {
    if (!graph || !activeRun) return;
    setError("");
    setRunning(true);
    try {
      const detail = await resumeFlowRunOnApi({
        flowId: graph.flow.id,
        runId: activeRun.run.id,
        decision,
      });
      setActiveRun(detail);
      setRuns((current) => [
        detail.run,
        ...current.filter((run) => run.id !== detail.run.id),
      ]);
    } catch (resumeError) {
      setError(
        resumeError instanceof Error ? resumeError.message : "审批处理失败",
      );
    } finally {
      setRunning(false);
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
        <div className="grid gap-2 sm:grid-cols-[minmax(160px,1fr)_minmax(180px,1fr)_auto_auto]">
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
          <button
            type="button"
            onClick={handleCreateJuejinTemplateFlow}
            disabled={!selectedWorkspace || savingFlow}
            className="h-10 rounded-md border border-emerald-700 bg-white px-4 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-emerald-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-300"
          >
            掘金入库模板
          </button>
        </div>
      </div>

      <div className="flex w-fit rounded-md border border-slate-200 bg-slate-50 p-1">
        <button
          type="button"
          onClick={() => setPageTab("list")}
          className={[
            "h-9 rounded px-4 text-sm font-medium",
            pageTab === "list"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-900",
          ].join(" ")}
        >
          流程列表
        </button>
        <button
          type="button"
          onClick={() => setPageTab("detail")}
          disabled={!graph}
          className={[
            "h-9 rounded px-4 text-sm font-medium",
            pageTab === "detail"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-900",
            !graph ? "cursor-not-allowed opacity-50" : "",
          ].join(" ")}
        >
          查看与修改
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {pageTab === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {flows.map((flow) => (
              <button
                key={flow.id}
                type="button"
                onClick={() => {
                  setActiveFlowId(flow.id);
                  setPageTab("detail");
                }}
                className={[
                  "min-h-32 rounded-md border bg-white p-4 text-left transition-colors",
                  flow.id === activeFlowId
                    ? "border-slate-900 border-l-[3px]"
                    : "border-slate-200 hover:border-slate-400",
                ].join(" ")}
              >
                <div className="truncate text-base font-semibold text-slate-900">
                  {flow.title}
                </div>
                <div className="mt-2 text-sm text-slate-600">
                  {flow.description || "暂无描述"}
                </div>
                <div className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                  {flow.workspaceName || "工作区"} ·{" "}
                  {formatTimestamp(new Date(flow.updatedAt).toISOString())}
                </div>
              </button>
            ))}
            {flows.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
                暂无流程
              </div>
            )}
          </div>
        </div>
      ) : activeFlowId && graph ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-slate-200 bg-white p-4">
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
            onResumeFlowRun={(decision) => void handleResumeFlowRun(decision)}
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
            onOpenFullscreen={() => {
              setEditorFullscreen(true);
              setEditorOpen(true);
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm text-slate-500">
          创建或选择一个流程
        </div>
      )}

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
            onResumeFlowRun={(decision) => void handleResumeFlowRun(decision)}
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
            onOpenFullscreen={() => setEditorFullscreen(true)}
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
  onResumeFlowRun,
  onSaveFlow,
  onArchiveFlow,
  onSaveNode,
  onPreviewNodePositions,
  onCommitNodePositions,
  onSaveEdge,
  onDeleteNode,
  onDeleteEdge,
  onOpenFullscreen,
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
  onResumeFlowRun: (decision: "approved" | "rejected") => void;
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
  onOpenFullscreen?: () => void;
}) {
  const [detailNodeId, setDetailNodeId] = useState("");
  const [inspectorMode, setInspectorMode] = useState<"config" | "detail">(
    "config",
  );

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
  const flowRunning = running || activeRun?.run.status === "running";

  const nextCanvasNodes = useMemo(
    () =>
      graph.nodes.map((node) => {
        const nodeRun = activeRun?.nodeRuns.find((run) => run.nodeId === node.id);
        return toFlowCanvasNode({
          node,
          nodeRun,
          runState: getNodeVisualState(nodeRun, activeRun?.run.status ?? null),
        });
      }),
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
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(320px,45%)] gap-4 overflow-hidden xl:grid-cols-[minmax(0,1fr)_380px] xl:grid-rows-1">
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
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
              disabled={flowRunning}
              className="h-9 rounded-md border border-emerald-700 bg-emerald-700 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
            >
              {flowRunning ? "运行中" : "运行"}
            </button>
            <button
              type="button"
              onClick={onAddNode}
              className="h-9 rounded-md border border-slate-900 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-900"
            >
              添加节点
            </button>
            {onOpenFullscreen && (
              <button
                type="button"
                onClick={onOpenFullscreen}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-700 hover:border-slate-900"
              >
                全屏
              </button>
            )}
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
          className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-slate-300 bg-slate-50"
        >
        <ReactFlowProvider>
          <ReactFlow
            key={canvasSyncKey}
            defaultNodes={nextCanvasNodes}
            defaultEdges={nextCanvasEdges}
            nodeTypes={nodeTypes}
            onSelectionChange={handleSelectionChange}
            onNodeClick={(_event, node) => {
              onSelectedNodesChange([node.id], node.id);
            }}
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
        mode={inspectorMode}
        runs={runs}
        flow={graph.flow}
        inputDraft={inputDraft}
        running={flowRunning}
        savingFlow={savingFlow}
        savingNode={savingNode}
        savingEdge={savingEdge}
        onInputDraftChange={onInputDraftChange}
        onRunFlow={onRunFlow}
        onModeChange={setInspectorMode}
        onSelectRun={onSelectRun}
        onResumeFlowRun={onResumeFlowRun}
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
          flow={graph.flow}
          onClose={() => setDetailNodeId("")}
        />
      )}
    </div>
  );
}

function FlowNodeCard({ data, selected }: NodeProps<FlowCanvasNode>) {
  const { node, nodeRun, runState } = data;
  const active = runState === "active";
  return (
    <div
      data-flow-node
      className={[
        "w-48 rounded-md border bg-white px-3 py-3 text-left shadow-sm transition-colors",
        active ? "border-emerald-700 ring-2 ring-emerald-200" : "",
        selected && !active ? "border-emerald-700 ring-2 ring-emerald-100" : "",
        !selected && !active ? "border-slate-900" : "",
      ].join(" ")}
    >
      {!isStartNodeType(node.type) && (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          className="!h-3 !w-3 !border-slate-900 !bg-white"
        />
      )}
      {!isEndNodeType(node.type) && (
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
          isAgentNodeType(node.type)
            ? "bg-violet-600"
            : isPromptNodeType(node.type)
            ? "bg-emerald-600"
            : isBrowserNodeType(node.type)
              ? "bg-indigo-600"
            : isDocumentNodeType(node.type)
              ? "bg-teal-600"
            : isConditionNodeType(node.type)
              ? "bg-amber-500"
              : isForeachNodeType(node.type)
                ? "bg-fuchsia-600"
                : isJoinNodeType(node.type)
                  ? "bg-cyan-600"
                  : isApprovalNodeType(node.type)
                    ? "bg-amber-600"
              : isTransformNodeType(node.type)
                ? "bg-sky-600"
                : "bg-slate-600",
        ].join(" ")}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
          {nodeTypeLabel(node.type)}
        </div>
        {runState !== "idle" && (
          <span
            className={[
              "rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]",
              runState === "done"
                ? "bg-emerald-50 text-emerald-700"
                : runState === "failed"
                  ? "bg-rose-50 text-rose-700"
                  : runState === "active"
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-100 text-slate-600",
            ].join(" ")}
          >
            {nodeStateLabel(runState, nodeRun?.status ?? null)}
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
  runState,
}: {
  node: FlowNode;
  nodeRun?: FlowNodeRun;
  runState: FlowNodeVisualState;
}): FlowCanvasNode {
  return {
    id: node.id,
    type: "flowNode",
    position: node.position,
    data: { node, nodeRun, runState },
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
  mode,
  runs,
  flow,
  inputDraft,
  running,
  savingFlow,
  savingNode,
  savingEdge,
  onInputDraftChange,
  onRunFlow,
  onModeChange,
  onSelectRun,
  onResumeFlowRun,
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
  mode: "config" | "detail";
  runs: FlowRun[];
  flow: FlowDefinition;
  inputDraft: string;
  running: boolean;
  savingFlow: boolean;
  savingNode: boolean;
  savingEdge: boolean;
  onInputDraftChange: (value: string) => void;
  onRunFlow: () => void;
  onModeChange: (mode: "config" | "detail") => void;
  onSelectRun: (runId: string) => void;
  onResumeFlowRun: (decision: "approved" | "rejected") => void;
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
    <aside
      data-flow-inspector
      className="h-full min-h-0 overflow-y-auto border-t border-slate-200 pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0"
    >
      <div className="space-y-4">
        <FlowDetailsForm
          key={flow.id}
          flow={flow}
          savingFlow={savingFlow}
          onSaveFlow={onSaveFlow}
          onArchiveFlow={onArchiveFlow}
        />

        <div className="grid grid-cols-2 gap-1 rounded-md border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => onModeChange("config")}
            className={[
              "h-8 rounded text-sm font-medium",
              mode === "config" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
            ].join(" ")}
          >
            配置
          </button>
          <button
            type="button"
            onClick={() => onModeChange("detail")}
            className={[
              "h-8 rounded text-sm font-medium",
              mode === "detail" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
            ].join(" ")}
          >
            运行详情
          </button>
        </div>

        <section className="rounded-md border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Eyebrow>运行输入</Eyebrow>
            <button
              type="button"
              onClick={() => {
                onModeChange("detail");
                onRunFlow();
              }}
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
                onClick={() => {
                  onModeChange("detail");
                  onSelectRun(run.id);
                }}
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

        {mode === "detail" && (
          <FlowRunDetailPanel
            activeRun={activeRun}
            nodes={nodes}
            selectedNodeId={selectedNode?.id ?? null}
            flow={flow}
            flowId={flow.id}
            onOpenNodeDetail={onOpenNodeDetail}
            onResumeFlowRun={onResumeFlowRun}
          />
        )}

        {mode === "config" && selectedEdge && (
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

        {mode === "config" && (
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
                    isStartNodeType(selectedNode.type) ||
                    isEndNodeType(selectedNode.type)
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
              <ImageArtifactPreview
                label="最近图片结果"
                value={selectedNodeRun?.output}
                workspaceRoot={flow.workspaceRoot}
              />
              <JsonBlock label="执行轨迹" value={selectedNodeRun?.trace ?? null} />
              <TranscriptLoader
                key={selectedNodeRun?.transcriptThreadId ?? "empty"}
                threadId={selectedNodeRun?.transcriptThreadId ?? null}
                nodeRun={selectedNodeRun}
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
        )}
      </div>
    </aside>
  );
}

function FlowRunDetailPanel({
  activeRun,
  nodes,
  selectedNodeId,
  flow,
  flowId,
  onOpenNodeDetail,
  onResumeFlowRun,
}: {
  activeRun: FlowRunWithNodes | null;
  nodes: FlowNode[];
  selectedNodeId: string | null;
  flow: FlowDefinition;
  flowId: string;
  onOpenNodeDetail: (nodeId: string) => void;
  onResumeFlowRun: (decision: "approved" | "rejected") => void;
}) {
  const [events, setEvents] = useState<FlowRunEvent[]>([]);
  const [eventsError, setEventsError] = useState("");

  useEffect(() => {
    if (!activeRun) {
      return;
    }
    let cancelled = false;
    const loadEvents = async () => {
      try {
        const nextEvents = await fetchFlowRunEvents({
          flowId,
          runId: activeRun.run.id,
        });
        if (cancelled) return;
        setEvents(nextEvents);
        setEventsError("");
      } catch (error) {
        if (cancelled) return;
        setEvents([]);
        setEventsError(
          error instanceof Error ? error.message : "运行事件加载失败",
        );
      }
    };
    void loadEvents();
    if (activeRun.run.status !== "running") {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void loadEvents();
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRun, flowId]);

  if (!activeRun) {
    return (
      <section className="rounded-md border border-dashed border-slate-300 px-3 py-5 text-center text-sm text-slate-500">
        暂无可查看的运行详情
      </section>
    );
  }

  const nodeRunByNodeId = new Map(
    activeRun.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]),
  );
  const orderedNodes = selectedNodeId
    ? [
        ...nodes.filter((node) => node.id === selectedNodeId),
        ...nodes.filter((node) => node.id !== selectedNodeId),
      ]
    : nodes;

  return (
    <section className="rounded-md border border-slate-200 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Eyebrow>执行详情</Eyebrow>
        <span className="rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
          {runStatusLabel(activeRun.run.status)}
        </span>
      </div>
      <div className="space-y-3">
        <JsonBlock
          label="流程输入"
          value={activeRun.run.input}
          heightClassName="max-h-40"
        />
        <JsonBlock
          label="流程输出"
          value={activeRun.run.output ?? null}
          heightClassName="max-h-40"
        />
        <ImageArtifactPreview
          label="流程图片结果"
          value={activeRun.run.output}
          workspaceRoot={flow.workspaceRoot}
        />
        <ApprovalRequestPanel
          value={activeRun.run.output}
          canDecide={activeRun.run.status === "waiting_for_approval"}
          onResumeFlowRun={onResumeFlowRun}
        />
        <FlowArtifactList
          label="流程产物"
          artifacts={activeRun.artifacts}
          workspaceRoot={flow.workspaceRoot}
        />
        <FlowItemList
          label="流程对象"
          items={activeRun.items}
        />
        {activeRun.run.error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
            {activeRun.run.error}
          </div>
        )}
        <FlowRunEventTimeline events={events} error={eventsError} />
        <div className="space-y-3">
          {orderedNodes.map((node) => {
            const nodeRun = nodeRunByNodeId.get(node.id) ?? null;
            const state = getNodeVisualState(nodeRun, activeRun.run.status);
            return (
              <div
                key={node.id}
                className="rounded-md border border-slate-200 bg-white p-3"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">
                      {node.title}
                      {node.id === selectedNodeId ? " · 当前节点" : ""}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                      {nodeTypeLabel(node.type)}
                    </div>
                  </div>
                  <span
                    className={[
                      "shrink-0 rounded px-2 py-1 text-xs font-medium",
                      state === "done"
                        ? "bg-emerald-50 text-emerald-700"
                        : state === "failed"
                          ? "bg-rose-50 text-rose-700"
                          : state === "active"
                            ? "bg-emerald-600 text-white"
                            : "bg-slate-100 text-slate-600",
                    ].join(" ")}
                  >
                    {nodeStateLabel(state, nodeRun?.status ?? null)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenNodeDetail(node.id)}
                  className="mb-3 h-8 rounded-md border border-slate-300 bg-white px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-700 hover:border-slate-900"
                >
                  查看节点所有输出
                </button>
                {nodeRun ? (
                  <div className="space-y-3">
                    <JsonBlock
                      label="节点输入"
                      value={nodeRun.input}
                      heightClassName="max-h-36"
                    />
                    <JsonBlock
                      label="节点输出"
                      value={nodeRun.output ?? null}
                      heightClassName="max-h-36"
                    />
                    <ImageArtifactPreview
                      label="节点图片结果"
                      value={nodeRun.output}
                      workspaceRoot={flow.workspaceRoot}
                    />
                    <FlowArtifactList
                      label="节点产物"
                      artifacts={activeRun.artifacts.filter(
                        (artifact) => artifact.nodeRunId === nodeRun.id,
                      )}
                      workspaceRoot={flow.workspaceRoot}
                    />
                    <FlowItemList
                      label="节点对象"
                      items={activeRun.items.filter(
                        (item) => item.nodeRunId === nodeRun.id,
                      )}
                    />
                    <TranscriptLoader
                      key={nodeRun.transcriptThreadId ?? nodeRun.id}
                      threadId={nodeRun.transcriptThreadId}
                      nodeRun={nodeRun}
                    />
                    {nodeRun.error && (
                      <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
                        {nodeRun.error}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">
                    {state === "pending" ? "等待上游节点完成" : "本次运行未执行"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FlowRunEventTimeline({
  events,
  error,
}: {
  events: FlowRunEvent[];
  error: string;
}) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Eyebrow>运行事件</Eyebrow>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          {events.length} 条
        </span>
      </div>
      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
          {error}
        </div>
      ) : (
        <div className="max-h-72 space-y-2 overflow-auto">
          {events.map((event) => (
            <div
              key={event.id}
              className="rounded-md border border-slate-200 bg-slate-50 p-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-slate-700">
                    #{event.sequence} · {flowEventLabel(event.type)}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {formatTimestamp(new Date(event.createdAt).toISOString())}
                  </div>
                </div>
                {event.nodeRunId && (
                  <span className="shrink-0 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                    {event.nodeRunId.slice(0, 8)}
                  </span>
                )}
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                  查看事件内容
                </summary>
                <div className="mt-2">
                  <JsonBlock
                    label="事件内容"
                    value={event.payload}
                    heightClassName="max-h-32"
                  />
                </div>
              </details>
            </div>
          ))}
          {events.length === 0 && (
            <div className="rounded-md border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-500">
              暂无运行事件
            </div>
          )}
        </div>
      )}
    </section>
  );
}

type ImageArtifact = {
  path: string | null;
  absolutePath: string | null;
  mediaType: string | null;
  bytesWritten: number | null;
  prompt: string | null;
};

function ImageArtifactPreview({
  label,
  value,
  workspaceRoot,
}: {
  label: string;
  value: unknown;
  workspaceRoot: string;
}) {
  const artifact = findImageArtifact(value);
  if (!artifact) return null;

  const artifactPath = artifact.path ?? artifact.absolutePath;
  if (!artifactPath) return null;

  const src = `/api/workspaces/artifact?workspaceRoot=${encodeURIComponent(
    workspaceRoot,
  )}&path=${encodeURIComponent(artifactPath)}`;

  return (
    <section className="rounded-md border border-emerald-100 bg-emerald-50/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <span className="rounded bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-700">
          可预览
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-md border border-emerald-100 bg-white">
          <Image
            src={src}
            alt={artifact.path ?? "Flow generated image"}
            width={512}
            height={512}
            unoptimized
            className="aspect-square h-full w-full object-cover"
          />
        </div>
        <dl className="grid content-start gap-1 text-xs text-slate-700">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            路径
          </dt>
          <dd className="break-all font-mono text-slate-900">
            {artifact.path ?? artifact.absolutePath}
          </dd>
          {artifact.mediaType && (
            <>
              <dt className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                类型
              </dt>
              <dd className="font-mono">{artifact.mediaType}</dd>
            </>
          )}
          {artifact.bytesWritten !== null && (
            <>
              <dt className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                大小
              </dt>
              <dd className="font-mono">
                {formatArtifactBytes(artifact.bytesWritten)}
              </dd>
            </>
          )}
        </dl>
      </div>
    </section>
  );
}

function FlowArtifactList({
  label,
  artifacts,
  workspaceRoot,
}: {
  label: string;
  artifacts: FlowArtifact[];
  workspaceRoot: string;
}) {
  if (artifacts.length === 0) return null;

  return (
    <section className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          {artifacts.length} 个
        </span>
      </div>
      <div className="space-y-2">
        {artifacts.map((artifact) => (
          <FlowArtifactRow
            key={artifact.id}
            artifact={artifact}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </section>
  );
}

function ApprovalRequestPanel({
  value,
  canDecide,
  onResumeFlowRun,
}: {
  value: unknown;
  canDecide: boolean;
  onResumeFlowRun: (decision: "approved" | "rejected") => void;
}) {
  const request = extractApprovalRequest(value);
  if (!request) return null;
  const title =
    typeof request.title === "string" && request.title.trim()
      ? request.title
      : "等待人工审批";
  const summary =
    typeof request.summary === "string" && request.summary.trim()
      ? request.summary
      : "请检查该节点产出的对象，确认后再继续后续动作。";

  return (
    <section className="rounded-md border border-amber-200 bg-amber-50 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Eyebrow>审批请求</Eyebrow>
        <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
          等待审批
        </span>
      </div>
      <div className="space-y-2">
        <div>
          <div className="text-sm font-semibold text-amber-950">{title}</div>
          <p className="mt-1 text-sm leading-5 text-amber-900">{summary}</p>
        </div>
        <JsonBlock
          label="审批对象"
          value={request.input ?? request}
          heightClassName="max-h-48"
        />
        {canDecide && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onResumeFlowRun("approved")}
              className="h-9 rounded-md border border-emerald-700 bg-emerald-700 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white"
            >
              批准继续
            </button>
            <button
              type="button"
              onClick={() => onResumeFlowRun("rejected")}
              className="h-9 rounded-md border border-rose-700 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-rose-700 hover:bg-rose-50"
            >
              拒绝结束
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function FlowItemList({
  label,
  items,
}: {
  label: string;
  items: FlowItem[];
}) {
  if (items.length === 0) return null;
  const counts = countItemsByStatus(items);

  return (
    <section className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          {items.length} 个
        </span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Object.entries(counts).map(([status, count]) => (
          <span
            key={status}
            className={[
              "rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em]",
              itemStatusClassName(status as FlowItemStatus),
            ].join(" ")}
          >
            {itemStatusLabel(status as FlowItemStatus)} · {count}
          </span>
        ))}
      </div>
      <div className="max-h-72 space-y-2 overflow-auto">
        {items.map((item) => (
          <FlowItemRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function extractApprovalRequest(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.approvalRequest)) return value.approvalRequest;
  if (value.status === "waiting_for_approval") return value;
  return null;
}

function FlowItemRow({ item }: { item: FlowItem }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">
            {item.title}
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            {item.externalId ?? item.id}
          </div>
        </div>
        <span
          className={[
            "shrink-0 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em]",
            itemStatusClassName(item.status),
          ].join(" ")}
        >
          {itemStatusLabel(item.status)}
        </span>
      </div>
      {item.error && (
        <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {item.error}
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          查看对象数据
        </summary>
        <div className="mt-2 grid gap-2">
          <JsonBlock label="输入" value={item.input} heightClassName="max-h-32" />
          <JsonBlock
            label="输出"
            value={item.output ?? null}
            heightClassName="max-h-32"
          />
          <JsonBlock
            label="元数据"
            value={item.metadata}
            heightClassName="max-h-32"
          />
        </div>
      </details>
    </div>
  );
}

function FlowArtifactRow({
  artifact,
  workspaceRoot,
}: {
  artifact: FlowArtifact;
  workspaceRoot: string;
}) {
  const isPreviewableImage =
    artifact.kind === "image" &&
    typeof artifact.mediaType === "string" &&
    artifact.mediaType.startsWith("image/") &&
    Boolean(artifact.path);
  const src =
    isPreviewableImage && artifact.path
      ? `/api/workspaces/artifact?workspaceRoot=${encodeURIComponent(
          workspaceRoot,
        )}&path=${encodeURIComponent(artifact.path)}`
      : null;

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">
            {artifact.title}
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            {artifact.kind}
            {artifact.mediaType ? ` · ${artifact.mediaType}` : ""}
          </div>
        </div>
        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
          {formatTimestamp(new Date(artifact.createdAt).toISOString())}
        </span>
      </div>
      {artifact.path && (
        <div className="mt-2 break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-700">
          {artifact.path}
        </div>
      )}
      {src && (
        <div className="mt-2 max-w-40 overflow-hidden rounded border border-slate-200 bg-white">
          <Image
            src={src}
            alt={artifact.title}
            width={320}
            height={320}
            unoptimized
            className="aspect-square h-full w-full object-cover"
          />
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
          查看元数据
        </summary>
        <div className="mt-2">
          <JsonBlock
            label="产物元数据"
            value={artifact.metadata}
            heightClassName="max-h-32"
          />
        </div>
      </details>
    </div>
  );
}

function NodeRunDetailDialog({
  node,
  nodeRun,
  activeRun,
  flow,
  onClose,
}: {
  node: FlowNode;
  nodeRun: FlowNodeRun | null;
  activeRun: FlowRunWithNodes | null;
  flow: FlowDefinition;
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
      <div className="w-full max-w-[90vw] rounded-md border border-slate-900 bg-white shadow-xl">
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
            <ImageArtifactPreview
              label="图片结果"
              value={nodeRun?.output}
              workspaceRoot={flow.workspaceRoot}
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
                nodeRun={nodeRun}
              />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function TranscriptLoader({
  threadId,
  nodeRun,
}: {
  threadId: string | null;
  nodeRun?: FlowNodeRun | null;
}) {
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

  return (
    <TranscriptBlock
      messages={messages}
      error={error}
      threadId={threadId}
      nodeRun={nodeRun}
    />
  );
}

function TranscriptBlock({
  messages,
  error,
  threadId,
  nodeRun,
}: {
  messages: UIMessage[];
  error: string;
  threadId: string | null;
  nodeRun?: FlowNodeRun | null;
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
      {nodeRun && (
        <div className="mb-2 space-y-2 rounded-md border border-sky-100 bg-sky-50 p-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-sky-700">
            Flow 自动触发
          </div>
          <div className="text-xs leading-5 text-slate-700">
            这条 user message 不是用户手动输入，而是 Flow runtime 在执行节点时自动生成；
            它把节点配置、节点 instruction 和节点输入一起传给 Chat agent。
          </div>
          <JsonBlock
            label="自动触发输入"
            value={nodeRun.input}
            heightClassName="max-h-40"
          />
          <JsonBlock
            label="节点最终响应"
            value={nodeRun.output ?? null}
            heightClassName="max-h-40"
          />
        </div>
      )}
      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
          {error}
        </div>
      ) : (
        <div className="max-h-96 space-y-3 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
          {messages.map((message) => (
            <div
              key={message.id}
              className={[
                "rounded-md border p-2.5",
                message.role === "assistant"
                  ? "border-emerald-100 bg-emerald-50/50"
                  : "border-slate-200 bg-white",
              ].join(" ")}
            >
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                {messageRoleLabel(message.role)}
              </div>
              <div className="space-y-2">
                {message.parts.map((part, index) => (
                  <MessagePartBlock
                    key={`${message.id}-${index}`}
                    part={part}
                  />
                ))}
                {message.parts.length === 0 && (
                  <div className="text-xs leading-5 text-slate-500">
                    无可展示内容
                  </div>
                )}
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

function MessagePartBlock({ part }: { part: UIMessage["parts"][number] }) {
  if (part.type === "reasoning") {
    return null;
  }
  if (part.type === "text") {
    return (
      <div className="whitespace-pre-wrap text-xs leading-5 text-slate-800">
        {(part as { text: string }).text || "无可展示内容"}
      </div>
    );
  }

  const maybe = part as Record<string, unknown>;
  if (typeof maybe.type === "string" && maybe.type.startsWith("tool-")) {
    const toolName = maybe.type.replace(/^tool-/, "");
    return (
      <div className="rounded-md border border-slate-200 bg-white p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            工具 · {toolName}
          </div>
          <span
            className={[
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
              maybe.errorText
                ? "bg-rose-50 text-rose-700"
                : maybe.state === "output-available"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-slate-100 text-slate-600",
            ].join(" ")}
          >
            {toolStateLabel(maybe.state)}
          </span>
        </div>
        <div className="space-y-2">
          <JsonBlock
            label="工具输入"
            value={maybe.input ?? null}
            heightClassName="max-h-32"
          />
          <JsonBlock
            label={maybe.errorText ? "工具错误" : "工具输出"}
            value={maybe.errorText ?? maybe.output ?? null}
            heightClassName="max-h-40"
          />
        </div>
      </div>
    );
  }

  return (
    <JsonBlock label="消息片段" value={maybe} heightClassName="max-h-40" />
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
  const [inputPathDraft, setInputPathDraft] = useState(flowConfig.inputPath);
  const [itemTitlePathDraft, setItemTitlePathDraft] = useState(
    flowConfig.itemTitlePath,
  );
  const [itemExternalIdPathDraft, setItemExternalIdPathDraft] = useState(
    flowConfig.itemExternalIdPath,
  );
  const [itemStatusPathDraft, setItemStatusPathDraft] = useState(
    flowConfig.itemStatusPath,
  );
  const [itemMetadataPathDraft, setItemMetadataPathDraft] = useState(
    flowConfig.itemMetadataPath,
  );
  const [limitDraft, setLimitDraft] = useState(String(flowConfig.limit));
  const [outputKeyDraft, setOutputKeyDraft] = useState(flowConfig.outputKey);
  const [urlDraft, setUrlDraft] = useState(flowConfig.url);
  const [urlPathDraft, setUrlPathDraft] = useState(flowConfig.urlPath);
  const [itemSelectorDraft, setItemSelectorDraft] = useState(
    flowConfig.itemSelector,
  );
  const [titleSelectorDraft, setTitleSelectorDraft] = useState(
    flowConfig.titleSelector,
  );
  const [hrefSelectorDraft, setHrefSelectorDraft] = useState(
    flowConfig.hrefSelector,
  );
  const [summarySelectorDraft, setSummarySelectorDraft] = useState(
    flowConfig.summarySelector,
  );
  const [contentSelectorDraft, setContentSelectorDraft] = useState(
    flowConfig.contentSelector,
  );
  const [hrefIncludesDraft, setHrefIncludesDraft] = useState(
    flowConfig.hrefIncludes,
  );
  const [baseUrlDraft, setBaseUrlDraft] = useState(flowConfig.baseUrl);
  const [targetRootDraft, setTargetRootDraft] = useState(flowConfig.targetRoot);
  const [outputDirDraft, setOutputDirDraft] = useState(flowConfig.outputDir);
  const [sourceTypeDraft, setSourceTypeDraft] = useState(flowConfig.sourceType);
  const [publisherDraft, setPublisherDraft] = useState(flowConfig.publisher);
  const [topicDraft, setTopicDraft] = useState(flowConfig.topic);
  const [tagsDraft, setTagsDraft] = useState(
    JSON.stringify(flowConfig.tags, null, 2),
  );
  const [conflictPolicyDraft, setConflictPolicyDraft] = useState(
    flowConfig.conflictPolicy,
  );
  const [approvalTitlePathDraft, setApprovalTitlePathDraft] = useState(
    flowConfig.titlePath,
  );
  const [approvalSummaryPathDraft, setApprovalSummaryPathDraft] = useState(
    flowConfig.summaryPath,
  );
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
      let config: unknown;
      if (isAgentLikeNodeType(node.type)) {
        config = buildPromptConfig({
          existing: node.config,
          prompt: promptDraft,
          inputMappingText: inputMappingDraft,
          schemaText: schemaDraft,
          retryText: retryDraft,
          timeoutText: timeoutDraft,
        });
      } else if (isTransformNodeType(node.type)) {
        config = buildTransformConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          outputPath: outputPathDraft,
        });
      } else if (isConditionNodeType(node.type)) {
        config = buildConditionConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          conditionText: conditionDraft,
        });
      } else if (isBrowserExtractListNodeType(node.type)) {
        config = buildBrowserExtractListConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          url: urlDraft,
          urlPath: urlPathDraft,
          itemSelector: itemSelectorDraft,
          titleSelector: titleSelectorDraft,
          hrefSelector: hrefSelectorDraft,
          summarySelector: summarySelectorDraft,
          hrefIncludes: hrefIncludesDraft,
          baseUrl: baseUrlDraft,
          limitText: limitDraft,
          timeoutText: timeoutDraft,
        });
      } else if (isBrowserExtractArticleNodeType(node.type)) {
        config = buildBrowserExtractArticleConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          inputPath: inputPathDraft,
          urlPath: urlPathDraft,
          titleSelector: titleSelectorDraft,
          contentSelector: contentSelectorDraft,
          summarySelector: summarySelectorDraft,
          limitText: limitDraft,
          timeoutText: timeoutDraft,
        });
      } else if (isDocumentPlanUpdateNodeType(node.type)) {
        config = buildDocumentPlanUpdateConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          inputPath: inputPathDraft,
          targetRoot: targetRootDraft,
          outputDir: outputDirDraft,
          sourceType: sourceTypeDraft,
          publisher: publisherDraft,
          topic: topicDraft,
          tagsText: tagsDraft,
          limitText: limitDraft,
        });
      } else if (isDocumentApplyPatchNodeType(node.type)) {
        config = buildDocumentApplyPatchConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          inputPath: inputPathDraft,
          targetRoot: targetRootDraft,
          conflictPolicy: conflictPolicyDraft,
        });
      } else if (isForeachNodeType(node.type)) {
        config = buildForeachConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          inputPath: inputPathDraft,
          itemTitlePath: itemTitlePathDraft,
          itemExternalIdPath: itemExternalIdPathDraft,
          itemStatusPath: itemStatusPathDraft,
          itemMetadataPath: itemMetadataPathDraft,
          limitText: limitDraft,
        });
      } else if (isJoinNodeType(node.type)) {
        config = buildJoinConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          inputPath: inputPathDraft,
          outputKey: outputKeyDraft,
        });
      } else if (isApprovalNodeType(node.type)) {
        config = buildApprovalConfig({
          existing: node.config,
          inputMappingText: inputMappingDraft,
          inputPath: inputPathDraft,
          titlePath: approvalTitlePathDraft,
          summaryPath: approvalSummaryPathDraft,
        });
      } else {
        config = parseConfigJson(configDraft, "配置");
      }
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
      {isAgentLikeNodeType(node.type) ? (
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
      ) : isTransformNodeType(node.type) ? (
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
      ) : isConditionNodeType(node.type) ? (
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
      ) : isBrowserExtractListNodeType(node.type) ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              URL
            </span>
            <input
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="https://juejin.cn/frontend"
            />
          </label>
          <PathInput
            label="URL 输入路径"
            value={urlPathDraft}
            onChange={setUrlPathDraft}
            placeholder="$.url"
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              条目选择器
            </span>
            <input
              value={itemSelectorDraft}
              onChange={(event) => setItemSelectorDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder={'a[href*="/post/"]'}
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              标题选择器
            </span>
            <input
              value={titleSelectorDraft}
              onChange={(event) => setTitleSelectorDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="留空使用条目文本"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              链接选择器
            </span>
            <input
              value={hrefSelectorDraft}
              onChange={(event) => setHrefSelectorDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="留空使用条目 href"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              摘要选择器
            </span>
            <input
              value={summarySelectorDraft}
              onChange={(event) => setSummarySelectorDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="可选"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                链接过滤
              </span>
              <input
                value={hrefIncludesDraft}
                onChange={(event) => setHrefIncludesDraft(event.target.value)}
                className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
                placeholder="/post/"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                Base URL
              </span>
              <input
                value={baseUrlDraft}
                onChange={(event) => setBaseUrlDraft(event.target.value)}
                className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
                placeholder="https://juejin.cn"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                最大数量
              </span>
              <input
                value={limitDraft}
                onChange={(event) => setLimitDraft(event.target.value)}
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
      ) : isBrowserExtractArticleNodeType(node.type) ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <PathInput
            label="文章数组路径"
            value={inputPathDraft}
            onChange={setInputPathDraft}
            placeholder="$.items"
          />
          <PathInput
            label="URL 路径"
            value={urlPathDraft}
            onChange={setUrlPathDraft}
            placeholder="$.url"
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              标题选择器
            </span>
            <input
              value={titleSelectorDraft}
              onChange={(event) => setTitleSelectorDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="h1"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              正文选择器
            </span>
            <input
              value={contentSelectorDraft}
              onChange={(event) => setContentSelectorDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="article, .article-content, .markdown-body, main"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              摘要选择器
            </span>
            <input
              value={summarySelectorDraft}
              onChange={(event) => setSummarySelectorDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="可选"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                最大数量
              </span>
              <input
                value={limitDraft}
                onChange={(event) => setLimitDraft(event.target.value)}
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
      ) : isDocumentPlanUpdateNodeType(node.type) ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <PathInput
            label="来源数组路径"
            value={inputPathDraft}
            onChange={setInputPathDraft}
            placeholder="$.items"
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              目标仓库
            </span>
            <input
              value={targetRootDraft}
              onChange={(event) => setTargetRootDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="/Users/apple/Desktop/project/document"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              输出目录
            </span>
            <input
              value={outputDirDraft}
              onChange={(event) => setOutputDirDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="wiki/sources"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                来源类型
              </span>
              <input
                value={sourceTypeDraft}
                onChange={(event) => setSourceTypeDraft(event.target.value)}
                className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
                placeholder="article"
              />
            </label>
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
                发布平台
              </span>
              <input
                value={publisherDraft}
                onChange={(event) => setPublisherDraft(event.target.value)}
                className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
                placeholder="juejin"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              主题
            </span>
            <input
              value={topicDraft}
              onChange={(event) => setTopicDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
              placeholder="AI 前端"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              标签 JSON
            </span>
            <textarea
              value={tagsDraft}
              onChange={(event) => setTagsDraft(event.target.value)}
              spellCheck={false}
              className="h-24 w-full resize-none rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-slate-900"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              最大数量
            </span>
            <input
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
              inputMode="numeric"
              className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
            />
          </label>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs leading-5 text-slate-700">
            此节点只生成写入计划和 patch 预览，不直接修改文件。
          </div>
        </>
      ) : isDocumentApplyPatchNodeType(node.type) ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <PathInput
            label="计划路径"
            value={inputPathDraft}
            onChange={setInputPathDraft}
            placeholder="$.plannedChanges"
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              目标仓库
            </span>
            <input
              value={targetRootDraft}
              onChange={(event) => setTargetRootDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="/Users/apple/Desktop/project/document"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              冲突策略
            </span>
            <select
              value={conflictPolicyDraft}
              onChange={(event) => setConflictPolicyDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-slate-900"
            >
              <option value="skip">跳过已存在文件</option>
              <option value="overwrite">覆盖已存在文件</option>
            </select>
          </label>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs leading-5 text-amber-900">
            此节点会写入文件。建议只放在 approval.review 之后，并保留 targetRoot 边界校验。
          </div>
        </>
      ) : isForeachNodeType(node.type) ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <PathInput
            label="数组路径"
            value={inputPathDraft}
            onChange={setInputPathDraft}
            placeholder="$.items"
          />
          <PathInput
            label="标题路径"
            value={itemTitlePathDraft}
            onChange={setItemTitlePathDraft}
            placeholder="$.title"
          />
          <PathInput
            label="外部 ID 路径"
            value={itemExternalIdPathDraft}
            onChange={setItemExternalIdPathDraft}
            placeholder="$.id"
          />
          <PathInput
            label="状态路径"
            value={itemStatusPathDraft}
            onChange={setItemStatusPathDraft}
            placeholder="$.status"
          />
          <PathInput
            label="元数据路径"
            value={itemMetadataPathDraft}
            onChange={setItemMetadataPathDraft}
            placeholder="$"
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              最大数量
            </span>
            <input
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
              inputMode="numeric"
              className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
            />
          </label>
        </>
      ) : isJoinNodeType(node.type) ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <PathInput
            label="聚合路径"
            value={inputPathDraft}
            onChange={setInputPathDraft}
            placeholder="$"
          />
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              输出键
            </span>
            <input
              value={outputKeyDraft}
              onChange={(event) => setOutputKeyDraft(event.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
              placeholder="items"
            />
          </label>
        </>
      ) : isApprovalNodeType(node.type) ? (
        <>
          <InputMappingEditor
            value={inputMappingDraft}
            onChange={setInputMappingDraft}
          />
          <PathInput
            label="审批对象路径"
            value={inputPathDraft}
            onChange={setInputPathDraft}
            placeholder="$"
          />
          <PathInput
            label="标题路径"
            value={approvalTitlePathDraft}
            onChange={setApprovalTitlePathDraft}
            placeholder="$.title"
          />
          <PathInput
            label="摘要路径"
            value={approvalSummaryPathDraft}
            onChange={setApprovalSummaryPathDraft}
            placeholder="$.summary"
          />
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs leading-5 text-amber-900">
            执行到这里会暂停整个 Flow，等待人工确认后再继续后续写入或应用动作。
          </div>
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

function PathInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-slate-300 px-2 font-mono text-xs outline-none focus:border-slate-900"
        placeholder={placeholder}
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

function findImageArtifact(value: unknown): ImageArtifact | null {
  return findImageArtifactInner(value, new Set());
}

function findImageArtifactInner(
  value: unknown,
  seen: Set<unknown>,
): ImageArtifact | null {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const artifact = findImageArtifactInner(item, seen);
      if (artifact) return artifact;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const mediaType = typeof record.mediaType === "string" ? record.mediaType : null;
  const pathValue = typeof record.path === "string" ? record.path : null;
  const absolutePath =
    typeof record.absolutePath === "string" ? record.absolutePath : null;

  if (
    mediaType?.startsWith("image/") &&
    (pathValue !== null || absolutePath !== null)
  ) {
    return {
      path: pathValue,
      absolutePath,
      mediaType,
      bytesWritten:
        typeof record.bytesWritten === "number" ? record.bytesWritten : null,
      prompt: typeof record.prompt === "string" ? record.prompt : null,
    };
  }

  for (const key of ["image", "data", "output", "result"]) {
    const artifact = findImageArtifactInner(record[key], seen);
    if (artifact) return artifact;
  }

  for (const child of Object.values(record)) {
    const artifact = findImageArtifactInner(child, seen);
    if (artifact) return artifact;
  }

  return null;
}

function formatArtifactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseJsonDraft(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("运行输入必须是合法 JSON。");
  }
}

function formatJsonForTextarea(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function getDefaultRunInput(graph: FlowGraph): unknown {
  const startNode = graph.nodes.find((node) => isStartNodeType(node.type));
  const config = isRecord(startNode?.config) ? startNode.config : {};
  return config.input ?? {};
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  inputPath: string;
  outputPath: string;
  condition: unknown;
  itemTitlePath: string;
  itemExternalIdPath: string;
  itemStatusPath: string;
  itemMetadataPath: string;
  limit: number;
  outputKey: string;
  url: string;
  urlPath: string;
  itemSelector: string;
  titleSelector: string;
  hrefSelector: string;
  summarySelector: string;
  contentSelector: string;
  hrefIncludes: string;
  baseUrl: string;
  targetRoot: string;
  outputDir: string;
  sourceType: string;
  publisher: string;
  topic: string;
  tags: string[];
  conflictPolicy: string;
  titlePath: string;
  summaryPath: string;
  approvalMode: string;
} {
  const maybe = isRecord(config) ? config : {};
  return {
    inputMapping: isRecord(maybe.inputMapping) ? maybe.inputMapping : {},
    inputPath: typeof maybe.inputPath === "string" ? maybe.inputPath : "$",
    outputPath: typeof maybe.outputPath === "string" ? maybe.outputPath : "$",
    condition:
      maybe.condition === undefined
        ? {
            path: "$.ok",
            equals: true,
          }
        : maybe.condition,
    itemTitlePath:
      typeof maybe.itemTitlePath === "string" ? maybe.itemTitlePath : "$.title",
    itemExternalIdPath:
      typeof maybe.itemExternalIdPath === "string"
        ? maybe.itemExternalIdPath
        : "$.id",
    itemStatusPath:
      typeof maybe.itemStatusPath === "string" ? maybe.itemStatusPath : "$.status",
    itemMetadataPath:
      typeof maybe.itemMetadataPath === "string" ? maybe.itemMetadataPath : "$",
    limit: normalizeInteger(maybe.limit, 50, 1, 500),
    outputKey: typeof maybe.outputKey === "string" ? maybe.outputKey : "items",
    url:
      typeof maybe.url === "string" ? maybe.url : "https://juejin.cn/frontend",
    urlPath: typeof maybe.urlPath === "string" ? maybe.urlPath : "",
    itemSelector:
      typeof maybe.itemSelector === "string"
        ? maybe.itemSelector
        : 'a[href*="/post/"]',
    titleSelector:
      typeof maybe.titleSelector === "string" ? maybe.titleSelector : "",
    hrefSelector:
      typeof maybe.hrefSelector === "string" ? maybe.hrefSelector : "",
    summarySelector:
      typeof maybe.summarySelector === "string" ? maybe.summarySelector : "",
    contentSelector:
      typeof maybe.contentSelector === "string"
        ? maybe.contentSelector
        : "article, .article-content, .markdown-body, main",
    hrefIncludes:
      typeof maybe.hrefIncludes === "string" ? maybe.hrefIncludes : "/post/",
    baseUrl:
      typeof maybe.baseUrl === "string" ? maybe.baseUrl : "https://juejin.cn",
    targetRoot:
      typeof maybe.targetRoot === "string"
        ? maybe.targetRoot
        : "/Users/apple/Desktop/project/document",
    outputDir: typeof maybe.outputDir === "string" ? maybe.outputDir : "wiki/sources",
    sourceType: typeof maybe.sourceType === "string" ? maybe.sourceType : "article",
    publisher: typeof maybe.publisher === "string" ? maybe.publisher : "juejin",
    topic: typeof maybe.topic === "string" ? maybe.topic : "",
    tags: Array.isArray(maybe.tags)
      ? maybe.tags.flatMap((tag) =>
          typeof tag === "string" && tag.trim() ? [tag.trim()] : [],
        )
      : ["source/article", "source/juejin"],
    conflictPolicy:
      typeof maybe.conflictPolicy === "string" ? maybe.conflictPolicy : "skip",
    titlePath: typeof maybe.titlePath === "string" ? maybe.titlePath : "$.title",
    summaryPath:
      typeof maybe.summaryPath === "string" ? maybe.summaryPath : "$.summary",
    approvalMode:
      typeof maybe.approvalMode === "string" ? maybe.approvalMode : "manual",
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

function buildForeachConfig(params: {
  existing: unknown;
  inputMappingText: string;
  inputPath: string;
  itemTitlePath: string;
  itemExternalIdPath: string;
  itemStatusPath: string;
  itemMetadataPath: string;
  limitText: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    inputPath: params.inputPath.trim() || "$.items",
    itemTitlePath: params.itemTitlePath.trim() || "$.title",
    itemExternalIdPath: params.itemExternalIdPath.trim() || "$.id",
    itemStatusPath: params.itemStatusPath.trim() || "$.status",
    itemMetadataPath: params.itemMetadataPath.trim() || "$",
    limit: normalizeInteger(Number(params.limitText), 50, 1, 500),
  };
}

function buildJoinConfig(params: {
  existing: unknown;
  inputMappingText: string;
  inputPath: string;
  outputKey: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    inputPath: params.inputPath.trim() || "$",
    outputKey: params.outputKey.trim() || "items",
  };
}

function buildApprovalConfig(params: {
  existing: unknown;
  inputMappingText: string;
  inputPath: string;
  titlePath: string;
  summaryPath: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    inputPath: params.inputPath.trim() || "$",
    titlePath: params.titlePath.trim() || "$.title",
    summaryPath: params.summaryPath.trim() || "$.summary",
    approvalMode: "manual",
  };
}

function buildBrowserExtractListConfig(params: {
  existing: unknown;
  inputMappingText: string;
  url: string;
  urlPath: string;
  itemSelector: string;
  titleSelector: string;
  hrefSelector: string;
  summarySelector: string;
  hrefIncludes: string;
  baseUrl: string;
  limitText: string;
  timeoutText: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    url: params.url.trim() || "https://juejin.cn/frontend",
    urlPath: params.urlPath.trim(),
    itemSelector: params.itemSelector.trim() || 'a[href*="/post/"]',
    titleSelector: params.titleSelector.trim(),
    hrefSelector: params.hrefSelector.trim(),
    summarySelector: params.summarySelector.trim(),
    hrefIncludes: params.hrefIncludes.trim() || "/post/",
    baseUrl: params.baseUrl.trim() || "https://juejin.cn",
    limit: normalizeInteger(Number(params.limitText), 20, 1, 100),
    timeoutMs: normalizeInteger(Number(params.timeoutText), 30_000, 1_000, 120_000),
  };
}

function buildBrowserExtractArticleConfig(params: {
  existing: unknown;
  inputMappingText: string;
  inputPath: string;
  urlPath: string;
  titleSelector: string;
  contentSelector: string;
  summarySelector: string;
  limitText: string;
  timeoutText: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    inputPath: params.inputPath.trim() || "$.items",
    urlPath: params.urlPath.trim() || "$.url",
    titleSelector: params.titleSelector.trim() || "h1",
    contentSelector:
      params.contentSelector.trim() ||
      "article, .article-content, .markdown-body, main",
    summarySelector: params.summarySelector.trim(),
    limit: normalizeInteger(Number(params.limitText), 5, 1, 20),
    timeoutMs: normalizeInteger(Number(params.timeoutText), 30_000, 1_000, 120_000),
  };
}

function buildDocumentPlanUpdateConfig(params: {
  existing: unknown;
  inputMappingText: string;
  inputPath: string;
  targetRoot: string;
  outputDir: string;
  sourceType: string;
  publisher: string;
  topic: string;
  tagsText: string;
  limitText: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  const tags = parseConfigJson(params.tagsText.trim() || "[]", "标签");
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new Error("标签必须是字符串数组。");
  }
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    inputPath: params.inputPath.trim() || "$.items",
    targetRoot:
      params.targetRoot.trim() || "/Users/apple/Desktop/project/document",
    outputDir: params.outputDir.trim() || "wiki/sources",
    sourceType: params.sourceType.trim() || "article",
    publisher: params.publisher.trim() || "juejin",
    topic: params.topic.trim(),
    tags,
    limit: normalizeInteger(Number(params.limitText), 5, 1, 20),
  };
}

function buildDocumentApplyPatchConfig(params: {
  existing: unknown;
  inputMappingText: string;
  inputPath: string;
  targetRoot: string;
  conflictPolicy: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
  return {
    ...existing,
    inputMapping: parseInputMapping(params.inputMappingText),
    inputPath: params.inputPath.trim() || "$.plannedChanges",
    targetRoot:
      params.targetRoot.trim() || "/Users/apple/Desktop/project/document",
    conflictPolicy:
      params.conflictPolicy === "overwrite" ? "overwrite" : "skip",
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

function isNodeType(
  value: FlowNodeType,
  legacyType: string,
  canonicalType: string,
): boolean {
  return value === legacyType || value === canonicalType;
}

function isStartNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "start", "core.start");
}

function isEndNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "end", "core.end");
}

function isAgentNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "agent", "ai.agent");
}

function isPromptNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "prompt", "ai.prompt");
}

function isAgentLikeNodeType(value: FlowNodeType): boolean {
  return isAgentNodeType(value) || isPromptNodeType(value);
}

function isTransformNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "transform", "core.transform");
}

function isConditionNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "condition", "core.condition");
}

function isBrowserExtractListNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "extractList", "browser.extractList");
}

function isBrowserExtractArticleNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "extractArticle", "browser.extractArticle");
}

function isBrowserNodeType(value: FlowNodeType): boolean {
  return isBrowserExtractListNodeType(value) || isBrowserExtractArticleNodeType(value);
}

function isDocumentPlanUpdateNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "planDocumentUpdate", "document.planUpdate");
}

function isDocumentApplyPatchNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "applyDocumentPatch", "document.applyPatch");
}

function isDocumentNodeType(value: FlowNodeType): boolean {
  return (
    isDocumentPlanUpdateNodeType(value) ||
    isDocumentApplyPatchNodeType(value)
  );
}

function isForeachNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "foreach", "core.foreach");
}

function isJoinNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "join", "core.join");
}

function isApprovalNodeType(value: FlowNodeType): boolean {
  return isNodeType(value, "approval", "approval.review");
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
    case "extractList":
      return "网页列表";
    case "extractArticle":
      return "网页文章";
    case "planDocumentUpdate":
      return "文档计划";
    case "applyDocumentPatch":
      return "应用文档";
    case "foreach":
      return "循环";
    case "join":
      return "汇总";
    case "approval":
      return "审批";
    case "end":
      return "结束";
    case "core.start":
      return "开始";
    case "ai.agent":
      return "智能体";
    case "ai.prompt":
      return "提示词";
    case "core.transform":
      return "转换";
    case "core.condition":
      return "判断";
    case "browser.extractList":
      return "网页列表";
    case "browser.extractArticle":
      return "网页文章";
    case "document.planUpdate":
      return "文档计划";
    case "document.applyPatch":
      return "应用文档";
    case "core.foreach":
      return "循环";
    case "core.join":
      return "汇总";
    case "approval.review":
      return "审批";
    case "core.end":
      return "结束";
    default:
      return type;
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
    case "waiting_for_approval":
      return "等待审批";
    case "skipped":
      return "已跳过";
    default:
      return "未运行";
  }
}

function itemStatusLabel(status: FlowItemStatus): string {
  switch (status) {
    case "discovered":
      return "已发现";
    case "queued":
      return "排队中";
    case "running":
      return "执行中";
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "skipped_duplicate":
      return "重复跳过";
    case "skipped_low_value":
      return "低价值跳过";
    case "waiting_for_approval":
      return "等待批准";
    case "applied":
      return "已应用";
    case "skipped":
      return "已跳过";
  }
}

function itemStatusClassName(status: FlowItemStatus): string {
  switch (status) {
    case "succeeded":
    case "applied":
      return "bg-emerald-50 text-emerald-700";
    case "failed":
      return "bg-rose-50 text-rose-700";
    case "waiting_for_approval":
      return "bg-amber-50 text-amber-700";
    case "running":
    case "queued":
      return "bg-sky-50 text-sky-700";
    case "skipped":
    case "skipped_duplicate":
    case "skipped_low_value":
      return "bg-slate-100 text-slate-600";
    case "discovered":
      return "bg-violet-50 text-violet-700";
  }
}

function countItemsByStatus(items: FlowItem[]): Partial<Record<FlowItemStatus, number>> {
  return items.reduce<Partial<Record<FlowItemStatus, number>>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
}

function getNodeVisualState(
  nodeRun: FlowNodeRun | null | undefined,
  runStatus: FlowRun["status"] | null,
): FlowNodeVisualState {
  if (!runStatus) return "idle";
  if (!nodeRun) {
    return runStatus === "running" ? "pending" : "skipped";
  }
  if (nodeRun.status === "running" || nodeRun.status === "queued") {
    return "active";
  }
  if (nodeRun.status === "succeeded") return "done";
  if (nodeRun.status === "failed") return "failed";
  if (nodeRun.status === "skipped") return "skipped";
  return "pending";
}

function nodeStateLabel(
  state: FlowNodeVisualState,
  rawStatus: FlowRun["status"] | null,
): string {
  if (state === "active") return "执行中";
  if (state === "done") return "已完成";
  if (state === "pending") return "等待中";
  if (state === "failed") return "失败";
  if (state === "skipped") return "未执行";
  return rawStatus ? runStatusLabel(rawStatus) : "未运行";
}

function flowEventLabel(type: string): string {
  switch (type) {
    case "flow.run.started":
      return "流程开始";
    case "flow.run.finished":
      return "流程完成";
    case "flow.run.failed":
      return "流程失败";
    case "flow.run.cancelled":
      return "流程取消";
    case "flow.run.resumed":
      return "流程继续";
    case "flow.run.waiting_for_approval":
      return "等待人工审批";
    case "node.queued":
      return "节点排队";
    case "node.started":
      return "节点开始";
    case "node.chat.thread.created":
      return "对话创建";
    case "node.finished":
      return "节点完成";
    case "node.failed":
      return "节点失败";
    case "node.approval.requested":
      return "请求审批";
    case "node.approval.approved":
      return "审批通过";
    case "node.approval.rejected":
      return "审批拒绝";
    case "node.enqueued":
      return "下游入队";
    default:
      return type;
  }
}

function messageRoleLabel(role: UIMessage["role"]): string {
  if (role === "user") return "输入";
  if (role === "assistant") return "Agent";
  if (role === "system") return "系统";
  return role;
}

function toolStateLabel(state: unknown): string {
  if (state === "input-available") return "已发起";
  if (state === "input-streaming") return "输入中";
  if (state === "output-available") return "已返回";
  if (state === "output-error") return "失败";
  if (state === "approval-requested") return "等待审批";
  if (typeof state === "string" && state.trim()) return state;
  return "未知";
}
