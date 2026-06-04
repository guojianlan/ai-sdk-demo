import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { UIMessage } from "ai";
import type { ChatUIMessageChunk } from "@/lib/chat-agent/active-runs";

import { runChatAgentLoop } from "@/lib/chat-agent/run-loop";
import { env } from "@/lib/env";
import {
  isFlowNodeType,
  normalizeFlowNodeType,
} from "@/lib/flows/node-registry";
import {
  normalizePermissionMode,
  type PermissionMode,
} from "@/lib/permissions";
import {
  appendFlowRunEvent,
  createFlowNodeRun,
  createFlowArtifact,
  createFlowItem,
  createFlowRun,
  getFlowRunWithNodes,
  getFlowWithGraph,
  archiveThread,
  loadMessages,
  saveMessages,
  updateFlowNodeRun,
  updateFlowRun,
  type FlowEdge,
  type FlowDefinition,
  type FlowNode,
  type FlowNodeRun,
  type FlowRunWithNodes,
  type FlowWithGraph,
  type FlowArtifactKind,
  type FlowItemStatus,
  upsertThread,
} from "@/lib/persistence";
import { getSkills } from "@/lib/skills";

const MAX_EXECUTED_NODES = 100;

type PromptNodeConfig = {
  prompt?: unknown;
  outputSchema?: unknown;
  inputMapping?: unknown;
  inputPath?: unknown;
  retry?: unknown;
  timeoutMs?: unknown;
  permissionMode?: unknown;
  useLastToolOutputAsOutput?: unknown;
};

type GenericNodeConfig = {
  inputMapping?: unknown;
  inputPath?: unknown;
  outputPath?: unknown;
  condition?: unknown;
  itemTitlePath?: unknown;
  itemExternalIdPath?: unknown;
  itemStatusPath?: unknown;
  itemMetadataPath?: unknown;
  limit?: unknown;
  outputKey?: unknown;
};

type ApprovalNodeConfig = {
  inputMapping?: unknown;
  inputPath?: unknown;
  titlePath?: unknown;
  summaryPath?: unknown;
  approvalMode?: unknown;
};

type BrowserExtractListNodeConfig = {
  inputMapping?: unknown;
  inputPath?: unknown;
  url?: unknown;
  urlPath?: unknown;
  searchQueryPath?: unknown;
  searchUrlTemplate?: unknown;
  itemSelector?: unknown;
  titleSelector?: unknown;
  hrefSelector?: unknown;
  summarySelector?: unknown;
  contentSelector?: unknown;
  hrefIncludes?: unknown;
  baseUrl?: unknown;
  limit?: unknown;
  timeoutMs?: unknown;
};

type DocumentPlanUpdateNodeConfig = {
  inputMapping?: unknown;
  inputPath?: unknown;
  targetRoot?: unknown;
  outputDir?: unknown;
  sourceType?: unknown;
  publisher?: unknown;
  topic?: unknown;
  tags?: unknown;
  limit?: unknown;
};

type DocumentApplyPatchNodeConfig = {
  inputMapping?: unknown;
  inputPath?: unknown;
  targetRoot?: unknown;
  conflictPolicy?: unknown;
};

type RetryConfig = {
  maxAttempts: number;
};

type NormalizedPromptConfig = {
  prompt: string;
  outputSchema: Record<string, unknown> | null;
  retry: RetryConfig;
  timeoutMs: number | null;
  permissionMode: PermissionMode;
  useLastToolOutputAsOutput: boolean;
};

type NodeExecutionResult = {
  output: unknown;
  trace: unknown;
  transcriptThreadId?: string | null;
  waitingForApproval?: boolean;
};

type FlowNodeExecutor = (
  node: FlowNode,
  input: unknown,
  context: {
    flow: FlowDefinition;
    flowRunId: string;
    nodeRunId: string;
  },
) => Promise<NodeExecutionResult> | NodeExecutionResult;

const FLOW_NODE_EXECUTORS = new Map<string, FlowNodeExecutor>([
  ["core.start", executeStartNode],
  ["ai.agent", executeAgentNode],
  ["ai.prompt", executeAgentNode],
  ["core.end", executeEndNode],
  ["core.transform", executeTransformNode],
  ["core.condition", executeConditionNode],
  ["core.foreach", executeForeachNode],
  ["core.join", executeJoinNode],
  ["browser.extractList", executeBrowserExtractListNode],
  ["browser.extractArticle", executeBrowserExtractArticleNode],
  ["document.planUpdate", executeDocumentPlanUpdateNode],
  ["document.applyPatch", executeDocumentApplyPatchNode],
  ["approval.review", executeApprovalReviewNode],
]);

export async function executeFlow(params: {
  flowId: string;
  input: unknown;
}): Promise<FlowRunWithNodes> {
  const graph = getFlowWithGraph(params.flowId);
  if (!graph) {
    throw new Error("Flow not found.");
  }

  const run = createFlowRun({
    flowId: graph.flow.id,
    input: params.input ?? {},
    status: "running",
  });

  return executeFlowRun({
    flowId: params.flowId,
    input: params.input,
    runId: run.id,
  });
}

