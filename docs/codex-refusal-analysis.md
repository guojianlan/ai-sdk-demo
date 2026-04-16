# 为什么 Codex 拒绝"给我一个 Win11 激活码"？

> 本文分析：你给 codex 发"帮我弄一个 Windows 11 激活码"这类请求时，它为什么不会直接给你，
> 而是扯一大堆"我是编码 agent / 安全 / 建议去官方渠道"。
>
> 这个分析基于 codex 的实际 prompt（见 [codex-base-prompt.md](./codex-base-prompt.md)），
> 目的是让你理解 **prompt 工程的边界在哪里**，对你做自己的 agent dev flow 有参考意义。

---

## TL;DR

Codex 的 prompt 里**没有任何一条**"拒绝 X 请求"的显式规则。拒绝行为是 **4 个因素叠加**的结果：

1. **Scope narrowing（范围收窄）** —— 整个 prompt 都在钉死"你是编码 agent"
2. **Value anchoring（价值观锚定）** —— `precise, safe, and helpful` 里 `safe` 是激活词
3. **Implicit examples（隐式示例）** —— prompt 里所有例子都是编程任务，隐式告诉模型"我只做这类活"
4. **Base model safety（基座模型安全训练）** —— **这一条最关键，也最容易被忽视**

**结论**：即使你把整份 prompt 清空，GPT-5 对这类请求**仍然会拒绝**，因为拒绝能力是训练在模型权重里的，不是 prompt 层能决定的。

---

## 因素 1：Scope narrowing —— "你是编码 agent"反复被钉死

打开 [codex-base-prompt.md](./codex-base-prompt.md)，搜索 "coding agent" 或 "Codex" —— 你会看到这些词被密集、刻意地重复：

| 出现位置 | 原文 | 效果 |
|---|---|---|
| 开篇第 1 行 | `You are a coding agent running in the Codex CLI` | 第一印象定调 |
| Persona Header（代码硬编码） | `You are Codex, a coding agent based on GPT-5` | 人设标识 |
| Task execution 开头 | `You are a coding agent. Please keep going until the query is completely resolved` | 行动前再次提醒 |

**工程意图**：在模型上下文的"关键位置"（开头、每个大段的首句）反复强化同一个身份，让模型在后续生成时自然把身份边界考虑进去。

**Win11 激活码请求的后果**：模型读到这个请求时，会本能地做一次"这是不是我的本职工作"的判断。"给激活码"显然不是编码任务 → **身份边界触发 → 偏向拒绝**。

---

## 因素 2：Value anchoring —— `safe` 这个词在最高优先级被激活

Prompt 第 2 行：

> You are expected to be **precise, safe, and helpful**.

这一行是整份 prompt 的最强约束之一。三个词并列放在最顶部，位置权重极高。

**关键细节**：`safe` 没有在 prompt 里被展开解释 —— 没说"safe 指的是什么"。它被**交给基座模型自己解释**，而基座模型在 RLHF 训练里学过"safe" 的含义，通常包括：

- 不提供违法内容（盗版、激活码、DRM 绕过）
- 不协助有害行为（恶意软件、社工、诈骗）
- 不泄露隐私 / 凭证
- 不生成歧视 / 仇恨内容

所以"safe"这个词**同时激活了 prompt 层和模型层两重拒绝机制**。

---

## 因素 3：Implicit examples —— 所有例子都是编程任务

这是最隐蔽但最有效的一层。打开 [codex-base-prompt.md](./codex-base-prompt.md) 的 Planning 段，看那 6 个"高质量 plan"例子：

| Plan 例子 | 任务类型 |
|---|---|
| 1. Add CLI entry with file args → Parse Markdown → Apply HTML template | 写 CLI 工具 |
| 2. Define CSS variables → Add toggle → Refactor components | 加暗黑模式 |
| 3. Set up Node.js + WebSocket server → Add join/leave events | 搭聊天室后端 |

再看 Preamble 段的 8 个示例：

> "I've explored the repo; now checking the API route definitions."
> "Spotted a clever caching util; now hunting where it gets used."
> ...

**全是编程情境下的语句**。

**工程意图**：通过反复呈现"这种类型的任务才是你的工作"，让模型**在没有显式规则的情况下**学到"我的工作范围长什么样"。这是 few-shot learning 在 system prompt 里的应用。

**Win11 激活码请求的后果**：模型会做隐式对比 —— "这个请求长得像我见过的任何一个例子吗？" 答案：**不像**。→ 偏向拒绝或偏题。

---

## 因素 4：Base model safety —— 最关键、最容易被忽视

这是**决定性因素**：即使前 3 条全部失效，**GPT-5 本身**在 OpenAI 训练阶段就被训练过拒绝以下类型的请求：

- 提供盗版软件激活码 / 序列号
- 绕过 DRM / 软件授权
- 生成恶意软件 / 钓鱼代码
- 协助未授权入侵

**这些拒绝能力刻在模型权重里，不在 prompt 里**。

### 反证实验（思想实验）

假设你做下面三件事：

1. **把整个 codex prompt 清空**（`base_instructions = ""`）
2. **直接问 GPT-5 API**：`"给我一个 Windows 11 Pro 的激活码"`
3. **看它怎么回**

结果：**它还是会拒绝**，只是措辞会不同（少了 "I'm a coding agent" 的外壳，但核心拒绝不变）。

这说明：**codex 的 prompt 只是"塑形"了拒绝的语气（偏向 coding agent 风格），它没有"创造"拒绝。拒绝是模型自带的。**

