# Codex 的 Prompt 分层结构 —— 每一层是什么、什么时候注入、role 是什么

> 本文整理的是 **OpenAI codex CLI（tmp/codex-main）** 在构造一次模型调用时，是怎么把
> system prompt / developer 指令 / AGENTS.md / environment_context / 对话历史拼起来的。
> 所有结论都带源码位置，方便你回去验证。
>
> 以此为参照，后面会对比说明我们的 AI SDK 项目里对应每一层放在哪。

---

## TL;DR —— 一次 codex 请求的消息流

codex 向 OpenAI Responses API 发的 **一个请求** 的结构大致是：

```
┌──────────────────────────────────────────────────────────┐
│ instructions 字段（API 顶级，= system prompt）           │ ← 模型的"人设"
│   内容：gpt_5_codex_prompt.md 等 base_instructions        │
└──────────────────────────────────────────────────────────┘
input: [
  ┌──────────────────────────────────────────────────────┐
  │ { role: "developer", content: <developer message> } │ ← 运行期规则
  │   - sandbox / approval policy                        │
  │   - memory tool 指令                                 │
  │   - personality / apps / skills / plugins …          │
  └──────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────┐
  │ { role: "user", content: <contextual user message> }│ ← 项目事实
  │   - user_instructions（AGENTS.md 拼接结果）          │
  │   - <environment_context> XML                        │
  └──────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────┐
  │ … 真正的对话历史（user / assistant / tool calls） …  │
  └──────────────────────────────────────────────────────┘
]
```

**关键点**：codex **不用 `role: system`**，而是把"系统性指令"分成两层：
- API 顶级 `instructions` 字段 = **基础人设**（base prompt，模型长期稳定的身份）
- `role: developer` 的第一条消息 = **本轮运行期指令**（sandbox、features 等可变部分）

而 `AGENTS.md` 和 `<environment_context>` 两个**都是 `role: user`** —— 在 codex 的模型里，它们被视为"用户提供的项目规则和环境事实"。

---

## 第 1 层：API `instructions` 字段（≈ 传统的 system prompt）

**角色**：模型的"人设 / 基础行为准则"。每次请求都原样重发。

**注入时机**：**每次调用**，作为 Responses API 请求体的顶级 `instructions` 字段。

**role**：这个字段**不是消息**，它是 Responses API 的独立顶级字段，会被模型层当作最高优先级的 system-like 指令。

**来源**：从 codex 仓库的 `.md` 文件编译进去（按模型系列分文件）：
- `gpt_5_codex_prompt.md`
- `gpt_5_2_prompt.md`
- `gpt-5.1-codex-max_prompt.md`
- `gpt_5_1_prompt.md`
- `prompt_with_apply_patch_instructions.md`（带 apply_patch 工具指令的变体）