export async function executeFlowRun(params: {
  flowId: string;
  input: unknown;
  runId: string;
}): Promise<FlowRunWithNodes> {
  const graph = getFlowWithGraph(params.flowId);
  if (!graph) {
    throw new Error("Flow not found.");
  }

  appendFlowRunEvent({
    flowRunId: params.runId,
    type: "flow.run.started",
    payload: {
      flowId: params.flowId,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
  });

  const startNode =
    graph.nodes.find((node) => isFlowNodeType(node.type, "core.start")) ??
    graph.nodes[0];
  if (!startNode) {
    const failed = updateFlowRun(params.runId, {
      status: "failed",
      error: "Flow has no nodes.",
      finishedAt: Date.now(),
    });
    appendFlowRunEvent({
      flowRunId: params.runId,
      type: "flow.run.failed",
      payload: {
        flowId: params.flowId,
        error: "Flow has no nodes.",
      },
    });
    return { run: failed, nodeRuns: [], artifacts: [], items: [] };
  }

  return continueFlowRun({
    graph,
    runId: params.runId,
    runInput: params.input,
    queue: [startNode.id],
    outputByNode: new Map(),
    executed: new Set(),
  });
}

export async function resumeFlowRun(params: {
  flowId: string;
  runId: string;
  decision: "approved" | "rejected";
  response?: unknown;
}): Promise<FlowRunWithNodes> {
  const detail = getFlowRunWithNodes(params.runId);
  if (!detail || detail.run.flowId !== params.flowId) {
    throw new Error("Flow run not found.");
  }
  if (detail.run.status !== "waiting_for_approval") {
    throw new Error("Flow run is not waiting for approval.");
  }

  const graph = getFlowWithGraph(params.flowId);
  if (!graph) {
    throw new Error("Flow not found.");
  }

  const approvalNodeRun = findWaitingApprovalNodeRun(detail.nodeRuns);
  if (!approvalNodeRun) {
    throw new Error("Approval node run not found.");
  }
  const approvalNode = graph.nodes.find((node) => node.id === approvalNodeRun.nodeId);
  if (!approvalNode) {
    throw new Error("Approval node not found in flow graph.");
  }

  const approved = params.decision === "approved";
  const approvalOutput = buildApprovalDecisionOutput({
    previousOutput: approvalNodeRun.output,
    approved,
    response: params.response,
  });
  updateFlowNodeRun(approvalNodeRun.id, {
    output: approvalOutput,
    trace: mergeTraceDecision(approvalNodeRun.trace, {
      approved,
      response: params.response,
    }),
  });
  appendFlowRunEvent({
    flowRunId: params.runId,
    nodeRunId: approvalNodeRun.id,
    type: approved ? "node.approval.approved" : "node.approval.rejected",
    payload: {
      ...nodeEventPayload(approvalNode),
      decision: approved ? "approved" : "rejected",
      response: params.response ?? null,
      output: approvalOutput,
    },
  });

  if (!approved) {
    updateFlowRun(params.runId, {
      status: "cancelled",
      output: approvalOutput,
      finishedAt: Date.now(),
      error: null,
    });
    appendFlowRunEvent({
      flowRunId: params.runId,
      nodeRunId: approvalNodeRun.id,
      type: "flow.run.cancelled",
      payload: {
        flowId: params.flowId,
        reason: "approval_rejected",
        output: approvalOutput,
      },
    });
    const rejectedDetail = getFlowRunWithNodes(params.runId);
    if (!rejectedDetail) {
      throw new Error("Flow run could not be loaded after rejection.");
    }
    return rejectedDetail;
  }

  const outputByNode = new Map<string, unknown>();
  const executed = new Set<string>();
  for (const nodeRun of detail.nodeRuns) {
    if (nodeRun.status !== "succeeded") continue;
    outputByNode.set(
      nodeRun.nodeId,
      nodeRun.id === approvalNodeRun.id ? approvalOutput : nodeRun.output,
    );
    executed.add(nodeRun.nodeId);
  }

  updateFlowRun(params.runId, {
    status: "running",
    output: approvalOutput,
    error: null,
    finishedAt: null,
  });
  appendFlowRunEvent({
    flowRunId: params.runId,
    nodeRunId: approvalNodeRun.id,
    type: "flow.run.resumed",
    payload: {
      flowId: params.flowId,
      resumedFromNodeId: approvalNode.id,
      decision: "approved",
    },
  });

  const queue = selectOutgoingEdges({
    node: approvalNode,
    edges: graph.edges,
    output: approvalOutput,
  })
    .map((edge) => edge.targetNodeId)
    .filter((nodeId) => !executed.has(nodeId));

  return continueFlowRun({
    graph,
    runId: params.runId,
    runInput: detail.run.input,
    queue,
    outputByNode,
    executed,
  });
}

async function continueFlowRun(params: {
  graph: FlowWithGraph;
  runId: string;
  runInput: unknown;
  queue: string[];
  outputByNode: Map<string, unknown>;
  executed: Set<string>;
}): Promise<FlowRunWithNodes> {
  const { graph, outputByNode, executed } = params;
  const queue = [...params.queue];
  const startNode =
    graph.nodes.find((node) => isFlowNodeType(node.type, "core.start")) ??
    graph.nodes[0];
  const reachableNodeIds = collectReachableNodeIdsFrom(
    queue.length > 0 ? queue : startNode ? [startNode.id] : [],
    graph.edges,
  );
  let stalledTurns = 0;

  try {
    while (queue.length > 0) {
      if (executed.size >= MAX_EXECUTED_NODES) {
        throw new Error(`Flow stopped after ${MAX_EXECUTED_NODES} nodes.`);
      }

      const nodeId = queue.shift();
      if (!nodeId || executed.has(nodeId)) continue;

      const node = graph.nodes.find((item) => item.id === nodeId);
      if (!node) continue;
      if (
        !isNodeReady({
          node,
          edges: graph.edges,
          executed,
          reachableNodeIds,
        })
      ) {
        queue.push(node.id);
        stalledTurns++;
        if (stalledTurns > queue.length + graph.nodes.length) {
          throw new Error(
            `Flow cannot continue; node "${node.title}" is waiting for upstream input.`,
          );
        }
        continue;
      }
      stalledTurns = 0;

      const rawInput =
        isFlowNodeType(node.type, "core.start")
          ? params.runInput ?? getConfiguredStartInput(node)
          : buildNodeInput(node, graph.edges, outputByNode);
      const input = applyNodeInputMapping(node, rawInput);

      appendFlowRunEvent({
        flowRunId: params.runId,
        type: "node.queued",
        payload: nodeEventPayload(node),
      });
      const nodeRun = createFlowNodeRun({
        flowRunId: params.runId,
        nodeId: node.id,
        input,
        status: "running",
      });
      appendFlowRunEvent({
        flowRunId: params.runId,
        nodeRunId: nodeRun.id,
        type: "node.started",
        payload: {
          ...nodeEventPayload(node),
          input,
        },
      });

      try {
        const result = await executeNode(node, input, {
          flow: graph.flow,
          flowRunId: params.runId,
          nodeRunId: nodeRun.id,
        });
        updateFlowNodeRun(nodeRun.id, {
          status: "succeeded",
          output: result.output,
          trace: result.trace,
          transcriptThreadId: result.transcriptThreadId ?? null,
          finishedAt: Date.now(),
        });
        appendFlowRunEvent({
          flowRunId: params.runId,
          nodeRunId: nodeRun.id,
          type: "node.finished",
          payload: {
            ...nodeEventPayload(node),
            status: "succeeded",
            output: result.output,
            transcriptThreadId: result.transcriptThreadId ?? null,
          },
        });
        for (const artifact of collectArtifactsFromNodeOutput({
          node,
          nodeRunId: nodeRun.id,
          flowRunId: params.runId,
          output: result.output,
        })) {
          const created = createFlowArtifact(artifact);
          appendFlowRunEvent({
            flowRunId: params.runId,
            nodeRunId: nodeRun.id,
            type: "node.artifact.created",
            payload: {
              ...nodeEventPayload(node),
              artifactId: created.id,
              kind: created.kind,
              title: created.title,
              path: created.path,
              mediaType: created.mediaType,
            },
          });
        }
        for (const item of collectItemsFromNodeOutput({
          node,
          nodeRunId: nodeRun.id,
          flowRunId: params.runId,
          output: result.output,
        })) {
          const created = createFlowItem(item);
          appendFlowRunEvent({
            flowRunId: params.runId,
            nodeRunId: nodeRun.id,
            type: "node.item.created",
            payload: {
              ...nodeEventPayload(node),
              itemId: created.id,
              externalId: created.externalId,
              status: created.status,
              title: created.title,
            },
          });
        }
        outputByNode.set(node.id, result.output);
        executed.add(node.id);
        if (result.waitingForApproval) {
          appendFlowRunEvent({
            flowRunId: params.runId,
            nodeRunId: nodeRun.id,
            type: "node.approval.requested",
            payload: {
              ...nodeEventPayload(node),
              approvalRequest: isRecord(result.output)
                ? result.output.approvalRequest ?? result.output
                : result.output,
            },
          });
          updateFlowRun(params.runId, {
            status: "waiting_for_approval",
            output: result.output,
            finishedAt: null,
          });
          appendFlowRunEvent({
            flowRunId: params.runId,
            nodeRunId: nodeRun.id,
            type: "flow.run.waiting_for_approval",
            payload: {
              flowId: graph.flow.id,
              status: "waiting_for_approval",
              approvalRequest: isRecord(result.output)
                ? result.output.approvalRequest ?? result.output
                : result.output,
              executedNodeCount: executed.size,
            },
          });
          const detail = getFlowRunWithNodes(params.runId);
          if (!detail) {
            throw new Error("Flow run could not be loaded after approval wait.");
          }
          return detail;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Node execution failed.";
        updateFlowNodeRun(nodeRun.id, {
          status: "failed",
          error: message,
          trace: {
            nodeType: node.type,
            message,
          },
          finishedAt: Date.now(),
        });
        appendFlowRunEvent({
          flowRunId: params.runId,
          nodeRunId: nodeRun.id,
          type: "node.failed",
          payload: {
            ...nodeEventPayload(node),
            status: "failed",
            error: message,
          },
        });
        throw new Error(`${node.title}: ${message}`);
      }

      for (const edge of selectOutgoingEdges({
        node,
        edges: graph.edges,
        output: outputByNode.get(node.id),
      })) {
        if (!executed.has(edge.targetNodeId)) {
          queue.push(edge.targetNodeId);
          const target = graph.nodes.find((item) => item.id === edge.targetNodeId);
          appendFlowRunEvent({
            flowRunId: params.runId,
            type: "node.enqueued",
            payload: {
              sourceNodeId: node.id,
              targetNodeId: edge.targetNodeId,
              targetTitle: target?.title ?? null,
              edgeId: edge.id,
              condition: edge.condition,
            },
          });
        }
      }
    }

    const finalOutput = findFinalOutput(graph.nodes, outputByNode);
    updateFlowRun(params.runId, {
      status: "succeeded",
      output: finalOutput,
      finishedAt: Date.now(),
    });
    appendFlowRunEvent({
      flowRunId: params.runId,
      type: "flow.run.finished",
      payload: {
        flowId: graph.flow.id,
        status: "succeeded",
        output: finalOutput,
        executedNodeCount: executed.size,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Flow execution failed.";
    updateFlowRun(params.runId, {
      status: "failed",
      error: message,
      output: findFinalOutput(graph.nodes, outputByNode),
      finishedAt: Date.now(),
    });
    appendFlowRunEvent({
      flowRunId: params.runId,
      type: "flow.run.failed",
      payload: {
        flowId: graph.flow.id,
        status: "failed",
        error: message,
        output: findFinalOutput(graph.nodes, outputByNode),
        executedNodeCount: executed.size,
      },
    });
  }

  const detail = getFlowRunWithNodes(params.runId);
  if (!detail) {
    throw new Error("Flow run could not be loaded after execution.");
  }
  return detail;
}

async function executeNode(
  node: FlowNode,
  input: unknown,
  context: {
    flow: FlowDefinition;
    flowRunId: string;
    nodeRunId: string;
  },
): Promise<NodeExecutionResult> {
  const normalizedType = normalizeFlowNodeType(node.type);
  const executor = FLOW_NODE_EXECUTORS.get(normalizedType);
  if (executor) return executor(node, input, context);

  return {
    output: input,
    trace: {
      kind: node.type,
      mode: "pass-through",
      output: input,
    },
  };
}

function executeStartNode(
  _node: FlowNode,
  input: unknown,
): NodeExecutionResult {
  return {
    output: input,
    trace: {
      kind: "start",
      output: input,
    },
  };
}

function executeEndNode(_node: FlowNode, input: unknown): NodeExecutionResult {
  return {
    output: input,
    trace: {
      kind: "end",
      output: input,
    },
  };
}

function executeTransformNode(
  node: FlowNode,
  input: unknown,
): NodeExecutionResult {
  const config = normalizeGenericNodeConfig(node.config);
  const output = config.outputPath ? getPath(input, config.outputPath) : input;
  return {
    output,
    trace: {
      kind: "transform",
      input,
      outputPath: config.outputPath,
      output,
    },
  };
}

function executeConditionNode(
  node: FlowNode,
  input: unknown,
): NodeExecutionResult {
  const config = normalizeGenericNodeConfig(node.config);
  if (config.condition === undefined) {
    return {
      output: input,
      trace: {
        kind: "condition",
        mode: "pass-through",
        input,
        output: input,
      },
    };
  }
  const matched = evaluateCondition(config.condition, input);
  const output = { condition: matched, input };
  return {
    output,
    trace: {
      kind: "condition",
      condition: config.condition,
      matched,
      input,
      output,
    },
  };
}

function executeForeachNode(
  node: FlowNode,
  input: unknown,
): NodeExecutionResult {
  const config = normalizeGenericNodeConfig(node.config);
  const source = config.inputPath ? getPath(input, config.inputPath) : input;
  const rawItems = coerceArrayFromValue(source);
  const limitedItems = rawItems.slice(0, config.limit);
  const flowItems = limitedItems.map((item, index) =>
    buildFlowItemLikeObject({
      item,
      index,
      config,
    }),
  );
  const output = {
    items: flowItems,
    flowItems,
    count: flowItems.length,
    skippedCount: Math.max(0, rawItems.length - flowItems.length),
    sourceCount: rawItems.length,
  };
  return {
    output,
    trace: {
      kind: "foreach",
      input,
      inputPath: config.inputPath,
      count: flowItems.length,
      sourceCount: rawItems.length,
      skippedCount: output.skippedCount,
      output,
    },
  };
}

function executeJoinNode(node: FlowNode, input: unknown): NodeExecutionResult {
  const config = normalizeGenericNodeConfig(node.config);
  const source = config.inputPath ? getPath(input, config.inputPath) : input;
  const items = collectJoinableValues(source);
  const outputKey = config.outputKey || "items";
  const output = {
    [outputKey]: items,
    items,
    flowItems: items,
    count: items.length,
  };
  return {
    output,
    trace: {
      kind: "join",
      input,
      inputPath: config.inputPath,
      outputKey,
      count: items.length,
      output,
    },
  };
}

async function executeBrowserExtractListNode(
  node: FlowNode,
  input: unknown,
): Promise<NodeExecutionResult> {
  const config = normalizeBrowserExtractListNodeConfig(node.config);
  const urlFromInput = config.urlPath ? getPath(input, config.urlPath) : null;
  const queryFromInput = config.searchQueryPath
    ? getPath(input, config.searchQueryPath)
    : null;
  const searchQuery = coerceSearchQuery(queryFromInput);
  const url = resolveBrowserExtractListUrl({
    configuredUrl: config.url,
    urlFromInput,
    searchQuery,
    searchUrlTemplate: config.searchUrlTemplate,
  });
  const startedAt = Date.now();
  let extractionMode: "playwright" | "fetch-html" | "juejin-search-api" =
    "playwright";
  let extractionError: string | null = null;
  let rawItems: BrowserExtractedItem[] = [];

  if (!coerceNonEmptyString(urlFromInput) && searchQuery && isJuejinFrontendUrl(config.url)) {
    try {
      rawItems = await extractJuejinSearchList({
        query: searchQuery,
        limit: config.limit,
        timeoutMs: config.timeoutMs,
      });
      extractionMode = "juejin-search-api";
    } catch (error) {
      extractionError =
        error instanceof Error ? error.message : "Juejin search API failed.";
    }
  }

  if (rawItems.length === 0 && extractionMode !== "juejin-search-api") {
    try {
      rawItems = await extractListWithPlaywright({ ...config, url });
    } catch (error) {
      extractionMode = "fetch-html";
      extractionError =
        error instanceof Error ? error.message : "Playwright extraction failed.";
      rawItems = await extractListFromHtml({ ...config, url });
    }
  }

  const items = normalizeBrowserExtractedItems({
    items: rawItems,
    config,
    url,
  });
  const output = {
    url,
    items,
    flowItems: items,
    count: items.length,
    mode: extractionMode,
    error: extractionError,
  };
  return {
    output,
    trace: {
      kind: "browser.extractList",
      input,
      config,
      mode: extractionMode,
      error: extractionError,
      durationMs: Date.now() - startedAt,
      count: items.length,
      output,
    },
  };
}

async function executeBrowserExtractArticleNode(
  node: FlowNode,
  input: unknown,
): Promise<NodeExecutionResult> {
  const config = normalizeBrowserExtractArticleNodeConfig(node.config);
  const source = config.inputPath ? getPath(input, config.inputPath) : input;
  const candidates = coerceArrayFromValue(source).slice(0, config.limit);
  const startedAt = Date.now();
  let extractionMode: "playwright" | "fetch-html" = "playwright";
  let extractionError: string | null = null;
  let articles: BrowserExtractedArticle[] = [];
  let skippedArticles: BrowserSkippedArticle[] = [];

  try {
    const result = await extractArticlesWithPlaywright({
      candidates,
      config,
    });
    articles = result.articles;
    skippedArticles = result.skippedArticles;
  } catch (error) {
    extractionMode = "fetch-html";
    extractionError =
      error instanceof Error ? error.message : "Playwright article extraction failed.";
    const result = await extractArticlesFromHtml({
      candidates,
      config,
    });
    articles = result.articles;
    skippedArticles = result.skippedArticles;
  }

  const items = normalizeBrowserExtractedArticles({
    articles,
    sourceInput: input,
  });
  const output = {
    articles,
    items,
    flowItems: items,
    count: items.length,
    skippedCount: skippedArticles.length,
    skippedArticles,
    mode: extractionMode,
    error: extractionError,
  };
  return {
    output,
    trace: {
      kind: "browser.extractArticle",
      input,
      config,
      mode: extractionMode,
      error: extractionError,
      durationMs: Date.now() - startedAt,
      count: items.length,
      skippedCount: skippedArticles.length,
      output,
    },
  };
}

function executeDocumentPlanUpdateNode(
  node: FlowNode,
  input: unknown,
): NodeExecutionResult {
  const config = normalizeDocumentPlanUpdateNodeConfig(node.config);
  const source = config.inputPath ? getPath(input, config.inputPath) : input;
  const candidates = coerceArrayFromValue(source).slice(0, config.limit);
  const plannedChanges = candidates.flatMap((candidate, index) =>
    buildDocumentPlannedChange({
      candidate,
      index,
      config,
    }),
  );
  const patch = buildUnifiedDiffPreview(plannedChanges);
  const output = {
    title: `准备写入 ${plannedChanges.length} 篇来源笔记`,
    summary: plannedChanges
      .map((change) => `${change.action}: ${change.path}`)
      .join("\n"),
    targetRoot: config.targetRoot,
    plannedChanges,
    patch,
    artifacts: [
      {
        kind: "patch",
        title: "Document update plan",
        metadata: {
          targetRoot: config.targetRoot,
          plannedChangeCount: plannedChanges.length,
          patch,
        },
      },
    ],
    count: plannedChanges.length,
  };
  return {
    output,
    trace: {
      kind: "document.planUpdate",
      input,
      config,
      count: plannedChanges.length,
      output,
    },
  };
}

async function executeDocumentApplyPatchNode(
  node: FlowNode,
  input: unknown,
): Promise<NodeExecutionResult> {
  const config = normalizeDocumentApplyPatchNodeConfig(node.config);
  const source = config.inputPath ? getPath(input, config.inputPath) : input;
  const plannedChanges = normalizePlannedChanges(source);
  const results: Array<Record<string, unknown>> = [];

  for (const change of plannedChanges) {
    const result = await applyDocumentPlannedChange({
      change,
      config,
    });
    results.push(result);
  }

  const applied = results.filter((result) => result.status === "applied");
  const skipped = results.filter((result) => result.status === "skipped");
  const failed = results.filter((result) => result.status === "failed");
  const output = {
    title: `已应用 ${applied.length} 个文档变更`,
    summary: [
      `applied: ${applied.length}`,
      `skipped: ${skipped.length}`,
      `failed: ${failed.length}`,
    ].join("\n"),
    targetRoot: config.targetRoot,
    results,
    items: results.map((result, index) => ({
      externalId: coerceNonEmptyString(result.path) ?? `document-change-${index + 1}`,
      title: coerceNonEmptyString(result.title) ?? `Document change ${index + 1}`,
      status:
        result.status === "applied"
          ? "applied"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
      input: result,
      output: result,
      metadata: result,
      error: result.status === "failed" ? coerceNonEmptyString(result.error) : null,
    })),
    flowItems: results,
    count: applied.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    artifacts: [
      {
        kind: "log",
        title: "Document apply result",
        metadata: {
          targetRoot: config.targetRoot,
          results,
        },
      },
    ],
  };
  return {
    output,
    trace: {
      kind: "document.applyPatch",
      input,
      config,
      resultCount: results.length,
      output,
    },
  };
}

function executeApprovalReviewNode(
  node: FlowNode,
  input: unknown,
): NodeExecutionResult {
  const config = normalizeApprovalNodeConfig(node.config);
  const reviewInput = config.inputPath ? getPath(input, config.inputPath) : input;
  const titleValue = config.titlePath
    ? getPath(reviewInput, config.titlePath)
    : undefined;
  const summaryValue = config.summaryPath
    ? getPath(reviewInput, config.summaryPath)
    : undefined;
  const approvalRequest = {
    id: randomUUID(),
    nodeId: node.id,
    nodeTitle: node.title,
    title: coerceNonEmptyString(titleValue) ?? node.title,
    summary: coerceNonEmptyString(summaryValue) ?? summarizeApprovalPayload(reviewInput),
    approvalMode: config.approvalMode,
    status: "waiting_for_approval",
    requestedAt: Date.now(),
    input: reviewInput,
  };
  const output = {
    approvalRequest,
    status: "waiting_for_approval",
    approved: false,
    input: reviewInput,
  };
  return {
    output,
    waitingForApproval: true,
    trace: {
      kind: "approval.review",
      input,
      inputPath: config.inputPath,
      titlePath: config.titlePath,
      summaryPath: config.summaryPath,
      approvalMode: config.approvalMode,
      output,
    },
  };
}

async function executeAgentNode(
  node: FlowNode,
  input: unknown,
  context: {
    flow: FlowDefinition;
    flowRunId: string;
    nodeRunId: string;
  },
): Promise<NodeExecutionResult> {
  const config = normalizePromptConfig(node.config);
  const userPrompt = buildPromptText({
    prompt: config.prompt,
    input,
    outputSchema: config.outputSchema,
  });

  const startedAt = Date.now();
  const transcriptThreadId = await createAgentNodeThread({
    flow: context.flow,
    nodeRunId: context.nodeRunId,
    node,
  });
  updateFlowNodeRun(context.nodeRunId, {
    transcriptThreadId,
  });
  appendFlowRunEvent({
    flowRunId: context.flowRunId,
    nodeRunId: context.nodeRunId,
    type: "node.chat.thread.created",
    payload: {
      ...nodeEventPayload(node),
      transcriptThreadId,
    },
  });
  const userMessage: UIMessage = {
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", text: userPrompt }],
  };
  await saveMessages(transcriptThreadId, [userMessage]);

  const chunks: ChatUIMessageChunk[] = [];
  const timeoutController = createTimeoutController(config.timeoutMs);
  try {
    await runChatAgentLoop({
      runId: `flow-node-run:${context.nodeRunId}`,
      writer: {
        write(part) {
          chunks.push(part);
        },
      },
      abortSignal: timeoutController.signal,
      options: {
        chatId: transcriptThreadId,
        agentMessages: [userMessage],
        fullMessages: [userMessage],
        compactionNotice: null,
        workspaceRoot: context.flow.workspaceRoot,
        workspaceName: context.flow.workspaceName ?? undefined,
        workspaceAccessMode: "workspace-tools",
        shellApprovalPolicy: "never",
        permissionMode: config.permissionMode,
        planMode: false,
        autoApproveTools: true,
        conversationSummary: null,
        skills: await getSkills(),
        hookContexts: [],
        stopAfterCompletedToolCalls: config.useLastToolOutputAsOutput,
      },
    });
  } finally {
    timeoutController.dispose();
  }

  const messages = loadMessages(transcriptThreadId);
  const assistantMessage = findLastAssistantMessage(messages);
  const assistantText = assistantMessage ? messageToText(assistantMessage) : "";
  const toolOutput =
    config.useLastToolOutputAsOutput && assistantMessage
      ? extractLastToolOutput(assistantMessage)
      : null;
  const output = toolOutput ?? parseAgentOutput(assistantText);
  const finalAssistantText =
    toolOutput !== null && !assistantText
      ? buildToolOutputAssistantText(output)
      : null;
  if (finalAssistantText) {
    const currentMessages = loadMessages(transcriptThreadId);
    await saveMessages(
      transcriptThreadId,
      currentMessages.map((message) =>
        message.id === assistantMessage?.id
          ? {
              ...message,
              parts: [
                ...message.parts,
                {
                  type: "text",
                  text: finalAssistantText,
                },
              ],
            }
          : message,
      ),
    );
  }

  return {
    output,
    transcriptThreadId,
    trace: {
      kind: "agent",
      model: env.gateway.modelId,
      permissionMode: config.permissionMode,
      shellApprovalPolicy: "never",
      workspaceAccessMode: "workspace-tools",
      prompt: config.prompt,
      outputSchema: config.outputSchema,
      input,
      text: finalAssistantText ?? assistantText,
      output,
      usedLastToolOutput: toolOutput !== null,
      durationMs: Date.now() - startedAt,
      attemptsConfigured: config.retry.maxAttempts,
      timeoutMs: config.timeoutMs,
      chunks: chunks.length,
    },
  };
}

function nodeEventPayload(node: FlowNode): Record<string, unknown> {
  return {
    nodeId: node.id,
    nodeType: node.type,
    title: node.title,
  };
}

function findWaitingApprovalNodeRun(
  nodeRuns: FlowNodeRun[],
): FlowNodeRun | null {
  for (let index = nodeRuns.length - 1; index >= 0; index--) {
    const nodeRun = nodeRuns[index];
    if (!nodeRun || nodeRun.status !== "succeeded") continue;
    if (extractApprovalRequestFromOutput(nodeRun.output)) return nodeRun;
  }
  return null;
}

function extractApprovalRequestFromOutput(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.approvalRequest)) return value.approvalRequest;
  if (value.status === "waiting_for_approval") return value;
  return null;
}

function buildApprovalDecisionOutput(params: {
  previousOutput: unknown;
  approved: boolean;
  response?: unknown;
}): Record<string, unknown> {
  const previous = isRecord(params.previousOutput) ? params.previousOutput : {};
  const previousRequest = extractApprovalRequestFromOutput(params.previousOutput);
  const approvedInput = isRecord(previousRequest?.input)
    ? previousRequest.input
    : {};
  const status = params.approved ? "approved" : "rejected";
  return {
    ...approvedInput,
    ...previous,
    approvalRequest: {
      ...(previousRequest ?? {}),
      status,
      decidedAt: Date.now(),
      response: params.response ?? null,
    },
    status,
    approved: params.approved,
    decision: params.approved ? "approved" : "rejected",
    response: params.response ?? null,
  };
}

function mergeTraceDecision(
  trace: unknown,
  decision: {
    approved: boolean;
    response?: unknown;
  },
): Record<string, unknown> {
  return {
    ...(isRecord(trace) ? trace : { previousTrace: trace }),
    decision: {
      approved: decision.approved,
      response: decision.response ?? null,
      decidedAt: Date.now(),
    },
  };
}

function collectArtifactsFromNodeOutput(params: {
  node: FlowNode;
  nodeRunId: string;
  flowRunId: string;
  output: unknown;
}): Array<{
  flowRunId: string;
  nodeRunId: string;
  kind: FlowArtifactKind;
  title: string;
  path?: string | null;
  mediaType?: string | null;
  metadata?: unknown;
}> {
  const artifacts: Array<{
    kind: FlowArtifactKind;
    title: string;
    path?: string | null;
    mediaType?: string | null;
    metadata?: unknown;
  }> = [];
  const seen = new Set<unknown>();
  collectExplicitArtifacts(params.output, seen, artifacts);
  collectImageArtifacts(params.output, new Set(), artifacts);
  return artifacts.map((artifact) => ({
    flowRunId: params.flowRunId,
    nodeRunId: params.nodeRunId,
    kind: artifact.kind,
    title: artifact.title || `${params.node.title} artifact`,
    path: artifact.path ?? null,
    mediaType: artifact.mediaType ?? null,
    metadata: {
      sourceNodeId: params.node.id,
      sourceNodeTitle: params.node.title,
      ...(isRecord(artifact.metadata) ? artifact.metadata : { value: artifact.metadata }),
    },
  }));
}

function collectItemsFromNodeOutput(params: {
  node: FlowNode;
  nodeRunId: string;
  flowRunId: string;
  output: unknown;
}): Array<{
  flowRunId: string;
  nodeRunId: string;
  externalId?: string | null;
  status?: FlowItemStatus;
  title: string;
  input?: unknown;
  output?: unknown | null;
  metadata?: unknown;
  error?: string | null;
}> {
  const candidates: unknown[] = [];
  collectExplicitItems(params.output, new Set(), candidates);
  return candidates.flatMap((candidate, index) => {
    const item = normalizeItemCandidate(candidate, index);
    if (!item) return [];
    return [
      {
        flowRunId: params.flowRunId,
        nodeRunId: params.nodeRunId,
        externalId: item.externalId,
        status: item.status,
        title: item.title || `${params.node.title} item ${index + 1}`,
        input: item.input,
        output: item.output,
        metadata: {
          sourceNodeId: params.node.id,
          sourceNodeTitle: params.node.title,
          ...(isRecord(item.metadata) ? item.metadata : { value: item.metadata }),
        },
        error: item.error,
      },
    ];
  });
}

function collectExplicitItems(
  value: unknown,
  seen: Set<unknown>,
  items: unknown[],
) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectExplicitItems(item, seen, items);
    return;
  }
  const record = value as Record<string, unknown>;
  const explicitItems = Array.isArray(record.flowItems)
    ? record.flowItems
    : Array.isArray(record.items)
      ? record.items
      : null;
  if (explicitItems) {
    items.push(...explicitItems);
  }
  for (const child of Object.values(record)) {
    collectExplicitItems(child, seen, items);
  }
}

function normalizeItemCandidate(
  value: unknown,
  index: number,
): {
  externalId?: string | null;
  status?: FlowItemStatus;
  title: string;
  input?: unknown;
  output?: unknown | null;
  metadata?: unknown;
  error?: string | null;
} | null {
  if (!isRecord(value)) return null;
  const status = normalizeFlowItemStatusForExecutor(value.status);
  const externalId =
    typeof value.externalId === "string"
      ? value.externalId
      : typeof value.id === "string"
        ? value.id
        : typeof value.url === "string"
          ? value.url
          : null;
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.trim()
      : typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : externalId ?? `Item ${index + 1}`;
  return {
    externalId,
    status,
    title,
    input: "input" in value ? value.input : value,
    output: "output" in value ? value.output : null,
    metadata: value.metadata ?? value,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function collectExplicitArtifacts(
  value: unknown,
  seen: Set<unknown>,
  artifacts: Array<{
    kind: FlowArtifactKind;
    title: string;
    path?: string | null;
    mediaType?: string | null;
    metadata?: unknown;
  }>,
) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectExplicitArtifacts(item, seen, artifacts);
    return;
  }
  const record = value as Record<string, unknown>;
  const maybeArtifacts = record.artifacts;
  if (Array.isArray(maybeArtifacts)) {
    for (const item of maybeArtifacts) {
      const artifact = normalizeArtifactCandidate(item);
      if (artifact) artifacts.push(artifact);
    }
  }
  for (const child of Object.values(record)) {
    collectExplicitArtifacts(child, seen, artifacts);
  }
}

function normalizeArtifactCandidate(value: unknown): {
  kind: FlowArtifactKind;
  title: string;
  path?: string | null;
  mediaType?: string | null;
  metadata?: unknown;
} | null {
  if (!isRecord(value)) return null;
  const kind = normalizeArtifactKindForExecutor(value.kind);
  if (!kind) return null;
  const pathValue =
    typeof value.path === "string"
      ? value.path
      : typeof value.absolutePath === "string"
        ? value.absolutePath
        : null;
  return {
    kind,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title.trim()
        : "Flow artifact",
    path: pathValue,
    mediaType: typeof value.mediaType === "string" ? value.mediaType : null,
    metadata: value.metadata ?? value,
  };
}

function collectImageArtifacts(
  value: unknown,
  seen: Set<unknown>,
  artifacts: Array<{
    kind: FlowArtifactKind;
    title: string;
    path?: string | null;
    mediaType?: string | null;
    metadata?: unknown;
  }>,
) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectImageArtifacts(item, seen, artifacts);
    return;
  }

  const record = value as Record<string, unknown>;
  const mediaType =
    typeof record.mediaType === "string" ? record.mediaType : null;
  const pathValue =
    typeof record.path === "string"
      ? record.path
      : typeof record.absolutePath === "string"
        ? record.absolutePath
        : null;
  if (mediaType?.startsWith("image/") && pathValue) {
    artifacts.push({
      kind: "image",
      title: typeof record.title === "string" ? record.title : "Image artifact",
      path: pathValue,
      mediaType,
      metadata: {
        prompt: typeof record.prompt === "string" ? record.prompt : null,
        bytesWritten:
          typeof record.bytesWritten === "number" ? record.bytesWritten : null,
      },
    });
  }

  for (const child of Object.values(record)) {
    collectImageArtifacts(child, seen, artifacts);
  }
}

