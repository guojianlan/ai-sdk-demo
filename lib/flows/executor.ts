import { randomUUID } from "node:crypto";

import type { UIMessage } from "ai";
import type { ChatUIMessageChunk } from "@/lib/chat-agent/active-runs";

import { runChatAgentLoop } from "@/lib/chat-agent/run-loop";
import { env } from "@/lib/env";
import {
  normalizePermissionMode,
  type PermissionMode,
} from "@/lib/permissions";
import {
  createFlowNodeRun,
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
  type FlowRunWithNodes,
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
};

type GenericNodeConfig = {
  inputMapping?: unknown;
  inputPath?: unknown;
  outputPath?: unknown;
  condition?: unknown;
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
};

type NodeExecutionResult = {
  output: unknown;
  trace: unknown;
  transcriptThreadId?: string | null;
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

  const startNode =
    graph.nodes.find((node) => node.type === "start") ?? graph.nodes[0];
  if (!startNode) {
    const failed = updateFlowRun(params.runId, {
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

      const rawInput =
        node.type === "start"
          ? params.input ?? getConfiguredStartInput(node)
          : buildNodeInput(node, graph.edges, outputByNode);
      const input = applyNodeInputMapping(node, rawInput);

      const nodeRun = createFlowNodeRun({
        flowRunId: params.runId,
        nodeId: node.id,
        input,
        status: "running",
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

      for (const edge of selectOutgoingEdges({
        node,
        edges: graph.edges,
        output: outputByNode.get(node.id),
      })) {
        if (!executed.has(edge.targetNodeId)) {
          queue.push(edge.targetNodeId);
        }
      }
    }

    const finalOutput = findFinalOutput(graph.nodes, outputByNode);
    updateFlowRun(params.runId, {
      status: "succeeded",
      output: finalOutput,
      finishedAt: Date.now(),
    });
  } catch (error) {
    updateFlowRun(params.runId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Flow execution failed.",
      output: findFinalOutput(graph.nodes, outputByNode),
      finishedAt: Date.now(),
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
  if (node.type === "start") {
    return {
      output: input,
      trace: {
        kind: "start",
        output: input,
      },
    };
  }

  if (node.type === "agent" || node.type === "prompt") {
    return executeAgentNode(node, input, context);
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

  if (node.type === "transform") {
    return executeTransformNode(node, input);
  }

  if (node.type === "condition") {
    return executeConditionNode(node, input);
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
        conversationSummary: null,
        skills: await getSkills(),
        hookContexts: [],
      },
    });
  } finally {
    timeoutController.dispose();
  }

  const messages = loadMessages(transcriptThreadId);
  const assistantMessage = findLastAssistantMessage(messages);
  const assistantText = assistantMessage ? messageToText(assistantMessage) : "";
  const output = parseAgentOutput(assistantText);

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
      text: assistantText,
      output,
      durationMs: Date.now() - startedAt,
      attemptsConfigured: config.retry.maxAttempts,
      timeoutMs: config.timeoutMs,
      chunks: chunks.length,
    },
  };
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
  if (node.type === "start") return input;
  const config = normalizeGenericNodeConfig(node.config);
  if (config.inputPath) {
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
  if (params.node.type === "start") return true;
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
    permissionMode: normalizePermissionMode(
      typeof maybe.permissionMode === "string"
        ? maybe.permissionMode
        : "bypassPermissions",
    ),
  };
}

function normalizeGenericNodeConfig(config: unknown): {
  inputMapping: unknown;
  inputPath: string | null;
  outputPath: string | null;
  condition: unknown;
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
