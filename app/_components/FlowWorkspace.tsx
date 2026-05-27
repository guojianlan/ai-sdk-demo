"use client";

import { useEffect, useMemo, useState } from "react";

import {
  createFlowEdgeOnApi,
  createFlowNodeOnApi,
  createFlowOnApi,
  fetchFlowRunDetail,
  fetchFlowRuns,
  fetchFlowGraph,
  fetchFlows,
  runFlowOnApi,
  updateFlowNodeOnApi,
  type FlowDefinition,
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
  "prompt",
  "transform",
  "condition",
  "end",
];

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
  const [titleDraft, setTitleDraft] = useState("New workflow");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [nodeType, setNodeType] = useState<FlowNodeType>("prompt");
  const [edgeSource, setEdgeSource] = useState("");
  const [edgeTarget, setEdgeTarget] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [activeRun, setActiveRun] = useState<FlowRunWithNodes | null>(null);
  const [inputDraft, setInputDraft] = useState("{\n  \"topic\": \"hello\"\n}");
  const [running, setRunning] = useState(false);
  const [savingNode, setSavingNode] = useState(false);
  const [error, setError] = useState("");

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
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "创建 workflow 失败",
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
      setError(runError instanceof Error ? runError.message : "运行 workflow 失败");
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
      });
      const nextGraph = await fetchFlowGraph(graph.flow.id);
      setGraph(nextGraph);
      setEdgeSource(edge.sourceNodeId);
      setEdgeTarget(edge.targetNodeId);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "连接节点失败");
    }
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
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存节点失败");
    } finally {
      setSavingNode(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden px-5 py-6 sm:px-8 lg:px-10">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Eyebrow>Flows</Eyebrow>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
            Workflow Canvas
          </h2>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(160px,1fr)_minmax(180px,1fr)_auto]">
          <input
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            className="h-10 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-slate-900"
            placeholder="Workflow name"
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
            Create
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
            <Eyebrow>All Workflows · {flows.length}</Eyebrow>
          </div>
          <div className="space-y-2">
            {flows.map((flow) => (
              <button
                key={flow.id}
                type="button"
                onClick={() => setActiveFlowId(flow.id)}
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
                  {flow.workspaceName || "workspace"} ·{" "}
                  {formatTimestamp(new Date(flow.updatedAt).toISOString())}
                </div>
              </button>
            ))}
            {flows.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                暂无 workflow
              </div>
            )}
          </div>
        </div>

        {activeFlowId && graph ? (
          <FlowEditor
            graph={graph}
            nodeType={nodeType}
            edgeSource={edgeSource}
            edgeTarget={edgeTarget}
            onNodeTypeChange={setNodeType}
            onEdgeSourceChange={setEdgeSource}
            onEdgeTargetChange={setEdgeTarget}
            selectedNodeId={selectedNodeId}
            onSelectedNodeChange={setSelectedNodeId}
            runs={runs}
            activeRun={activeRun}
            inputDraft={inputDraft}
            running={running}
            savingNode={savingNode}
            onInputDraftChange={setInputDraft}
            onAddNode={() => void handleAddNode()}
            onConnectNodes={() => void handleConnectNodes()}
            onRunFlow={() => void handleRunFlow()}
            onSelectRun={(runId) => void handleSelectRun(runId)}
            onSaveNode={(params) => void handleSaveNode(params)}
          />
        ) : (
          <div className="flex min-h-0 items-center justify-center rounded-md border border-dashed border-slate-300 text-sm text-slate-500">
            创建或选择一个 workflow
          </div>
        )}
      </div>
    </div>
  );
}