async function createAgentNodeThread(params: {
  flow: FlowDefinition;
  nodeRunId: string;
  node: FlowNode;
}): Promise<string> {
  const threadId = `flow-node:${params.nodeRunId}`;
  await upsertThread({
    id: threadId,
    workspaceRoot: params.flow.workspaceRoot,
    workspaceName: params.flow.workspaceName ?? undefined,
    workspaceAccessMode: "workspace-tools",
    shellApprovalPolicy: "never",
    permissionMode: "bypassPermissions",
    planMode: false,
    title: `${params.flow.title} / ${params.node.title}`,
    model: env.gateway.modelId,
  });
  archiveThread(threadId);
  return threadId;
}

function buildNodeInput(
  node: FlowNode,
  edges: FlowEdge[],
  outputByNode: Map<string, unknown>,
): unknown {
  const upstream = edges
    .filter((edge) => edge.targetNodeId === node.id)
    .map((edge) => ({
      nodeId: edge.sourceNodeId,
      output: outputByNode.get(edge.sourceNodeId),
    }))
    .filter((item) => item.output !== undefined);

  if (upstream.length === 0) return {};
  if (upstream.length === 1) return upstream[0]?.output ?? {};
  return { inputs: upstream };
}

function applyNodeInputMapping(node: FlowNode, input: unknown): unknown {
  if (isFlowNodeType(node.type, "core.start")) return input;
  const config = normalizeGenericNodeConfig(node.config);
  const nodeOwnsInputPath =
    isFlowNodeType(node.type, "core.foreach") ||
    isFlowNodeType(node.type, "core.join") ||
    isFlowNodeType(node.type, "browser.extractArticle") ||
    isFlowNodeType(node.type, "document.planUpdate") ||
    isFlowNodeType(node.type, "document.applyPatch") ||
    isFlowNodeType(node.type, "approval.review");
  if (config.inputPath && !nodeOwnsInputPath) {
    return getPath(input, config.inputPath);
  }
  if (isRecord(config.inputMapping) && Object.keys(config.inputMapping).length > 0) {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config.inputMapping)) {
      output[key] =
        typeof value === "string" && isPathExpression(value)
          ? getPath(input, value)
          : value;
    }
    return output;
  }
  return input;
}

function coerceArrayFromValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.flowItems)) return value.flowItems;
    if (Array.isArray(value.results)) return value.results;
    if (Array.isArray(value.data)) return value.data;
  }
  if (value == null) return [];
  return [value];
}

function buildFlowItemLikeObject(params: {
  item: unknown;
  index: number;
  config: ReturnType<typeof normalizeGenericNodeConfig>;
}): Record<string, unknown> {
  const { item, index, config } = params;
  const titleValue = config.itemTitlePath
    ? getPath(item, config.itemTitlePath)
    : getPath(item, "$.title");
  const externalIdValue = config.itemExternalIdPath
    ? getPath(item, config.itemExternalIdPath)
    : getPath(item, "$.id");
  const statusValue = config.itemStatusPath
    ? getPath(item, config.itemStatusPath)
    : getPath(item, "$.status");
  const metadataValue = config.itemMetadataPath
    ? getPath(item, config.itemMetadataPath)
    : item;
  const title =
    typeof titleValue === "string" && titleValue.trim()
      ? titleValue.trim()
      : typeof getPath(item, "$.name") === "string"
        ? String(getPath(item, "$.name"))
        : `Item ${index + 1}`;
  const externalId =
    typeof externalIdValue === "string" && externalIdValue.trim()
      ? externalIdValue.trim()
      : typeof getPath(item, "$.url") === "string"
        ? String(getPath(item, "$.url"))
        : `item-${index + 1}`;
  const status = normalizeFlowItemStatusForExecutor(statusValue) ?? "discovered";
  return {
    externalId,
    title,
    status,
    input: item,
    metadata: metadataValue,
    index,
  };
}

