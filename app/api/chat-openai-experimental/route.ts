import path from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import {
  createAgentUIStreamResponse,
  smoothStream,
  stepCountIs,
  ToolLoopAgent,
  type UIMessage,
} from "ai";
import { z } from "zod";

import {
  assemblePromptLayers,
  type PromptLayers,
} from "@/lib/prompt-layers";
import { buildSessionPrimer } from "@/lib/session-primer";
import { createShellTool } from "@/lib/shell-tool";
import { normalizeWorkspaceRoot } from "@/lib/workspaces";
import {
  workspaceToolset,
  type WorkspaceToolContext,
} from "@/lib/workspace-tools";
import { instrumentModel } from "@/lib/devtools";

const openaiExperimentBaseURL =
  process.env.OPENAI_BASE_URL ??
  process.env.OPENAI_COMPAT_BASE_URL ??
  process.env.GEMINI_BASE_URL;
const openaiExperimentApiKey =
  process.env.OPENAI_API_KEY ??
  process.env.OPENAI_COMPAT_API_KEY ??
  process.env.GEMINI_API_KEY;
const openaiExperimentModel =
  process.env.OPENAI_EXPERIMENT_MODEL ??
  process.env.OPENAI_MODEL ??
  process.env.OPENAI_COMPAT_MODEL ??
  process.env.GEMINI_MODEL ??
  "gpt-5-codex";

const openaiProvider = createOpenAI({
  apiKey: openaiExperimentApiKey,
  baseURL: openaiExperimentBaseURL,
});

const segmenter = new Intl.Segmenter("zh-CN", {
  granularity: "grapheme",
});

/**
 * 三种工具模式：
 * - workspace-toolset：细粒度自定义 function tools（list_files / search_code / read_file）
 * - shell：通用 shell function tool（见 lib/shell-tool.ts）；跨模型通用
 * - hybrid：两边都开，观察模型自己怎么选
 *
 * 注意：`shell` 走的是普通 function calling 路径，**不是** OpenAI Responses API 的 built-in
 * `local_shell`。因此任何支持 function calling 的模型都能用（GPT-5.4 / Gemini / Claude），
 * 不再受 gpt-5-codex 这一条限制。这也是 codex CLI 的做法（见 docs/codex-prompt-layering.md）。
 */
const experimentToolModes = [
  "workspace-toolset",
  "shell",
  "hybrid",
] as const;

type OpenAIExperimentToolMode = (typeof experimentToolModes)[number];

type OpenAIExperimentContext = WorkspaceToolContext & {
  toolMode: OpenAIExperimentToolMode;
};

const experimentCallOptionsSchema = z.object({
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
  toolMode: z.enum(experimentToolModes).default("hybrid"),
});

type ExperimentCallOptions = z.infer<typeof experimentCallOptionsSchema>;

/**
 * Layer 1 —— Persona：实验 agent 的稳定身份。
 * 强调"比较两种 function tool 粒度"的元任务视角。
 */
const openaiExperimentPersona = [
  "你是一名高级软件工程师，正在比较两类本地代码库分析方式。",
  "第一类是细粒度自定义 toolset：list_files / search_code / read_file —— 每个工具语义明确、schema 严格。",
  "第二类是通用的 shell 工具：让模型自己提出 shell 命令（只读白名单），服务端执行后回传输出。",
  "回答时请明确区分：本次用的是哪种工具模式、工具返回了什么证据、结论来自哪些文件或命令。",
  "如果当前模式无法完成任务，请明确说明缺口，而不是猜测代码细节。",
  "除非用户明确要求，否则不要建议执行任何写操作或危险命令。",
].join("\n");

/**
 * Layer 2 —— Developer rules：随 toolMode 变化的运行期规则。
 */
function buildExperimentDeveloperRules(
  toolMode: OpenAIExperimentToolMode,
  workspaceName: string,
): string {
  const modeRules =
    toolMode === "workspace-toolset"
      ? [
          "- 你只能使用 workspaceToolset（list_files / search_code / read_file），不要调用 shell。",
          "- 重点观察细粒度工具如何提供代码证据。",
        ]
      : toolMode === "shell"
        ? [
            "- 你只能使用 shell 工具，不要调用 workspaceToolset。",
            "- 优先使用只读命令：rg、find、ls、cat、sed、head、tail、wc、stat、git log/diff/status。",
            "- 支持 sh -c 包装；简单管道（|）可用，但 ; & > < || $() 等操作符会被拒。",
          ]
        : [
            "- 你可以同时使用 workspaceToolset 和 shell。",
            "- 当两者都能完成任务时，请指出哪一种证据链更直接。",
          ];

  return [
    `当前实验配置：`,
    `- workspace: ${workspaceName}`,
    `- toolMode: ${toolMode}`,
    `- model: ${openaiExperimentModel}`,
    "",
    "实验规则：",
    ...modeRules,
  ].join("\n");
}

function normalizeExperimentToolMode(value: unknown): OpenAIExperimentToolMode {
  return value === "workspace-toolset" || value === "shell"
    ? value
    : "hybrid";
}

/**
 * 跨模型通用的 shell 工具实例。放模块级复用（不是每个 agent 重建一个）。
 */
const shellTool = createShellTool();

