# Hook 系统（P9 首版）

抄 Claude Code 的事件模型 + codex 的 `additional_contexts` 注入想法，做成 in-process TS hook。命中切点就能拦截 / 改写 / 注入开发者消息 / 记录，比把这些散落在工具实现和路由里清爽很多。

## 四个事件

| 事件 | 切点 | payload 关键字段 | 用途 |
|---|---|---|---|
| `PreToolUse` | tool execute 前 | `toolName`, `input` | 拒绝（deny）/ 改写入参 / 记审计 |
| `PostToolUse` | tool execute 后（含异常） | `toolName`, `input`, `result`, `durationMs` | 日志 / 注入 context 给下一轮 |
| `UserPromptSubmit` | POST 入口、sanitize 之后 | `prompt` | 拒绝整轮 / 拼 session primer 增量 |
| `SessionStart` | 首条 user 消息（DB 空） | `sessionId` | 注入 system message |

## 返回值（`HookResult`）

```ts
{
  decision?: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: unknown;        // PreToolUse 改写入参
  additionalContexts?: string[]; // 累积成 `# Hook context` 段塞 system prompt
  systemMessage?: string;        // 同上，但语义上是"系统话"
}
```

聚合规则：
- `deny` 短路 —— 后续 hook 不再跑，主流程立即拒（PreToolUse 工具 → `toolErr`；UserPromptSubmit → HTTP 403）
- `ask` 不短路（首版 execute 阶段忽略，预留给 approval 流水线对接）
- `updatedInput` last-write-wins
- `additionalContexts` / `systemMessages` 累加

失败 / 超时（默认 5s）的 hook 自动跳过，不影响主流程也不影响后续 hook。

## 内置 hook

| name | 事件 | 默认是否注册 |
|---|---|---|
| `tool-logging` | PostToolUse | ✅ 自动（写一行 `[hooks] post tool=… ok=… duration=…ms`） |
| `dotenv-blocklist` | PreToolUse | ⬜ 需 settings.json 显式开启 |

`dotenv-blocklist` 故意不默认 —— 它跟现有 `env.dotEnvFileApproval` 的"弹审批卡"行为相比是硬 deny，对单用户学习项目可能太严。要开就在 settings.json 里声明。

## settings.json 声明

层级：`~/.local-agent/settings.json` 兜底 ↗ `<project>/.agents/settings.json` 项目级（closer-to-cwd 覆盖外层；hooks 按事件分桶 concat）。

```json
{
  "hooks": {
    "PreToolUse": [
      { "name": "dotenv-blocklist" }
    ]
  }
}
```

`name` 只能引用 `lib/hooks/settings-loader.ts` 里 `HOOK_FACTORIES` 已注册的 hook —— **settings.json 不能定义任意 JS**（避免变 RCE 入口）。未知 name 或事件桶错位都 warn+skip，不抛。

可选字段 `matcher`：字符串正则，覆盖 hook 默认的 tool-name matcher。

## 流水线集成

- **主 agent 工具调用**：`app/workflows/chat.ts` 在每步内构造 `default + settings` 组合 registry，包 toolset。
- **子 agent 工具调用**：`lib/subagents/sub-agent.ts` 用同一套构造，保证 dotenv blocklist / logging 在 subagent 内部一样生效，安全护栏不出口径割裂。
- **prompt 阶段**：`app/api/chat/route.ts` 在 sanitize 之后跑 SessionStart（首条消息）+ UserPromptSubmit，deny → 403，contexts 累积穿过 workflow 注到 system prompt 末尾 `# Hook context` 段。

## 写自己的 hook

```ts
import { defineHook } from "@/lib/hooks";

export const myHook = defineHook({
  event: "PreToolUse",
  name: "my-hook",
  matcher: "^shell$",
  handler: (payload) => {
    if (looksDangerous(payload.input)) {
      return { decision: "deny", reason: "blocked by my-hook" };
    }
  },
});
```

要让它能在 settings.json 里按名字开关，往 `lib/hooks/settings-loader.ts` 的 `HOOK_FACTORIES` 追加一项即可。

## 调试

- `[hooks] post tool=…` 是默认 logging 行，关掉就把 `defaultHookRegistry` 里的 `toolLoggingHook` 注释掉
- hook 抛错被吞但会打 `[hooks] PreToolUse "xxx" threw: …` 到 stderr —— 找不到 hook 被触发就盯这条
- 超时同样有警告 `[hooks] … timed out after …ms`

## 跟外部 command hook 的关系

Claude Code / codex 都有"配 shell command 当 hook"的能力（stdin JSON → stdout JSON）。我们故意先不做（P9-d parked）：单进程 Next.js 起 child process 既增 IPC/超时复杂度又脱离学习目标。等真有"非代码人想写 hook"的场景再启动 P9-d。
