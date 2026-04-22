import { generateText, type LanguageModel, type UIMessage } from "ai";

/**
 * 标记一条 role=system 消息是 compaction 通知而不是随意的 system 内容。
 * 前端靠这个 sentinel 精准识别"这是压缩通知"，渲染成紧凑的一行系统提示；
 * 不同于 user / assistant 气泡。
 */
export const COMPACTION_NOTICE_SENTINEL = "__compaction_notice__::";

export type CompactionNoticePayload = {
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /** 人读的一句话，前端直接展示。 */
  humanText: string;
};

/**
 * 把一次 compaction 的结果打包成一条 role=system 的 UIMessage，给 DB + UI 消费。
 *
 * 消息文本格式：`<sentinel><JSON 字符串化的 payload>`
 * 前端看到 sentinel 开头就解析 payload 渲染，看不到就退回纯文本。
 */
export function buildCompactionNotice(
  result: CompactionResult<UIMessage>,
): UIMessage {
  const humanText = `已把早期 ${result.compactedCount} 条消息折叠为摘要（${result.tokensBefore} → ${result.tokensAfter} tokens）。`;

  const payload: CompactionNoticePayload = {
    compactedCount: result.compactedCount,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
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

/**
 * 前端用：如果这条 UIMessage 是 compaction 通知，解析出结构化 payload；否则返回 null。
 */
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
    return JSON.parse(
      text.slice(COMPACTION_NOTICE_SENTINEL.length),
    ) as CompactionNoticePayload;
  } catch {
    return null;
  }
}

/**
 * P4-b：context compaction。
 *
 * 两件事：
 * 1. `estimateTokens(messages)` —— 粗估整个对话的 token 数。没用 tiktoken，
 *    直接 char count / 3。多语言、包含 JSON tool output 的情形下这个 heuristic
 *    误差 ±30%，**足够做"要不要压缩"的阈值判断**（不需要精确到字节）。
 *    如果以后想精确，可以换 `@dqbd/tiktoken` 或 provider 自家的 tokenizer。
 *
 * 2. `compactMessages({ messages, model, keepRecent })` —— 核心 handoff 摘要逻辑：
 *    - 把老消息（除最近 N 条外）喂给一次**额外的 LLM 调用**
 *    - 让它产出一段结构化摘要（USER'S CORE REQUEST / COMPLETED / DECISIONS /
 *      PREFERENCES / PENDING / OPEN QUESTIONS 六段式，照抄 codex compact.rs 的
 *      字段分类）
 *    - 返回 `{ summary, keptMessages, compactedCount }` —— 主路由拿着 summary
 *      塞进 prompt layer，拿着 keptMessages 当新 history 喂给 agent
 *
 * 设计选择：
 * - 摘要调用用 `generateText` 而不是 `streamText`：摘要是一次性产物，不需要流；
 *   而且调用阻塞在主请求之前，简单直接。
 * - 按**消息边界切**，不按 part 切：tool-call 和对应的 tool-result 都在同一条
 *   assistant message 的 parts 里；按消息切就天然把它们绑在一起。
 * - keepRecent 的切分做了"至少保留一条 user 消息" 的兜底：如果最近 N 条刚好都
 *   是 assistant message（奇怪但可能发生），往前走到找到 user message 为止。
 */

/**
 * 用于**摘要 prompt 输入**的精简文本 —— tool input / output 都截断，省 summarizer token。
 * 注意不能用这个函数来估 token：tool output 被裁成 800 字符，会严重低估模型实际要付的 context 成本。
 */
function messageToSummarizerInput(message: UIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const toolPart = part as {
        type: string;
        input?: unknown;
        output?: unknown;
      };
      const toolName = part.type.replace(/^tool-/, "");
      const inputSummary = toolPart.input
        ? JSON.stringify(toolPart.input).slice(0, 500)
        : "";
      const outputSummary = toolPart.output
        ? JSON.stringify(toolPart.output).slice(0, 800)
        : "";
      parts.push(
        `[tool ${toolName}] input=${inputSummary} output=${outputSummary}`,
      );
    }
  }
  return `[${message.role}] ${parts.join("\n")}`;
}

/**
 * 用于 **token 估算** 的纯文本序列化 —— 把 tool input / output 完整 JSON 化，
 * **不做截断**。因为 compaction 的主要服务场景就是"大 tool output 填满 context"，
 * 估算阶段必须看到真实的体量才会触发压缩。
 */
function messageToFullPlainText(message: UIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const toolPart = part as {
        type: string;
        input?: unknown;
        output?: unknown;
      };
      const toolName = part.type.replace(/^tool-/, "");
      const inputFull = toolPart.input ? JSON.stringify(toolPart.input) : "";
      const outputFull = toolPart.output
        ? JSON.stringify(toolPart.output)
        : "";
      parts.push(`[tool ${toolName}] input=${inputFull} output=${outputFull}`);
    }
  }
  return `[${message.role}] ${parts.join("\n")}`;
}

/**
 * 粗估 tokens。中文 ≈ 1 char/token，英文 ≈ 4 char/token，JSON 介于两者——
 * 用 3 做中间值，足够判断阈值。**不截断 tool output**，这是 compaction 的主要发生场景。
 */
