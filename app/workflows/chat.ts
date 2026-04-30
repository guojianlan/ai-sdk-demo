import {
  convertToModelMessages,
  generateId,
  smoothStream,
  type InferUIMessageChunk,
  type ToolSet,
  type UIMessage,
} from "ai";
import { getWorkflowMetadata, getWritable } from "workflow";
import { getRun } from "workflow/api";

import {
  createProjectEngineerAgent,
  projectEngineerStaticToolset,
} from "@/app/api/chat/agent-config";
import {
  compareAndSetActiveStreamId,
  saveMessages,
} from "@/lib/chat-store";
import type { WorkspaceAccessMode } from "@/lib/chat-access-mode";
import { interactiveToolset } from "@/lib/interactive-tools";
import { createWeatherMCPClient } from "@/lib/mcp/weather-client";

export type ChatWorkflowOptions = {
  chatId: string;
  agentMessages: UIMessage[];
  fullMessages: UIMessage[];
  compactionNotice: UIMessage | null;
  workspaceRoot: string;
  workspaceName?: string;
  workspaceAccessMode: WorkspaceAccessMode;
  bypassPermissions: boolean;
  conversationSummary: string | null;
};

type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

export async function runAgentWorkflow(options: ChatWorkflowOptions) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();

  try {
    await runAgentStep(options, workflowRunId);
  } finally {
    await clearActiveStream(options.chatId, workflowRunId);
    await closeWorkflowStream();
  }
}

async function runAgentStep(
  options: ChatWorkflowOptions,
  workflowRunId: string,
) {
  "use step";

  const hasWorkspaceTools = options.workspaceAccessMode === "workspace-tools";

  let mcpTools: ToolSet = {};
  let closeMcp: (() => Promise<void>) | null = null;
  if (hasWorkspaceTools) {
    try {
      const mcp = await createWeatherMCPClient();
      mcpTools = await mcp.tools();
      closeMcp = () => mcp.close();
    } catch (error) {
      console.warn(
        "[workflow/chat] weather MCP init failed, continuing without it:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const agent = createProjectEngineerAgent({
    tools: hasWorkspaceTools
      ? { ...projectEngineerStaticToolset, ...mcpTools }
      : { ...interactiveToolset },
    conversationSummary: options.conversationSummary,
  });

  const modelMessages = await convertToModelMessages(options.agentMessages, {
    tools: agent.tools,
    ignoreIncompleteToolCalls: true,
  });

  const abortController = new AbortController();
  const stopMonitor = startStopMonitor(workflowRunId, abortController);
  let responseMessage: UIMessage | null = null;

  try {
    const result = await agent.stream({
      messages: modelMessages,
      options: {
        workspaceRoot: options.workspaceRoot,
        workspaceName: options.workspaceName,
        workspaceAccessMode: options.workspaceAccessMode,
        bypassPermissions: options.bypassPermissions,
      },
      abortSignal: abortController.signal,
      experimental_transform: smoothStream({
        chunking: new Intl.Segmenter("zh-CN", { granularity: "grapheme" }),
        delayInMs: 18,
      }),
    });

    const writer = getWritable<ChatUIMessageChunk>().getWriter();
    try {
      for await (const part of result.toUIMessageStream<UIMessage>({
        originalMessages: options.agentMessages,
        generateMessageId: generateId,
        // Workflow streams can be re-read by reconnect/auto-submit paths. AI SDK
        // reasoning chunks are stateful (`reasoning-start` must be seen before
        // every delta), so keep Phase 1 conservative and stream only visible text
        // plus tool state. We can re-enable reasoning once we track stream cursors.
        sendReasoning: false,
        onFinish: ({ responseMessage: finishedResponseMessage }) => {
          responseMessage = finishedResponseMessage;
        },
        onError: (error) =>
          error instanceof Error ? error.message : "Unknown agent error",
      })) {
        await writer.write(part);
      }
    } finally {
      writer.releaseLock();
    }

    if (responseMessage) {
      const allMessages: UIMessage[] = [...options.fullMessages];
      if (options.compactionNotice) {
        allMessages.push(options.compactionNotice);
      }
      allMessages.push(responseMessage);
      saveMessages(options.chatId, allMessages);
    }
  } finally {
    stopMonitor.stop();
    await stopMonitor.done;
    await closeMcp?.();
  }
}

async function clearActiveStream(chatId: string, workflowRunId: string) {
  "use step";

  compareAndSetActiveStreamId(chatId, workflowRunId, null);
}

async function closeWorkflowStream() {
  "use step";

  await getWritable<ChatUIMessageChunk>().close();
}

function startStopMonitor(runId: string, abortController: AbortController) {
  let shouldStop = false;

  const done = (async () => {
    const run = getRun(runId);

    while (!shouldStop && !abortController.signal.aborted) {
      try {
        if ((await run.status) === "cancelled") {
          abortController.abort();
          return;
        }
      } catch {
        // The run can be briefly invisible while local workflow bookkeeping
        // catches up. Keep polling; cancellation is best-effort.
      }
      await delay(150);
    }
  })();

  return {
    stop() {
      shouldStop = true;
    },
    done,
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
