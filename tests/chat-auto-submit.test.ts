import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { lastAssistantMessageHasCompletedClientContinuationTool } from "@/lib/chat/auto-submit";

function assistantWithParts(parts: UIMessage["parts"]): UIMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    parts,
  };
}

describe("lastAssistantMessageHasCompletedClientContinuationTool", () => {
  it("does not continue ordinary completed server tools", () => {
    const messages = [
      assistantWithParts([
        {
          type: "tool-read",
          toolCallId: "call-1",
          state: "output-available",
          input: { filePath: "app/page.tsx" },
          output: { text: "content" },
        } as UIMessage["parts"][number],
      ]),
    ];

    expect(
      lastAssistantMessageHasCompletedClientContinuationTool({ messages }),
    ).toBe(false);
  });

  it("continues completed client interaction tools", () => {
    const messages = [
      assistantWithParts([
        {
          type: "tool-ask_user_question",
          toolCallId: "call-1",
          state: "output-available",
          input: { question: "Which path?" },
          output: { answer: "Use the backend loop." },
        } as UIMessage["parts"][number],
      ]),
    ];

    expect(
      lastAssistantMessageHasCompletedClientContinuationTool({ messages }),
    ).toBe(true);
  });

  it("waits until all last-step tools are complete", () => {
    const messages = [
      assistantWithParts([
        {
          type: "tool-ask_choice",
          toolCallId: "call-1",
          state: "output-available",
          input: { question: "Pick one", options: [] },
          output: { selectedId: "a" },
        } as UIMessage["parts"][number],
        {
          type: "tool-shell",
          toolCallId: "call-2",
          state: "input-available",
          input: { command: "pwd" },
        } as UIMessage["parts"][number],
      ]),
    ];

    expect(
      lastAssistantMessageHasCompletedClientContinuationTool({ messages }),
    ).toBe(false);
  });
});
