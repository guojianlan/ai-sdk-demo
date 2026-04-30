import { generateObject } from "ai";

import { instrumentModel } from "@/lib/devtools";
import { env } from "@/lib/env";
import { gateway } from "@/lib/gateway";
import { getSchema } from "@/lib/workflow/schema-registry";
import { renderTemplate, resolveInputs } from "@/lib/workflow/template";
import { globalRegistry } from "@/lib/tooling";
// 副作用 import：把业务 tool 注册进 registry。
import "@/lib/tools";
import type {
  NodeDefinition,
  RunNodeRequest,
  RunNodeResponse,
} from "@/lib/workflow/types";

/**
 * 节点执行器 —— 把节点定义 + 运行时 context 跑成 RunNodeResponse。
 *
 * 总入口 `runNode` 按 `node.config.kind` 分发到三个 handler：
 *
 * - `runStructuredNode` —— generateObject 出结构化输出（一次模型调用，无 tool loop）
 * - `runToolNode`       —— 直接执行一个 tool（无 LLM 调用）
 * - `runHumanNode`      —— 第一次进来：返 awaiting-input；带 humanResponse 回来：完成
 *
 * **agent kind 节点不在这里执行**：按"前端驱动 single-step"约定，agent 节点的
 * 整个 loop 由客户端 runner 通过 `/api/agent/step` + `/api/agent/tool` 推进。
 * 服务端这一层看到 agent kind 直接抛错，避免协议歧义。
 *
 * 设计要点：
 * - 节点的 instructionsTemplate / promptTemplate 在执行前用 `renderTemplate`
 *   渲染（{{var}} 替换为 inputs 对应字段）。
 * - 节点 outputs 通过 schema-registry 校验后返回——校验失败抛错，让运行流挂在
 *   error 状态而不是塞脏数据给下游节点。
 * - tool execute 时透传 `experimental_context`：包含 workspaceRoot / workspaceName
 *   / bypassPermissions（按节点配置覆盖）。
 *
 * MVP 局限：
 * - 节点是顺序执行；分支 / 并行后续再加。
 */

function buildExperimentalContext(
  request: RunNodeRequest,
  bypassPermissions: boolean,
): Record<string, unknown> {
  return {
    workspaceRoot: request.workspaceRoot,
    workspaceName: request.workspaceName ?? request.workspaceRoot,
    bypassPermissions,
  };
}

/**
 * 把节点 inputs 路径表解析成实际值。
 * 节点执行器都用这个统一拿 inputs，避免重复读 context。
 */
function resolveNodeInputs(
  node: NodeDefinition,
  request: RunNodeRequest,
): Record<string, unknown> {
  return resolveInputs(node.inputs, {
    workflow: { input: request.workflowInput },
    // upstreamOutputs 已经是 `{ [nodeId]: { output } }` 的形态
    nodes: request.upstreamOutputs as Record<
      string,
      { output: unknown } | undefined
    >,
  });
}

// ---------- structured 节点 ----------

async function runStructuredNode(
  node: NodeDefinition,
  request: RunNodeRequest,
): Promise<RunNodeResponse> {
  if (node.config.kind !== "structured") {
    throw new Error(`runStructuredNode called with kind=${node.config.kind}`);
  }
  const config = node.config;
  const startedAt = Date.now();

  const inputs = resolveNodeInputs(node, request);
  const prompt = renderTemplate(config.instructionsTemplate, inputs);
  const schema = getSchema(config.outputSchemaKey);

  const result = await generateObject({
    model: instrumentModel(gateway.chatModel(env.gateway.modelId)),
    schema,
    prompt,
  });

  return {
    status: "done",
    output: result.object,
    durationMs: Date.now() - startedAt,
  };
}

// ---------- tool 节点 ----------

async function runToolNode(
  node: NodeDefinition,
  request: RunNodeRequest,
): Promise<RunNodeResponse> {
  if (node.config.kind !== "tool") {
    throw new Error(`runToolNode called with kind=${node.config.kind}`);
  }
  const config = node.config;
  const startedAt = Date.now();

  const definedTool = globalRegistry.get(config.toolName);
  const tool = definedTool.aiTool;
  if (typeof tool.execute !== "function") {
    throw new Error(
      `Tool '${config.toolName}' is not executable (interactive kind)`,
    );
  }

  // tool 节点的 inputs 直接作为 tool 的 input —— 节点定义里的 inputs 名要和 tool
  // schema 字段名一致（不一致就让 zod 报错，定义端早 fail）。
  const inputs = resolveNodeInputs(node, request);
  const experimentalContext = buildExperimentalContext(
    request,
    /* bypassPermissions = */ true,
  );

  const output = await tool.execute(inputs, {
    toolCallId: `node-${node.id}-${Date.now()}`,
    messages: [],
    experimental_context: experimentalContext,
  });

  return {
    status: "done",
    output,
    durationMs: Date.now() - startedAt,
  };
}

// ---------- human 节点 ----------

async function runHumanNode(
  node: NodeDefinition,
  request: RunNodeRequest,
): Promise<RunNodeResponse> {
  if (node.config.kind !== "human") {
    throw new Error(`runHumanNode called with kind=${node.config.kind}`);
  }
  const config = node.config;

  // 第一次进来：渲染 prompt，返 awaiting-input
  if (request.humanResponse === undefined) {
    const inputs = resolveNodeInputs(node, request);
    const prompt = renderTemplate(config.promptTemplate, inputs);

    return {
      status: "awaiting-input",
      payload: {
        kind: "human-approval",
        uiKind: config.uiKind,
        prompt,
        // 把 inputs 也透出去：审批 UI 通常要展示"用户要批准什么"的上下文。
        context: inputs,
      },
    };
  }

  // 带 humanResponse 回来：用 schema 校验、返 done
  const startedAt = Date.now();
  const schema = getSchema(node.outputSchemaKey);
  const parseResult = schema.safeParse(request.humanResponse);
  if (!parseResult.success) {
    return {
      status: "error",
      error: `Human response failed schema validation: ${parseResult.error.message}`,
    };
  }

  return {
    status: "done",
    output: parseResult.data,
    durationMs: Date.now() - startedAt,
  };
}

// ---------- dispatcher ----------

export async function runNode(
  node: NodeDefinition,
  request: RunNodeRequest,
): Promise<RunNodeResponse> {
  try {
    switch (node.config.kind) {
      case "agent":
        // agent 节点必须在客户端通过 /api/agent/step + /api/agent/tool 推进。
        // 走到这里说明调用方协议错——直接报错让前端把问题暴露出来。
        return {
          status: "error",
          error:
            "Agent kind nodes must be driven from the client via /api/agent/step + /api/agent/tool. The /api/workflow/.../run route does not execute agent loops server-side.",
        };
      case "structured":
        return await runStructuredNode(node, request);
      case "tool":
        return await runToolNode(node, request);
      case "human":
        return await runHumanNode(node, request);
    }
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
