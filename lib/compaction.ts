import { generateText, type LanguageModel, type UIMessage } from "ai";

/**
 * 标记一条 role=system 消息是 compaction 通知而不是随意的 system 内容。
 * 前端靠这个 sentinel 精准识别"这是压缩通知"，渲染成紧凑的一行系统提示。
 */
export const COMPACTION_NOTICE_SENTINEL = "__compaction_notice__::";

export type CompactionStrategy = "llm" | "deterministic-fallback";

export type CompactionNoticePayload = {
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  strategy: CompactionStrategy;
  /** 人读的一句话，前端直接展示。 */
  humanText: string;
};

export type CompactionResult<M extends UIMessage = UIMessage> = {
  summary: string;
  /** 压缩后的 active model history。UI 全量历史继续保存在 messages 表里。 */
  replacementMessages: M[];
  /** 被本次 replacement 语义覆盖掉的原消息数量，主要用于 UI/debug。 */
  compactedCount: number;
  /** 压缩前、后的 token 粗估，方便日志和 fail-closed 判断。 */
  tokensBefore: number;
  tokensAfter: number;
  strategy: CompactionStrategy;
};

export function buildCompactionNotice(
  result: CompactionResult<UIMessage>,
): UIMessage {
  const strategyText =
    result.strategy === "llm" ? "摘要" : "确定性兜底摘要";
  const humanText = `已用${strategyText}把早期 ${result.compactedCount} 条消息折叠为 active context（${result.tokensBefore} → ${result.tokensAfter} tokens）。`;

  const payload: CompactionNoticePayload = {
    compactedCount: result.compactedCount,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    strategy: result.strategy,
    humanText,
  };

  return {
    id: crypto.randomUUID(),
    role: "system",
    parts: [
      {
        type: "text",
        text: `${COMPACTION_NOTICE_SENTINEL}${JSON.stringify(payload)}`,
      },
    ],
  };
}

export function parseCompactionNotice(
  message: UIMessage,
): CompactionNoticePayload | null {
  if (message.role !== "system") return null;
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
  if (!text.startsWith(COMPACTION_NOTICE_SENTINEL)) return null;
  try {
    const parsed = JSON.parse(
      text.slice(COMPACTION_NOTICE_SENTINEL.length),
    ) as Partial<CompactionNoticePayload>;
    return {
      compactedCount: parsed.compactedCount ?? 0,
      tokensBefore: parsed.tokensBefore ?? 0,
      tokensAfter: parsed.tokensAfter ?? 0,
      strategy: parsed.strategy ?? "llm",
      humanText: parsed.humanText ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * 用于摘要 prompt 输入的精简文本。tool input/output 会截断，避免摘要请求本身
 * 被超大工具输出撑爆。
 */
function messageToSummarizerInput(message: UIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const toolPart = part as {
        type: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
        state?: string;
      };
      const toolName =
        toolPart.type === "dynamic-tool"
          ? toolPart.toolName ?? "dynamic-tool"
          : toolPart.type.replace(/^tool-/, "");
      const inputSummary = toolPart.input
        ? JSON.stringify(toolPart.input).slice(0, 500)
        : "";
      const outputSummary = toolPart.output
        ? JSON.stringify(toolPart.output).slice(0, 800)
        : "";
      const errorSummary = toolPart.errorText
        ? ` error=${toolPart.errorText.slice(0, 300)}`
        : "";
      parts.push(
        `[tool ${toolName}] state=${toolPart.state ?? "unknown"} input=${inputSummary} output=${outputSummary}${errorSummary}`,
      );
    }
  }
  return `[${message.role}] ${parts.join("\n")}`;
}

function messageToFullPlainText(message: UIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const toolPart = part as {
        type: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
        state?: string;
      };
      const toolName =
        toolPart.type === "dynamic-tool"
          ? toolPart.toolName ?? "dynamic-tool"
          : toolPart.type.replace(/^tool-/, "");
      const inputFull = toolPart.input ? JSON.stringify(toolPart.input) : "";
      const outputFull = toolPart.output ? JSON.stringify(toolPart.output) : "";
      const errorFull = toolPart.errorText ? ` error=${toolPart.errorText}` : "";
      parts.push(
        `[tool ${toolName}] state=${toolPart.state ?? "unknown"} input=${inputFull} output=${outputFull}${errorFull}`,
      );
    }
  }
  return `[${message.role}] ${parts.join("\n")}`;
}

export function estimateTokens(messages: UIMessage[]): number {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += messageToFullPlainText(message).length;
  }
  return Math.ceil(totalChars / 3);
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

const COMPACTION_SYSTEM_PROMPT = `
You are a "conversation handoff" summarizer for a coding agent.
Compress the transcript into a concise handoff brief that can replace old
assistant/tool history.

Use these exact headings:

## CURRENT GOAL
What the user is trying to accomplish now.

## COMPLETED
Concrete work already done: files read, files edited, commands run, facts established.

## DECISIONS
Technical decisions and rationale.

## CONSTRAINTS AND USER PREFERENCES
Hard constraints, style rules, validation expectations, and user preferences.

## NEXT STEPS
The next useful actions in order.

## CRITICAL REFERENCES
File paths, commands, ids, or error messages that future work must preserve.

Rules:
- Be concrete. Do not write vague phrases like "the conversation discussed".
- Do not invent facts not present in the transcript.
- Do not include code blocks.
- If a section is empty, write "(none)".
- Keep the result under 600 words.
`.trim();