**源码定位**：[tmp/codex-main/codex-rs/core/src/client.rs:828](../tmp/codex-main/codex-rs/core/src/client.rs#L828)
```rust
// client.rs: 构造 ResponsesApiRequest 时
let instructions = &prompt.base_instructions.text;  // ← 这里
// ...
let request = ResponsesApiRequest {
    model: model_info.slug.clone(),
    instructions: instructions.clone(),  // ← 塞到顶级字段
    input,                                // ← 下面的消息列表
    // ...
};
```

**特点**：
- **永久**：不随对话轮次变化
- **不可变**：从 markdown 文件编译进来，运行时不动它
- **全局唯一**：一次对话里就这一份

---

## 第 2 层：`role: developer` 消息（运行期规则）

**角色**：告诉模型"这一轮你要遵守的具体约束"—— sandbox policy、approval 级别、可用 feature flag 等。

**注入时机**：**首次**建立会话时注入完整版；之后只注入"diff"（变化的部分）。

**role**：`developer` —— Responses API 支持的介于 system 和 user 之间的角色，权威性高于 user，但可以在对话中多次更新。

**内容来源**（按 codex 实际 push 顺序）：
1. **model switch 提示**（如果中途换了模型）
2. **权限 / 沙箱说明** —— `DeveloperInstructions::from_policy(sandbox, approval, ...)`
3. **自定义 `developer_instructions`**（config 里可配）
4. **Memory tool 指令**（如果 `Feature::MemoryTool` 开启）
5. **Collaboration mode 指令**
6. **Realtime 状态更新**
7. **Personality spec**
8. **Apps / MCP connectors 摘要**
9. **Skills 列表**
10. **Plugins 列表**
11. **Git commit 说明**（如果 `Feature::CodexGitCommit`）

**源码定位**：[tmp/codex-main/codex-rs/core/src/codex.rs:3766-3876](../tmp/codex-main/codex-rs/core/src/codex.rs#L3766)
```rust
// build_initial_context() 里
let mut developer_sections = Vec::<String>::with_capacity(8);

// 按上面编号逐个 push 进 developer_sections …
developer_sections.push(DeveloperInstructions::from_policy(…).into_text());
developer_sections.push(memory_prompt);
developer_sections.push(collab_instructions.into_text());
// … 等等

// 最后拼成一条 role: developer 消息
if let Some(developer_message) =
    build_developer_update_item(developer_sections)
{
    items.push(developer_message);
}
```

**特点**：
- **半动态**：第一次注入全部；后续轮次如果 sandbox / feature 没变就不重发
- **可变更**：sandbox 升级、新 feature 启用会在后续 turn 里以 diff 形式追加

---

## 第 3 层：`role: user` 消息 ——「contextual user」块（AGENTS.md + environment_context）

**角色**：告诉模型"用户在什么项目里工作、这个项目有什么规则"。

**注入时机**：**首次**建立会话时注入完整版；后续轮次不变的话不重发（见"优化"一节）。

**role**：`user` —— 注意这里 codex 的关键设计：`AGENTS.md` 不是 system 指令，而是"**用户在告诉模型这个项目的规则**"。这让模型以"执行用户意图"的视角来对待 AGENTS.md 内容，而不是"执行系统命令"。

**内容**（按 push 顺序）：

### 3a. `user_instructions` —— AGENTS.md 拼接结果

从项目根向下收集所有 `AGENTS.md`（参见 [lib/session-primer.ts](../lib/session-primer.ts) 实现）。

每个文件被包装成：
```
# AGENTS.md instructions for <目录>

<INSTRUCTIONS>
<文件内容>
</INSTRUCTIONS>
```

多个文件用 `\n\n` 拼起来。总预算 32 KiB（超出截断）。

**源码**：
- 发现/读取：[tmp/codex-main/codex-rs/core/src/project_doc.rs:149-209](../tmp/codex-main/codex-rs/core/src/project_doc.rs#L149-L209)
- 拼接格式：[tmp/codex-main/codex-rs/instructions/src/fragment.rs:4](../tmp/codex-main/codex-rs/instructions/src/fragment.rs#L4)

### 3b. `<environment_context>` XML

告诉模型当前环境的客观事实。格式：
```xml
<environment_context>
  <cwd>/absolute/path</cwd>
  <shell>zsh</shell>
  <current_date>2026-04-14</current_date>
  <timezone>Asia/Shanghai</timezone>
  <network enabled="true">
    <allowed>example.com</allowed>
  </network>
  <subagents>…</subagents>
</environment_context>
```

**源码定位**：[tmp/codex-main/codex-rs/core/src/environment_context.rs:166-207](../tmp/codex-main/codex-rs/core/src/environment_context.rs#L166-L207)

### 3a + 3b 被拼成一条消息

源码：[tmp/codex-main/codex-rs/core/src/codex.rs:3877-3897](../tmp/codex-main/codex-rs/core/src/codex.rs#L3877-L3897)
```rust
let mut contextual_user_sections = Vec::<String>::with_capacity(2);

// 先 push AGENTS.md 结果
if let Some(user_instructions) = turn_context.user_instructions.as_deref() {
    contextual_user_sections.push(
        UserInstructions { text: …, directory: … }.serialize_to_text(),
    );
}

// 再 push <environment_context>
if turn_context.config.include_environment_context {
    contextual_user_sections.push(
        EnvironmentContext::from_turn_context(…)
            .with_subagents(subagents)
            .serialize_to_xml(),
    );
}

// 最后拼成一条 role: user 消息
if let Some(contextual_user_message) =
    build_contextual_user_message(contextual_user_sections)
{
    items.push(contextual_user_message);
}
```

**特点**：
- 顺序固定：`user_instructions` 先，`<environment_context>` 后
- 都用 `role: user`
- **只注入一次**（首轮），除非 cwd / shell / user_instructions 变了

---

## 第 4 层：真实对话历史（user / assistant / tool calls）

**角色**：正常的对话内容。

**注入时机**：每次请求都带上全部历史（或压缩后的历史）。

**role**：
- `user` —— 用户输入的消息
- `assistant` —— 模型上一轮的回复（含 reasoning、text、tool call）
- `tool` / `function` —— 工具调用的返回结果

**源码**：见 [tmp/codex-main/codex-rs/core/src/client_common.rs:48](../tmp/codex-main/codex-rs/core/src/client_common.rs#L48) 的 `get_formatted_input()`，以及 `context_manager` 模块。

---

## 优化：并非每次都重发前 1-3 层

这是 codex 里一个很漂亮的工程细节。

**源码定位**：[tmp/codex-main/codex-rs/core/src/codex.rs:3968-3975](../tmp/codex-main/codex-rs/core/src/codex.rs#L3968-L3975)
```rust
let should_inject_full_context = reference_context_item.is_none();
let context_items = if should_inject_full_context {
    // 首次调用：注入完整 developer + contextual user
    self.build_initial_context(turn_context).await
} else {
    // 稳态：只追加"变化的部分"（比如 sandbox 升级）
    self.build_settings_update_items(reference_context_item.as_ref(), turn_context)
        .await
};
```

也就是说：
- **第一次请求**：API `instructions` + 完整 developer 消息 + 完整 contextual user 消息 + 对话历史
- **后续请求**：API `instructions`（永远重发）+ **只追加** diff developer/context 消息 + 对话历史

这样第 2、3 层在稳态下不会每轮都重复占 token。配合 OpenAI 的 prompt caching，成本可控。

---

## 对比：我们的 AI SDK 项目怎么对应

| codex 层级 | codex 的做法 | 我们项目对应 |
|---|---|---|
| API `instructions` 字段（base prompt / 人设） | 编译自 `.md`，顶级字段发送 | `ToolLoopAgent` 构造时的 `instructions: developerInstructions` 常量字符串 |
| `role: developer` 消息（运行期规则） | 动态拼接 policy/features/skills… | 在 `prepareCall` 里拼进 `instructions` —— 比如 `Behavior rules for this workspace:` 那段 |
| `role: user` contextual（AGENTS.md + env） | 以 user 消息注入 | 在 `prepareCall` 里拼进 `instructions`（见 [lib/session-primer.ts](../lib/session-primer.ts) + [app/api/chat/route.ts](../app/api/chat/route.ts)）|
| 真实对话历史 | `input` 数组的其余部分 | `useChat` 自动管理，通过 `DefaultChatTransport` 送回服务端 |

**关键差异**：

1. **codex 分三个"发送位置"（API instructions / developer 消息 / contextual user 消息）；我们全部合并到 AI SDK 的 `instructions`（即 system prompt）。**
   - 好处：AI SDK 抽象更简单，一条 system prompt 就够了
   - 代价：模型对"哪段来自用户"的语义区分没有 codex 那么明确；但对通用模型影响不大

2. **codex 的 Responses API `store: false` 时会出 item id 问题**（见你之前遇到的 `rs_* not found` 错误）；我们的 `sanitizeExperimentUIMessages` 专门处理这个。

3. **codex 有"首次 vs 增量"优化**；我们现在每次调用都全量重发 primer。这个优化等你做 context compaction 时再考虑。

---

## 我们项目要不要完全模仿 codex 的三段式？

**短期不建议**。理由：

- AI SDK v6 的 `instructions` 就是 system prompt，足够承载这些内容
- 模型对"developer 消息 vs user 消息"的语义区分，在通用模型上影响远小于 codex 声称的那么大
- 拆分三段式会让你的 `prepareCall` 复杂度激增，但收益有限

**长期可考虑的情境**：
- 如果你开始接入专门训练过 `role: developer` 的模型（比如将来的 gpt-5.x-codex），再拆
- 如果你的 primer 非常大（>10 KiB），为了 prompt cache hit rate，可以把"稳定部分"和"变动部分"分开注入
- 如果你做 multi-agent，subagent 需要不同的 developer rules，分开注入更清晰

---

## 速查：我改一条 AGENTS.md，流到模型的路径是什么？

1. 你编辑 workspace 的 `AGENTS.md`
2. 下一条消息 `POST /api/chat`
3. `prepareCall` 被调用
4. `buildSessionPrimer({ workspaceRoot })` 被执行
   - `findProjectRoot` 从 workspaceRoot 向上找 `.git`
   - `walkDownDirs` 从项目根走回 workspaceRoot
   - `collectDocPaths` 每个目录找第一个 `AGENTS.override.md` 或 `AGENTS.md`
   - `readDocsWithBudget` 按 32 KiB 预算读取
5. `primer.combined` 被拼进 `instructions` 字符串
6. `ToolLoopAgent` 把 `instructions` 当作 system prompt 发给 Gemini / OpenAI
7. 模型看到你刚改的规则

**不经过缓存**（我们当前实现），每次都现读。如果你编辑完 AGENTS.md 立即发消息，生效。