function FlowEditor({
  graph,
  nodeType,
  edgeSource,
  edgeTarget,
  onNodeTypeChange,
  onEdgeSourceChange,
  onEdgeTargetChange,
  selectedNodeId,
  onSelectedNodeChange,
  runs,
  activeRun,
  inputDraft,
  running,
  savingNode,
  onInputDraftChange,
  onAddNode,
  onConnectNodes,
  onRunFlow,
  onSelectRun,
  onSaveNode,
}: {
  graph: FlowGraph;
  nodeType: FlowNodeType;
  edgeSource: string;
  edgeTarget: string;
  onNodeTypeChange: (type: FlowNodeType) => void;
  onEdgeSourceChange: (id: string) => void;
  onEdgeTargetChange: (id: string) => void;
  selectedNodeId: string;
  onSelectedNodeChange: (id: string) => void;
  runs: FlowRun[];
  activeRun: FlowRunWithNodes | null;
  inputDraft: string;
  running: boolean;
  savingNode: boolean;
  onInputDraftChange: (value: string) => void;
  onAddNode: () => void;
  onConnectNodes: () => void;
  onRunFlow: () => void;
  onSelectRun: (runId: string) => void;
  onSaveNode: (params: {
    nodeId: string;
    title: string;
    config: unknown;
  }) => void;
}) {
  const selectedNode =
    graph.nodes.find((node) => node.id === selectedNodeId) ?? graph.nodes[0];
  const selectedNodeRun = selectedNode
    ? activeRun?.nodeRuns.find((run) => run.nodeId === selectedNode.id) ?? null
    : null;

  return (
    <div className="grid min-h-0 gap-4 overflow-hidden xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-slate-900">
            {graph.flow.title}
          </div>
          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">
            {graph.nodes.length} nodes · {graph.edges.length} edges
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
                {type}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRunFlow}
            disabled={running}
            className="h-9 rounded-md border border-emerald-700 bg-emerald-700 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
          >
            {running ? "Running" : "Run"}
          </button>
          <button
            type="button"
            onClick={onAddNode}
            className="h-9 rounded-md border border-slate-900 bg-white px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-900"
          >
            Add Node
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
          to
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
          Connect
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto rounded-md border border-slate-300 bg-[linear-gradient(#e2e8f0_1px,transparent_1px),linear-gradient(90deg,#e2e8f0_1px,transparent_1px)] bg-[size:32px_32px]">
        <div className="relative h-[720px] w-[1120px]">
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            {graph.edges.map((edge) => {
              const source = graph.nodes.find((node) => node.id === edge.sourceNodeId);
              const target = graph.nodes.find((node) => node.id === edge.targetNodeId);
              if (!source || !target) return null;
              return (
                <line
                  key={edge.id}
                  x1={source.position.x + 96}
                  y1={source.position.y + 32}
                  x2={target.position.x}
                  y2={target.position.y + 32}
                  stroke="#0f172a"
                  strokeWidth="2"
                  strokeDasharray={edge.condition ? "4 4" : undefined}
                />
              );
            })}
          </svg>
          {graph.nodes.map((node) => (
            <FlowNodeCard
              key={node.id}
              node={node}
              selected={node.id === selectedNode?.id}
              nodeRun={activeRun?.nodeRuns.find((run) => run.nodeId === node.id)}
              onSelect={() => onSelectedNodeChange(node.id)}
            />
          ))}
        </div>
      </div>
      </div>

      <FlowInspector
        selectedNode={selectedNode}
        selectedNodeRun={selectedNodeRun}
        activeRun={activeRun}
        runs={runs}
        inputDraft={inputDraft}
        running={running}
        savingNode={savingNode}
        onInputDraftChange={onInputDraftChange}
        onRunFlow={onRunFlow}
        onSelectRun={onSelectRun}
        onSaveNode={onSaveNode}
      />
    </div>
  );
}

function FlowNodeCard({
  node,
  selected,
  nodeRun,
  onSelect,
}: {
  node: FlowNode;
  selected: boolean;
  nodeRun?: FlowNodeRun;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "absolute w-48 rounded-md border bg-white px-3 py-3 text-left shadow-sm transition-colors",
        selected ? "border-emerald-700 ring-2 ring-emerald-100" : "border-slate-900",
      ].join(" ")}
      style={{ left: node.position.x, top: node.position.y }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
          {node.type}
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
            {nodeRun.status}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-slate-900">
        {node.title}
      </div>
    </button>
  );
}

