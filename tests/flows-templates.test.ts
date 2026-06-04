import { describe, expect, it } from "vitest";

import { getFlowTemplate } from "@/lib/flows/templates";

describe("flow templates", () => {
  it("keeps the Juejin document intake template behind approval", () => {
    const template = getFlowTemplate("juejin-frontend-document-intake");

    expect(template?.nodes.map((node) => node.type)).toEqual([
      "core.start",
      "browser.extractList",
      "browser.extractArticle",
      "document.planUpdate",
      "approval.review",
      "document.applyPatch",
      "core.end",
    ]);
    expect(template?.edges).toEqual([
      { source: "start", target: "extractList" },
      { source: "extractList", target: "extractArticle" },
      { source: "extractArticle", target: "planUpdate" },
      { source: "planUpdate", target: "approval" },
      { source: "approval", target: "applyPatch" },
      { source: "applyPatch", target: "end" },
    ]);

    const applyNode = template?.nodes.find(
      (node) => node.type === "document.applyPatch",
    );
    expect(applyNode?.config).toMatchObject({
      targetRoot: "/Users/apple/Desktop/project/document",
      conflictPolicy: "skip",
    });
  });
});

