import type { UIMessage } from "ai";

import { extractMessageText } from "@/app/_lib/chat-session";

import { ToolPartCard } from "./tool-card/ToolPartCard";
import { isToolPart, type ApprovalHandler } from "./tool-card/types";

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
}: {
  message: UIMessage;
  onApproval: ApprovalHandler;
}) {
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
              return (
                <div
                  key={`text-${index}`}
                  className="whitespace-pre-wrap text-[15px] leading-7 text-slate-800"
                >
                  {(part as { text: string }).text}
                </div>
              );
            }

            if (isToolPart(part)) {
              const keyId = part.toolCallId ?? `tool-${index}`;
              return <ToolPartCard key={keyId} part={part} onApproval={onApproval} />;
            }

            return null;
          })}
        </div>
      </div>
    </div>
  );
}
