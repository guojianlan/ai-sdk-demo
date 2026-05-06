import type { Sandbox } from "./interface";
import { connectLocal } from "./local/connect";
import type { SandboxState } from "./types";

/**
 * 按 SandboxState.type 分发到具体实现。
 * 加新 sandbox 类型时：往 SandboxState union 里加成员，TS 会逼着这里补 case。
 */
export async function connectSandbox(state: SandboxState): Promise<Sandbox> {
  switch (state.type) {
    case "local":
      return connectLocal(state);
    default: {
      const _exhaustive: never = state.type;
      throw new Error(`Unknown sandbox type: ${String(_exhaustive)}`);
    }
  }
}
