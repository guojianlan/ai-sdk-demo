# Agent Brief — A 路：Loop 模型改造

> **范围**：Phase 0 + Phase 1 + Phase 2
> **预计时间**：2-3 小时
> **PR 数**：1 个
> **前置依赖**：无（最先做，B/C 路都依赖此 PR merge）

---

## 1. 背景

参考主文档 [docs/open-agents-alignment-plan.md](./open-agents-alignment-plan.md) §0、§3 Phase 0/1/2、§8 风险。

**目标**：把 `ToolLoopAgent` 的内部 loop 从 16 步压到 1 步，外层在 workflow 里手写 `for` 循环（maxSteps=500），并在 step 边界判断是否要 pause（approval / interactive tool）。

**对齐对象**：`tmp/open-agents-main/apps/web/app/workflows/chat.ts:489-544`（外层 for 循环）+ `packages/agent/open-harness-agent.ts:83`（`stopWhen: stepCountIs(1)`）。

---

## 2. 必须修改的文件

| 文件 | 修改内容 |
|---|---|
| `lib/active-streams.ts` | **删除**（死代码，零引用） |
| `lib/chat-agent/builder.ts` | `stopWhen: stepCountIs(config.stepLimit)` → `stepCountIs(1)`；从 `ChatAgentConfig` 删 `stepLimit` 字段 |
| `lib/subagents/explorer.ts` | `stepCountIs(20)` → `stepCountIs(100)`（subagent 上限对齐 open-agents） |
| `app/api/chat/agent-config.ts` | 删 `stepLimit: 16`；导出 `OUTER_STEP_LIMIT = 500`（可被 env 覆盖） |
| `app/workflows/chat.ts` | `runAgentWorkflow` 改成 `for` 循环；`runAgentStep` 返回 `{ responseMessage, finishReason }`；按步 saveMessages |
| `lib/workflow/should-pause.ts` | **新建**：导出 `shouldPauseForToolInteraction(parts)`，遍历 `ToolUIPart` 判断 `state in {input-available, approval-requested}` |

---

## 3. 不要碰的区域（防止越权）

- `lib/skills/` 不存在 → **不要**新建（这是 B 路的事）
- `lib/sandbox/` 不存在 → **不要**新建（这是 C 路的事）
- `lib/workspace-tools.ts` / `lib/write-tools.ts` → **不要**改（C 路才动）
- `lib/chat-agent/system-prompt.ts` 的 skills 段落 → **不要**加（B 路才加）
- `.agents/skills/` → **不要**创建（B 路）
- `lib/chat-store.ts` / `app/api/chat/[chatId]/stream/route.ts` → **不需要**改（workflow durable stream 已经自己处理 resume）

---

## 4. 详细执行步骤

### 4.1 Phase 0 — 删 active-streams（5min）

```bash
# 先确认零引用
rg "active-streams|activeStreams" --type ts -g '!node_modules' -g '!tmp/'
# 应该零结果
rm lib/active-streams.ts
```

### 4.2 Phase 1 — Loop 改造

#### Step 1：内层降到 1
- `lib/chat-agent/builder.ts:77` `stopWhen: stepCountIs(config.stepLimit)` → `stepCountIs(1)`
- 从 `ChatAgentConfig` interface 删 `stepLimit: number;` 字段
- 检查 builder 函数签名调用方有没有破坏

#### Step 2：subagent 上限拉到 100
- `lib/subagents/explorer.ts:57` `stepCountIs(20)` → `stepCountIs(100)`
- 系统 prompt 里如果有"最多 20 步"字样，同步改

#### Step 3：删 stepLimit 配置字段
- `app/api/chat/agent-config.ts:154` 删 `stepLimit: 16,` 这一行
- 同文件 export `OUTER_STEP_LIMIT`：

```ts
export const OUTER_STEP_LIMIT = Number(process.env.CHAT_OUTER_STEP_LIMIT ?? 500);
```

注意：要走 [lib/env.ts](../lib/env.ts) 的统一 env 入口，不要直接读 `process.env`。如果 env.ts 不方便加，临时直接读也可，但要在 PR 描述里标 TODO。

#### Step 4：workflow 外层循环

参考 `tmp/open-agents-main/apps/web/app/workflows/chat.ts:489-544` 的结构。

`app/workflows/chat.ts` 当前只调一次 `runAgentStep`，改成：

```ts
let modelMessages = await convertToModelMessages(options.agentMessages, ...);
const accumulatedMessages: UIMessage[] = [];
let exhaustedMaxSteps = false;

for (let step = 0; step < OUTER_STEP_LIMIT; step++) {
  const result = await runAgentStep({
    options,
    modelMessages,
    workflowRunId,
    stepIndex: step,
  });

  if (result.responseMessage) {
    accumulatedMessages.push(result.responseMessage);
    // 把 response 的 model messages 也累加进去，下一步要用
    modelMessages = [...modelMessages, ...convertToModelMessages([result.responseMessage], ...)];

    // 按步 saveMessages（compactionNotice 只在第一步推一次）
    const allForSave = [...options.fullMessages];
    if (options.compactionNotice && step === 0) allForSave.push(options.compactionNotice);
    allForSave.push(...accumulatedMessages);
    saveMessages(options.chatId, allForSave);
  }

  // 出口判断
  const shouldContinue =
    result.finishReason === "tool-calls" &&
    !shouldPauseForToolInteraction(result.responseMessage?.parts ?? []);

  if (!shouldContinue) break;
  if (step + 1 >= OUTER_STEP_LIMIT) { exhaustedMaxSteps = true; break; }
}
```

