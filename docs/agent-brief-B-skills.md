# Agent Brief — B 路：Skills 体系

> **范围**：Phase 3 + Phase 4（A 档 5 个 + B 档 5 个 = 共 10 个 skill）
> **预计时间**：1-1.5 天
> **PR 数**：2 个（Phase 3 一个，Phase 4 一个）
> **前置依赖**：A 路 PR 已 merge

---

## 1. 背景

参考主文档 [docs/open-agents-alignment-plan.md](./open-agents-alignment-plan.md) §0、§3 Phase 3/4。

**关键概念**：Skill ≠ Tool。
- Tool = 函数，model 调用时执行代码（如 `read_file`）
- Skill = 指令文档（markdown），扩展 model 上下文但不执行代码

**接入方式**：open-agents hybrid 模式
- Skill names + descriptions 进 system prompt（model 知道有什么可用）
- Skill body 通过 `skill` 工具按需拉取（不爆 token）

**对齐对象**：
- 工具定义：`tmp/open-agents-main/packages/agent/tools/skill.ts`
- prompt 注入：`tmp/open-agents-main/packages/agent/system-prompt.ts:370-413` `buildSkillsPrompt()`
- 类型/frontmatter：`tmp/open-agents-main/packages/agent/skills/types.ts`
- 加载器：`tmp/open-agents-main/apps/web/app/api/chat/_lib/runtime.ts:32` 周边

---

## 2. PR 1：Phase 3（A 档骨架）

### 2.1 必须修改的文件

| 文件 | 修改内容 |
|---|---|
| `.agents/skills/{ai-sdk,chat-sdk,plan-mode,code-review,workflow}/` | **新建**：从 `tmp/open-agents-main/.agents/skills/` 整目录拷贝 |
| `lib/skills/types.ts` | **新建**：`Skill` 类型 + frontmatter schema |
| `lib/skills/discover.ts` | **新建**：扫 `.agents/skills/*/SKILL.md`，解析 YAML frontmatter |
| `lib/skills/cache.ts` | **新建**：进程内 `Map<sessionId, Skill[]>` 缓存 |
| `lib/skills/index.ts` | **新建**：barrel export |
| `lib/tools/skill.ts` | **新建**：`skill` 工具（按 name 读 SKILL.md body 返回） |
| `lib/chat-agent/system-prompt.ts` | 新增 `buildSkillsSection(skills)` 函数 + 在主 prompt 拼接 |
| `app/api/chat/agent-config.ts` | 把 `skill` 工具加入 toolset；通过 `experimental_context.skills` 注入 |
| `app/api/chat/route.ts` | 在 POST handler 调 `discoverSkills()` 并传给 workflow options |
| `app/workflows/chat.ts` | `ChatWorkflowOptions` 新增 `skills` 字段；传给 agent |

### 2.2 详细步骤

#### Step 1：拷贝 skill 文件

```bash
mkdir -p .agents/skills
cp -r tmp/open-agents-main/.agents/skills/ai-sdk .agents/skills/
cp -r tmp/open-agents-main/.agents/skills/chat-sdk .agents/skills/
cp -r tmp/open-agents-main/.agents/skills/plan-mode .agents/skills/
cp -r tmp/open-agents-main/.agents/skills/code-review .agents/skills/
cp -r tmp/open-agents-main/.agents/skills/workflow .agents/skills/
```

#### Step 2：`lib/skills/types.ts`

参考 open-agents `packages/agent/skills/types.ts`。Zod schema 定义 frontmatter：

```ts
import { z } from "zod";

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  version: z.string().optional(),
  "disable-model-invocation": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
  "allowed-tools": z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export type Skill = {
  name: string;
  description: string;
  body: string; // 去掉 frontmatter 后的纯 markdown
  filePath: string;
  frontmatter: SkillFrontmatter;
};
```

#### Step 3：`lib/skills/discover.ts`

```ts
// 伪代码骨架
import fs from "node:fs/promises";
import path from "node:path";
// 用 gray-matter 或自己 parse YAML
// 注意：gray-matter 已是 indirect dep，可以直接用；如果没有，用 js-yaml 自己 parse
```

实现 `discoverSkills(rootDir = ".agents/skills"): Promise<Skill[]>`：
- glob `${rootDir}/*/SKILL.md`
- 每个文件读出来，splitFrontmatter（找 `---` ... `---`）
- 用 `skillFrontmatterSchema.parse()` 校验
- 返回 `Skill[]`

