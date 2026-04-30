import type { ToolSet } from "ai";

import type { DefinedTool, ToolKind } from "@/lib/tooling/types";

/**
 * Tool 注册中心。`source.ts` / step API 通过它按 name 列表挑出 ToolSet 给
 * streamText 用。
 *
 * 设计取舍：单例模式（默认 export `globalRegistry`）。MVP 不需要多注册中心
 * 的复杂度——所有 tool 在 module load 期一次性 register。后续如果要做 plugin /
 * 多 workspace 隔离的 tool 集合，再考虑实例化。
 */
export class ToolRegistry {
  private byName = new Map<string, DefinedTool>();

  /** 注册一个或多个 tool。重复名直接抛错（防 silent override）。 */
  register(...tools: DefinedTool[]): this {
    for (const t of tools) {
      if (this.byName.has(t.name)) {
        throw new Error(
          `ToolRegistry: tool '${t.name}' already registered (duplicate definition?)`,
        );
      }
      this.byName.set(t.name, t);
    }
    return this;
  }

  /** 按名拿单个 tool。未注册抛错。 */
  get(name: string): DefinedTool {
    const t = this.byName.get(name);
    if (!t) {
      throw new Error(
        `ToolRegistry: unknown tool '${name}'. Registered: ${[...this.byName.keys()].join(", ")}`,
      );
    }
    return t;
  }

  /**
   * 按 name 列表挑出 ToolSet 直接给 AI SDK 用（spread 进 streamText 的 tools 字段）。
   * 未知名字抛错——防止节点定义和 registry 之间 silent drift。
   */
  pick(names: readonly string[]): ToolSet {
    const out: ToolSet = {};
    for (const name of names) {
      out[name] = this.get(name).aiTool;
    }
    return out;
  }

  /** 按 kind 过滤（UI 分组 / debug 用）。 */
  byKind(kind: ToolKind): DefinedTool[] {
    return [...this.byName.values()].filter((t) => t.kind === kind);
  }

  /** 全部已注册 tool。 */
  all(): DefinedTool[] {
    return [...this.byName.values()];
  }

  /** 全部已注册 tool 名（debug / UI 用）。 */
  names(): string[] {
    return [...this.byName.keys()];
  }
}

/**
 * 仓库唯一 ToolRegistry 实例。
 *
 * 注册在 `lib/tools/index.ts`：那里 import 全部业务 tool 文件并依次 register。
 * 注意：依赖 import 顺序——任何调用 globalRegistry 的代码必须先 import
 * `lib/tools` 触发注册。
 */
export const globalRegistry = new ToolRegistry();