function collectJoinableValues(value: unknown): unknown[] {
  const collected: unknown[] = [];
  collectJoinableValuesInner(value, new Set(), collected);
  return collected;
}

function collectJoinableValuesInner(
  value: unknown,
  seen: Set<unknown>,
  collected: unknown[],
) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJoinableValuesInner(item, seen, collected);
    return;
  }
  if (!isRecord(value)) {
    collected.push(value);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);

  for (const key of ["flowItems", "items", "results"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      collected.push(...child);
      return;
    }
  }
  if (Array.isArray(value.inputs)) {
    for (const input of value.inputs) {
      if (isRecord(input) && "output" in input) {
        collectJoinableValuesInner(input.output, seen, collected);
      } else {
        collectJoinableValuesInner(input, seen, collected);
      }
    }
    return;
  }
  collected.push(value);
}

type BrowserExtractedItem = {
  title: string;
  url: string;
  summary: string | null;
  text: string | null;
};

type BrowserExtractedArticle = {
  title: string;
  url: string;
  summary: string | null;
  content: string;
  text: string;
  sourceItem: unknown;
};

type BrowserSkippedArticle = {
  url: string;
  title: string | null;
  error: string;
  sourceItem: unknown;
};

async function extractListWithPlaywright(config: {
  url: string;
  itemSelector: string;
  titleSelector: string | null;
  hrefSelector: string | null;
  summarySelector: string | null;
  baseUrl: string;
  hrefIncludes: string | null;
  limit: number;
  timeoutMs: number;
}): Promise<BrowserExtractedItem[]> {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    });
    page.setDefaultTimeout(config.timeoutMs);
    await page.goto(config.url, {
      waitUntil: "domcontentloaded",
      timeout: config.timeoutMs,
    });
    await page.waitForLoadState("networkidle", {
      timeout: Math.min(config.timeoutMs, 10_000),
    }).catch(() => undefined);
    const items = await page.locator(config.itemSelector).evaluateAll(
      (
        elements,
        options: {
          titleSelector: string | null;
          hrefSelector: string | null;
          summarySelector: string | null;
          baseUrl: string;
          hrefIncludes: string | null;
          limit: number;
        },
      ) => {
        function cleanText(value: string | null | undefined): string {
          return (value ?? "").replace(/\s+/g, " ").trim();
        }
        function absoluteUrl(value: string | null | undefined): string {
          if (!value) return "";
          try {
            return new URL(value, options.baseUrl).toString();
          } catch {
            return value;
          }
        }
        function readHref(element: Element): string {
          const hrefElement = options.hrefSelector
            ? element.querySelector(options.hrefSelector)
            : element;
          return absoluteUrl(hrefElement?.getAttribute("href"));
        }
        function readText(element: Element, selector: string | null): string {
          const target = selector ? element.querySelector(selector) : element;
          return cleanText(target?.textContent);
        }

        const results: BrowserExtractedItem[] = [];
        for (const element of elements) {
          const url = readHref(element);
          if (!url) continue;
          if (options.hrefIncludes && !url.includes(options.hrefIncludes)) {
            continue;
          }
          const title = readText(element, options.titleSelector);
          const summary = options.summarySelector
            ? readText(element, options.summarySelector)
            : "";
          results.push({
            title: title || url,
            url,
            summary: summary || null,
            text: cleanText(element.textContent),
          });
          if (results.length >= options.limit) break;
        }
        return results;
      },
      {
        titleSelector: config.titleSelector,
        hrefSelector: config.hrefSelector,
        summarySelector: config.summarySelector,
        baseUrl: config.baseUrl,
        hrefIncludes: config.hrefIncludes,
        limit: config.limit,
      },
    );
    return items;
  } finally {
    await browser.close();
  }
}

async function extractListFromHtml(config: {
  url: string;
  baseUrl: string;
  hrefIncludes: string | null;
  limit: number;
  timeoutMs: number;
}): Promise<BrowserExtractedItem[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      },
    });
    if (!response.ok) {
      throw new Error(`Fetch failed with ${response.status}.`);
    }
    const html = await response.text();
    return extractAnchorItemsFromHtml({
      html,
      baseUrl: config.baseUrl,
      hrefIncludes: config.hrefIncludes,
      limit: config.limit,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractAnchorItemsFromHtml(params: {
  html: string;
  baseUrl: string;
  hrefIncludes: string | null;
  limit: number;
}): BrowserExtractedItem[] {
  const items: BrowserExtractedItem[] = [];
  const anchorPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(params.html)) !== null) {
    const rawHref = decodeHtmlEntity(match[2] ?? "");
    const url = normalizeUrl(rawHref, params.baseUrl);
    if (!url) continue;
    if (params.hrefIncludes && !url.includes(params.hrefIncludes)) continue;
    const title = stripHtml(match[3] ?? "");
    items.push({
      title: title || url,
      url,
      summary: null,
      text: title || null,
    });
    if (items.length >= params.limit * 3) break;
  }
  return items;
}

function normalizeBrowserExtractedItems(params: {
  items: BrowserExtractedItem[];
  config: { limit: number };
  url: string;
}): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const output: Array<Record<string, unknown>> = [];
  for (const item of params.items) {
    const normalizedUrl = normalizeUrl(item.url, params.url);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    output.push({
      id: normalizedUrl,
      externalId: normalizedUrl,
      title: item.title || normalizedUrl,
      url: normalizedUrl,
      summary: item.summary,
      text: item.text,
      status: "discovered",
      input: {
        url: normalizedUrl,
        title: item.title || normalizedUrl,
        summary: item.summary,
      },
      metadata: {
        sourceUrl: params.url,
      },
    });
    if (output.length >= params.config.limit) break;
  }
  return output;
}

function resolveBrowserExtractListUrl(params: {
  configuredUrl: string;
  urlFromInput: unknown;
  searchQuery: unknown;
  searchUrlTemplate: string | null;
}): string {
  const explicitUrl = coerceNonEmptyString(params.urlFromInput);
  if (explicitUrl) return explicitUrl;

  const query = coerceSearchQuery(params.searchQuery);
  if (!query) return params.configuredUrl;

  if (params.searchUrlTemplate) {
    return params.searchUrlTemplate.replaceAll(
      "{query}",
      encodeURIComponent(query),
    );
  }

  if (params.configuredUrl === "https://juejin.cn/frontend") {
    return `https://juejin.cn/search?query=${encodeURIComponent(query)}&type=0`;
  }

  return params.configuredUrl;
}

function coerceSearchQuery(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return null;
  return (
    coerceNonEmptyString(value.query) ??
    coerceNonEmptyString(value.keyword) ??
    coerceNonEmptyString(value.topic) ??
    coerceNonEmptyString(value.input)
  );
}

function isJuejinFrontendUrl(value: string): boolean {
  return value === "https://juejin.cn/frontend";
}

async function extractJuejinSearchList(params: {
  query: string;
  limit: number;
  timeoutMs: number;
}): Promise<BrowserExtractedItem[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(
      "https://api.juejin.cn/search_api/v1/search?aid=2608&spider=0",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        },
        body: JSON.stringify({
          id_type: 0,
          key_word: params.query,
          cursor: "0",
          limit: params.limit,
          search_type: 0,
          sort_type: 0,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Juejin search API HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || payload.err_no !== 0 || !Array.isArray(payload.data)) {
      throw new Error("Juejin search API returned an unexpected payload.");
    }
    return payload.data.flatMap((entry) => {
      if (!isRecord(entry) || !isRecord(entry.result_model)) return [];
      const articleInfo = isRecord(entry.result_model.article_info)
        ? entry.result_model.article_info
        : null;
      if (!articleInfo) return [];
      const articleId = coerceNonEmptyString(articleInfo.article_id);
      if (!articleId) return [];
      const title = stripHtml(coerceNonEmptyString(articleInfo.title) ?? "");
      const summary = stripHtml(coerceNonEmptyString(articleInfo.brief_content) ?? "");
      return [
        {
          title: title || articleId,
          url: `https://juejin.cn/post/${articleId}`,
          summary: summary || null,
          text: title || summary || null,
        },
      ];
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function extractArticlesWithPlaywright(params: {
  candidates: unknown[];
  config: {
    urlPath: string | null;
    titleSelector: string | null;
    contentSelector: string;
    summarySelector: string | null;
    timeoutMs: number;
  };
}): Promise<{
  articles: BrowserExtractedArticle[];
  skippedArticles: BrowserSkippedArticle[];
}> {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    });
    page.setDefaultTimeout(params.config.timeoutMs);
    const articles: BrowserExtractedArticle[] = [];
    const skippedArticles: BrowserSkippedArticle[] = [];
    for (const candidate of params.candidates) {
      const url = getArticleCandidateUrl(candidate, params.config.urlPath);
      if (!url) continue;
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: params.config.timeoutMs,
        });
        await page
          .waitForLoadState("networkidle", {
            timeout: Math.min(params.config.timeoutMs, 10_000),
          })
          .catch(() => undefined);
        const article = await page.evaluate(
          (
            options: {
              url: string;
              titleSelector: string | null;
              contentSelector: string;
              summarySelector: string | null;
              sourceItem: unknown;
            },
          ) => {
            function cleanText(value: string | null | undefined): string {
              return (value ?? "").replace(/\s+/g, " ").trim();
            }
            function readText(selector: string | null, fallback: Element | null): string {
              const target = selector ? document.querySelector(selector) : fallback;
              return cleanText(target?.textContent);
            }
            const contentElement =
              document.querySelector(options.contentSelector) ?? document.body;
            const title =
              readText(options.titleSelector, null) ||
              cleanText(document.querySelector("h1")?.textContent) ||
              document.title ||
              options.url;
            const summary = options.summarySelector
              ? readText(options.summarySelector, contentElement)
              : "";
            const content = cleanText(contentElement?.textContent);
            return {
              title,
              url: options.url,
              summary: summary || null,
              content,
              text: content,
              sourceItem: options.sourceItem,
            } satisfies BrowserExtractedArticle;
          },
          {
            url,
            titleSelector: params.config.titleSelector,
            contentSelector: params.config.contentSelector,
            summarySelector: params.config.summarySelector,
            sourceItem: candidate,
          },
        );
        articles.push(article);
      } catch (error) {
        skippedArticles.push({
          url,
          title: getArticleCandidateTitle(candidate),
          error: error instanceof Error ? error.message : "Article extraction failed.",
          sourceItem: candidate,
        });
      }
    }
    return { articles, skippedArticles };
  } finally {
    await browser.close();
  }
}

