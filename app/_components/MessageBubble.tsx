import type { UIMessage } from "ai";

import { extractMessageText } from "@/app/_lib/chat-session";
import { parseCompactionNotice } from "@/lib/compaction";

import { AssistantMarkdown } from "./AssistantMarkdown";
import { ToolPartCard } from "./tool-card/ToolPartCard";
import {
  isToolPart,
  type ApprovalHandler,
  type OnToolOutputHandler,
} from "./tool-card/types";

/**
 * role=system 消息是我们自己造的 UI 标记（目前只有 compaction 通知一种）。
 * 单独渲染成一行紧凑的虚线系统通知，不是气泡，避免占视觉位。
 */
function SystemNoticeLine({ message }: { message: UIMessage }) {
  const compaction = parseCompactionNotice(message);
  if (compaction) {
    return (
      <div className="my-2 flex items-center gap-3 px-2">
        <span
          className="h-px flex-1 bg-slate-200"
          aria-hidden="true"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to right, #cbd5e1 0, #cbd5e1 4px, transparent 4px, transparent 8px)",
            backgroundColor: "transparent",
          }}
        />
        <span className="inline-flex items-center gap-2 rounded-sm border border-slate-300 bg-white px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">
          <span
            className="h-1.5 w-1.5 rounded-full bg-slate-500"
            aria-hidden="true"
          />
          compacted · {compaction.compactedCount} msgs ·{" "}
          {(compaction.tokensBefore / 1000).toFixed(1)}k→
          {(compaction.tokensAfter / 1000).toFixed(1)}k tokens
        </span>
        <span
          className="h-px flex-1 bg-slate-200"
          aria-hidden="true"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to right, #cbd5e1 0, #cbd5e1 4px, transparent 4px, transparent 8px)",
            backgroundColor: "transparent",
          }}
        />
      </div>
    );
  }

  // 兜底：未知 system 消息（future-proof），给一个朴素的单行 system 提示。
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("")
    .trim();
  if (!text) return null;
  return (
    <div className="my-2 px-2 font-mono text-[11px] italic text-slate-500">
      system · {text}
    </div>
  );
}

/**
 * 一条消息的气泡。
 *
 * 实际上消息是由多个 part 拼出来的：文本段 + tool 调用段 + 文本段 ...
 * 这里按顺序遍历所有可渲染 part：文本段直接展示，tool 段交给 ToolPartCard。
 *
 * 用户消息右对齐 + 天蓝色左边线；Agent 消息左对齐 + 深色左边线——我们一眼就能
 * 分辨说话方，不需要额外的 avatar。
 */
export function MessageBubble({
  message,
  onApproval,
  onToolOutput,
}: {
  message: UIMessage;
  onApproval: ApprovalHandler;
  onToolOutput: OnToolOutputHandler;
}) {
  // system role 消息（目前只有 compaction 通知）走单独一行的系统通知样式，
  // 不是气泡。提前 return，避免下面的 user/assistant 气泡逻辑介入。
  if (message.role === "system") {
    return <SystemNoticeLine message={message} />;
  }

  const isUser = message.role === "user";
  const renderableParts = message.parts.filter(
    (part) =>
      (part.type === "text" && extractMessageText({ ...message, parts: [part] })) ||
      isToolPart(part),
  );

  if (renderableParts.length === 0) {
    return null;
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "relative max-w-[88%] space-y-3 rounded-md border bg-white px-5 py-4",
          isUser
            ? "border-sky-500 border-l-[3px]"
            : "border-slate-300 border-l-[3px] border-l-slate-900",
        ].join(" ")}
      >
        <div className="flex items-center gap-2">
          <span className="h-px w-4 bg-slate-300" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-500">
            {isUser ? "[ YOU ]" : "[ ENGINEER ]"}
          </span>
        </div>
        <div className="space-y-3">
          {renderableParts.map((part, index) => {
            if (part.type === "text") {
              const text = (part as { text: string }).text;
              // user 消息保持纯文本，不过 markdown —— 避免用户随手打的 `*foo*` 被吃成斜体、
              // 或者贴的代码片段里 ` 被当成 inline code 起始。
              if (isUser) {
                return (
                  <div
                    key={`text-${index}`}
                    className="whitespace-pre-wrap text-[15px] leading-7 text-slate-800"
                  >
                    {text}
                  </div>
                );
              }
              return <AssistantMarkdown key={`text-${index}`} text={text} />;
            }

            if (isToolPart(part)) {
              const keyId = part.toolCallId ?? `tool-${index}`;
              return (
                <ToolPartCard
                  key={keyId}
                  part={part}
                  onApproval={onApproval}
                  onToolOutput={onToolOutput}
                />
              );
            }

            return null;
          })}
        </div>
      </div>
    </div>
  );
}
