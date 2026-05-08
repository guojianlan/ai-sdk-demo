# Sandbox 迁移回顾

> **状态**：已完成。本文件保留为实现回顾和后续 cloud sandbox adapter 的参考。

---

## 1. 背景

参考主文档 [docs/open-agents-alignment-plan.md](./open-agents-alignment-plan.md) §0、§6。

**结果**：本项目已经引入 open-agents 风格的 `Sandbox` interface，实现 `LocalSandbox`，并让 workspace/write/shell 工具通过 sandbox interface 访问本机工作区。

**收益**：
1. 工具与底层 IO 解耦，将来要切 Vercel cloud sandbox / 远程沙箱零代码改动
2. 测试时 mock sandbox 即可
3. 跟 open-agents 架构对齐，未来可以无痛吸收他们的工具实现

**对齐对象**：
- interface：`tmp/open-agents-main/packages/sandbox/interface.ts`
- factory：`tmp/open-agents-main/packages/sandbox/factory.ts`
- 工具示例（Vercel 实现）：`tmp/open-agents-main/packages/sandbox/vercel/sandbox.ts`

---

## 2. 必须修改的文件

| 文件 | 修改内容 |
|---|---|
| `lib/sandbox/interface.ts` | 已新增：对齐 open-agents，`SandboxType = "cloud" \| "local"` |
| `lib/sandbox/types.ts` | 已新增：`SandboxState` discriminated union |
| `lib/sandbox/local/index.ts` | 已新增：`LocalSandbox` 实现 |
| `lib/sandbox/local/connect.ts` | 已新增：`connectLocal(state, options)` 工厂函数 |
| `lib/sandbox/factory.ts` | 已新增：`connectSandbox(config)` 按 type dispatch |
| `lib/sandbox/index.ts` | 已新增：barrel export |
| `lib/tools/{read,grep,glob}.ts` | 已改造：read / grep / glob 走 sandbox |
| `lib/tools/write.ts` | 已改造：write / edit 走 sandbox，保留 `.env*` approval 策略 |
| `lib/tools/shell.ts` | 已改造：shell 走 sandbox.exec，保留 shell approval 策略 |
| `lib/workspaces.ts` | **保留**路径校验函数，作为 `LocalSandbox` 内部 guard 复用 |
| `app/api/chat/agent-config.ts` | 创建 sandbox 实例并通过 `experimental_context.sandbox` 注入 |
| `app/workflows/chat.ts` | 把 sandbox 实例从 workflow options 传给 agent |

---

## 3. 不要碰的区域

- `lib/active-streams.ts`（A 路已删）
- `lib/skills/` / `lib/tools/skill.ts`（B 路负责）
- `app/workflows/chat.ts` 的 outer loop 结构（A 路已定，只加 sandbox 注入字段）
- `lib/chat-store.ts`（不相关）
- `lib/subagents/explorer.ts` 的 step limit（A 路已改）

---

## 4. 详细执行步骤

### 4.1 sandbox 层（commit 1）

#### Step 1：interface.ts

从 `tmp/open-agents-main/packages/sandbox/interface.ts` 整文件拷过来，做两处修改：

```ts
// 修改 1
export type SandboxType = "cloud" | "local";

// 修改 2：删掉所有跟 Vercel 强相关的注释（如 "Native Vercel snapshot ID"）
// 但接口本身保留（snapshot / extendTimeout 设为 optional，本地实现不提供）
```

#### Step 2：types.ts

```ts
import type { Sandbox } from "./interface";

export type LocalSandboxState = {
  type: "local";
  workingDirectory: string;
};

// 留好 union 扩展点
export type SandboxState = LocalSandboxState; // 后续加 cloud 时改成 LocalSandboxState | CloudSandboxState
```

#### Step 3：`lib/sandbox/local/index.ts`

实现 `LocalSandbox`：

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Sandbox, SandboxStats, ExecResult } from "../interface";
import { resolveSafePath } from "@/lib/workspaces"; // 复用现有路径校验

export class LocalSandbox implements Sandbox {
  readonly type = "local" as const;
  readonly workingDirectory: string;

  constructor(opts: { workingDirectory: string }) {
    this.workingDirectory = opts.workingDirectory;
  }

  async readFile(p: string, encoding: "utf-8"): Promise<string> {
    const safe = resolveSafePath(this.workingDirectory, p);
    return fs.readFile(safe, encoding);
  }