`runAgentStep` 内部：保持原来 `agent.stream(...)` 的逻辑，但**返回** `{ responseMessage, finishReason }` 给外层而不是只 stream。`finishReason` 从 `result.finishReason` 拿（AI SDK 6 stream API 有这个字段）。

#### Step 5：日志
加 step 日志方便调试：
```ts
console.log(`[workflow/chat] step=${step+1}/${OUTER_STEP_LIMIT} finishReason=${result.finishReason} pause=${pause}`);
```

### 4.3 Phase 2 — shouldPauseForToolInteraction

#### Step 1：新建 `lib/workflow/should-pause.ts`

```ts
import type { UIMessagePart, UITools, UIDataTypes } from "ai";

export function shouldPauseForToolInteraction(
  parts: ReadonlyArray<UIMessagePart<UIDataTypes, UITools>>,
): boolean {
  for (const part of parts) {
    if (part.type?.startsWith?.("tool-")) {
      const state = (part as { state?: string }).state;
      if (state === "input-available" || state === "approval-requested") {
        return true;
      }
    }
  }
  return false;
}
```

参考 open-agents `apps/web/app/workflows/chat.ts:61-66`。

#### Step 2：接入外层循环（已在 4.2 Step 4 写出）

---

## 5. 验证清单

执行完 PR 之前必须跑：

| # | 验证项 | 怎么验 |
|---|---|---|
| 1 | lint | `npm run lint` 通过 |
| 2 | active-streams 已删 | `ls lib/active-streams.ts` 报 not found |
| 3 | 内层步数 = 1 | grep `stepCountIs(1)` 在 builder.ts |
| 4 | 外层步数 = 500 | grep `OUTER_STEP_LIMIT` 用到 |
| 5 | subagent = 100 | grep `stepCountIs(100)` 在 explorer.ts |
| 6 | **多步对话 smoke test** | dev server 起，问 "列出 lib 目录然后读 lib/env.ts，最后总结这个文件做啥的"，期望：list_files → read_file → 文字答复，不报错，3 步内完成 |
| 7 | **approval 弹窗中断** | 问 "在 /tmp/test.md 写一个 hello world"，弹审批 → **不应**继续往下跑（外层 break） |
| 8 | resume 仍 work | 问完一个长 reply，刷新页面，应该看到 SSE 续上 |

**不需要**跑 `npm run build`（除非改了 next config / 路由结构）。

---

## 6. PR 输出格式

### Branch 名
`feat/phase-loop-refactor`

### PR 标题
`feat(chat): align loop model with open-agents (inner=1, outer=500)`

### PR 描述模板

```markdown
## 改动

按 [docs/open-agents-alignment-plan.md](docs/open-agents-alignment-plan.md) Phase 0+1+2 执行：

- 删死代码 `lib/active-streams.ts`（workflow durable stream 已接管 resume）
- `ToolLoopAgent` 内层 `stopWhen: stepCountIs(16)` → `stepCountIs(1)`
- 外层在 `app/workflows/chat.ts` 手写 `for` 循环，`OUTER_STEP_LIMIT=500`
- `lib/subagents/explorer.ts` step 上限 20 → 100（对齐 open-agents）
- 新建 `lib/workflow/should-pause.ts`，approval / interactive tool 在 step 边界中断 outer loop
- 按步 `saveMessages`（之前只在末尾保存一次）

## 验证
- [x] lint 通过
- [x] 多步对话 smoke test
- [x] approval 中断正常
- [x] resume 正常

## 不做
- 不改 chat-store / sandbox / skills / workspace-tools（B/C 路负责）
- 不上 build 检查（无 framework-level 改动）
```

---

## 7. 给执行 agent 的额外指令

- **不要默认 `npm run build`**（项目 [AGENTS.md](../AGENTS.md) 明确说了）。
- **绝不**在没确认的前提下扩大改动范围（哪怕看到顺手能修的也忍住）。
- 遇到决策点（比如"runAgentStep 的返回类型怎么定"）：选最像 open-agents 的写法，不要发明新模式。
- 如果发现执行步骤跟当前代码现状有出入（比如 `agent-config.ts:154` 已经不是 `stepLimit:16`），先停下报告，不要自作主张。
- **不要写测试**（项目当前没 test framework）。
- **不要写新文档**（除非任务里明确要）。
- 中文 / 英文 commit 都行，跟历史 commit 风格一致。