export function estimateTokens(messages: UIMessage[]): number {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += messageToFullPlainText(message).length;
  }
  return Math.ceil(totalChars / 3);
}

const COMPACTION_SYSTEM_PROMPT = `
You are a "conversation handoff" summarizer. Your job is to compress a long
coding-assistant conversation into a concise handoff brief that the next
instance of the assistant can use to continue the work without re-reading
the full history.

Structure your output as six sections, in this exact order, using these
exact headings:

## USER'S CORE REQUEST
What is the user overall trying to accomplish in this conversation?
One to three sentences. Ignore tangents.

## COMPLETED
Concrete work that has already been done: files read, files edited, tools
used, information established. Reference files by relative path. Be
specific but compact. Use bullet points.

## DECISIONS
Key technical judgment calls made so far (library picks, architecture
choices, deliberate tradeoffs). Each bullet: decision + one-line rationale.

## PREFERENCES
Stated user preferences / dislikes / coding style rules that should govern
future work. Each bullet = one preference.

## PENDING
Unfinished sub-tasks or the obvious next step. Ordered by priority.

## OPEN QUESTIONS
Things the user has been asked but hasn't answered yet, or ambiguity the
next assistant will probably need to clarify.

Rules:
- Be concrete. No filler phrases like "the user and assistant discussed".
- Do NOT invent facts not present in the transcript.
- Do NOT include code blocks — reference changes as "edited X to do Y".
- If a section is genuinely empty, write "(none)" under that heading.
- Total output: under ~600 words.
`.trim();

export type CompactionResult<M extends UIMessage = UIMessage> = {
  summary: string;
  /** 保留原样的最近几条消息（按时间顺序）。保持和输入同一种 UIMessage 子类型。 */
  keptMessages: M[];
  /** 被压缩掉的消息数量（前 N 条被 summary 取代）。 */
  compactedCount: number;
  /** 压缩前、后的 token 粗估，方便日志。 */
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * 切分 messages：把"要压缩的前半"和"要保留的后半"分开。
 *
 * 规则：
 * - 先从 `messages.length - keepRecent` 处切
 * - **向前**（往小索引方向）回退直到切点是一条 user message——确保 kept 的第一条
 *   永远是 user role。如果让 kept 以 assistant 起头，LLM 会迷惑于"前面没人发话
 *   为什么会有 assistant 在说话"，直接空转返回 `finish=other`（真坑踩过的）
 * - 如果向前找不到 user（整段都是 assistant），**宁可不压**（返回 toCompact=[]），
 *   也不要让 agent 收到一段没 user 锚定的 kept 消息
 *
 * 副作用：kept 可能比 keepRecent 多几条（因为要兜到 user）——这是用正确性换一点
 * 压缩比，值得。
 */
function splitForCompaction<M extends UIMessage>(
  messages: M[],
  keepRecent: number,
): { toCompact: M[]; kept: M[] } {
  if (messages.length <= keepRecent) {
    return { toCompact: [], kept: messages };
  }

  let splitIndex = messages.length - keepRecent;
  // 向前回退到最近的一条 user message。
  while (splitIndex > 0 && messages[splitIndex].role !== "user") {
    splitIndex--;
  }

  // 边界：前面一整串都没 user role（极端情况），放弃压缩。
  if (messages[splitIndex]?.role !== "user") {
    return { toCompact: [], kept: messages };
  }

  return {
    toCompact: messages.slice(0, splitIndex),
    kept: messages.slice(splitIndex),
  };
}

export async function compactMessages<M extends UIMessage>(params: {
  messages: M[];
  model: LanguageModel;
  keepRecent: number;
  /** 可选：上一次压缩保留下来的 summary。有的话拼进 prompt 作为"上一次压缩结束时的状态"，避免信息丢失。 */
  previousSummary?: string | null;
}): Promise<CompactionResult<M>> {
  const { messages, model, keepRecent, previousSummary } = params;
  const tokensBefore = estimateTokens(messages);

  const { toCompact, kept } = splitForCompaction(messages, keepRecent);

  if (toCompact.length === 0) {
    // 没啥好压的（对话还太短）。返回一个空 summary，调用方自己决定要不要写进 DB。
    return {
      summary: "",
      keptMessages: kept,
      compactedCount: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  // 把老消息拼成纯文本，喂给摘要 LLM。加上上一次的 summary 作为前置 context，
  // 保证链式压缩时信息不会在每一轮丢一点。
  const transcriptParts: string[] = [];
  if (previousSummary) {
    transcriptParts.push(
      `(Previous handoff summary from an earlier compaction:\n${previousSummary}\n)`,
    );
  }
  transcriptParts.push("--- Conversation transcript to compact ---");
  for (const message of toCompact) {
    // 摘要输入用截断版本：tool output 裁到 800 字节，summarizer 看到梗概就够。
    transcriptParts.push(messageToSummarizerInput(message));
  }
  const transcript = transcriptParts.join("\n\n");

  const result = await generateText({
    model,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: transcript,
    // 没必要流式；一次性拿字符串就行。
  });

  const summary = result.text.trim();
  const tokensAfter = estimateTokens(kept) + Math.ceil(summary.length / 3);

  return {
    summary,
    keptMessages: kept,
    compactedCount: toCompact.length,
    tokensBefore,
    tokensAfter,
  };
}