function buildTranscript(messages: UIMessage[], previousSummary?: string | null) {
  const transcriptParts: string[] = [];
  if (previousSummary) {
    transcriptParts.push(
      `(Previous active-context summary:\n${previousSummary}\n)`,
    );
  }
  transcriptParts.push("--- Conversation transcript to compact ---");
  for (const message of messages) {
    transcriptParts.push(messageToSummarizerInput(message));
  }
  return transcriptParts.join("\n\n");
}

function cloneUserMessageWithText(message: UIMessage, text: string): UIMessage {
  return {
    ...message,
    parts: [{ type: "text", text }],
  };
}

function getUserText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n")
    .trim();
}

function selectRecentUserMessages<M extends UIMessage>(
  messages: M[],
  tokenBudget: number,
  maxMessages: number,
): M[] {
  if (tokenBudget <= 0 || maxMessages <= 0) return [];

  const selected: M[] = [];
  let remaining = tokenBudget;
  let latestUser: M | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    latestUser ??= message;
    if (selected.length >= maxMessages) continue;

    const messageTokens = estimateTokens([message]);
    if (messageTokens > remaining) continue;
    selected.unshift(message);
    remaining -= messageTokens;
  }

  if (selected.length === 0 && latestUser) {
    const maxChars = Math.max(120, tokenBudget * 3);
    const text = getUserText(latestUser).slice(-maxChars);
    return [cloneUserMessageWithText(latestUser, text) as M];
  }

  return selected;
}

function buildDeterministicSummary(params: {
  messages: UIMessage[];
  previousSummary?: string | null;
  reason?: string;
}): string {
  const latestUser = [...params.messages]
    .reverse()
    .find((message) => message.role === "user");
  const latestUserText = latestUser ? getUserText(latestUser) : "";
  const toolNames = new Set<string>();

  for (const message of params.messages) {
    for (const part of message.parts) {
      if (part.type.startsWith("tool-")) {
        toolNames.add(part.type.slice("tool-".length));
      } else if (part.type === "dynamic-tool") {
        toolNames.add((part as { toolName?: string }).toolName ?? "dynamic-tool");
      }
    }
  }

  return [
    "## CURRENT GOAL",
    latestUserText
      ? latestUserText.slice(0, 1200)
      : "The earlier visible transcript was too large to keep in model context.",
    "",
    "## COMPLETED",
    params.previousSummary
      ? `- Previous summary was preserved:\n${params.previousSummary}`
      : "- Earlier assistant and tool details were omitted from active model history to stay within budget.",
    toolNames.size > 0
      ? `- Earlier tool activity included: ${Array.from(toolNames).sort().join(", ")}.`
      : "- No earlier tool names were recoverable from the compacted transcript.",
    "",
    "## DECISIONS",
    "- Deterministic fallback compaction was used because LLM compaction was unavailable or unsafe.",
    "",
    "## CONSTRAINTS AND USER PREFERENCES",
    "- Preserve the full visible UI transcript in storage; use this summary plus recent user intent as active model context.",
    "",
    "## NEXT STEPS",
    "- Continue from the latest user request. If old tool output details are required, ask the user or inspect the workspace again.",
    "",
    "## CRITICAL REFERENCES",
    params.reason ? `- Fallback reason: ${params.reason}` : "- (none)",
  ].join("\n");
}

export function compactMessagesDeterministically<M extends UIMessage>(params: {
  messages: M[];
  keepRecent: number;
  previousSummary?: string | null;
  reason?: string;
  recentUserTokenBudget?: number;
}): CompactionResult<M> {
  const tokensBefore = estimateTokens(params.messages);
  const summary = buildDeterministicSummary({
    messages: params.messages,
    previousSummary: params.previousSummary,
    reason: params.reason,
  });
  const replacementMessages = selectRecentUserMessages(
    params.messages,
    params.recentUserTokenBudget ?? 4_000,
    params.keepRecent,
  );
  const tokensAfter =
    estimateTokens(replacementMessages) + estimateTextTokens(summary);

  return {
    summary,
    replacementMessages,
    compactedCount: Math.max(
      0,
      params.messages.length - replacementMessages.length,
    ),
    tokensBefore,
    tokensAfter,
    strategy: "deterministic-fallback",
  };
}

export async function compactMessages<M extends UIMessage>(params: {
  messages: M[];
  model?: LanguageModel;
  keepRecent: number;
  previousSummary?: string | null;
  recentUserTokenBudget?: number;
  summarizeTranscript?: (input: {
    system: string;
    prompt: string;
  }) => Promise<string>;
}): Promise<CompactionResult<M>> {
  const tokensBefore = estimateTokens(params.messages);
  const transcript = buildTranscript(params.messages, params.previousSummary);

  const summary = params.summarizeTranscript
    ? await params.summarizeTranscript({
        system: COMPACTION_SYSTEM_PROMPT,
        prompt: transcript,
      })
    : await (async () => {
        if (!params.model) {
          throw new Error("compactMessages requires a model or summarizer");
        }
        const result = await generateText({
          model: params.model,
          system: COMPACTION_SYSTEM_PROMPT,
          prompt: transcript,
        });
        return result.text;
      })();

  const replacementMessages = selectRecentUserMessages(
    params.messages,
    params.recentUserTokenBudget ?? 4_000,
    params.keepRecent,
  );
  const normalizedSummary = summary.trim();
  const tokensAfter =
    estimateTokens(replacementMessages) + estimateTextTokens(normalizedSummary);

  return {
    summary: normalizedSummary,
    replacementMessages,
    compactedCount: Math.max(
      0,
      params.messages.length - replacementMessages.length,
    ),
    tokensBefore,
    tokensAfter,
    strategy: "llm",
  };
}
