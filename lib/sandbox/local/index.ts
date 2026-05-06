import { spawn } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";

import { resolveWorkspacePath } from "@/lib/workspaces";

import type {
  ExecResult,
  Sandbox,
  SandboxStats,
} from "../interface";

/**
 * 本机 sandbox 实现 —— fs + child_process。
 *
 * 关键安全点：
 * - 所有 path 都过 `resolveWorkspacePath(workingDirectory, p)`，沿用 workspaces.ts
 *   原有的 ".." escape 校验。这是当前 workspace 安全防御的核心，**不能在 sandbox
 *   抽象层上消失**。
 * - `exec` 使用 `shell: true`，方便构造带 quote / 管道的命令（例如 ripgrep + glob）。
 *   **代价是命令字符串必须由调用方保证可信**：不要让 model 直接控制 command 字符串，
 *   只给受控工具（如 search_code）构造命令时使用，并在那一层做 shell-escape。
 *
 * cloud-only 字段（snapshot / extendTimeout / domain / execDetached）不实现。
 */

const DEFAULT_OUTPUT_TRUNCATE_BYTES = 1_000_000; // 1MB

export class LocalSandbox implements Sandbox {
  readonly type = "local" as const;
  readonly workingDirectory: string;

  constructor(opts: { workingDirectory: string }) {
    this.workingDirectory = opts.workingDirectory;
  }

  async readFile(p: string, encoding: "utf-8"): Promise<string> {
    const safe = resolveWorkspacePath(this.workingDirectory, p);
    return fs.readFile(safe, encoding);
  }

  async writeFile(
    p: string,
    content: string,
    encoding: "utf-8",
  ): Promise<void> {
    const safe = resolveWorkspacePath(this.workingDirectory, p);
    await fs.writeFile(safe, content, encoding);
  }

  async stat(p: string): Promise<SandboxStats> {
    const safe = resolveWorkspacePath(this.workingDirectory, p);
    const s = await fs.stat(safe);
    return {
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async access(p: string): Promise<void> {
    const safe = resolveWorkspacePath(this.workingDirectory, p);
    await fs.access(safe);
  }

  async mkdir(p: string, options?: { recursive?: boolean }): Promise<void> {
    const safe = resolveWorkspacePath(this.workingDirectory, p);
    await fs.mkdir(safe, options);
  }

  async readdir(
    p: string,
    options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    const safe = resolveWorkspacePath(this.workingDirectory, p);
    return fs.readdir(safe, options);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    // cwd 同样过校验，避免传 "../foo" 跳出 workspace。
    const safeCwd = resolveWorkspacePath(this.workingDirectory, cwd);

    return new Promise<ExecResult>((resolve) => {
      // shell:true：让调用方可以传完整 command line（带 args / quote）。
      // 安全前提：command 必须由调用方 escape；不要把模型直接给的字符串塞进来。
      const child = spawn(command, {
        cwd: safeCwd,
        shell: true,
        signal: options?.signal,
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeoutMs)
          : null;

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        if (stdout.length + text.length > DEFAULT_OUTPUT_TRUNCATE_BYTES) {
          stdout += text.slice(
            0,
            Math.max(0, DEFAULT_OUTPUT_TRUNCATE_BYTES - stdout.length),
          );
          truncated = true;
        } else {
          stdout += text;
        }
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        if (stderr.length + text.length > DEFAULT_OUTPUT_TRUNCATE_BYTES) {
          stderr += text.slice(
            0,
            Math.max(0, DEFAULT_OUTPUT_TRUNCATE_BYTES - stderr.length),
          );
          truncated = true;
        } else {
          stderr += text;
        }
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const finalStderr = timedOut
          ? `${stderr}${stderr ? "\n" : ""}[exec] killed after ${timeoutMs}ms timeout`
          : stderr;
        resolve({
          success: !timedOut && code === 0,
          exitCode: code,
          stdout,
          stderr: finalStderr,
          truncated,
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          success: false,
          exitCode: null,
          stdout,
          stderr: stderr + (stderr ? "\n" : "") + (err.message ?? String(err)),
          truncated,
        });
      });
    });
  }

  async stop(): Promise<void> {
    // local sandbox 没有需要释放的远端资源；保留方法为了对齐接口。
  }

  getState() {
    return {
      type: "local" as const,
      workingDirectory: this.workingDirectory,
    };
  }
}
