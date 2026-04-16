/**
 * Prompt 分层组装器 —— 把"一坨 system prompt"拆成有语义的几层，
 * 在代码里各自命名、各自构造，最后拼回一个字符串塞给 AI SDK 的 `instructions`。
 *
 * 为什么不直接拼字符串？
 *
 * 1. **关注点分离**：Persona（稳定身份）、Developer rules（运行期规则）、
 *    Environment context（会话环境）、User instructions（项目规则）本来
 *    就是四类不同性质的内容；拆开后每层可以独立改、独立测试。
 * 2. **可观测性**：装配完可以把每层单独 dump 出来看，方便调试（比如
 *    "我这次发给模型的到底是什么"）。
 * 3. **可升级**：将来如果你想切到 codex 那种"多消息 role"的真三段式
 *    （Persona 进 `instructions`、其他几层以 system/user 消息注入），
 *    只需要换装配层，上游构造代码不动。
 *
 * 注入时的层顺序（对应 codex 的 build_initial_context 设计）：
 *   1. Persona              —— 最稳定，放最顶
 *   2. Developer rules      —— 运行期规则，次之
 *   3. Environment context  —— 客观环境事实
 *   4. User instructions    —— 用户项目规则（AGENTS.md）
 *
 * 详见 docs/codex-prompt-layering.md 的对照表。
 */

export type PromptLayers = {
  /** 稳定身份与语气。等价于 codex 的 `base_instructions`。 */
  persona: string;
  /** 运行期行为规则（基于当前 access mode / tool mode 等会变化）。 */
  developerRules: string;
  /**
   * 环境上下文 XML。由 session-primer 生成，形如：
   *   <environment_context>
   *     <cwd>…</cwd>
   *     <shell>zsh</shell>
   *     …
   *   </environment_context>
   */
  environmentContext: string;
  /**
   * 用户项目规则：AGENTS.md / AGENTS.override.md 拼接结果。
   * 没有任何 AGENTS.md 时为 null，会自动被跳过。
   */
  userInstructions: string | null;
};

/** 每层在最终字符串里的标题。沿用 codex 的风格（# 开头 + 语义名）。 */
const LAYER_HEADINGS = {
  persona: "# Persona",
  developerRules: "# Developer rules",
  environmentContext: "# Environment context",
  userInstructions: "# User project instructions",
} as const;

/**
 * 组装成单个 `instructions` 字符串。
 * 每层前加一个 markdown 标题，section 之间空一行分隔。
 *
 * 这个函数刻意保持纯函数：相同输入 → 相同输出，方便测试和缓存。
 */
export function assemblePromptLayers(layers: PromptLayers): string {
  const sections: string[] = [];

  const pushSection = (heading: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) {
      return;
    }
    sections.push(`${heading}\n\n${trimmed}`);
  };

  pushSection(LAYER_HEADINGS.persona, layers.persona);
  pushSection(LAYER_HEADINGS.developerRules, layers.developerRules);
  pushSection(LAYER_HEADINGS.environmentContext, layers.environmentContext);
  if (layers.userInstructions) {
    pushSection(LAYER_HEADINGS.userInstructions, layers.userInstructions);
  }

  return sections.join("\n\n");
}

/**
 * 调试辅助：把装配结果按层分解，便于面板展示 / 日志输出。
 * 装配逻辑和 assemblePromptLayers 一致，但返回每层单独的字符串和总长度。
 */
export function explainPromptLayers(layers: PromptLayers): {
  sections: Array<{ name: string; heading: string; body: string; chars: number }>;
  combined: string;
  totalChars: number;
} {
  const entries: Array<[keyof PromptLayers, string, string]> = [
    ["persona", LAYER_HEADINGS.persona, layers.persona],
    ["developerRules", LAYER_HEADINGS.developerRules, layers.developerRules],
    ["environmentContext", LAYER_HEADINGS.environmentContext, layers.environmentContext],
  ];

  if (layers.userInstructions) {
    entries.push([
      "userInstructions",
      LAYER_HEADINGS.userInstructions,
      layers.userInstructions,
    ]);
  }

  const sections = entries
    .map(([name, heading, body]) => ({
      name,
      heading,
      body: body.trim(),
      chars: body.trim().length,
    }))
    .filter((section) => section.body.length > 0);

  const combined = assemblePromptLayers(layers);

  return {
    sections,
    combined,
    totalChars: combined.length,
  };
}