注意：扫描深度限制 1 层（`.agents/skills/<name>/SKILL.md`），不要递归（避免误读 references/ 子目录里的 .md）。

#### Step 4：`lib/skills/cache.ts`

```ts
const cache = new Map<string, Promise<Skill[]>>();

export function getSkillsForSession(sessionId: string): Promise<Skill[]> {
  if (!cache.has(sessionId)) {
    cache.set(sessionId, discoverSkills());
  }
  return cache.get(sessionId)!;
}

export function invalidateSkillsCache(sessionId: string): void {
  cache.delete(sessionId);
}
```

简单进程内缓存。多实例部署时再换。

#### Step 5：`lib/tools/skill.ts`（核心）

参考 open-agents `packages/agent/tools/skill.ts:32-110`。

```ts
import { tool } from "ai";
import { z } from "zod";
import fs from "node:fs/promises";
import { toolOk, toolErr } from "@/lib/tool-result";
import type { Skill } from "@/lib/skills/types";

export function createSkillTool() {
  return tool({
    description: "Load a skill's full instructions on demand. Use this when a skill in the available list is relevant.",
    inputSchema: z.object({
      skill: z.string().describe("The skill name to load"),
      args: z.string().optional().describe("Optional arguments passed to the skill"),
    }),
    async execute({ skill: skillName, args }, { experimental_context }) {
      const skills = (experimental_context as { skills?: Skill[] })?.skills ?? [];
      const found = skills.find((s) => s.name === skillName);
      if (!found) {
        return toolErr(`Skill "${skillName}" not found. Available: ${skills.map((s) => s.name).join(", ")}`);
      }
      if (found.frontmatter["disable-model-invocation"]) {
        return toolErr(`Skill "${skillName}" cannot be invoked by the model directly.`);
      }
      return toolOk({
        name: found.name,
        body: found.body,
        args: args ?? null,
      });
    },
  });
}
```

#### Step 6：system prompt 注入

`lib/chat-agent/system-prompt.ts` 新增：

```ts
export function buildSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "## Skills",
    "- 使用 `skill` 工具按需拉取下面任一 skill 的完整指令",
    '- 用户输入 "/<skill-name>" 即代表显式调用',
    "- 部分 skill 不允许模型主动调用（user-invocable only），仅响应用户显式触发",
    "",
    "可用 skills:",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ];
  return lines.join("\n");
}
```

在 `buildSystemPrompt` 主函数里把 skills section 拼进去（位置看现有 prompt 结构，建议放在 tool 说明附近）。

#### Step 7：注入到 agent

`app/api/chat/agent-config.ts`：
- toolset 新增 `skill: createSkillTool()`
- agent 创建时通过 `experimental_context.skills` 传入

`app/api/chat/route.ts`：
- POST handler 里 `const skills = await getSkillsForSession(chatId);`
- 传给 `runAgentWorkflow({ ..., skills })`

`app/workflows/chat.ts`：
- `ChatWorkflowOptions` 新增 `skills: Skill[]`
- 传给 `createProjectEngineerAgent({ ..., skills })`
- agent 调用时通过 `options: { ..., skills }` 走 `experimental_context`

### 2.3 不要碰

- `lib/workspace-tools.ts` / `lib/write-tools.ts`（C 路）
- `lib/sandbox/`（C 路，不存在）
- `app/workflows/chat.ts` 的 outer loop 结构（A 路已经定了，只加 skills 字段）
- `lib/active-streams.ts`（A 路已经删了）

### 2.4 验证

| # | 验证项 | 怎么验 |
|---|---|---|
| 1 | lint | `npm run lint` 通过 |
| 2 | discover 能跑 | 加临时脚本 `tsx -e "import('./lib/skills/discover').then(m => m.discoverSkills().then(console.log))"`，应该列出 5 个 |
| 3 | system prompt 注入 | dev server 起，触发一次对话，console.log system prompt 看 "可用 skills" 段是否在 |
| 4 | model 能调 `skill` 工具 | 发"用 ai-sdk skill 解释 streamText 怎么用"，期望 agent 调 `skill({skill:"ai-sdk"})`，前端显示 tool card |
| 5 | 不存在的 skill 报错 | 手动测 `skill({skill:"foo"})`，应该返回 toolErr |
| 6 | token 大小检查 | 5 个 skill 的 names+descriptions 拼起来 < 2KB（log 出来量一下） |

