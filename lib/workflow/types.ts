import { z } from "zod";

/**
 * 工作流核心类型 —— 节点式编排（MVP 顺序执行）。
 *
 * 设计原则：
 * - **节点边界 ≠ HTTP 边界**：节点定义在后端 TS 文件硬编码，前端 WorkflowRunner
 *   按定义顺序逐个发起 `/api/workflow/[id]/node/[nodeId]/run` 请求。
 * - **节点输出累积成 context**：后续节点可通过 `inputs` 字段从 context 取值。
 * - **运行状态前端维护**：MVP 用 sessionStorage 持久化 `WorkflowRunState`，
 *   不入库；后续要做"恢复中断的工作流"再加 server-side 持久化。
 *
 * 节点 kind 四种（discriminated union）：
 * - `agent`     —— 跑一个迷你 ToolLoopAgent（在节点 maxSteps 内自由决策）
 * - `structured` —— 调 streamObject / generateObject 出结构化输出（不带 tool）
 * - `tool`      —— 直接执行某个 tool（无 LLM 调用）
 * - `human`     —— 创建 awaiting-input，前端渲染审批 UI，等用户回包
 */

/** 节点种类。 */
export const nodeKindSchema = z.enum(["agent", "structured", "tool", "human"]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

/**
 * 节点输入映射：把上游 context / 工作流初始 input 的某个字段映射到本节点的入参。
 *
 * key   = 本节点入参名（自由命名）
 * value = JSONPath-lite，支持两种前缀：
 *   - `workflow.input.<field>`         —— 取工作流初始 input 的字段
 *   - `nodes.<nodeId>.output.<field>`  —— 取上游某个节点 output 的字段
 *
 * 例：`{ bugReport: "workflow.input.bugReport", patches: "nodes.propose-fix.output.patches" }`
 */
export type NodeInputs = Record<string, string>;

// ---------- 节点配置（按 kind 区分） ----------

export const agentNodeConfigSchema = z.object({
  kind: z.literal("agent"),
  /**
   * Persona / instructions 模板。允许用 `{{var}}` 占位符引用本节点的 inputs。
   * 例：`"Diagnose the bug. Bug report:\n{{bugReport}}"`
   */
  instructionsTemplate: z.string().min(1),
  /**
   * 本节点允许使用的 tool 名称白名单。从 `lib/tools/` 经 `globalRegistry` 取。
   * 节点配置的"权限边界"，比 access mode 更细。
   */
  tools: z.array(z.string()).default([]),
  /** 本节点 agent loop 的步数上限（安全阀）。 */
  maxSteps: z.number().int().min(1).max(50).default(10),
  /**
   * 本节点是否绕过写入工具的审批（true = 自动批，false = 触发用户审批）。
   * 比如 `apply-patch` 节点已经过 human 审批节点，这里可以设 true。
   */
  bypassPermissions: z.boolean().default(false),
});
export type AgentNodeConfig = z.infer<typeof agentNodeConfigSchema>;

export const structuredNodeConfigSchema = z.object({
  kind: z.literal("structured"),
  instructionsTemplate: z.string().min(1),
  /**
   * 用于 streamObject / generateObject 的输出 schema。
   * 这里存"schema 注册表 key"——具体 Zod schema 在节点执行器 dispatch 时按 key 取。
   * 不直接存 z.ZodType 是因为 schema 内部往往有自定义 method，序列化容易丢。
   */
  outputSchemaKey: z.string().min(1),
});
export type StructuredNodeConfig = z.infer<typeof structuredNodeConfigSchema>;

export const toolNodeConfigSchema = z.object({
  kind: z.literal("tool"),
  /** 直接执行的 tool 名称。 */
  toolName: z.string().min(1),
});
export type ToolNodeConfig = z.infer<typeof toolNodeConfigSchema>;

export const humanNodeConfigSchema = z.object({
  kind: z.literal("human"),
  /**
   * 给用户看的提示模板，支持 `{{var}}` 占位符。
   * 节点执行器把模板渲染后塞进 awaiting-input.payload，前端审批卡渲染它。
   */
  promptTemplate: z.string().min(1),
  /**
   * UI 类型：决定前端用哪种审批组件渲染。
   * MVP 只支持 `approval`（通过/拒绝 + 可选评论），后续可扩展 `text-input` / `multi-choice`。
   */
  uiKind: z.enum(["approval"]).default("approval"),
});
export type HumanNodeConfig = z.infer<typeof humanNodeConfigSchema>;

export const nodeConfigSchema = z.discriminatedUnion("kind", [
  agentNodeConfigSchema,
  structuredNodeConfigSchema,
  toolNodeConfigSchema,
  humanNodeConfigSchema,
]);
export type NodeConfig = z.infer<typeof nodeConfigSchema>;

// ---------- 节点定义 ----------

/**
 * 节点定义。`config.kind` 必须等于 `kind` 字段（外层冗余一份是为了 type-narrow 方便）。
 */
export type NodeDefinition = {
  id: string;
  kind: NodeKind;
  label: string;
  /** UI 描述：节点卡片副标题，给人看。 */
  description?: string;
  /** 输入映射（见 NodeInputs 注释）。 */
  inputs: NodeInputs;
  /**
   * 输出 schema 注册表 key。节点执行器按这个 key 取 Zod schema 校验本节点 output。
   * 输出会按 schema 校验后写进 WorkflowRunState.context.nodes[id].output。
   */
  outputSchemaKey: string;
  config: NodeConfig;
};

export type WorkflowDefinition = {
  id: string;
  label: string;
  description?: string;
  /** 工作流初始 input 的 schema 注册表 key。 */
  inputSchemaKey: string;
  /** MVP：数组顺序即执行顺序，无分支。 */
  nodes: NodeDefinition[];
};

// ---------- 运行时状态 ----------

export type NodeStatus =
  | "pending"
  | "running"
  | "awaiting-input"
  | "done"
  | "error";

/**
 * agent 节点 awaiting-input 的子分类（discriminated by `kind`）。
 *
 * - `human-approval`        —— `human` kind 节点；前端渲染 HumanApprovalCard
 * - `agent-tool-approval`   —— agent 节点中模型要调一个 approvedTool 且 bypass=false
 * - `agent-interactive`     —— agent 节点中模型要调一个 interactiveTool（无 execute）
 * - `agent-step-pause`      —— 用户切了"逐步执行"模式，agent 在两个 step 之间暂停
 */
export type AwaitingInputPayload =
  | {
      kind: "human-approval";
      uiKind: "approval";
      prompt: string;
      context: Record<string, unknown>;
    }
  | {
      kind: "agent-tool-approval";
      toolCallId: string;
      toolName: string;
      input: unknown;
      stepCount: number;
    }
  | {
      kind: "agent-interactive";
      toolCallId: string;
      toolName: string;
      input: unknown;
      stepCount: number;
    }
  | {
      kind: "agent-step-pause";
      stepCount: number;
      maxSteps: number;
      lastText: string;
    };

/** agent 节点 running 时的运行时元信息（让 UI 能渲染 step 进度）。 */
export type AgentLoopProgress = {
  stepCount: number;
  maxSteps: number;
  /** 当前 step 内 LLM 已经产出的纯文本（最近一段）。 */
  lastText: string;
};

export type NodeState =
  | { status: "pending" }
  | {
      status: "running";
      startedAt: number;
      /** agent 节点专用：当前 step 进度。其它 kind 不带。 */
      agentLoop?: AgentLoopProgress;
    }
  | {
      status: "awaiting-input";
      payload: AwaitingInputPayload;
      awaitingSince: number;
    }
  | {
      status: "done";
      output: unknown;
      durationMs: number;
      /** agent 节点：消耗的 step 数（用于 UI 显示 "5/10 steps"）。 */
      stepsUsed?: number;
    }
  | { status: "error"; error: string; failedAt: number };

/**
 * 工作流运行状态。前端 sessionStorage 持久化这个对象（按 workflowRunId 为 key）。
 *
 * `context.workflow.input` = 工作流初始输入
 * `context.nodes[nodeId].output` = 各节点 output
 *
 * 节点 inputs 的字符串路径就是从这个对象上取值（见 NodeInputs）。
 */
export type WorkflowRunState = {
  /** 一次运行的唯一 id（前端创建时生成 uuid）。 */
  runId: string;
  workflowId: string;
  /** 工作流定义快照（前端拿到后渲染节点列表，不依赖再去拉一次）。 */
  workflow: WorkflowDefinition;
  context: {
    workflow: { input: Record<string, unknown> };
    nodes: Record<string, { output: unknown } | undefined>;
  };
  nodeStates: Record<string, NodeState>;
  /** 当前正在执行的节点下标（指向 workflow.nodes[cursor]）；全部完成时 = nodes.length。 */
  cursor: number;
  /** 创建时间。 */
  startedAt: number;
};

// ---------- 节点执行器 I/O 协议 ----------

/**
 * 节点执行器的入参（API 路由收到的 body）。
 *
 * `humanResponse` 字段：当 awaiting-input 状态的节点收到用户回包时，前端把响应放在
 * 这个字段里再次 POST 同一个节点 url。节点执行器看到这个字段，就跳过"创建 awaiting-input"
 * 阶段直接产出 output。
 */
export type RunNodeRequest = {
  runId: string;
  /** 工作流初始 input。 */
  workflowInput: Record<string, unknown>;
  /** 截至当前节点的 context.nodes 快照（用于解析 inputs 路径）。 */
  upstreamOutputs: Record<string, unknown>;
  /** 工作区根目录（节点执行需要传给 tool experimental_context）。 */
  workspaceRoot: string;
  workspaceName?: string;
  /** human 节点专用：用户审批/回填的内容。 */
  humanResponse?: unknown;
};

/**
 * 节点执行器的返回。两种状态：done / awaiting-input / error。
 * `running` 是过程态，由 API 路由在响应里不出现（要么完成、要么挂起、要么失败）。
 */
export type RunNodeResponse =
  | {
      status: "done";
      output: unknown;
      durationMs: number;
      stepsUsed?: number;
    }
  | {
      status: "awaiting-input";
      payload: unknown;
    }
  | { status: "error"; error: string };