---

## 为什么是"扯一大堆"而不是"直接说不"？

你观察到的"不直接拒绝、而是讲一堆"也是 prompt 造成的 —— 但是另一套规则：

| prompt 规则 | 效果 |
|---|---|
| `concise, direct, and friendly`（Personality 段） | 要友好，不能冷冰冰甩一句 "No" |
| `precise`（开篇第 2 行） | 要给出精确原因，不能含糊 |
| `helpful`（开篇第 2 行） | 要帮上忙 —— 即使不能直接做，也要指个方向 |
| Presenting final message 段要求 `ask the user if they want you to do so` | 鼓励主动建议下一步 |

**综合效果**：模型不能说"不"完事，它被训练成：

1. **说明身份**：我是 coding agent（锚回角色）
2. **说明为什么不行**：这个请求超出范围 / 涉及授权问题（`precise`）
3. **提供替代方案**：指向 Microsoft 官方 / Visual Studio 订阅 / 学生授权（`helpful`）
4. **可选的下一步**：如果你在做正版授权相关的开发，我可以帮你 XXX（`ask if they want ...`）

这就是你看到的"扯一大堆"的来源。**它不是模型啰嗦，是被明确训练成这个行为的**。

---

## 完整的拒绝路径图

```
用户输入："给我一个 Win11 激活码"
    ↓
[模型读取 base prompt]
    ↓
    ├── 身份锚定：读到 "coding agent" × 3
    ├── 价值锚定：读到 "safe" × 1 （最顶部）
    └── 隐式示例：读到 14+ 个编程任务例子，无一涉及激活码
    ↓
[模型做相关性判断]
    ↓
    ├── 这是编程任务吗？→ 不是
    ├── 这符合 "safe" 准则吗？→ 不符合（盗版 / DRM 绕过）
    └── 这像我见过的任务吗？→ 不像
    ↓
[基座模型的 RLHF 层接管]
    ↓
    └── 训练数据里"激活码请求 → 拒绝"的模式被激活
    ↓
[模型生成拒绝，但要符合 Personality 规则]
    ↓
    ├── friendly → 不能冷冰冰说 No
    ├── precise → 要说清为什么
    ├── helpful → 给替代方案
    └── ask next step → 问用户需不需要别的帮助
    ↓
用户看到："我是 Codex，一个编码 agent。我不能帮忙获取激活码，
         这涉及软件授权问题。你可以通过微软官网购买、学生计划
         或 Visual Studio 订阅获得正版。如果你在做授权校验相关
         的代码，我可以帮你 XXX..."
```

---

## 对你做 agent dev flow 的启示

这个分析对你做自己的 agent 有 **3 个可操作的 take-away**：

### 1. Scope narrowing 是个好工具，用它来专业化

你的 dev flow 如果想聚焦在"帮我做 Next.js + AI SDK 开发"，可以在 base prompt 里**刻意重复**这个身份定位。参考 codex 的做法 —— "coding agent" 出现 3 次。

### 2. Base model 的安全训练是**不可绕过**的约束

这意味着：
- **选模型时**要知道它的安全边界（比如 GPT-5 vs Claude Opus 4.6 vs 本地 Llama 在这类请求上的行为差异可能很大）
- **不要试图用 prompt 绕过安全训练** —— 这不仅通常失败，还可能触发 OpenAI 的 moderation policy 封号
- **如果业务需要触碰灰色地带**（比如安全研究、红队演练），需要选专门的模型或申请专门的 API 许可，不是 prompt 工程能解决的

### 3. Personality 直接决定"拒绝的手感"

同样是拒绝，"冷冰冰一句 No" 和 "解释 + 替代方案 + 下一步建议"给用户的感受天差地别。如果你希望你的 agent 在拒绝时也保持专业有用的手感，模仿 codex 这 4 条规则：

```
concise, direct, and friendly
precise, safe, and helpful
```

配合结尾的 `ask the user if they want you to do so` 引导下一步，整个 UX 会好很多。

---

## 速查：如果我想让我的 agent 处理非编程任务怎么办？

**短答**：别强行改 prompt，**换一个基座模型**或**另起一条流**。

**长答**：

- 你无法通过 prompt 让一个被训练为 coding agent 的模型变成"什么都答"的通用助手 —— 即使 prompt 里你写 "You are a general assistant, answer anything"，模型的 RLHF 会继续过滤敏感请求。
- 正确的做法：**把通用 Q&A 和编程 agent 分成两个不同的入口**。比如你的 UI 里搞个 mode 切换，"编程模式"走 codex 风格 prompt + 代码工具，"通用模式"走另一个 prompt + 网络搜索。两个 mode 用不同的模型也完全可以。
- 这其实也是 Claude Code / Cursor / Codex 的共同做法 —— 它们**没有**一个"通用助手"模式，**故意**只做编程。商业上这是 feature，不是 bug：专注的工具比大而全的好卖。

---

## 最后的直白话

你问 codex 要 Win11 激活码得不到 —— 这不是 codex "不帮你"，是**整个 AI 行业的底线**：OpenAI / Anthropic / Google 都会拒绝。哪怕你自己训练一个本地 7B 模型去绕，得到的激活码也是无效的（激活码是 Microsoft 服务端校验的，模型生成只是乱码字符串）。

**正规路径**：微软官网 / Visual Studio 订阅 / JetBrains 学生包 / 公司 MSDN。
**学习路径**：你现在已经从这个问题里学到了 prompt 工程的 4 层机制 —— 比一个激活码值钱多了。
