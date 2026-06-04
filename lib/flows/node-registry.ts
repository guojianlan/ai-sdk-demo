export type FlowNodeCategory =
  | "core"
  | "ai"
  | "browser"
  | "file"
  | "document"
  | "approval"
  | "integration";

export type FlowNodeDefinition = {
  type: string;
  aliases?: string[];
  category: FlowNodeCategory;
  label: string;
  description: string;
  defaultTitle: string;
  defaultConfig: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  configSchema?: unknown;
};

const BUILTIN_FLOW_NODE_DEFINITIONS: FlowNodeDefinition[] = [
  {
    type: "core.start",
    aliases: ["start"],
    category: "core",
    label: "开始",
    description: "Flow run 的入口节点，输出运行输入 JSON。",
    defaultTitle: "Start",
    defaultConfig: { input: {} },
  },
  {
    type: "ai.agent",
    aliases: ["agent"],
    category: "ai",
    label: "智能体",
    description: "调用工作区 Agent，可使用工具完成一个节点任务并返回 JSON。",
    defaultTitle: "Agent",
    defaultConfig: {
      prompt: "Use the workspace tools when needed, then return the next JSON object.",
      outputSchema: {
        type: "object",
        additionalProperties: true,
      },
      retry: {
        maxAttempts: 3,
      },
      timeoutMs: 60_000,
      permissionMode: "bypassPermissions",
    },
  },
  {
    type: "ai.prompt",
    aliases: ["prompt"],
    category: "ai",
    label: "提示词",
    description: "调用模型执行结构化提示词任务并返回 JSON。",
    defaultTitle: "Prompt",
    defaultConfig: {
      prompt: "Use the input JSON and return the next JSON object.",
      outputSchema: {
        type: "object",
        additionalProperties: true,
      },
      retry: {
        maxAttempts: 3,
      },
      timeoutMs: 60_000,
      permissionMode: "bypassPermissions",
    },
  },
  {
    type: "core.transform",
    aliases: ["transform"],
    category: "core",
    label: "转换",
    description: "按路径或输入映射改写节点输入输出。",
    defaultTitle: "Transform",
    defaultConfig: {
      inputMapping: {},
      outputPath: "$",
    },
  },
  {
    type: "core.condition",
    aliases: ["condition"],
    category: "core",
    label: "判断",
    description: "根据 JSON 条件选择后续连线。",
    defaultTitle: "Condition",
    defaultConfig: {
      condition: {
        path: "$.ok",
        equals: true,
      },
    },
  },
  {
    type: "core.foreach",
    aliases: ["foreach"],
    category: "core",
    label: "循环",
    description: "把输入数组规范化成 flow items，作为批处理工作流的入口。",
    defaultTitle: "For Each",
    defaultConfig: {
      inputPath: "$.items",
      itemTitlePath: "$.title",
      itemExternalIdPath: "$.id",
      itemStatusPath: "$.status",
      itemMetadataPath: "$",
      limit: 50,
    },
  },
  {
    type: "core.join",
    aliases: ["join"],
    category: "core",
    label: "汇总",
    description: "聚合上游输出里的 items、flowItems 或 results。",
    defaultTitle: "Join",
    defaultConfig: {
      inputPath: "$",
      outputKey: "items",
    },
  },
  {
    type: "browser.extractList",
    aliases: ["extractList"],
    category: "browser",
    label: "网页列表",
    description: "打开网页并抽取链接列表，输出 flow items 供后续批处理节点使用。",
    defaultTitle: "Extract List",
    defaultConfig: {
      url: "https://juejin.cn/frontend",
      itemSelector: "a[href*=\"/post/\"]",
      titleSelector: "",
      hrefSelector: "",
      summarySelector: "",
      hrefIncludes: "/post/",
      baseUrl: "https://juejin.cn",
      limit: 20,
      timeoutMs: 30_000,
    },
  },
  {
    type: "browser.extractArticle",
    aliases: ["extractArticle"],
    category: "browser",
    label: "网页文章",
    description: "抽取一个或多个文章 URL 的标题、正文和摘要，输出可供 AI 评估的 flow items。",
    defaultTitle: "Extract Article",
    defaultConfig: {
      inputPath: "$.items",
      urlPath: "$.url",
      titleSelector: "h1",
      contentSelector: "article, .article-content, .markdown-body, main",
      summarySelector: "",
      limit: 5,
      timeoutMs: 30_000,
    },
  },
  {
    type: "document.planUpdate",
    aliases: ["planDocumentUpdate"],
    category: "document",
    label: "文档计划",
    description: "把来源文章转换成待审批的 document 知识库写入计划，不直接写文件。",
    defaultTitle: "Plan Document Update",
    defaultConfig: {
      inputPath: "$.items",
      targetRoot: "/Users/apple/Desktop/project/document",
      outputDir: "wiki/sources",
      sourceType: "article",
      publisher: "juejin",
      topic: "",
      tags: ["source/article", "source/juejin"],
      limit: 5,
    },
  },
  {
    type: "document.applyPatch",
    aliases: ["applyDocumentPatch"],
    category: "document",
    label: "应用文档",
    description: "应用已审批的 document 写入计划，带 targetRoot 路径边界校验。",
    defaultTitle: "Apply Document Patch",
    defaultConfig: {
      inputPath: "$.plannedChanges",
      targetRoot: "/Users/apple/Desktop/project/document",
      conflictPolicy: "skip",
    },
  },
  {
    type: "approval.review",
    aliases: ["approval"],
    category: "approval",
    label: "审批",
    description: "暂停 Flow run，等待人工确认后再继续执行高风险写入或应用动作。",
    defaultTitle: "Approval",
    defaultConfig: {
      inputPath: "$",
      titlePath: "$.title",
      summaryPath: "$.summary",
      approvalMode: "manual",
    },
  },
  {
    type: "core.end",
    aliases: ["end"],
    category: "core",
    label: "结束",
    description: "Flow run 的结束节点，输出最终 JSON。",
    defaultTitle: "End",
    defaultConfig: {},
  },
];