async function extractArticlesFromHtml(params: {
  candidates: unknown[];
  config: {
    urlPath: string | null;
    timeoutMs: number;
  };
}): Promise<{
  articles: BrowserExtractedArticle[];
  skippedArticles: BrowserSkippedArticle[];
}> {
  const articles: BrowserExtractedArticle[] = [];
  const skippedArticles: BrowserSkippedArticle[] = [];
  for (const candidate of params.candidates) {
    const url = getArticleCandidateUrl(candidate, params.config.urlPath);
    if (!url) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.config.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        },
      });
      if (!response.ok) {
        skippedArticles.push({
          url,
          title: getArticleCandidateTitle(candidate),
          error: `HTTP ${response.status}`,
          sourceItem: candidate,
        });
        continue;
      }
      const html = await response.text();
      const title = extractHtmlTitle(html) ?? getArticleCandidateTitle(candidate) ?? url;
      const content = stripHtml(extractHtmlArticleBody(html));
      articles.push({
        title,
        url,
        summary: null,
        content,
        text: content,
        sourceItem: candidate,
      });
    } catch (error) {
      skippedArticles.push({
        url,
        title: getArticleCandidateTitle(candidate),
        error: error instanceof Error ? error.message : "Article fetch failed.",
        sourceItem: candidate,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return { articles, skippedArticles };
}

function normalizeBrowserExtractedArticles(params: {
  articles: BrowserExtractedArticle[];
  sourceInput: unknown;
}): Array<Record<string, unknown>> {
  return params.articles.map((article) => {
    const content = truncateText(article.content, 16_000);
    return {
      id: article.url,
      externalId: article.url,
      title: article.title,
      url: article.url,
      summary: article.summary ?? truncateText(content, 280),
      status: "discovered",
      input: article.sourceItem,
      output: {
        title: article.title,
        url: article.url,
        summary: article.summary,
        content,
      },
      metadata: {
        sourceUrl: article.url,
        sourceItem: article.sourceItem,
        sourceInput: params.sourceInput,
        contentLength: article.content.length,
      },
    };
  });
}

function getArticleCandidateUrl(candidate: unknown, urlPath: string | null): string {
  const fromPath = urlPath ? getPath(candidate, urlPath) : null;
  const fromPathString = coerceNonEmptyString(fromPath);
  if (fromPathString) return normalizeUrl(fromPathString, fromPathString);
  if (isRecord(candidate)) {
    for (const key of ["url", "href", "externalId", "id"]) {
      const value = coerceNonEmptyString(candidate[key]);
      if (value?.startsWith("http")) return value;
    }
    if (isRecord(candidate.input)) {
      const value = coerceNonEmptyString(candidate.input.url);
      if (value) return value;
    }
  }
  const direct = coerceNonEmptyString(candidate);
  return direct?.startsWith("http") ? direct : "";
}

function getArticleCandidateTitle(candidate: unknown): string | null {
  if (!isRecord(candidate)) return null;
  return coerceNonEmptyString(candidate.title) ?? coerceNonEmptyString(candidate.name);
}

function extractHtmlTitle(html: string): string | null {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (h1) return stripHtml(h1);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return title ? stripHtml(title) : null;
}

function extractHtmlArticleBody(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1];
  if (article) return article;
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
  if (main) return main;
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  return body ?? html;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

type DocumentPlannedChange = {
  action: "create";
  path: string;
  absolutePath: string;
  title: string;
  sourceUrl: string;
  content: string;
  metadata: Record<string, unknown>;
};

function buildDocumentPlannedChange(params: {
  candidate: unknown;
  index: number;
  config: ReturnType<typeof normalizeDocumentPlanUpdateNodeConfig>;
}): DocumentPlannedChange[] {
  const title = getDocumentCandidateTitle(params.candidate) ?? `Source ${params.index + 1}`;
  const sourceUrl = getDocumentCandidateUrl(params.candidate);
  if (!sourceUrl) return [];
  const slug = slugifyForPath(title || sourceUrl, sourceUrl);
  const date = formatDateInTimeZone(new Date(), "Asia/Shanghai");
  const relativePath = joinRelativePath(
    params.config.outputDir,
    `${date}_${params.config.sourceType}_${params.config.publisher}_${slug}.md`,
  );
  const content = buildSourceNoteMarkdown({
    title,
    sourceUrl,
    sourceType: params.config.sourceType,
    publisher: params.config.publisher,
    topic: params.config.topic,
    tags: params.config.tags,
    candidate: params.candidate,
  });
  return [
    {
      action: "create",
      path: relativePath,
      absolutePath: `${params.config.targetRoot}/${relativePath}`,
      title,
      sourceUrl,
      content,
      metadata: {
        sourceType: params.config.sourceType,
        publisher: params.config.publisher,
        topic: params.config.topic,
        tags: params.config.tags,
      },
    },
  ];
}

function buildSourceNoteMarkdown(params: {
  title: string;
  sourceUrl: string;
  sourceType: string;
  publisher: string;
  topic: string;
  tags: string[];
  candidate: unknown;
}): string {
  const article = extractDocumentCandidateArticle(params.candidate);
  const processedAt = new Date().toISOString();
  const rawContent = article.content || article.text || "";
  const content = cleanArticleContent(rawContent);
  const summary = buildArticleSummary({
    title: params.title,
    summary: article.summary,
    content,
  });
  const keyPoints = extractArticleBulletPoints(content, {
    fallbackTitle: params.title,
    keywords: [
      "核心",
      "区别",
      "优点",
      "缺点",
      "请求",
      "响应",
      "类型",
      "函数",
      "接口",
      "泛型",
      "axios",
      "XHR",
      "XMLHttpRequest",
      "TypeScript",
    ],
    limit: 3,
  });
  const facts = extractArticleBulletPoints(content, {
    fallbackTitle: params.title,
    keywords: [
      "步骤",
      "安装",
      "配置",
      "语法",
      "参数",
      "返回",
      "编译",
      "运行",
      "示例",
      "代码",
    ],
    limit: 3,
  });
  const methods = extractArticleSections(content, 2);
  const retained = extractArticleBulletPoints(content, {
    fallbackTitle: params.title,
    keywords: ["推荐", "适合", "实践", "项目", "维护", "团队", "封装", "复用"],
    limit: 3,
  });
  return [
    "---",
    "type: source_note",
    `source_type: ${params.sourceType}`,
    "status: draft",
    `topic: ${params.topic}`,
    `tags: [${params.tags.join(", ")}]`,
    `source_title: ${escapeYamlScalar(params.title)}`,
    `source_url: ${escapeYamlScalar(params.sourceUrl)}`,
    "author:",
    `publisher: ${escapeYamlScalar(params.publisher)}`,
    "published_at:",
    `processed_at: ${processedAt}`,
    "---",
    "",
    `# ${params.title}`,
    "",
    "## 来源信息",
    "",
    `- 原文链接：${params.sourceUrl}`,
    "- 作者：",
    `- 发布平台：${params.publisher}`,
    "- 发布时间：",
    "",
    "## 一句话摘要",
    "",
    summary,
    "",
    "## 核心观点",
    "",
    ...keyPoints.map((point) => `- ${point}`),
    "",
    "## 关键事实 / 数据 / 论据",
    "",
    ...facts.map((point) => `- ${point}`),
    "",
    "## 方法 / 框架 / 流程",
    "",
    ...methods.map((point) => `- ${point}`),
    "",
    "## 我认为最值得保留的内容",
    "",
    `- 可复用结论：${retained[0] ?? summary}`,
    `- 可引用表达：${retained[1] ?? "待二次精读后补充可直接引用的原文表达。"}`,
    `- 可延展讨论：${retained[2] ?? "可继续和同主题资料对照，判断是否并入主题笔记。"}`,
    "",
    "## 原文摘录",
    "",
    truncateText(content, 4_000) || "待补充。",
    "",
    "## 与哪些主题相关",
    "",
    params.topic ? `- [[${params.topic}]]` : "- 待补充",
    "",
    "## 下一步动作",
    "",
    "- 是否需要并入某个主题笔记",
    "- 是否值得输出成分享内容",
    "- 是否需要补充对照资料",
    "",
  ].join("\n");
}

function buildUnifiedDiffPreview(changes: DocumentPlannedChange[]): string {
  return changes
    .map((change) => {
      const lines = change.content.split("\n").map((line) => `+${line}`);
      return [`diff --git a/${change.path} b/${change.path}`, "new file mode 100644", "--- /dev/null", `+++ b/${change.path}`, "@@", ...lines].join("\n");
    })
    .join("\n");
}

function extractDocumentCandidateArticle(candidate: unknown): {
  title: string | null;
  url: string | null;
  summary: string | null;
  content: string | null;
  text: string | null;
} {
  const record = isRecord(candidate) ? candidate : {};
  const output = isRecord(record.output) ? record.output : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  return {
    title:
      coerceNonEmptyString(output.title) ??
      coerceNonEmptyString(record.title) ??
      null,
    url:
      coerceNonEmptyString(output.url) ??
      coerceNonEmptyString(record.url) ??
      coerceNonEmptyString(record.externalId) ??
      null,
    summary:
      coerceNonEmptyString(output.summary) ??
      coerceNonEmptyString(record.summary) ??
      null,
    content:
      coerceNonEmptyString(output.content) ??
      coerceNonEmptyString(metadata.content) ??
      null,
    text:
      coerceNonEmptyString(record.text) ??
      coerceNonEmptyString(output.text) ??
      null,
  };
}

function getDocumentCandidateTitle(candidate: unknown): string | null {
  return extractDocumentCandidateArticle(candidate).title;
}

function getDocumentCandidateUrl(candidate: unknown): string | null {
  return extractDocumentCandidateArticle(candidate).url;
}

function slugifyForPath(value: string, fallbackUrl?: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii) return ascii.slice(0, 80);
  const urlTail = fallbackUrl ? /\/([^/?#]+)(?:[?#].*)?$/.exec(fallbackUrl)?.[1] : null;
  if (urlTail) return urlTail.slice(0, 80);
  return Buffer.from(value).toString("hex").slice(0, 32);
}

function joinRelativePath(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function escapeYamlScalar(value: string): string {
  return JSON.stringify(value);
}

type NormalizedDocumentPlannedChange = {
  action: "create";
  path: string;
  title: string;
  content: string;
  sourceUrl: string | null;
  metadata: unknown;
};

async function applyDocumentPlannedChange(params: {
  change: NormalizedDocumentPlannedChange;
  config: ReturnType<typeof normalizeDocumentApplyPatchNodeConfig>;
}): Promise<Record<string, unknown>> {
  const targetRoot = path.resolve(params.config.targetRoot);
  const targetPath = resolvePathInsideRoot(targetRoot, params.change.path);
  if (!targetPath) {
    return {
      status: "failed",
      action: params.change.action,
      path: params.change.path,
      title: params.change.title,
      error: "Target path escapes targetRoot.",
    };
  }

  const exists = await fileExists(targetPath);
  if (exists && params.config.conflictPolicy === "skip") {
    return {
      status: "skipped",
      reason: "exists",
      action: params.change.action,
      path: params.change.path,
      absolutePath: targetPath,
      title: params.change.title,
    };
  }

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, params.change.content, "utf8");
    return {
      status: "applied",
      action: params.change.action,
      path: params.change.path,
      absolutePath: targetPath,
      title: params.change.title,
      sourceUrl: params.change.sourceUrl,
      bytesWritten: Buffer.byteLength(params.change.content, "utf8"),
    };
  } catch (error) {
    return {
      status: "failed",
      action: params.change.action,
      path: params.change.path,
      absolutePath: targetPath,
      title: params.change.title,
      error: error instanceof Error ? error.message : "Unable to write file.",
    };
  }
}

function normalizePlannedChanges(value: unknown): NormalizedDocumentPlannedChange[] {
  const approvalInput = isRecord(value)
    ? extractApprovalRequestFromOutput(value)?.input
    : null;
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.plannedChanges)
      ? value.plannedChanges
      : isRecord(approvalInput) && Array.isArray(approvalInput.plannedChanges)
        ? approvalInput.plannedChanges
        : [];
  return source.flatMap((item) => {
    if (!isRecord(item)) return [];
    const action = item.action === "create" ? "create" : null;
    const relativePath = coerceNonEmptyString(item.path);
    const title = coerceNonEmptyString(item.title) ?? relativePath ?? "Document change";
    const content = coerceNonEmptyString(item.content);
    if (!action || !relativePath || content === null) return [];
    return [
      {
        action,
        path: relativePath,
        title,
        content,
        sourceUrl: coerceNonEmptyString(item.sourceUrl),
        metadata: item.metadata ?? {},
      },
    ];
  });
}

function resolvePathInsideRoot(root: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(value: string, baseUrl: string): string {
  if (!value.trim()) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value.trim();
  }
}

function stripHtml(value: string): string {
  return decodeHtmlEntity(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntity(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function coerceNonEmptyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function summarizeApprovalPayload(value: unknown): string {
  if (Array.isArray(value)) {
    return `等待人工审批 ${value.length} 个对象。`;
  }
  if (isRecord(value)) {
    const count = Array.isArray(value.items)
      ? value.items.length
      : Array.isArray(value.flowItems)
        ? value.flowItems.length
        : Array.isArray(value.results)
          ? value.results.length
          : null;
    if (count !== null) {
      return `等待人工审批 ${count} 个对象。`;
    }
  }
  const text = stableStringify(value).replace(/\s+/g, " ").trim();
  return text.length > 160
    ? `${text.slice(0, 157)}...`
    : text || "等待人工审批。";
}

function selectOutgoingEdges(params: {
  node: FlowNode;
  edges: FlowEdge[];
  output: unknown;
}): FlowEdge[] {
  const outgoing = params.edges.filter((edge) => edge.sourceNodeId === params.node.id);
  const conditional = outgoing.filter((edge) => edge.condition != null);
  if (conditional.length === 0) return outgoing;

  const matched = conditional.filter((edge) =>
    evaluateCondition(edge.condition, params.output),
  );
  if (matched.length > 0) return matched;
  return outgoing.filter((edge) => edge.condition == null);
}

function buildPromptText(params: {
  prompt: string;
  input: unknown;
  outputSchema: Record<string, unknown> | null;
}): string {
  const parts = [
    "You are executing a single node inside a workflow canvas.",
    "This user message was generated automatically by the Flow runtime, not typed directly by the end user.",
    "Use the same workspace tools as the normal Chat agent when the node task needs files, shell commands, or other workspace actions.",
    "Do not ask the user for confirmation during this node run. The workflow runner has already selected bypass permission mode for this execution.",
    "",
    "Node instruction:",
    params.prompt,
    "",
    "Input JSON:",
    stableStringify(params.input),
    "",
  ];

  if (params.outputSchema) {
    parts.push(
      "Output JSON schema:",
      stableStringify(params.outputSchema),
      "",
      "When all needed tool work is complete, return only valid JSON that matches the output schema.",
    );
  } else {
    parts.push(
      "When all needed tool work is complete, return only a valid JSON object.",
    );
  }

  return parts.join("\n");
}

function isNodeReady(params: {
  node: FlowNode;
  edges: FlowEdge[];
  executed: Set<string>;
  reachableNodeIds: Set<string>;
}): boolean {
  if (isFlowNodeType(params.node.type, "core.start")) return true;
  const incomingReachableEdges = params.edges.filter(
    (edge) =>
      edge.targetNodeId === params.node.id &&
      params.reachableNodeIds.has(edge.sourceNodeId),
  );
  if (incomingReachableEdges.length > 1) {
    return incomingReachableEdges.some((edge) =>
      params.executed.has(edge.sourceNodeId),
    );
  }
  return incomingReachableEdges.every((edge) =>
    params.executed.has(edge.sourceNodeId),
  );
}

function collectReachableNodeIdsFrom(
  startNodeIds: string[],
  edges: FlowEdge[],
): Set<string> {
  const reachable = new Set<string>(startNodeIds);
  const queue = [...startNodeIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const edge of edges) {
      if (edge.sourceNodeId !== current || reachable.has(edge.targetNodeId)) {
        continue;
      }
      reachable.add(edge.targetNodeId);
      queue.push(edge.targetNodeId);
    }
  }
  return reachable;
}

function findFinalOutput(
  nodes: FlowNode[],
  outputByNode: Map<string, unknown>,
): unknown | null {
  const endNode = nodes.find((node) => isFlowNodeType(node.type, "core.end"));
  if (endNode && outputByNode.has(endNode.id)) {
    return outputByNode.get(endNode.id) ?? null;
  }
  let lastOutput: unknown | null = null;
  for (const output of outputByNode.values()) {
    lastOutput = output;
  }
  return lastOutput;
}

function getConfiguredStartInput(node: FlowNode): unknown {
  if (!node.config || typeof node.config !== "object") return {};
  const config = node.config as { input?: unknown };
  return config.input ?? {};
}

function normalizePromptConfig(config: unknown): NormalizedPromptConfig {
  const maybe = isRecord(config) ? (config as PromptNodeConfig) : {};
  return {
    prompt:
      typeof maybe.prompt === "string" && maybe.prompt.trim()
        ? maybe.prompt.trim()
        : "Use the input JSON and return the next JSON object.",
    outputSchema: normalizeOutputSchema(maybe.outputSchema),
    retry: normalizeRetryConfig(maybe.retry),
    timeoutMs: normalizeTimeoutMs(maybe.timeoutMs),
    permissionMode: normalizePermissionMode(
      typeof maybe.permissionMode === "string"
        ? maybe.permissionMode
        : "bypassPermissions",
    ),
    useLastToolOutputAsOutput: maybe.useLastToolOutputAsOutput === true,
  };
}

function normalizeGenericNodeConfig(config: unknown): {
  inputMapping: unknown;
  inputPath: string | null;
  outputPath: string | null;
  condition: unknown;
  itemTitlePath: string | null;
  itemExternalIdPath: string | null;
  itemStatusPath: string | null;
  itemMetadataPath: string | null;
  limit: number;
  outputKey: string | null;
} {
  const maybe = isRecord(config) ? (config as GenericNodeConfig) : {};
  return {
    inputMapping: maybe.inputMapping,
    inputPath: typeof maybe.inputPath === "string" && maybe.inputPath.trim()
      ? maybe.inputPath.trim()
      : null,
    outputPath: typeof maybe.outputPath === "string" && maybe.outputPath.trim()
      ? maybe.outputPath.trim()
      : null,
    condition: maybe.condition,
    itemTitlePath: typeof maybe.itemTitlePath === "string" && maybe.itemTitlePath.trim()
      ? maybe.itemTitlePath.trim()
      : null,
    itemExternalIdPath:
      typeof maybe.itemExternalIdPath === "string" &&
      maybe.itemExternalIdPath.trim()
        ? maybe.itemExternalIdPath.trim()
        : null,
    itemStatusPath: typeof maybe.itemStatusPath === "string" && maybe.itemStatusPath.trim()
      ? maybe.itemStatusPath.trim()
      : null,
    itemMetadataPath:
      typeof maybe.itemMetadataPath === "string" && maybe.itemMetadataPath.trim()
        ? maybe.itemMetadataPath.trim()
        : null,
    limit: normalizePositiveInteger(maybe.limit, 50, 1, 500),
    outputKey: typeof maybe.outputKey === "string" && maybe.outputKey.trim()
      ? maybe.outputKey.trim()
      : null,
  };
}

function normalizeApprovalNodeConfig(config: unknown): {
  inputMapping: unknown;
  inputPath: string | null;
  titlePath: string | null;
  summaryPath: string | null;
  approvalMode: "manual";
} {
  const maybe = isRecord(config) ? (config as ApprovalNodeConfig) : {};
  return {
    inputMapping: maybe.inputMapping,
    inputPath: typeof maybe.inputPath === "string" && maybe.inputPath.trim()
      ? maybe.inputPath.trim()
      : "$",
    titlePath: typeof maybe.titlePath === "string" && maybe.titlePath.trim()
      ? maybe.titlePath.trim()
      : "$.title",
    summaryPath: typeof maybe.summaryPath === "string" && maybe.summaryPath.trim()
      ? maybe.summaryPath.trim()
      : "$.summary",
    approvalMode: "manual",
  };
}

function normalizeBrowserExtractListNodeConfig(config: unknown): {
  inputMapping: unknown;
  url: string;
  urlPath: string | null;
  searchQueryPath: string | null;
  searchUrlTemplate: string | null;
  itemSelector: string;
  titleSelector: string | null;
  hrefSelector: string | null;
  summarySelector: string | null;
  hrefIncludes: string | null;
  baseUrl: string;
  limit: number;
  timeoutMs: number;
} {
  const maybe = isRecord(config) ? (config as BrowserExtractListNodeConfig) : {};
  const url =
    typeof maybe.url === "string" && maybe.url.trim()
      ? maybe.url.trim()
      : "https://juejin.cn/frontend";
  return {
    inputMapping: maybe.inputMapping,
    url,
    urlPath: typeof maybe.urlPath === "string" && maybe.urlPath.trim()
      ? maybe.urlPath.trim()
      : null,
    searchQueryPath:
      typeof maybe.searchQueryPath === "string" && maybe.searchQueryPath.trim()
        ? maybe.searchQueryPath.trim()
        : "$.input",
    searchUrlTemplate:
      typeof maybe.searchUrlTemplate === "string" && maybe.searchUrlTemplate.trim()
        ? maybe.searchUrlTemplate.trim()
        : null,
    itemSelector:
      typeof maybe.itemSelector === "string" && maybe.itemSelector.trim()
        ? maybe.itemSelector.trim()
        : "a[href*=\"/post/\"]",
    titleSelector:
      typeof maybe.titleSelector === "string" && maybe.titleSelector.trim()
        ? maybe.titleSelector.trim()
        : null,
    hrefSelector:
      typeof maybe.hrefSelector === "string" && maybe.hrefSelector.trim()
        ? maybe.hrefSelector.trim()
        : null,
    summarySelector:
      typeof maybe.summarySelector === "string" && maybe.summarySelector.trim()
        ? maybe.summarySelector.trim()
        : null,
    hrefIncludes:
      typeof maybe.hrefIncludes === "string" && maybe.hrefIncludes.trim()
        ? maybe.hrefIncludes.trim()
        : "/post/",
    baseUrl:
      typeof maybe.baseUrl === "string" && maybe.baseUrl.trim()
        ? maybe.baseUrl.trim()
        : url,
    limit: normalizePositiveInteger(maybe.limit, 20, 1, 100),
    timeoutMs: normalizePositiveInteger(maybe.timeoutMs, 30_000, 1_000, 120_000),
  };
}

function normalizeBrowserExtractArticleNodeConfig(config: unknown): {
  inputMapping: unknown;
  inputPath: string | null;
  urlPath: string | null;
  titleSelector: string | null;
  contentSelector: string;
  summarySelector: string | null;
  limit: number;
  timeoutMs: number;
} {
  const maybe = isRecord(config) ? (config as BrowserExtractListNodeConfig) : {};
  return {
    inputMapping: maybe.inputMapping,
    inputPath: typeof maybe.inputPath === "string" && maybe.inputPath.trim()
      ? maybe.inputPath.trim()
      : "$.items",
    urlPath: typeof maybe.urlPath === "string" && maybe.urlPath.trim()
      ? maybe.urlPath.trim()
      : "$.url",
    titleSelector:
      typeof maybe.titleSelector === "string" && maybe.titleSelector.trim()
        ? maybe.titleSelector.trim()
        : "h1",
    contentSelector:
      typeof maybe.contentSelector === "string" && maybe.contentSelector.trim()
        ? maybe.contentSelector.trim()
        : "article, .article-content, .markdown-body, main",
    summarySelector:
      typeof maybe.summarySelector === "string" && maybe.summarySelector.trim()
        ? maybe.summarySelector.trim()
        : null,
    limit: normalizePositiveInteger(maybe.limit, 5, 1, 20),
    timeoutMs: normalizePositiveInteger(maybe.timeoutMs, 30_000, 1_000, 120_000),
  };
}

function normalizeDocumentPlanUpdateNodeConfig(config: unknown): {
  inputMapping: unknown;
  inputPath: string | null;
  targetRoot: string;
  outputDir: string;
  sourceType: string;
  publisher: string;
  topic: string;
  tags: string[];
  limit: number;
} {
  const maybe = isRecord(config) ? (config as DocumentPlanUpdateNodeConfig) : {};
  return {
    inputMapping: maybe.inputMapping,
    inputPath: typeof maybe.inputPath === "string" && maybe.inputPath.trim()
      ? maybe.inputPath.trim()
      : "$.items",
    targetRoot:
      typeof maybe.targetRoot === "string" && maybe.targetRoot.trim()
        ? maybe.targetRoot.trim()
        : "/Users/apple/Desktop/project/document",
    outputDir:
      typeof maybe.outputDir === "string" && maybe.outputDir.trim()
        ? maybe.outputDir.trim()
        : "wiki/sources",
    sourceType:
      typeof maybe.sourceType === "string" && maybe.sourceType.trim()
        ? maybe.sourceType.trim()
        : "article",
    publisher:
      typeof maybe.publisher === "string" && maybe.publisher.trim()
        ? maybe.publisher.trim()
        : "juejin",
    topic:
      typeof maybe.topic === "string" && maybe.topic.trim()
        ? maybe.topic.trim()
        : "",
    tags: Array.isArray(maybe.tags)
      ? maybe.tags.flatMap((tag) =>
          typeof tag === "string" && tag.trim() ? [tag.trim()] : [],
        )
      : ["source/article", "source/juejin"],
    limit: normalizePositiveInteger(maybe.limit, 5, 1, 20),
  };
}

function normalizeDocumentApplyPatchNodeConfig(config: unknown): {
  inputMapping: unknown;
  inputPath: string | null;
  targetRoot: string;
  conflictPolicy: "skip" | "overwrite";
} {
  const maybe = isRecord(config) ? (config as DocumentApplyPatchNodeConfig) : {};
  const conflictPolicy =
    maybe.conflictPolicy === "overwrite" ? "overwrite" : "skip";
  return {
    inputMapping: maybe.inputMapping,
    inputPath: typeof maybe.inputPath === "string" && maybe.inputPath.trim()
      ? maybe.inputPath.trim()
      : "$.plannedChanges",
    targetRoot:
      typeof maybe.targetRoot === "string" && maybe.targetRoot.trim()
        ? maybe.targetRoot.trim()
        : "/Users/apple/Desktop/project/document",
    conflictPolicy,
  };
}

function normalizeRetryConfig(value: unknown): RetryConfig {
  if (!isRecord(value)) {
    return { maxAttempts: 3 };
  }
  const maybe = value as { maxAttempts?: unknown };
  if (
    typeof maybe.maxAttempts === "number" &&
    Number.isFinite(maybe.maxAttempts) &&
    maybe.maxAttempts > 0
  ) {
    return { maxAttempts: Math.min(5, Math.floor(maybe.maxAttempts)) };
  }
  return { maxAttempts: 3 };
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}

function normalizeOutputSchema(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).length === 0) return null;
  return value;
}

function normalizeTimeoutMs(value: unknown): number | null {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1_000
  ) {
    return Math.min(300_000, Math.floor(value));
  }
  return 60_000;
}

