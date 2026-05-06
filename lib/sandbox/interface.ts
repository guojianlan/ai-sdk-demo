import type { Dirent } from "node:fs";

/**
 * Sandbox 抽象层 —— 对齐 open-agents `packages/sandbox/interface.ts`。
 *
 * 设计目标：
 * - 把"工具底层 IO（读写文件、跑 shell）"和"工具的业务逻辑"解耦。
 * - 当前只实现 `local` —— 本机 fs + child_process。
 * - 将来要切换到远程 sandbox（Vercel cloud / Daytona / E2B 等）时，
 *   只需要新增一个 `Sandbox` 实现 + 在 `connectSandbox` factory 里 dispatch，
 *   工具代码一行不动。
 *
 * 几个 cloud-only 的字段（`snapshot` / `extendTimeout` / `domain` / `execDetached` /
 * `currentBranch` / `host` / `expiresAt` / `timeout` / `environmentDetails`）保留为
 * optional —— 本地实现不提供，调用方需要时自行 narrow。
 */

export type SandboxType = "cloud" | "local";

/**
 * Lifecycle hook that receives the sandbox instance.
 */
export type SandboxHook = (sandbox: Sandbox) => Promise<void>;

export interface SandboxHooks {
  afterStart?: SandboxHook;
  beforeStop?: SandboxHook;
  onTimeout?: SandboxHook;
  onTimeoutExtended?: (sandbox: Sandbox, additionalMs: number) => Promise<void>;
}

/**
 * File stats returned by sandbox.stat().
 * Mirrors the subset of fs.Stats used by the tools.
 */
export interface SandboxStats {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Result of shell command execution.
 */
export interface ExecResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SnapshotResult {
  snapshotId: string;
}

/**
 * Sandbox interface for file system and shell operations.
 *
 * Path 语义：
 * - 所有 path 参数均按"workspace-relative"语义传入（也接受落在 workingDirectory
 *   下的绝对路径）。具体校验由实现方负责（local 实现复用 `resolveWorkspacePath`，
 *   拒绝任何 ".." escape）。
 */
export interface Sandbox {
  readonly type: SandboxType;
  readonly workingDirectory: string;

  readonly env?: Record<string, string>;
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;
  readonly environmentDetails?: string;
  readonly host?: string;
  readonly expiresAt?: number;
  readonly timeout?: number;

  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf-8"): Promise<void>;
  stat(path: string): Promise<SandboxStats>;
  access(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult>;

  execDetached?(command: string, cwd: string): Promise<{ commandId: string }>;
  domain?(port: number): string;
  stop(): Promise<void>;
  extendTimeout?(additionalMs: number): Promise<{ expiresAt: number }>;
  snapshot?(): Promise<SnapshotResult>;
  getState?(): unknown;
}
