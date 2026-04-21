import {
  createAgentUIStreamResponse,
  smoothStream,
  type ToolSet,
  type UIMessage,
} from "ai";

import {
  createProjectEngineerAgent,
  projectEngineerStaticToolset,
} from "@/app/api/chat/agent-config";
import { interactiveToolset } from "@/lib/interactive-tools";
import {
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import { sanitizeChatUIMessages } from "@/lib/chat/sanitize-messages";
import { saveMessages } from "@/lib/chat-store";
import * as activeStreams from "@/lib/active-streams";
import { requireGatewayApiKey } from "@/lib/env";
import { createWeatherMCPClient } from "@/lib/mcp/weather-client";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export async function POST(request: Request) {
  try {
    requireGatewayApiKey();
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Missing gateway API key",
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    messages?: unknown[];
    chatId?: string;
    workspaceRoot?: string;
    workspaceName?: string;
    workspaceAccessMode?: WorkspaceAccessMode;
    bypassPermissions?: boolean;
  };

  const workspaceRoot = body.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return new Response("Please select a workspace before sending a message.", {
      status: 400,
    });
  }

  // chatId 一定要有：持久化和 resume 都靠它做 key。
  const chatId = body.chatId?.trim();
  if (!chatId) {
    return new Response("missing chatId", { status: 400 });
  }

  const workspaceAccessMode = normalizeWorkspaceAccessMode(
    body.workspaceAccessMode,
  );
  const hasWorkspaceTools = workspaceAccessMode === "workspace-tools";

  // MCP（天气）只在有工具的模式下拉起；失败 → 降级无 MCP 继续跑。
  let mcpTools: ToolSet = {};
  let closeMcp: (() => Promise<void>) | null = null;
  if (hasWorkspaceTools) {
    try {
      const mcp = await createWeatherMCPClient();
      mcpTools = await mcp.tools();
      closeMcp = () => mcp.close();
    } catch (error) {
      console.warn(
        "[chat] weather MCP init failed, continuing without it:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const agent = createProjectEngineerAgent({
    // no-tools 模式也给交互工具：即使不让读文件，也允许 agent 追问用户意图。
    tools: hasWorkspaceTools
      ? { ...projectEngineerStaticToolset, ...mcpTools }
      : { ...interactiveToolset },
    onFinish: closeMcp ?? undefined,
  });

  const originalMessages = sanitizeChatUIMessages(body.messages ?? []);

  // 注册 active stream：POST 跑的同时把 SSE 字节也 tee 一份到内存 buffer；
  // 客户端 mid-stream 刷新时，GET /api/chat/[chatId]/stream 从这里订阅。
  const live = activeStreams.register(chatId);
  const encoder = new TextEncoder();

  return createAgentUIStreamResponse({
    agent,
    uiMessages: originalMessages,
    // 传 originalMessages：AI SDK 会给新生成的响应消息分配稳定 id + 在 onFinish 回传整段。
    originalMessages,
    options: {
      workspaceRoot,
      workspaceName: body.workspaceName,
      workspaceAccessMode,
      bypassPermissions: body.bypassPermissions === true,
    },
    experimental_transform: smoothStream({
      chunking: segmenter,
      delayInMs: 18,
    }),
    // consumeSseStream：AI SDK tee 一份 SSE 文本给我们独立处理，不阻塞主响应。
    // 我们把它编码成字节塞进 active-streams 的 buffer，resume GET 过来时能 replay + live。
    consumeSseStream: async ({ stream }) => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (typeof value === "string") {
            live.push(encoder.encode(value));
          }
        }
        live.end();
      } catch (error) {
        live.fail(error instanceof Error ? error : new Error(String(error)));
      }
    },
    // onFinish：流完整跑完后触发，持久化最终消息到 DB，清理 active-stream 条目。
    // 失败不能让整个响应 throw —— 只 log，前端看到的还是正常的完成状态。
    onFinish: ({ messages }) => {
      try {
        saveMessages(chatId, messages as UIMessage[]);
      } catch (error) {
        console.error(
          "[chat] saveMessages failed:",
          error instanceof Error ? error.message : error,
        );
      }
      live.cleanup();
    },
    onError: (error) => {
      // 流级错误：也要清 active-stream 条目，不然它一直挂着。
      live.fail(error instanceof Error ? error : new Error(String(error)));
      live.cleanup();
      return error instanceof Error ? error.message : "Unknown agent error";
    },
  });
}
