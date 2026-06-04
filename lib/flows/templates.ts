import type { FlowNodeType } from "@/lib/persistence/flows";

export type FlowTemplateId = "juejin-frontend-document-intake";

export type FlowTemplateNode = {
  key: string;
  type: FlowNodeType;
  title: string;
  position: { x: number; y: number };
  config: unknown;
};

export type FlowTemplateEdge = {
  source: string;
  target: string;
  condition?: unknown | null;
};

export type FlowTemplate = {
  id: FlowTemplateId;
  title: string;
  description: string;
  nodes: FlowTemplateNode[];
  edges: FlowTemplateEdge[];
};

export const JUEJIN_FRONTEND_DOCUMENT_INTAKE_TEMPLATE: FlowTemplate = {
  id: "juejin-frontend-document-intake",
  title: "掘金前端文档入库",
  description:
    "抓取掘金前端文章列表，抽取文章正文，生成 document 写入计划，经人工审批后写入来源笔记。",
  nodes: [
    {
      key: "start",
      type: "core.start",
      title: "Start",
      position: { x: 80, y: 220 },
      config: { input: {} },
    },
    {
      key: "extractList",
      type: "browser.extractList",
      title: "读取掘金前端列表",
      position: { x: 340, y: 220 },
      config: {
        url: "https://juejin.cn/frontend",
        itemSelector: 'a[href*="/post/"]',
        titleSelector: "",
        hrefSelector: "",
        summarySelector: "",
        hrefIncludes: "/post/",
        baseUrl: "https://juejin.cn",
        limit: 1,
        timeoutMs: 30_000,
      },
    },
    {
      key: "extractArticle",
      type: "browser.extractArticle",
      title: "抽取文章正文",
      position: { x: 620, y: 220 },
      config: {
        inputPath: "$.items",
        urlPath: "$.url",
        titleSelector: "h1",
        contentSelector: "article, .article-content, .markdown-body, main",
        summarySelector: "",
        limit: 1,
        timeoutMs: 30_000,
      },
    },
    {
      key: "planUpdate",
      type: "document.planUpdate",
      title: "生成文档计划",
      position: { x: 900, y: 220 },
      config: {
        inputPath: "$.items",
        targetRoot: "/Users/apple/Desktop/project/document",
        outputDir: "wiki/sources",
        sourceType: "article",
        publisher: "juejin",
        topic: "frontend",
        tags: ["source/article", "source/juejin", "topic/frontend"],
        limit: 1,
      },
    },
    {
      key: "approval",
      type: "approval.review",
      title: "人工审批",
      position: { x: 1180, y: 220 },
      config: {
        inputPath: "$",
        titlePath: "$.title",
        summaryPath: "$.summary",
        approvalMode: "manual",
      },
    },
    {
      key: "applyPatch",
      type: "document.applyPatch",
      title: "写入 document",
      position: { x: 1460, y: 220 },
      config: {
        inputPath: "$.plannedChanges",
        targetRoot: "/Users/apple/Desktop/project/document",
        conflictPolicy: "skip",
      },
    },
    {
      key: "end",
      type: "core.end",
      title: "End",
      position: { x: 1740, y: 220 },
      config: {},
    },
  ],
  edges: [
    { source: "start", target: "extractList" },
    { source: "extractList", target: "extractArticle" },
    { source: "extractArticle", target: "planUpdate" },
    { source: "planUpdate", target: "approval" },
    { source: "approval", target: "applyPatch" },
    { source: "applyPatch", target: "end" },
  ],
};

const FLOW_TEMPLATES = new Map<FlowTemplateId, FlowTemplate>([
  [
    JUEJIN_FRONTEND_DOCUMENT_INTAKE_TEMPLATE.id,
    JUEJIN_FRONTEND_DOCUMENT_INTAKE_TEMPLATE,
  ],
]);

export function getFlowTemplate(templateId: string): FlowTemplate | null {
  return FLOW_TEMPLATES.get(templateId as FlowTemplateId) ?? null;
}

