import type { UIMessage } from "ai";

const CLIENT_CONTINUATION_TOOLS = new Set([
  "ask_user_question",
  "ask_choice",
  "show_reference",
]);

type ToolLikePart = {
  type: string;
  toolName?: string;
  state?: string;
  providerExecuted?: boolean;
};

function isToolLikePart(
  part: UIMessage["parts"][number],
): part is UIMessage["parts"][number] & ToolLikePart {
  return (
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  );
}

function getToolName(part: ToolLikePart): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "";
  return part.type.slice("tool-".length);
}

function getLastStepToolParts(message: UIMessage): ToolLikePart[] {
  const lastStepStartIndex = message.parts.reduce((lastIndex, part, index) => {
    return part.type === "step-start" ? index : lastIndex;
  }, -1);

  return message.parts
    .slice(lastStepStartIndex + 1)
    .filter(isToolLikePart)
    .filter((part) => !part.providerExecuted);
}

/**
 * Client-side auto-submit is only for tools whose output is produced by the
 * browser after a human interaction. Server-side tool results are continued by
 * the backend workflow loop and must not create a new POST/workflow run.
 */
export function lastAssistantMessageHasCompletedClientContinuationTool({
  messages,
}: {
  messages: UIMessage[];
}): boolean {
  const message = messages[messages.length - 1];
  if (!message || message.role !== "assistant") return false;

  const toolParts = getLastStepToolParts(message);
  const clientToolParts = toolParts.filter((part) =>
    CLIENT_CONTINUATION_TOOLS.has(getToolName(part)),
  );

  return (
    clientToolParts.length > 0 &&
    clientToolParts.some((part) => part.state === "output-available") &&
    toolParts.every(
      (part) =>
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "approval-responded" ||
        part.state === "output-denied",
    )
  );
}
