import { describe, expect, it } from "vitest";

import {
  getDefaultFlowNodeConfig,
  getFlowNodeDefinition,
  isRegisteredFlowNodeType,
  normalizeFlowNodeType,
} from "@/lib/flows/node-registry";

describe("flow node registry", () => {
  it("maps legacy canvas node types to canonical registry types", () => {
    expect(normalizeFlowNodeType("start")).toBe("core.start");
    expect(normalizeFlowNodeType("agent")).toBe("ai.agent");
    expect(normalizeFlowNodeType("prompt")).toBe("ai.prompt");
    expect(normalizeFlowNodeType("transform")).toBe("core.transform");
    expect(normalizeFlowNodeType("condition")).toBe("core.condition");
    expect(normalizeFlowNodeType("foreach")).toBe("core.foreach");
    expect(normalizeFlowNodeType("join")).toBe("core.join");
    expect(normalizeFlowNodeType("approval")).toBe("approval.review");
    expect(normalizeFlowNodeType("extractList")).toBe("browser.extractList");
    expect(normalizeFlowNodeType("extractArticle")).toBe("browser.extractArticle");
    expect(normalizeFlowNodeType("planDocumentUpdate")).toBe("document.planUpdate");
    expect(normalizeFlowNodeType("applyDocumentPatch")).toBe("document.applyPatch");
    expect(normalizeFlowNodeType("end")).toBe("core.end");
  });

  it("recognizes both legacy and canonical node types", () => {
    expect(isRegisteredFlowNodeType("agent")).toBe(true);
    expect(isRegisteredFlowNodeType("ai.agent")).toBe(true);
    expect(isRegisteredFlowNodeType("foreach")).toBe(true);
    expect(isRegisteredFlowNodeType("core.foreach")).toBe(true);
    expect(isRegisteredFlowNodeType("join")).toBe(true);
    expect(isRegisteredFlowNodeType("core.join")).toBe(true);
    expect(isRegisteredFlowNodeType("approval")).toBe(true);
    expect(isRegisteredFlowNodeType("approval.review")).toBe(true);
    expect(isRegisteredFlowNodeType("extractList")).toBe(true);
    expect(isRegisteredFlowNodeType("browser.extractList")).toBe(true);
    expect(isRegisteredFlowNodeType("extractArticle")).toBe(true);
    expect(isRegisteredFlowNodeType("browser.extractArticle")).toBe(true);
    expect(isRegisteredFlowNodeType("planDocumentUpdate")).toBe(true);
    expect(isRegisteredFlowNodeType("document.planUpdate")).toBe(true);
    expect(isRegisteredFlowNodeType("applyDocumentPatch")).toBe(true);
    expect(isRegisteredFlowNodeType("document.applyPatch")).toBe(true);
    expect(getFlowNodeDefinition("agent")?.type).toBe("ai.agent");
    expect(getFlowNodeDefinition("approval")?.category).toBe("approval");
    expect(getFlowNodeDefinition("browser.extractList")?.category).toBe("browser");
    expect(getFlowNodeDefinition("browser.extractArticle")?.category).toBe("browser");
    expect(getFlowNodeDefinition("document.planUpdate")?.category).toBe("document");
    expect(getFlowNodeDefinition("document.applyPatch")?.category).toBe("document");
    expect(isRegisteredFlowNodeType("browser.snapshot")).toBe(false);
  });

  it("returns cloned default config objects", () => {
    const first = getDefaultFlowNodeConfig("agent") as {
      retry?: { maxAttempts?: number };
    };
    const second = getDefaultFlowNodeConfig("agent") as {
      retry?: { maxAttempts?: number };
    };

    first.retry = { maxAttempts: 1 };

    expect(second.retry?.maxAttempts).toBe(3);
  });
});