const hybridToolset = {
  ...workspaceToolset,
  shell: shellTool,
};

type HybridToolset = typeof hybridToolset;
type OpenAIExperimentAgent = ToolLoopAgent<
  ExperimentCallOptions,
  HybridToolset
>;

/**
 * 兼容网关不一定会持久化 OpenAI Responses 的 item。
 * 这里把客户端回传的任何 *Metadata 字段都清掉，
 * 避免旧轮次的 rs_* / item 引用再次进入 provider 层。
 */
function isMetadataKey(key: string) {
  return key === "metadata" || /Metadata$/.test(key);
}

function sanitizeExperimentUIMessages(messages: unknown[]): UIMessage[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) {
      return [];
    }

    const role =
      "role" in message && typeof message.role === "string"
        ? message.role
        : undefined;
    const rawId =
      "id" in message && typeof message.id === "string" ? message.id : "";
    const rawParts =
      "parts" in message && Array.isArray(message.parts) ? message.parts : [];

    if (role !== "system" && role !== "user" && role !== "assistant") {
      return [];
    }

    const parts = rawParts.flatMap((part) => {
      if (typeof part !== "object" || part === null) {
        return [];
      }

      const sanitizedPart = Object.fromEntries(
        Object.entries(part).filter(([key]) => !isMetadataKey(key)),
      );

      return [sanitizedPart as UIMessage["parts"][number]];
    });

    if (parts.length === 0) {
      return [];
    }

    return [
      {
        id: rawId || crypto.randomUUID(),
        role,
        parts,
      } satisfies UIMessage,
    ];
  });
}

function pickTools(toolMode: OpenAIExperimentToolMode) {
  if (toolMode === "workspace-toolset") {
    return workspaceToolset;
  }

  if (toolMode === "shell") {
    return { shell: shellTool };
  }

  return hybridToolset;
}

function createOpenAIExperimentAgent(
  toolMode: OpenAIExperimentToolMode,
): OpenAIExperimentAgent {
  const tools = pickTools(toolMode);

  return new ToolLoopAgent({
    model: instrumentModel(openaiProvider.responses(openaiExperimentModel)),
    // Agent 默认 instructions 只给 persona；真正的装配在 prepareCall。
    instructions: openaiExperimentPersona,
    stopWhen: stepCountIs(10),
    callOptionsSchema: experimentCallOptionsSchema,
    prepareCall: async ({ options, ...settings }) => {
      const normalizedWorkspaceRoot = await normalizeWorkspaceRoot(
        options.workspaceRoot,
      );
      const workspaceName =
        options.workspaceName?.trim() || path.basename(normalizedWorkspaceRoot);

      const primer = await buildSessionPrimer({
        workspaceRoot: normalizedWorkspaceRoot,
      });

      const layers: PromptLayers = {
        persona: openaiExperimentPersona,
        developerRules: buildExperimentDeveloperRules(toolMode, workspaceName),
        environmentContext: primer.environmentContext,
        userInstructions: primer.userInstructions,
      };

      return {
        ...settings,
        instructions: assemblePromptLayers(layers),
        experimental_context: {
          workspaceRoot: normalizedWorkspaceRoot,
          workspaceName,
          toolMode,
        } satisfies OpenAIExperimentContext,
      };
    },
    tools: tools as HybridToolset,
  });
}

const openaiExperimentAgents: Record<
  OpenAIExperimentToolMode,
  OpenAIExperimentAgent
> = {
  "workspace-toolset": createOpenAIExperimentAgent("workspace-toolset"),
  shell: createOpenAIExperimentAgent("shell"),
  hybrid: createOpenAIExperimentAgent("hybrid"),
};

export async function POST(request: Request) {
  if (!openaiExperimentApiKey) {
    return new Response(
      "Missing OPENAI_API_KEY, OPENAI_COMPAT_API_KEY, or GEMINI_API_KEY in .env.local",
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    messages?: unknown[];
    workspaceRoot?: string;
    workspaceName?: string;
    toolMode?: OpenAIExperimentToolMode;
  };

  if (!body.workspaceRoot?.trim()) {
    return new Response("Please select a workspace before sending a message.", {
      status: 400,
    });
  }

  const normalizedWorkspaceRoot = await normalizeWorkspaceRoot(
    body.workspaceRoot,
  );
  const workspaceName =
    body.workspaceName?.trim() || path.basename(normalizedWorkspaceRoot);
  const toolMode = normalizeExperimentToolMode(body.toolMode);
  const sanitizedMessages = sanitizeExperimentUIMessages(body.messages ?? []);

  return createAgentUIStreamResponse({
    agent: openaiExperimentAgents[toolMode],
    uiMessages: sanitizedMessages,
    options: {
      workspaceRoot: normalizedWorkspaceRoot,
      workspaceName,
      toolMode,
    },
    experimental_transform: smoothStream({
      chunking: segmenter,
      delayInMs: 18,
    }),
    onError: (error) => {
      if (error instanceof Error) {
        return error.message;
      }

      return "Unknown experimental agent error";
    },
  });
}

export async function GET() {
  return Response.json({
    model: openaiExperimentModel,
    baseURL: openaiExperimentBaseURL ?? null,
  });
}
