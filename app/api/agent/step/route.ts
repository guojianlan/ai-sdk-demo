import { stepCountIs, streamText, type ModelMessage } from "ai";
import { z } from "zod";

import {
  agentSourceSchema,
  resolveAgentSource,
  workflowNodeContextSchema,
  workspaceContextSchema,
} from "@/lib/agent/source";
import { inferToolCallMeta } from "@/lib/agent/tool-utils";
import { instrumentModel } from "@/lib/devtools";
import { env, requireGatewayApiKey } from "@/lib/env";
import { gateway } from "@/lib/gateway";

/**
 * POST /api/agent/step
 *
 * **客户端驱动 agent loop 的唯一服务端原语**。流式（SSE）是默认的、也是唯一的
 * 响应形态。
 *
 * 协议（请求 body）：
 *   {
 *     messages: ModelMessage[],
 *     source:
 *       | { kind: "chat", accessMode?: "workspace-tools" | "no-tools" }
 *       | { kind: "workflow-node", workflowId: "bug-fix", nodeId: "diagnose" },
 *     workspaceContext: { workspaceRoot, workspaceName?, bypassPermissions? },
 *     nodeContext?: { workflowInput, upstreamOutputs }   // 仅 workflow-node 时传
 *   }
 *
 * 关键点：**客户端不再传 toolNames / system**。服务端按 source 自己 lookup
 * 出 tool 集合 + 拼出 system prompt（chat 走 `lib/chat-agent/system-prompt.ts`，
 * workflow-node 走节点定义里的 instructionsTemplate）。这样客户端不知道服务端
 * 内部有哪些 tool、prompt 是怎么拼的。
 *
 * SSE 事件协议（自定义）：
 *   event: text-delta
 *   event: tool-call
 *   event: tool-result
 *   event: tool-error
 *   event: tool-approval-request
 *   event: finish
 *   event: error
 *
 * `stepCountIs(1)` 限制服务端这一次只跑一个 step：一次 LLM 调用 + 该 step 内
 * 可执行的 tool（普通 tool 自动跑，发 tool-result；approvedTool 待审批 / interactive
 * 不跑，发 tool-call / tool-approval-request）。剩下交给客户端 loop。
 */

const requestSchema = z.object({
  messages: z.array(z.unknown()).min(1),
  source: agentSourceSchema,
  workspaceContext: workspaceContextSchema,
  nodeContext: workflowNodeContextSchema.optional(),
});

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request) {
  try {
    requireGatewayApiKey();
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Missing gateway API key",
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { messages, source, workspaceContext, nodeContext } = parsed.data;

  // 解析 source → system + tools + experimentalContext + maxSteps
  let resolved;
  try {
    resolved = await resolveAgentSource({
      source,
      workspaceContext,
      nodeContext,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to resolve source",
      },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 提前打开连接 + 一个 ping，让代理 / 浏览器立刻识别这是 event-stream。
      controller.enqueue(encoder.encode(": stream-start\n\n"));

      try {
        const result = streamText({
          model: instrumentModel(gateway.chatModel(env.gateway.modelId)),
          system: resolved.system,
          messages: messages as ModelMessage[],
          tools: resolved.tools,
          experimental_context: resolved.experimentalContext,
          // 严格只跑一步，剩下交给客户端 loop。
          stopWhen: stepCountIs(1),
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta": {
              controller.enqueue(
                encoder.encode(sseLine("text-delta", { delta: part.text })),
              );
              break;
            }
            case "tool-call": {
              const meta = inferToolCallMeta(
                part.toolName,
                part.toolCallId,
                resolved.tools,
              );
              controller.enqueue(
                encoder.encode(
                  sseLine("tool-call", {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: part.input,
                    meta,
                  }),
                ),
              );
              break;
            }
            case "tool-result": {
              controller.enqueue(
                encoder.encode(
                  sseLine("tool-result", {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output: part.output,
                  }),
                ),
              );
              break;
            }
            case "tool-error": {
              const errMsg =
                part.error instanceof Error
                  ? part.error.message
                  : String(part.error);
              controller.enqueue(
                encoder.encode(
                  sseLine("tool-error", {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    error: errMsg,
                  }),
                ),
              );
              break;
            }
            case "tool-approval-request": {
              controller.enqueue(
                encoder.encode(
                  sseLine("tool-approval-request", {
                    approvalId: part.approvalId,
                    toolCallId: part.toolCall.toolCallId,
                    toolName: part.toolCall.toolName,
                    input: part.toolCall.input,
                  }),
                ),
              );
              break;
            }
            case "error": {
              const errMsg =
                part.error instanceof Error
                  ? part.error.message
                  : String(part.error);
              controller.enqueue(
                encoder.encode(sseLine("error", { error: errMsg })),
              );
              break;
            }
            // 其它事件（reasoning, file, source 等）暂不透传——客户端 loop 不消费。
          }
        }

        // final aggregates
        const finishReason = await result.finishReason;
        const usage = await result.usage;
        const responseMessages = (await result.response).messages;

        controller.enqueue(
          encoder.encode(
            sseLine("finish", {
              finishReason,
              usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
              },
              responseMessages,
              maxSteps: resolved.maxSteps,
            }),
          ),
        );
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          controller.enqueue(
            encoder.encode(sseLine("error", { error: message })),
          );
        } finally {
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