function FlowInspector({
  selectedNode,
  selectedNodeRun,
  activeRun,
  runs,
  inputDraft,
  running,
  savingNode,
  onInputDraftChange,
  onRunFlow,
  onSelectRun,
  onSaveNode,
}: {
  selectedNode: FlowNode | undefined;
  selectedNodeRun: FlowNodeRun | null;
  activeRun: FlowRunWithNodes | null;
  runs: FlowRun[];
  inputDraft: string;
  running: boolean;
  savingNode: boolean;
  onInputDraftChange: (value: string) => void;
  onRunFlow: () => void;
  onSelectRun: (runId: string) => void;
  onSaveNode: (params: {
    nodeId: string;
    title: string;
    config: unknown;
  }) => void;
}) {
  return (
    <aside className="min-h-0 overflow-y-auto border-l border-slate-200 pl-4">
      <div className="space-y-4">
        <section className="rounded-md border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Eyebrow>Run Input</Eyebrow>
            <button
              type="button"
              onClick={onRunFlow}
              disabled={running}
              className="h-8 rounded-md border border-slate-900 bg-slate-900 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-white disabled:cursor-wait disabled:border-slate-300 disabled:bg-slate-300"
            >
              {running ? "Running" : "Run"}
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
          <Eyebrow>Runs · {runs.length}</Eyebrow>
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
                  <span className="font-medium text-slate-900">{run.status}</span>
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

        <section className="rounded-md border border-slate-200 p-3">
          <Eyebrow>Node Inspector</Eyebrow>
          {selectedNode ? (
            <div className="mt-3 space-y-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                  {selectedNode.type}
                </div>
              </div>
              <NodeConfigForm
                key={selectedNode.id}
                node={selectedNode}
                savingNode={savingNode}
                onSaveNode={onSaveNode}
              />
              <JsonBlock label="Config" value={selectedNode.config} />
              <JsonBlock label="Last Input" value={selectedNodeRun?.input ?? null} />
              <JsonBlock
                label="Last Output"
                value={selectedNodeRun?.output ?? null}
              />
              <JsonBlock label="Trace" value={selectedNodeRun?.trace ?? null} />
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
  const [titleDraft, setTitleDraft] = useState(node.title);
  const [promptDraft, setPromptDraft] = useState(promptConfig.prompt);
  const [schemaDraft, setSchemaDraft] = useState(
    JSON.stringify(promptConfig.outputSchema, null, 2),
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
        node.type === "prompt"
          ? buildPromptConfig({
              existing: node.config,
              prompt: promptDraft,
              schemaText: schemaDraft,
              retryText: retryDraft,
              timeoutText: timeoutDraft,
            })
          : parseConfigJson(configDraft, "Config");
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
          Title
        </span>
        <input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-slate-900"
        />
      </label>
      {node.type === "prompt" ? (
        <>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
              Prompt
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
              Output Schema
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
                Retry
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
                Timeout ms
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
      ) : (
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
            Config
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
        {savingNode ? "Saving" : "Save Node"}
      </button>
    </>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <pre className="max-h-48 overflow-auto rounded-md bg-slate-950 p-2 text-xs leading-5 text-slate-100">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function parseJsonDraft(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Run input 必须是合法 JSON。");
  }
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

function buildPromptConfig(params: {
  existing: unknown;
  prompt: string;
  schemaText: string;
  retryText: string;
  timeoutText: string;
}): unknown {
  const existing = isRecord(params.existing) ? params.existing : {};
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
    outputSchema,
    retry: {
      maxAttempts: normalizeInteger(Number(params.retryText), 3, 1, 5),
    },
    timeoutMs: normalizeInteger(Number(params.timeoutText), 60_000, 1_000, 300_000),
  };
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
