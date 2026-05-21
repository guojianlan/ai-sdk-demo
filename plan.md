# Hook 下一步计划

## 目标

把当前“代码注册 hook factory + `.agents/settings.json` 启用”的模式，补一层网页操作入口，让用户可以在 UI 里配置已注册 hook，而不是手写 JSON。

## 当前 hook 使用模式

当前 hook 仍然是代码优先：

1. hook 逻辑在代码里实现并注册到 `lib/hooks/settings-loader.ts`。
2. 项目通过 `.agents/settings.json` 启用 hook。
3. workflow / subagent 在运行时读取 settings，并把工具调用包进 hook pipeline。

这种模式的好处是安全边界清楚：settings 只能引用已注册 hook 名字，不能直接执行任意 JS。

## 推荐新增：Hook Settings 面板

新增一个前端配置面板，先只支持配置已注册 hook：

- 展示当前已知 hook 列表，例如 `tool-logging`、`dotenv-blocklist`。
- 按事件桶分组：`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`SessionStart`。
- 支持启用 / 禁用 hook。
- 支持填写可选 `matcher`，用于匹配 tool name。
- 保存时写入项目 `.agents/settings.json`。

示例保存结果：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "name": "dotenv-blocklist",
        "matcher": "^(write|edit)$"
      }
    ],
    "PostToolUse": [
      {
        "name": "tool-logging"
      }
    ]
  }
}
```

## 暂不做

先不要允许用户在网页里直接写 JS hook。

原因：如果 settings 或浏览器 UI 能直接提交任意 JS，就会把 hook 系统变成远程代码执行入口。首版应该保持“网页改配置，代码注册能力”的边界。

## 后续可选增强

- 暴露 `GET /api/hooks/catalog`：返回已注册 hook 名称、事件类型、默认 matcher、说明。
- 暴露 `GET/PUT /api/hooks/settings`：读取和保存 `.agents/settings.json` 的 hooks 配置。
- 在 UI 里加 hook 测试按钮：输入 tool name 和 payload，预览哪些 hook 会命中。
- 支持 `PostToolUse additionalContexts` 的调试展示，帮助确认 context 是否进入下一步模型调用。