function createTimeoutController(timeoutMs: number | null): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (!timeoutMs) {
    return {
      signal: controller.signal,
      dispose: () => {},
    };
  }
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Flow node timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evaluateCondition(condition: unknown, value: unknown): boolean {
  if (condition == null) return true;
  if (typeof condition === "boolean") return condition;
  if (typeof condition === "string") return Boolean(getPath(value, condition));
  if (!isRecord(condition)) return false;

  const pathValue =
    typeof condition.path === "string" && condition.path.trim()
      ? getPath(value, condition.path)
      : value;

  if ("exists" in condition) {
    return condition.exists ? pathValue !== undefined : pathValue === undefined;
  }
  if ("truthy" in condition) {
    return condition.truthy ? Boolean(pathValue) : !pathValue;
  }
  if ("equals" in condition) {
    return isDeepEqual(pathValue, condition.equals);
  }
  if ("notEquals" in condition) {
    return !isDeepEqual(pathValue, condition.notEquals);
  }
  if ("contains" in condition) {
    return valueContains(pathValue, condition.contains);
  }
  if ("gt" in condition) {
    return compareNumber(pathValue, condition.gt, (left, right) => left > right);
  }
  if ("gte" in condition) {
    return compareNumber(pathValue, condition.gte, (left, right) => left >= right);
  }
  if ("lt" in condition) {
    return compareNumber(pathValue, condition.lt, (left, right) => left < right);
  }
  if ("lte" in condition) {
    return compareNumber(pathValue, condition.lte, (left, right) => left <= right);
  }
  if (Array.isArray(condition.in)) {
    return condition.in.some((item) => isDeepEqual(pathValue, item));
  }
  return Boolean(pathValue);
}