  async writeFile(p: string, content: string, _encoding: "utf-8"): Promise<void> {
    const safe = resolveSafePath(this.workingDirectory, p);
    await fs.writeFile(safe, content, "utf-8");
  }

  async stat(p: string): Promise<SandboxStats> {
    const safe = resolveSafePath(this.workingDirectory, p);
    const s = await fs.stat(safe);
    return {
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async access(p: string): Promise<void> {
    const safe = resolveSafePath(this.workingDirectory, p);
    await fs.access(safe);
  }

  async mkdir(p: string, options?: { recursive?: boolean }): Promise<void> {
    const safe = resolveSafePath(this.workingDirectory, p);
    await fs.mkdir(safe, options);
  }

  async readdir(p: string, _options: { withFileTypes: true }) {
    const safe = resolveSafePath(this.workingDirectory, p);
    return fs.readdir(safe, { withFileTypes: true });
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    // shell:true 方便支持 ripgrep 这类带管道的命令
    // 但要注意 command injection——调用方必须确保 command 是可信的
    return new Promise((resolve) => {
      const safeCwd = resolveSafePath(this.workingDirectory, cwd);
      const child = spawn(command, { cwd: safeCwd, shell: true, signal: options?.signal });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const MAX = 1_000_000; // 1MB 截断

      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

      child.stdout.on("data", (b) => {
        if (stdout.length < MAX) stdout += b.toString();
        else truncated = true;
      });
      child.stderr.on("data", (b) => {
        if (stderr.length < MAX) stderr += b.toString();
        else truncated = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          success: code === 0,
          exitCode: code,
          stdout,
          stderr,
          truncated,
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          exitCode: null,
          stdout,
          stderr: stderr + "\n" + (err.message ?? ""),
          truncated,
        });
      });
    });
  }

  async stop(): Promise<void> {
    // local 不需要清理
  }

  getState() {
    return { type: "local" as const, workingDirectory: this.workingDirectory };
  }
}
```

**关键点**：
- `resolveSafePath`：复用 [lib/workspaces.ts](../lib/workspaces.ts) 的 `..` escape 校验。**如果当前 workspaces.ts 没暴露这个函数，新建 `resolveSafePath` 并把现有内联校验抽出来**——但保持原校验逻辑不变。
- `exec` 用 `shell: true`：仅供 ripgrep 等可信命令调用，**不要让 model 直接传任意 shell 命令**（这会变成 RCE）。具体哪些 command 能用，由调用方（search_code 工具）控制，不在 sandbox 层。
- `snapshot` / `extendTimeout` / `domain` / `execDetached` 都不实现（interface 上是 optional）。

#### Step 4：factory + connect

`lib/sandbox/local/connect.ts`：
```ts
import { LocalSandbox } from "./index";
import type { LocalSandboxState } from "../types";

export async function connectLocal(state: LocalSandboxState): Promise<LocalSandbox> {
  return new LocalSandbox({ workingDirectory: state.workingDirectory });
}
```

`lib/sandbox/factory.ts`：
```ts
import type { Sandbox } from "./interface";
import type { SandboxState } from "./types";
import { connectLocal } from "./local/connect";

export async function connectSandbox(state: SandboxState): Promise<Sandbox> {
  switch (state.type) {
    case "local":
      return connectLocal(state);
    default: {
      const _exhaustive: never = state.type;
      throw new Error(`Unknown sandbox type: ${_exhaustive}`);
    }
  }
}
```

### 4.2 工具改造（commit 2）

#### Step 5：context 注入

新增 helper（建议放 `lib/sandbox/context.ts` 或 `lib/tool-helpers.ts`）：

```ts
import type { Sandbox } from "@/lib/sandbox/interface";

