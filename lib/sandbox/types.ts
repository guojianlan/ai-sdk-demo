/**
 * Sandbox state —— factory 用来构造 Sandbox 实例的可序列化描述。
 *
 * 设计：discriminated union，将来加 cloud sandbox 时把 SandboxState 改成
 * `LocalSandboxState | CloudSandboxState`，factory.ts 的 switch 自动逼着补 case。
 */

export type LocalSandboxState = {
  type: "local";
  workingDirectory: string;
};

export type SandboxState = LocalSandboxState;
