import type { LocalSandboxState } from "../types";
import { LocalSandbox } from "./index";

/**
 * 把 LocalSandboxState 物化成一个可用的 LocalSandbox。
 * 当前没有异步初始化（不像 cloud 实现需要拉远端 session），但保留 Promise 签名
 * 以便和 factory + cloud 实现保持同构。
 */
export async function connectLocal(
  state: LocalSandboxState,
): Promise<LocalSandbox> {
  return new LocalSandbox({ workingDirectory: state.workingDirectory });
}
