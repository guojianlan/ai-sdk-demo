import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  buildCompactionNotice,
  compactMessages,
  compactMessagesDeterministically,
  estimateTokens,
  parseCompactionNotice,
} from "@/lib/compaction";

function userMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function assistantToolMessage(id: string, output: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-read",
        toolCallId: id,
        state: "output-available",
        input: { filePath: "large.txt" },
        output: { text: output },
      } as UIMessage["parts"][number],
    ],
  };
}

describe("compaction", () => {
  it("deterministic fallback handles corrupted user plus assistant snapshots", () => {
    const messages = [
      userMessage("u1", "Fix the workflow loop and compaction."),
      ...Array.from({ length: 8 }, (_, index) =>
        assistantToolMessage(`a${index}`, "x".repeat(3_000)),
      ),
    ];

    const result = compactMessagesDeterministically({
      messages,
      keepRecent: 4,
      reason: "unit test",
    });

    expect(result.strategy).toBe("deterministic-fallback");
    expect(result.summary).toContain("Deterministic fallback compaction");
    expect(result.replacementMessages).toHaveLength(1);
    expect(result.replacementMessages[0]?.role).toBe("user");
    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThan(estimateTokens(messages));
  });

  it("llm compaction builds user-only replacement history", async () => {
    const messages = [
      userMessage("u1", "Initial request"),
      assistantToolMessage("a1", "tool output".repeat(200)),
      userMessage("u2", "Newest request"),
    ];

    const result = await compactMessages({
      messages,
      keepRecent: 4,
      summarizeTranscript: async () => "## CURRENT GOAL\nContinue safely.",
    });

    expect(result.strategy).toBe("llm");
    expect(result.summary).toContain("Continue safely");
    expect(result.replacementMessages.map((message) => message.role)).toEqual([
      "user",
      "user",
    ]);
    expect(result.replacementMessages.some((message) => message.id === "a1"))
      .toBe(false);
  });

  it("compaction notices preserve strategy metadata", () => {
    const notice = buildCompactionNotice({
      summary: "summary",
      replacementMessages: [userMessage("u1", "hello")],
      compactedCount: 3,
      tokensBefore: 10_000,
      tokensAfter: 900,
      strategy: "deterministic-fallback",
    });

    const parsed = parseCompactionNotice(notice);

    expect(parsed?.strategy).toBe("deterministic-fallback");
    expect(parsed?.compactedCount).toBe(3);
  });
});
