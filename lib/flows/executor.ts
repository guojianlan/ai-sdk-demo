import { generateText, jsonSchema, Output } from "ai";

import { instrumentModel } from "@/lib/devtools";
import { env } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import {
  createFlowNodeRun,
  createFlowRun,
  getFlowRunWithNodes,
  getFlowWithGraph,
  updateFlowNodeRun,
  updateFlowRun,
  type FlowEdge,
  type FlowNode,
  type FlowRunWithNodes,
} from "@/lib/persistence";

const MAX_EXECUTED_NODES = 100;

type PromptNodeConfig = {
  prompt?: unknown;
  outputSchema?: unknown;
  retry?: unknown;
  timeoutMs?: unknown;
};

type RetryConfig = {
  maxAttempts: number;
};

type NormalizedPromptConfig = {
  prompt: string;
  outputSchema: Record<string, unknown> | null;
  retry: RetryConfig;
  timeoutMs: number | null;
};

type NodeExecutionResult = {
  output: unknown;
  trace: unknown;
};

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

  const startNode =
    graph.nodes.find((node) => node.type === "start") ?? graph.nodes[0];
  if (!startNode) {
    const failed = updateFlowRun(run.id, {
      status: "failed",
      error: "Flow has no nodes.",
      finishedAt: Date.now(),
    });
    return { run: failed, nodeRuns: [] };
  }

  const outputByNode = new Map<string, unknown>();
  const executed = new Set<string>();
  const queue = [startNode.id];
  const reachableNodeIds = collectReachableNodeIds(startNode.id, graph.edges);
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

      const input =
        node.type === "start"
          ? params.input ?? getConfiguredStartInput(node)
          : buildNodeInput(node, graph.edges, outputByNode);

      const nodeRun = createFlowNodeRun({
        flowRunId: run.id,
        nodeId: node.id,
        input,
        status: "running",
      });

      try {
        const result = await executeNode(node, input);
        updateFlowNodeRun(nodeRun.id, {
          status: "succeeded",
          output: result.output,
          trace: result.trace,
          finishedAt: Date.now(),
        });
        outputByNode.set(node.id, result.output);
        executed.add(node.id);
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
        throw new Error(`${node.title}: ${message}`);
      }

      for (const edge of graph.edges) {
        if (edge.sourceNodeId === node.id && !executed.has(edge.targetNodeId)) {
          queue.push(edge.targetNodeId);
        }
      }
    }

    const finalOutput = findFinalOutput(graph.nodes, outputByNode);
    updateFlowRun(run.id, {
      status: "succeeded",
      output: finalOutput,
      finishedAt: Date.now(),
    });
  } catch (error) {
    updateFlowRun(run.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Flow execution failed.",
      output: findFinalOutput(graph.nodes, outputByNode),
      finishedAt: Date.now(),
    });
  }

  const detail = getFlowRunWithNodes(run.id);
  if (!detail) {
    throw new Error("Flow run could not be loaded after execution.");
  }
  return detail;
}

async function executeNode(
  node: FlowNode,
  input: unknown,
): Promise<NodeExecutionResult> {
  if (node.type === "start") {
    return {
      output: input,
      trace: {
        kind: "start",
        output: input,
      },
    };
  }

  if (node.type === "prompt") {
    return executePromptNode(node, input);
  }

  if (node.type === "end") {
    return {
      output: input,
      trace: {
        kind: "end",
        output: input,
      },
    };
  }

  return {
    output: input,
    trace: {
      kind: node.type,
      mode: "pass-through",
      output: input,
    },
  };
}

async function executePromptNode(
  node: FlowNode,
  input: unknown,
): Promise<NodeExecutionResult> {
  const config = normalizePromptConfig(node.config);
  const userPrompt = buildPromptText({
    prompt: config.prompt,
    input,
    outputSchema: config.outputSchema,
  });

  const startedAt = Date.now();
  const result = config.outputSchema
    ? await generateText({
        model: instrumentModel(gateway.chatModel(env.gateway.modelId)),
        output: Output.object({
          schema: jsonSchema<Record<string, unknown>>(
            config.outputSchema as Parameters<typeof jsonSchema>[0],
          ),
        }),
        prompt: userPrompt,
        maxRetries: Math.max(0, config.retry.maxAttempts - 1),
        abortSignal: createTimeoutSignal(config.timeoutMs),
      })
    : await generateText({
        model: instrumentModel(gateway.chatModel(env.gateway.modelId)),
        output: Output.json(),
        prompt: userPrompt,
        maxRetries: Math.max(0, config.retry.maxAttempts - 1),
        abortSignal: createTimeoutSignal(config.timeoutMs),
      });

  return {
    output: result.output,
    trace: {
      kind: "prompt",
      model: env.gateway.modelId,
      prompt: config.prompt,
      outputSchema: config.outputSchema,
      input,
      text: result.text,
      output: result.output,
      finishReason: result.finishReason,
      usage: result.totalUsage,
      durationMs: Date.now() - startedAt,
      attemptsConfigured: config.retry.maxAttempts,
      timeoutMs: config.timeoutMs,
      messages: [
        { role: "user", content: userPrompt },
        { role: "assistant", content: result.text },
      ],
    },
  };
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

function buildPromptText(params: {
  prompt: string;
  input: unknown;
  outputSchema: Record<string, unknown> | null;
}): string {
  const parts = [
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
      "Return only valid JSON that matches the output schema.",
    );
  } else {
    parts.push("Return only valid JSON.");
  }

  return parts.join("\n");
}

function isNodeReady(params: {
  node: FlowNode;
  edges: FlowEdge[];
  executed: Set<string>;
  reachableNodeIds: Set<string>;
}): boolean {
  if (params.node.type === "start") return true;
  const incomingReachableEdges = params.edges.filter(
    (edge) =>
      edge.targetNodeId === params.node.id &&
      params.reachableNodeIds.has(edge.sourceNodeId),
  );
  return incomingReachableEdges.every((edge) =>
    params.executed.has(edge.sourceNodeId),
  );
}

function collectReachableNodeIds(
  startNodeId: string,
  edges: FlowEdge[],
): Set<string> {
  const reachable = new Set<string>([startNodeId]);
  const queue = [startNodeId];
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
  const endNode = nodes.find((node) => node.type === "end");
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

function createTimeoutSignal(timeoutMs: number | null): AbortSignal | undefined {
  if (!timeoutMs) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return JSON.stringify({ value: String(value) }, null, 2);
  }
}
