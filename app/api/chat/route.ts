import path from "node:path";

import {
  createAgentUIStreamResponse,
  smoothStream,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";

import { gateway, gatewayApiKey, gatewayModelId } from "@/lib/gateway";
import {
  normalizeWorkspaceRoot,
} from "@/lib/workspaces";
import {
  DEFAULT_WORKSPACE_ACCESS_MODE,
  normalizeWorkspaceAccessMode,
  type WorkspaceAccessMode,
} from "@/lib/chat-access-mode";
import {
  assemblePromptLayers,
  type PromptLayers,
} from "@/lib/prompt-layers";
import { buildSessionPrimer } from "@/lib/session-primer";
import {
  workspaceToolset,
  type WorkspaceToolContext,
} from "@/lib/workspace-tools";
import { writeToolset } from "@/lib/write-tools";
import { subagentToolset } from "@/lib/subagents/explorer";
import { instrumentModel } from "@/lib/devtools";
import { createWeatherMCPClient } from "@/lib/mcp/weather-client";

// baseURL / apiKey / modelId / gateway 全部迁到 lib/gateway.ts，
// 让 subagents/explorer 等其它模块能共用同一套配置。
const segmenter = new Intl.Segmenter("zh-CN", {
  granularity: "grapheme",
});

/**
 * Layer 1 —— Persona：稳定的身份与行为准则。
 * 不随 call 变，等价于 codex 里的 base_instructions。
 */
const projectEngineerPersona = [
  "You are a senior software engineer helping the user understand the selected workspace.",
  "Always ground your answer in the workspace files rather than assumptions.",
  "Use the available tools to inspect directories, search code, and read files before making architectural claims.",
  "When you reference a file, mention the workspace-relative path in your answer.",
  "If you do not have enough evidence from the files yet, say so and inspect more files.",
  "Prefer concise, practical explanations with an engineering focus: architecture, data flow, responsibilities, risks, and next steps.",
].join("\n");

/**
 * Layer 2 —— Developer rules：运行期规则，依赖当前 access mode 和工作区名。
 * 对应 codex 里 build_initial_context 里的 developer_sections。
 */
function buildDeveloperRules(
  workspaceAccessMode: WorkspaceAccessMode,
  workspaceName: string,
): string {
  const hasWorkspaceTools = workspaceAccessMode === "workspace-tools";

  const modeRules = hasWorkspaceTools
    ? [
        "- You have access to workspace inspection tools in this mode.",
        "- Start by inspecting the workspace with tools before you explain the project.",
        "- Read the smallest useful set of files first, then expand only if needed.",
        "- Treat build output, dependency folders, and generated files as low priority unless the user asks for them.",
        "- For questions that clearly need reading many files to answer (e.g. 'how does auth work', 'what is the architecture of module X'), prefer delegating to `explore_workspace` — it runs in an isolated context and returns only a short summary, keeping this conversation lean. Don't use it for single-file lookups.",
        "- For edits: always read the target file before calling `write_file` or `edit_file`, and keep the scope tight (one concern per edit).",
      ]
    : [
        "- You know which workspace was selected, but you cannot inspect its files in this mode.",
        "- Never claim that you listed directories, searched code, or read a file.",
        "- If the user asks for project-specific facts, explain that workspace access is disabled and ask them to switch to the workspace-tools mode.",
      ];

  return [
    `Workspace display name: ${workspaceName}`,
    `Access mode: ${workspaceAccessMode}`,
    "",
    "Behavior rules for this workspace:",
    ...modeRules,
  ].join("\n");
}

type WorkspaceContext = WorkspaceToolContext & {
  workspaceAccessMode: WorkspaceAccessMode;
  bypassPermissions: boolean;
};

/**
 * 请求参数在服务端独立校验，
 * 这样无论是浏览器里的聊天请求，还是手工调用接口，都会共用同一套契约。
 *
 * `bypassPermissions`：会话级"自动批准"开关。默认 false（安全态），
 * 开启后写入工具的 `needsApproval` 会返回 false，Agent 不再弹确认卡片。
 */
const agentCallOptionsSchema = z.object({
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1).optional(),
  workspaceAccessMode: z
    .enum(["workspace-tools", "no-tools"])
    .default(DEFAULT_WORKSPACE_ACCESS_MODE),
  bypassPermissions: z.boolean().default(false),
});

// workspace-tools 模式下的完整工具集 = 只读探查 + 需要批准的写入 + 子 agent 委派。
// 合并成单一常量后，`typeof projectEngineerToolset` 直接给到 ToolLoopAgent 用，
// 避免散落的联合类型在调用处又要重算一次。
//
// subagentToolset 里的 explore_workspace 工具内部会启动一个独立的 ToolLoopAgent
// （lib/subagents/explorer.ts），把"摸清一块代码"这种发散型工作隔离在子 context 里跑完，
// 只把 ≤ 500 字摘要交回主 agent，防止主 context 被 30 次 read_file 灌爆。
const projectEngineerToolset = {
  ...workspaceToolset,
  ...writeToolset,
  ...subagentToolset,
};

/**
 * 构造一个 agent 实例。现在走**每请求一次**的构造路径，原因：
 * - MCP 工具需要运行期 spawn 子进程、握手、拿到工具列表，没法在模块加载期预构建
 * - onFinish 要绑定到"这一次请求的 mcpClient"上才能做清理，闭包必须是 per-request
 *
 * 代价：每次请求多构建一个 ToolLoopAgent 对象，~毫秒级，忽略不计。
 */