---

## 3. PR 2：Phase 4（B 档 5 个适配）

### 3.1 必须修改的文件

| 文件 | 修改内容 |
|---|---|
| `.agents/skills/{vercel-react-best-practices,emil-design-eng,baseline-ui,frontend-design,web-animation-design}/` | **新建**：从 `tmp/open-agents-main/.agents/skills/` 拷贝 |
| 同上目录里的 `SKILL.md` | **逐个 review** content，剔除冲突 |

### 3.2 逐个 review 重点

| Skill | 关注点 |
|---|---|
| `vercel-react-best-practices` | 剔除 Vercel 部署 / Vercel CLI 相关条款；保留 React 19 / Next.js 16 best practices |
| `emil-design-eng` | 跟我们现有 UI 风格（参考 `app/_components/`）冲突的描述要删 |
| `baseline-ui` | 跟 Tailwind v4 不兼容的旧 v3 写法要清 |
| `frontend-design` | 同上 |
| `web-animation-design` | 我们目前没动画需求，可以保留作参考但 description 标 "（参考用）" |

### 3.3 Skills 同步策略

不引入 `skills-lock.json`。直接 vendor 到 `.agents/skills/`，自己维护。

可选：写一个 `scripts/sync-skills.ts`，手动 diff 用，**不放进 npm scripts**：
```ts
// 仅当 tmp/open-agents-main 存在时跑，对比各 skill 跟上游差异
```

### 3.4 验证

| # | 验证项 | 怎么验 |
|---|---|---|
| 1 | discover 能扫到 10 个 | 跑 discover 脚本 |
| 2 | UI skill 加载后不污染原有交互 | dev server 起，做一次普通对话，确认 system prompt 拼接正常、agent 行为没变怪 |
| 3 | token 大小复查 | 10 个 skill 的 names+descriptions 总和 < 4KB |

---

## 4. 不要碰的区域（贯穿 B 路两个 PR）

- 任何 A 路 / C 路改的文件
- workflow / loop 逻辑（A 路负责）
- workspace tools（C 路负责）
- skill body 内容（除非 B 档 review 时主动改）
- frontmatter 字段定义（保持跟 open-agents 一致，方便后续 sync）

---

## 5. PR 输出格式

### PR 1（Phase 3）

**Branch**：`feat/phase-skills-core`
**标题**：`feat(skills): add A-tier skills with hybrid loading (open-agents pattern)`

```markdown
## 改动

按 [docs/open-agents-alignment-plan.md](docs/open-agents-alignment-plan.md) Phase 3 执行：

- 新增 `.agents/skills/` 5 个 A 档 skill（ai-sdk / chat-sdk / plan-mode / code-review / workflow）
- 新增 `lib/skills/` 模块（types / discover / cache）
- 新增 `lib/tools/skill.ts` 工具，按 name 拉取 SKILL.md body
- system prompt 注入 skills section（仅 names + descriptions）
- chat route + workflow options 串通 skills 注入链路

## 验证
- [x] lint
- [x] discover 列出 5 个
- [x] system prompt 包含 skills section
- [x] model 实际能调 `skill` 工具拉取 body
```

### PR 2（Phase 4）

**Branch**：`feat/phase-skills-ui`
**标题**：`feat(skills): add B-tier UI skills with adaptation`

```markdown
## 改动

按 [docs/open-agents-alignment-plan.md](docs/open-agents-alignment-plan.md) Phase 4 执行：

- 新增 5 个 B 档 skill（vercel-react-best-practices / emil-design-eng / baseline-ui / frontend-design / web-animation-design）
- 逐个 review SKILL.md 内容，剔除跟我们栈（Tailwind v4、Next.js 16）冲突的条款

## 改动 review 摘要
- vercel-react-best-practices: 剔除 X 段
- ...

## 验证
- [x] discover 列出 10 个
- [x] 普通对话回归
```

---

## 6. 给执行 agent 的额外指令

- **PR 1 必须 merge 后才能开 PR 2**（PR 2 依赖 PR 1 的 skill 加载机制）
- skill body 内容**保留 open-agents 原样**（除非是 PR 2 review 阶段必要剔除）
- frontmatter 字段**严格按 open-agents schema**，不自创
- **不要在 skill 里塞代码执行逻辑**——skill 就是文档，不要把它扩展成"可执行 skill"
- 不要默认 `npm run build`
- 中文 / 英文 commit 都行