const DEFINITIONS_BY_TYPE = new Map<string, FlowNodeDefinition>();
const ALIAS_TO_TYPE = new Map<string, string>();

for (const definition of BUILTIN_FLOW_NODE_DEFINITIONS) {
  DEFINITIONS_BY_TYPE.set(definition.type, definition);
  for (const alias of definition.aliases ?? []) {
    ALIAS_TO_TYPE.set(alias, definition.type);
  }
}

export function listFlowNodeDefinitions(): FlowNodeDefinition[] {
  return [...BUILTIN_FLOW_NODE_DEFINITIONS];
}

export function normalizeFlowNodeType(type: string): string {
  return ALIAS_TO_TYPE.get(type) ?? type;
}

export function getFlowNodeDefinition(type: string): FlowNodeDefinition | null {
  return DEFINITIONS_BY_TYPE.get(normalizeFlowNodeType(type)) ?? null;
}

export function isRegisteredFlowNodeType(type: string): boolean {
  return getFlowNodeDefinition(type) !== null;
}

export function isFlowNodeType(type: string, canonicalType: string): boolean {
  return normalizeFlowNodeType(type) === canonicalType;
}

export function isFlowNodeTypeIn(
  type: string,
  canonicalTypes: string[],
): boolean {
  const normalized = normalizeFlowNodeType(type);
  return canonicalTypes.includes(normalized);
}

export function getDefaultFlowNodeTitle(type: string): string {
  return getFlowNodeDefinition(type)?.defaultTitle ?? "Node";
}

export function getDefaultFlowNodeConfig(type: string): unknown {
  return cloneJsonValue(getFlowNodeDefinition(type)?.defaultConfig ?? {});
}

export function getFlowNodeLabel(type: string): string {
  return getFlowNodeDefinition(type)?.label ?? type;
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? {}));
}
