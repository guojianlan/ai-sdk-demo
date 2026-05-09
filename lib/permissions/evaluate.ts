import type { PermissionBehavior, PermissionRule } from "./types";

/**
 * ACL 评估器 —— 给定 (toolName, ruleContent, rules)，返回 'allow' | 'deny' | 'ask' | null。
 *
 * 决策语义（对齐 claude-code）：
 * 1. **Deny 优先**：所有规则里只要有一条 deny 命中，立刻 deny。即使后面有 allow，
 *    也压不住——这是 settings.json"组织级 deny 兜底"想表达的意思。
 * 2. **首个 allow/ask 胜**：deny 都没命中，就按 rules 顺序找第一条 allow 或 ask。
 *    rules 顺序由 settings 加载器保证（closer-to-cwd 在前），所以更具体的层级先匹配。
 * 3. **全没命中 → null**：调用方应回落到 tool 自身的 `needsApproval` 默认逻辑
 *    （C3 接入时实现），而不是默认 allow。
 *
 * 跟 claude-code 的差异：
 * - 我们规则匹配走 zod 对象 + 简易 glob，不解析 `Tool(pattern)` 字符串语法
 * - 不实现 `dontAsk` 状态机（用户已确认不做）
 *
 * Glob 语义：
 * - `*` → 任意字符（含空格、含 /），贪婪；shell command 和 path 都用同一套
 * - `?` → 任意单字符
 * - 全字符串锚定（`^pattern$`）；想匹配子串时显式写 `*foo*`
 * - 其它正则元字符自动转义
 */

/**
 * 把 glob pattern 转成锚定正则。
 * 思路：先把所有正则元字符转义（除了 `*` 和 `?`），再把 `*` 替换成 `.*`、`?` 替换成 `.`。
 * 这样能保留点号、加号、括号等字面意义，但允许 `*` `?` 起 glob 作用。
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexBody = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexBody}$`);
}

/**
 * 单条规则是否命中目标。
 *
 * - `tool: "*"` 任意 toolName 命中
 * - `tool: "shell"` 仅当 toolName === "shell" 命中
 * - 没 `pattern` → 命中（适合"整个工具一刀切"）
 * - 有 `pattern` 但调用方没传 ruleContent → 不命中（避免误伤无内容场景）
 * - 有 `pattern` 且有 ruleContent → glob 匹配
 */
export function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (rule.tool !== "*" && rule.tool !== toolName) return false;
  if (rule.pattern === undefined) return true;
  if (ruleContent === undefined) return false;
  try {
    return globToRegex(rule.pattern).test(ruleContent);
  } catch (error) {
    // 极端情况下 globToRegex 抛 —— 打 warn 不命中，绝不传染上层。
    console.warn(
      `[permissions] invalid glob pattern "${rule.pattern}":`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * 主评估入口。返回 null 表示"没规则匹配"，调用方按默认逻辑处理。
 *
 * @param toolName tool 名（如 `"shell"`、`"write"`、`"read"`）
 * @param ruleContent 这次调用要被规则盘查的内容；shell 工具传 command，
 *   write/read 传 relativePath，没什么可盘查的工具传 undefined
 * @param rules `loadSettings().rules`，已经按 closer-wins 排过序
 */
export function evaluatePermission(
  toolName: string,
  ruleContent: string | undefined,
  rules: PermissionRule[],
): PermissionBehavior | null {
  // 第一遍：deny 兜底优先扫描
  for (const rule of rules) {
    if (rule.behavior !== "deny") continue;
    if (ruleMatches(rule, toolName, ruleContent)) return "deny";
  }
  // 第二遍：第一条命中的 allow/ask 胜
  for (const rule of rules) {
    if (rule.behavior === "deny") continue;
    if (ruleMatches(rule, toolName, ruleContent)) return rule.behavior;
  }
  return null;
}