function createProjectEngineerAgent({
  workspaceAccessMode,
  extraTools,
  onFinish,
}: {
  workspaceAccessMode: WorkspaceAccessMode;
  extraTools: Record<string, unknown>;
  onFinish?: () => void | Promise<void>;
}) {
  const hasWorkspaceTools = workspaceAccessMode === "workspace-tools";

  // 合并工具集：基础 + 动态（MCP）。仅在 workspace-tools 模式下启用。
  const tools = hasWorkspaceTools
    ? { ...projectEngineerToolset, ...extraTools }
    : undefined;

  return new ToolLoopAgent({
    model: instrumentModel(gateway.chatModel(gatewayModelId)),
    instructions: projectEngineerPersona,
    stopWhen: stepCountIs(16),
    callOptionsSchema: agentCallOptionsSchema,
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
        persona: projectEngineerPersona,
        developerRules: buildDeveloperRules(workspaceAccessMode, workspaceName),
        environmentContext: primer.environmentContext,
        userInstructions: primer.userInstructions,
      };

      return {
        ...settings,
        instructions: assemblePromptLayers(layers),
        experimental_context: {
          workspaceRoot: normalizedWorkspaceRoot,
          workspaceName,
          workspaceAccessMode,
          bypassPermissions: options.bypassPermissions,
        } satisfies WorkspaceContext,
      };
    },
    // 合并后包含 MCP 动态工具，schema 在 tsc 眼里不再固定；用 ToolSet 做顶层类型。
    tools: tools as ToolSet,
    // 这一轮 agent loop 全部结束时触发：正是关掉 MCP 子进程的时机。
    onFinish: onFinish ? async () => { await onFinish(); } : undefined,
  });
}

/**
 * 客户端 localStorage 里可能留下"半成品"的 tool part，例如：
 * - 流式刚开始就被中断（`input-streaming` / `input-available`，没有 output）
 * - 用户开了 approval 卡片但没点同意 / 拒绝就关页面（`approval-requested` 永远悬空）
 *
 * 这些 part 在下一次发起 POST /api/chat 时会被一并发回来。AI SDK 会把它们
 * 转成 OpenAI 兼容协议的 tool_call，但因为没有配对的 tool_result，
 * 网关会报 "No tool output found for function call call_xxx" 直接拒绝整次请求。
 *
 * 解决：把所有 tool / dynamic-tool part 限制在"终结状态"
 * （output-available / output-error / approval-responded），
 * 其它状态视为孤儿，连同空消息一起丢掉。
 *
 * 这个清洗只针对 assistant 消息——user 消息里不会有 tool part。
 */
const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "approval-responded",
]);

function isToolLikePart(type: string) {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

function sanitizeWorkspaceUIMessages(input: unknown[]): UIMessage[] {
  return input.flatMap((message) => {
    if (typeof message !== "object" || message === null) {
      return [];
    }

    const role =
      "role" in message && typeof message.role === "string"
        ? message.role
        : undefined;

    if (role !== "system" && role !== "user" && role !== "assistant") {
      return [];
    }

    const rawId =
      "id" in message && typeof message.id === "string" ? message.id : "";
    const rawParts =
      "parts" in message && Array.isArray(message.parts) ? message.parts : [];

    const parts = rawParts.filter((part) => {
      if (typeof part !== "object" || part === null || !("type" in part)) {
        return false;
      }

      const type = (part as { type: unknown }).type;

      if (typeof type !== "string") {
        return false;
      }

      if (!isToolLikePart(type)) {
        return true;
      }

      const state =
        "state" in part && typeof (part as { state: unknown }).state === "string"
          ? (part as { state: string }).state
          : "";

      return TERMINAL_TOOL_STATES.has(state);
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

export async function POST(request: Request) {
  if (!gatewayApiKey) {
    return new Response(
      "Missing OPENAI_COMPAT_API_KEY (or GEMINI_API_KEY) in .env.local",
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    messages?: unknown[];
    workspaceRoot?: string;
    workspaceName?: string;
    workspaceAccessMode?: WorkspaceAccessMode;
    bypassPermissions?: boolean;
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
  const workspaceAccessMode = normalizeWorkspaceAccessMode(
    body.workspaceAccessMode,
  );
  // 显式布尔化，避免客户端误传 truthy 字符串（"true" / "false"）直接透传到 agent。
  const bypassPermissions = body.bypassPermissions === true;

  const sanitizedMessages = sanitizeWorkspaceUIMessages(body.messages ?? []);

  // MCP（天气）只在有工具的模式下拉起。spawn 子进程 + 握手要花几百毫秒，
  // 用 try/catch 包住，任何失败都**降级为无 MCP**继续跑，不让聊天 500。
  let mcpTools: Record<string, unknown> = {};
  let closeMcp: (() => Promise<void>) | null = null;
  if (workspaceAccessMode === "workspace-tools") {
    try {
      const mcp = await createWeatherMCPClient();
      mcpTools = (await mcp.tools()) as Record<string, unknown>;
      closeMcp = () => mcp.close();
    } catch (error) {
      console.warn(
        "[chat] weather MCP init failed, continuing without it:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const agent = createProjectEngineerAgent({
    workspaceAccessMode,
    extraTools: mcpTools,
    // agent loop 跑完（成功或出错）都关掉 MCP 子进程，避免泄漏。
    onFinish: closeMcp ?? undefined,
  });

  return createAgentUIStreamResponse({
    agent,
    uiMessages: sanitizedMessages,
    options: {
      workspaceRoot: normalizedWorkspaceRoot,
      workspaceName,
      workspaceAccessMode,
      bypassPermissions,
    },
    experimental_transform: smoothStream({
      chunking: segmenter,
      delayInMs: 18,
    }),
    onError: (error) => {
      if (error instanceof Error) {
        return error.message;
      }

      return "Unknown agent error";
    },
  });
}