export function getSandbox(ctx: unknown): Sandbox {
  const sandbox = (ctx as { sandbox?: Sandbox })?.sandbox;
  if (!sandbox) throw new Error("Sandbox not available in tool context");
  return sandbox;
}
```

#### Step 6：改造 `list_files`（lib/workspace-tools.ts）

把直接 `fs.readdir` 改成 `getSandbox(ctx).readdir(...)`。其他逻辑（递归深度、忽略列表）不变。

#### Step 7：改造 `read_file`（lib/workspace-tools.ts）

把 `fs.readFile` 改成 `sandbox.readFile`。

#### Step 8：改造 `search_code`（lib/workspace-tools.ts）

`ripgrep` 调用改成 `sandbox.exec("rg <args>", workingDirectory, timeoutMs)`。

注意：构造命令时**仍要做 shell escape**（用现有方式或 `shell-escape` 包），避免 model 通过 query 注入 shell。

#### Step 9：改造 `write_file`（lib/write-tools.ts）

- `fs.writeFile` 改 `sandbox.writeFile`
- **approval 包装层不变**：`approvedTool` / `needsApproval` / `bypassPermissions` 全保留

#### Step 10：改造 `edit_file`（lib/write-tools.ts）

- `fs.readFile` + `fs.writeFile` 都改 sandbox
- approval 流不变

#### Step 11：sandbox 实例化与注入

`app/api/chat/route.ts` POST handler：
```ts
const sandboxState: LocalSandboxState = {
  type: "local",
  workingDirectory: workspaceRoot, // 已有
};
// 不需要在这里创建实例，把 state 传进 workflow，workflow 内部 connect
```

`app/workflows/chat.ts`：
```ts
// ChatWorkflowOptions 新增 sandboxState: SandboxState
const sandbox = await connectSandbox(options.sandboxState);
// ... 创建 agent 时
agent.stream({
  ...,
  options: {
    ...,
    sandbox, // 通过 experimental_context 注入
  },
});
// finally
await sandbox.stop();
```

`app/api/chat/agent-config.ts`：
- 工具签名里 `experimental_context.sandbox` 类型补上

---

## 5. 验证清单

| # | 验证项 | 怎么验 |
|---|---|---|
| 1 | lint | `npm run lint` 通过 |
| 2 | `..` escape 仍被拒 | dev server 起，让 model 试 `read_file({path:"../../etc/passwd"})`，应该 toolErr |
| 3 | `list_files` 正常 | 让 model 列 lib 目录，跟改造前结果一致 |
| 4 | `read_file` 正常 | 读 README.md，内容一致 |
| 5 | `search_code` 正常 | 搜一个常见 keyword，结果一致 |
| 6 | **`write_file` approval 流回归** | 让 model 写文件 → 弹审批 → 同意 → 实际写盘成功；拒绝 → 不写 |
| 7 | **`edit_file` approval 流回归** | 同上 |
| 8 | `bypassPermissions=true` 时 write 不弹审批 | session 设 bypass，让 model 写文件，应该直接成功 |
| 9 | ripgrep 大输出截断 | 搜一个匹配很多的 pattern，stdout 超过 1MB 时截断 + truncated=true |
| 10 | exec abort 不留僵尸 | 中断对话时检查 `ps aux \| grep rg`，应该没残留 |

**不需要**跑 `npm run build`（无 framework 改动）。

---

## 6. PR 输出格式

### Branch
`feat/phase-sandbox`

### 标题
`feat(sandbox): add local Sandbox abstraction and migrate workspace tools`

### PR 描述

```markdown
## 改动

按 [docs/open-agents-alignment-plan.md](docs/open-agents-alignment-plan.md) 的 sandbox 迁移计划执行：

### Commit 1: sandbox 抽象层
- 新增 `lib/sandbox/` 模块，`Sandbox` interface 对齐 open-agents
- 实现 `LocalSandbox`（fs + child_process）
- 复用现有 `lib/workspaces.ts` 的 `..` escape 校验作为 guard

### Commit 2: 5 个工具迁移
- workspace/write 工具全部接入 sandbox interface
- approval 流（`needsApproval` / `bypassPermissions`）保持不变
- chat route + workflow 串通 sandbox 注入链路

## 验证
- [x] lint
- [x] `..` escape 防御仍生效
- [x] 5 个工具功能回归通过
- [x] write/edit approval 弹窗 + 同意/拒绝路径回归
- [x] bypassPermissions=true 路径回归
- [x] ripgrep 大输出截断生效

## 不做
- 不实现 cloud sandbox（interface 留口子）
- 不动 skills / loop（B/A 路）
- 不改 chat-store / persistence
```

---

## 7. 给执行 agent 的额外指令

- **2 个 commit 拆开**：sandbox 层一个、工具改造一个，方便 review 时分别看
- **路径校验绝对不能丢**——这是当前安全防御的核心，新加抽象层不能成为绕过口子
- **`exec` 不要暴露给 model 直接调用**——只给 search_code 这种受控工具用
- approval 流改造时**特别小心**，所有 `needsApproval` / `bypassPermissions` / `approvedTool` 包装层一行不动，只换底层 IO 调用
- 不要默认 `npm run build`
- 不写测试（项目当前没 test framework）
- 中文 / 英文 commit 都行
