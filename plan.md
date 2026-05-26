# Hook 下一步计划

## 目标

把 hook 从“只能引用代码里注册好的 hook factory”，扩展成 Codex/Claude 风格的项目级 command hook：

1. 项目 `.agents/settings.json` 可以按事件配置 shell command。
2. runtime 在服务端命中事件时执行 command，并把事件 JSON 写入 stdin。
3. command 的 stdout JSON / stderr / exit code 决定是否继续、阻断、或给模型追加上下文。
4. `Stop` 事件用于“LLM 准备结束这一轮时跑最终检查”，例如 `npm run lint` / typecheck。

## 当前 hook 使用模式

当前 hook 分成两条能力：

1. **registered hook**：hook 逻辑在代码里实现并注册到 `lib/hooks/settings-loader.ts`，项目通过 `.agents/settings.json` 按 name 启用。
2. **command hook**：项目 `.agents/settings.json` 直接声明 command，由 runtime 在服务端执行。

command hook 只从项目级 settings 加载，不从用户全局 settings 继承。原因是 command 会执行本地命令，必须由当前项目显式 opt-in，不能把 `npm run lint` 这类 Node 项目命令全局注入到所有仓库。

## 已落地的执行链路

- `lib/permissions/types.ts`：settings schema 支持 Codex 风格 matcher group：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm run lint",
            "timeout": 120,
            "statusMessage": "Running lint before completion"
          }
        ]
      }
    ]
  }
}
```

- `lib/permissions/settings.ts`：新增 `loadProjectSettings(cwd)`，只读取项目层级 `.agents/settings.json`。
- `lib/hooks/command.ts`：执行 command，stdin 输入事件 JSON，解析 stdout JSON；命令失败会返回 `deny` 和 additional context。
- `lib/hooks/settings-loader.ts`：新增 `buildCommandHookRegistryFromProjectSettings(settings, { cwd })`，只注册 command matcher group。
- `app/api/chat/route.ts`：`SessionStart` / `UserPromptSubmit` 阶段把项目 command hooks 加入 registry。
- `app/workflows/chat.ts`：工具阶段加入项目 command hooks；当模型准备 stop 时触发 `Stop` hooks，如果 hook block，就把反馈作为 hook context 送回下一轮 LLM。
- `lib/subagents/sub-agent.ts`：子 agent 工具调用也接入项目 command hooks，避免父/子 agent hook 口径不一致。

## 典型配置

### Stop 时跑 lint

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm run lint",
            "timeout": 120,
            "statusMessage": "Running lint before completion"
          }
        ]
      }
    ]
  }
}
```

### 文件修改后记录或检查

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(write|edit)$",
        "hooks": [
          {
            "type": "command",
            "command": "node .agents/hooks/post-edit.mjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## command 输入/输出约定

输入：runtime 把事件 JSON 写入 command stdin。基础字段包括：

- `session_id`
- `cwd`
- `hook_event_name`
- tool 事件还有 `tool_name` / `tool_input` / `tool_response`
- `Stop` 事件还有 `finish_reason` / `step` / `last_assistant_message`

输出：command stdout 可以返回 JSON：

```json
{
  "decision": "block",
  "reason": "lint failed, fix before final response",
  "hookSpecificOutput": {
    "additionalContext": "Run npm run lint again after fixing."
  }
}
```

当前实现里非 0 exit code 也会 block，并把 stderr/stdout 作为反馈回灌给模型。这是为了让 `npm run lint` / typecheck 这类命令不需要额外 wrapper 就能用于 `Stop`。

## 后续可选增强

- 增加 command hook 信任态：记录 command hash，配置变化后要求用户重新确认。
- 暴露 `GET /api/hooks/catalog`：返回已注册 hook 名称、事件类型、默认 matcher、说明。
- 暴露 `GET/PUT /api/hooks/settings`：读取和保存 `.agents/settings.json` 的 hooks 配置。
- 在 UI 里加 hook 测试按钮：输入 event/payload，预览哪些 hook 会命中。
- 支持 `PostToolUse additionalContexts` 的调试展示，帮助确认 context 是否进入下一步模型调用。
