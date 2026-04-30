/**
 * 节点 instructionsTemplate / promptTemplate / inputs 路径解析。
 *
 * 两个能力：
 * 1. `resolveInputs(inputsMap, runtimeContext)` —— 把节点的 `inputs` 路径表
 *    （`{ bugReport: "workflow.input.bugReport" }`）按运行时 context 取值，
 *    返回 `{ bugReport: "实际值" }` 的字面量对象。
 *
 * 2. `renderTemplate(template, inputs)` —— 把 `{{var}}` 占位符按 inputs 替换。
 *    占位符语法故意做得很窄（只支持单层变量名），不支持表达式 / 条件，
 *    避免 prompt 注入和模板调试地狱。复杂逻辑放节点执行器里。
 *
 * 设计取舍：
 * - 路径用点分（`workflow.input.bugReport`）而不是 JSONPath 完整规范——MVP 只
 *   需要二层（workflow.input.X / nodes.<id>.output.X），简单 split 够用。
 * - 路径解析失败抛错：silent fallback 比抛错难调多了，节点定义里写错路径要立刻挂。
 */

export type RuntimeContext = {
  workflow: { input: Record<string, unknown> };
  nodes: Record<string, { output: unknown } | undefined>;
};

/**
 * 取嵌套字段。例：`getDeep(obj, ["nodes", "diagnose", "output", "rootCause"])`
 * 任一中间层为 undefined / 非 object → 抛错。
 */
function getDeep(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (let i = 0; i < path.length; i++) {
    if (current === null || typeof current !== "object") {
      throw new Error(
        `Path '${path.slice(0, i + 1).join(".")}' is not an object (got ${typeof current})`,
      );
    }
    current = (current as Record<string, unknown>)[path[i]];
  }
  return current;
}

export function resolveInputs(
  inputsMap: Record<string, string>,
  context: RuntimeContext,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, pathStr] of Object.entries(inputsMap)) {
    const path = pathStr.split(".");
    if (path.length < 2) {
      throw new Error(
        `Invalid input path '${pathStr}' for input '${key}': need at least 2 segments`,
      );
    }
    try {
      resolved[key] = getDeep(context, path);
    } catch (error) {
      throw new Error(
        `Failed to resolve input '${key}' (path '${pathStr}'): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return resolved;
}

/**
 * 占位符替换。`{{var}}` → inputs[var]。
 *
 * - var 必须是 inputs 里已有的 key；不在则抛错（早 fail，避免模板里悄悄留 `{{}}`）
 * - 替换值会被 stringify：
 *   - string 直接用
 *   - 其它（object / array / number / boolean）用 JSON.stringify(..., null, 2)
 *     （便于 LLM 看清结构）
 */
export function renderTemplate(
  template: string,
  inputs: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in inputs)) {
      throw new Error(
        `Template references unknown input '${name}'. Available: ${Object.keys(inputs).join(", ") || "(none)"}`,
      );
    }
    const value = inputs[name];
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  });
}