function valueContains(value: unknown, needle: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(String(needle));
  }
  if (Array.isArray(value)) {
    return value.some((item) => isDeepEqual(item, needle));
  }
  if (isRecord(value) && typeof needle === "string") {
    return Object.prototype.hasOwnProperty.call(value, needle);
  }
  return false;
}

function compareNumber(
  leftValue: unknown,
  rightValue: unknown,
  compare: (left: number, right: number) => boolean,
): boolean {
  const left = Number(leftValue);
  const right = Number(rightValue);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return compare(left, right);
}

function normalizeArtifactKindForExecutor(
  value: unknown,
): FlowArtifactKind | null {
  if (
    value === "json" ||
    value === "markdown" ||
    value === "text" ||
    value === "image" ||
    value === "html" ||
    value === "patch" ||
    value === "log"
  ) {
    return value;
  }
  return null;
}

function normalizeFlowItemStatusForExecutor(
  value: unknown,
): FlowItemStatus | undefined {
  if (
    value === "discovered" ||
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped_duplicate" ||
    value === "skipped_low_value" ||
    value === "waiting_for_approval" ||
    value === "applied" ||
    value === "skipped"
  ) {
    return value;
  }
  return undefined;
}

function findLastAssistantMessage(messages: UIMessage[]): UIMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant") return message;
  }
  return null;
}

function messageToText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n")
    .trim();
}

function parseAgentOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const direct = tryParseJson(trimmed);
  if (direct.ok) return direct.value;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed.ok) return parsed.value;
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    const parsed = tryParseJson(trimmed.slice(objectStart, objectEnd + 1));
    if (parsed.ok) return parsed.value;
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const parsed = tryParseJson(trimmed.slice(arrayStart, arrayEnd + 1));
    if (parsed.ok) return parsed.value;
  }

  return { text: trimmed };
}

function buildToolOutputAssistantText(output: unknown): string {
  return [
    "Flow node completed after a tool call.",
    "",
    "The workflow runtime used the completed tool output as this node response:",
    "",
    "```json",
    stableStringify(output),
    "```",
  ].join("\n");
}

function extractLastToolOutput(message: UIMessage): unknown | null {
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index] as Record<string, unknown>;
    if (typeof part.type !== "string" || !part.type.startsWith("tool-")) {
      continue;
    }
    if (part.state !== "output-available") {
      continue;
    }

    const output = part.output;
    if (isRecord(output) && "data" in output) {
      const data = output.data;
      const parsedStdout = parseShellStdoutJson(data);
      return parsedStdout ?? data;
    }
    return output ?? null;
  }
  return null;
}

function parseShellStdoutJson(value: unknown): unknown | null {
  if (!isRecord(value) || typeof value.stdout !== "string") return null;
  const trimmed = value.stdout.trim();
  if (!trimmed) return null;
  const direct = tryParseJson(trimmed);
  if (direct.ok) return direct.value;

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = tryParseJson(lines[index] ?? "");
    if (parsed.ok) return parsed.value;
  }
  return null;
}

function tryParseJson(
  value: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function getPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "$" || trimmed === ".") return value;
  const normalized = trimmed
    .replace(/^\$\./, "")
    .replace(/^\$/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/^\./, "");
  if (!normalized) return value;

  let current = value;
  for (const segment of normalized.split(".").filter(Boolean)) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isPathExpression(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "$" || trimmed.startsWith("$.") || trimmed.startsWith(".");
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return JSON.stringify({ value: String(value) }, null, 2);
  }
}
