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
import { globalRegistry } from "@/lib/tooling";
// 副作用 import：触发 lib/tools/index.ts 注册全部 tool（agent-config 也 import 了，
// 双 import 没有副作用——register 内部去重抛错，这里没竞争因为 import 是 idempotent）。
import "@/lib/tools";
import {
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import { sanitizeChatUIMessages } from "@/lib/chat/sanitize-messages";
import {
  loadSummary,
  saveMessages,
  saveSummary,
} from "@/lib/chat-store";
import * as activeStreams from "@/lib/active-streams";
import {
  buildCompactionNotice,
  compactMessages,
  estimateTokens,
} from "@/lib/compaction";
import { env, requireGatewayApiKey } from "@/lib/env";
import { gateway } from "@/lib/gateway";
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

  const fullSanitized = sanitizeChatUIMessages(body.messages ?? []);

  // --- P4-b context compaction 决策 ------------------------------------
  //
  // 约定：
  // - DB 保留全量历史（包括 system-role 的 compaction 通知），UI 能看完整
  // - **Agent 视角只看 non-system 消息**：system-role UI message 是我们自己造的
  //   UI 标记（compaction 通知），不应该被喂进 LLM 的 system prompt
  // - `session_summaries.compacted_count` 记录"agent 视角下前 N 条已被摘要代表"
  //
  // 每次请求：
  //   1. fullSanitized 里过滤 role=system 得到 agent 视角的消息
  //   2. 从 DB 读 existing summary，按 compacted_count 切出 agent 实际要看的 tail
  //   3. tail 的 token 估算 > 阈值 → 再压一次；新 summary 叠加在 existing 上
  //
  // 链式压缩：summary 永远是"截至现在所有老消息"的最新版，而不是每次都从头压。
  const existingSummary = loadSummary(chatId);
  const compactedCountSoFar = existingSummary?.compactedCount ?? 0;

  const agentViewMessages = fullSanitized.filter(
    (message) => message.role !== "system",
  );

  let agentMessages = agentViewMessages.slice(compactedCountSoFar);
  let agentSummary = existingSummary?.summary ?? null;
  // 本轮压缩产生的通知消息；onFinish 时插入到保存链里给下次 UI 看到。
  let compactionNotice: UIMessage | null = null;

  const currentTokens = estimateTokens(agentMessages);
  // 每次 POST 都打一行"现在多少 token / 阈值多少 / 会不会触发"——这是 compaction
  // 唯一可观察的信号，放在终端最显眼的位置方便 debug。
  const willCompact = currentTokens > env.compaction.thresholdTokens;
  console.log(
    `[compaction] chat=${chatId} tokens=${currentTokens} threshold=${env.compaction.thresholdTokens} trigger=${willCompact}`,
  );
  if (willCompact) {
    // 用和主 agent 同一个 gateway model 做摘要。没必要走 instrumentModel——
    // compaction 走单独一次调用，和主对话 stream 不混在同一条 devtools run 里。
    const summarizerModel = gateway.chatModel(env.gateway.modelId);
    try {
      const result = await compactMessages({
        messages: agentMessages,
        model: summarizerModel,
        keepRecent: env.compaction.keepRecentMessages,
        previousSummary: agentSummary,
      });

      if (result.compactedCount > 0 && result.summary) {
        const newCompactedCount = compactedCountSoFar + result.compactedCount;
        saveSummary(chatId, {
          summary: result.summary,
          compactedCount: newCompactedCount,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        });
        agentMessages = result.keptMessages;
        agentSummary = result.summary;
        // 产生一条 role=system 的通知，给前端显示（onFinish 时持久化进 DB）。
        compactionNotice = buildCompactionNotice(result);
        console.log(
          `[compaction] chat=${chatId} ${result.tokensBefore}→${result.tokensAfter} tokens, compacted ${result.compactedCount} messages`,
        );
      }
    } catch (error) {
      // compaction 失败不应阻塞主对话：降级继续用原消息喂 agent（可能超 context，
      // 但至少能跑），并打日志。
      console.warn(
        `[compaction] failed for chat=${chatId}, continuing without compaction:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  // ---------------------------------------------------------------------

  const agent = createProjectEngineerAgent({
    // no-tools 模式也给交互工具：即使不让读文件，也允许 agent 追问用户意图 + 跟进 plan。
    tools: hasWorkspaceTools
      ? { ...projectEngineerStaticToolset, ...mcpTools }
      : globalRegistry.pick([
          "ask_question",
          "ask_choice",
          "show_reference",
          "update_plan",
        ]),
    onFinish: closeMcp ?? undefined,
    conversationSummary: agentSummary,
  });

  // 注册 active stream：POST 跑的同时把 SSE 字节也 tee 一份到内存 buffer；
  // 客户端 mid-stream 刷新时，GET /api/chat/[chatId]/stream 从这里订阅。
  const live = activeStreams.register(chatId);
  const encoder = new TextEncoder();

  return createAgentUIStreamResponse({
    agent,
    // agent 只看截断后的 tail，不看被压缩掉的那段。
    uiMessages: agentMessages,
    originalMessages: agentMessages,
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
    // onFinish 拿到的 messages = originalMessages（= agentMessages 截断后）+ 新 response。
    // 但 DB 要存的是**全量**：fullSanitized（包括已被压缩的部分）+ 本轮压缩通知（如有）+ 新 response。
    // 所以这里不能直接用 event.messages，要手动拼。
    onFinish: ({ responseMessage }) => {
      try {
        const allMessages: UIMessage[] = [...fullSanitized];
        if (compactionNotice) {
          allMessages.push(compactionNotice);
        }
        allMessages.push(responseMessage as UIMessage);
        saveMessages(chatId, allMessages);
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
