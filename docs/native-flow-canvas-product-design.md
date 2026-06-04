# Native Flow Canvas Product Design

## 1. Product Vision

The Flow canvas should become a local-first workflow product for people who want to turn repeatable knowledge work into visible, inspectable, and reusable automations.

The promise is not "draw boxes and hope an agent figures it out." The promise is:

- users describe a workflow visually;
- each node has a clear job, input, output, artifacts, and failure state;
- agent nodes remain available for judgment-heavy work;
- deterministic nodes handle repeatable browser, file, shell, transform, and approval actions;
- every run can be inspected, resumed, retried, or safely applied.

The first anchor workflow is:

```text
Juejin Frontend -> article candidates -> article extraction -> source notes
-> topic/update proposals -> human approval -> document workspace updates
```

This is a good product proving ground because it combines the hard parts:

- dynamic web pages;
- repeated item processing;
- dedupe and ranking;
- AI summarization;
- file writes into another workspace;
- human approval before knowledge-base changes;
- run reports and artifacts.

## 2. Current System

The current code already provides a useful skeleton:

- `lib/persistence/flows.ts`
  - flow definitions;
  - nodes and edges;
  - run and node-run records;
  - run events;
  - graph snapshots.
- `lib/flows/executor.ts`
  - starts from a `start` node;
  - waits for upstream nodes;
  - executes nodes;
  - stores outputs and events;
  - routes through conditional edges.
- `app/_components/FlowWorkspace.tsx`
  - React Flow canvas;
  - node creation;
  - node config forms;
  - run input;
  - run detail and event inspection.

The available node types are currently:

```text
start
agent
prompt
transform
condition
end
```

This means the product is currently a flexible agent/prompt chain with JSON handoff. That is already valuable, but it is not yet a full workflow automation platform.

## 3. Product Gap

The canvas can represent arbitrary shapes, but the runtime cannot yet execute arbitrary useful workflows in a stable way.

The missing product capabilities are:

1. Node plugin registry
2. Purpose-built tool nodes
3. Foreach and batch processing
4. Human approval and edit gates
5. Dry-run/apply split
6. Run artifacts
7. Per-item state
8. Strict input/output schemas
9. Real retry semantics
10. Pause, resume, cancel, and rerun
11. Scheduled and external triggers
12. Browser automation as a first-class node family
13. Flow templates
14. Subflows
15. Permission and write-safety policies

The right direction is to keep agent nodes, but stop making agent nodes carry every responsibility.

## 4. Target User Model

The product serves three user groups.

### Individual Operators

They want to automate recurring personal workflows:

- collect articles;
- summarize PDFs;
- organize notes;
- generate reports;
- prepare publishing assets;
- inspect codebases;
- run local maintenance tasks.

They care about speed, low ceremony, and trust.

### Knowledge Workers and Creators

They want workflows that turn raw sources into useful outputs:

- source intake;
- topic synthesis;
- content packaging;
- newsletter preparation;
- research digests;
- social copy;
- image and document assets.

They care about quality, attribution, review, and repeatability.

### Teams

They want shared workflow templates:

- onboarding;
- weekly reporting;
- release notes;
- support triage;
- competitor monitoring;
- internal knowledge-base upkeep.

They care about permissions, logs, templates, and reproducibility.

## 5. Core Product Principles

### Visible Work

Every important action should have a node run, event, artifact, or item state. Hidden agent transcript work is acceptable for exploratory judgment, but not for business-critical side effects.

### Human Control at Risk Boundaries

The system can read, summarize, rank, propose, and draft automatically. It should ask before irreversible or broad writes, especially when updating a knowledge base, publishing output, sending messages, or running mutating shell commands.

### Agent Where Needed, Determinism Where Possible

AI should decide fuzzy things: relevance, summary, classification, tone, synthesis. Deterministic nodes should handle repeatable mechanics: fetching, parsing, mapping, filtering, writing, patching, routing, waiting, and applying.

### Dry Run First

Any workflow that writes outside `.tmp` should support proposal mode. Users should be able to inspect what would change before applying it.

### Reusable Nodes Over Giant Prompts

If a workflow step will be reused, inspected, retried, or audited, it should become a node capability rather than a giant instruction inside an agent node.

## 6. Target Architecture

```text
Flow Canvas UI
  |
  | create/edit graph
  v
Flow Persistence
  |
  | flow + nodes + edges + config + graph snapshots
  v
Flow Executor
  |
  | dispatch node by registry
  v
Node Registry
  |
  +-- core nodes
  +-- ai nodes
  +-- browser nodes
  +-- file/document nodes
  +-- approval nodes
  +-- integration nodes
  |
  v
Artifacts + Item State + Events
  |
  v
Inspector / Resume / Apply
```

The graph remains the source of truth for workflow definition. A run snapshot is the source of truth for what was executed. Artifacts and item state are the source of truth for intermediate business data.

## 7. Node Registry

Current node types are hard-coded across persistence, API, UI, and executor. The target system needs a registry.

Conceptual interface:

```ts
type FlowNodeDefinition = {
  type: string;
  category: "core" | "ai" | "browser" | "file" | "document" | "approval" | "integration";
  label: string;
  description: string;
  defaultTitle: string;
  defaultConfig: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  configSchema?: unknown;
  execute: FlowNodeExecutor;
};
```

The first implementation should register the existing node behavior:

- `core.start`
- `ai.agent`
- `ai.prompt`
- `core.transform`
- `core.condition`
- `core.end`

For backward compatibility, current types can be mapped:

```text
start     -> core.start
agent     -> ai.agent
prompt    -> ai.prompt
transform -> core.transform
condition -> core.condition
end       -> core.end
```

The UI can initially keep the current labels while the backend supports qualified types internally.

## 8. Node Families

### Core Nodes

```text
core.start
core.end
core.transform
core.condition
core.foreach
core.join
core.delay
core.subflow
```

Core nodes own graph mechanics and JSON shaping.

### AI Nodes

```text
ai.agent
ai.prompt
ai.classify
ai.summarize
ai.extract
ai.rank
ai.synthesize
```

AI nodes should support strict output schemas and configurable model/tool access.

### Browser Nodes

```text
browser.open
browser.extractList
browser.extractArticle
browser.click
browser.scroll
browser.snapshot
browser.close
```

Browser nodes should produce visible artifacts:

- page title;
- final URL;
- extracted items;
- screenshots when useful;
- raw DOM/text snapshot where allowed.

### File Nodes

```text
file.read
file.write
file.patch
file.exists
file.glob
file.copy
file.diff
```

File writes should support dry-run/apply mode.

### Document Knowledge Nodes

These are product-level nodes for the `/Users/apple/Desktop/project/document` use case, but should be generic enough to adapt.

```text
document.intakeSource
document.writeSourceNote
document.proposeTopicUpdates
document.applyApprovedUpdates
document.updateIndex
document.appendLog
```

The node should encode workspace conventions instead of asking a generic agent to remember them every time.

### Approval Nodes

```text
approval.review
approval.choose
approval.edit
approval.apply
```

These nodes pause a run and wait for user input.

### Integration Nodes

Later:

```text
rss.fetch
http.fetch
github.issueSearch
slack.send
email.send
notion.update
linear.createIssue
```

## 9. Execution Lifecycle

### Run States

```text
queued
running
waiting_for_approval
paused
succeeded
failed
cancelled
```

The current status model already has `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `skipped`. It needs `waiting_for_approval` or a separate wait-state table.

### Node Run States

```text
queued
running
waiting
succeeded
failed
skipped
cancelled
retrying
```

### Item States

For batch work:

```text
discovered
queued
running
succeeded
failed
skipped_duplicate
skipped_low_value
waiting_for_approval
applied
```

An item is not a graph node. It is a business object moving through nodes. For Juejin, each article is an item.

## 10. Artifact Model

Artifacts are outputs that deserve a stable reference.

Examples:

- candidate list JSON;
- candidate list Markdown;
- extracted article Markdown;
- screenshots;
- source note draft;
- proposed file patch;
- final run report;
- generated images;
- logs.

Suggested model:

```ts
type FlowArtifact = {
  id: string;
  flowRunId: string;
  nodeRunId: string | null;
  itemId: string | null;
  kind: "json" | "markdown" | "text" | "image" | "html" | "patch" | "log";
  title: string;
  path: string | null;
  mediaType: string | null;
  metadata: unknown;
  createdAt: number;
};
```

Artifacts can live under:

```text
.flow-artifacts/<flow-id>/<run-id>/
```

For external workspaces, artifact references should store absolute paths only when needed and should respect workspace boundaries.

## 11. Safety Model

### Permission Modes

Suggested run policies:

```text
readOnly
dryRun
applyApproved
directApply
```

Default should be `dryRun` for workflows that touch file systems outside the app workspace.

### Write Policy

Every write-capable node should know whether it is allowed to:

- write only artifacts;
- write only inside current workspace;
- write inside selected external workspace;
- produce patches but not apply;
- apply patches after approval.

### Approval Boundaries

Approval should be required before:

- updating `wiki/topics`;
- updating `outputs`;
- running mutating shell commands;
- sending external messages;
- deleting or overwriting files;
- applying multi-file patches.

For the document knowledge workflow:

- source notes can be auto-written in dry-run or controlled apply mode;
- topic/synthesis/output updates should require approval.

## 12. Juejin Frontend Reference Workflow

### User Goal

Regularly scan the Juejin Frontend channel, find useful articles, summarize them, and improve the document knowledge base without polluting it.

### Flow

```text
Start
  input:
    url: https://juejin.cn/frontend
    limit: 20
    documentWorkspace: /Users/apple/Desktop/project/document
    mode: dryRun

Browser Extract List
  output:
    candidates[]

Dedupe + Rank
  output:
    selected[]
    skipped[]
    reasons

Foreach selected article
  Browser Extract Article
    output: article markdown + metadata

  AI Source Summary
    output: structured summary

  Document Source Note Draft
    output: note path + patch/artifact

Join
  output:
    all drafted source notes

Topic Proposal
  output:
    topic candidates
    mention normalization proposals
    existing topic update proposals

Human Approval
  output:
    approved source writes
    approved topic updates
    rejected items

Apply Approved Updates
  output:
    changed files

Run Report
  output:
    summary markdown

End
```

### Important Behavior

The workflow should not automatically "improve everything." It should:

- collect evidence;
- produce source notes;
- propose higher-level updates;
- wait for human approval;
- apply only approved changes.

### Candidate Scoring

Each article can be scored:

```text
relevance: 0-5
novelty: 0-5
depth: 0-5
reuse: 0-5
risk: 0-5
```

Default rule:

```text
total >= 14 and risk <= 2 -> selected
total >= 10 -> needs review
otherwise -> skipped
```

### Outputs

Suggested run output:

```text
/Users/apple/Desktop/project/document/.tmp/juejin-frontend-runs/<date>/
  candidates.json
  candidates.md
  articles/
    <post-id>.md
  source-notes/
    <slug>.md
  proposals.md
  run-report.md
```

Long-lived accepted outputs go into the existing document workspace structure:

```text
raw/sources/Articles/
wiki/sources/
wiki/topics/
wiki/syntheses/
06_Maps/index.md
log.md
```

## 13. UX Design

### Canvas

The canvas should remain the main work surface, but node creation should be categorized:

```text
Core
AI
Browser
Files
Documents
Approval
Integrations
```

Each node card should show:

- type;
- title;
- last run state;
- item count where relevant;
- artifact count;
- error summary when failed.

### Inspector

The right inspector should support:

- node config;
- input schema;
- output schema;
- last input/output;
- artifacts;
- item list;
- retry/cancel/rerun controls;
- approval controls.

### Run Detail

Run detail should answer:

- What ran?
- What changed?
- What is waiting?
- What failed?
- What artifacts were produced?
- What can I approve/apply?

### Templates

Users should be able to create from templates:

- Juejin Frontend Intake
- Google News Image Flow
- RSS Digest
- PDF Source Intake
- Weekly Work Report
- Codebase Review
- Release Notes

## 14. Implementation Roadmap

### Phase 1: Foundation

Goal: make current behavior registry-driven without changing product surface.

Work:

- introduce node registry;
- register current node types;
- dispatch via registry in executor;
- keep current UI behavior;
- add tests for existing node execution.

### Phase 2: Artifacts and Item State

Goal: make workflow outputs inspectable and resumable.

Work:

- add `flow_artifacts`;
- add `flow_items`;
- show artifacts and item status in inspector;
- add run report artifact support.

### Phase 3: Real Retry and Schema Validation

Goal: make runs reliable.

Work:

- validate node config/input/output;
- enforce output schema for AI nodes;
- retry failed safe nodes;
- show schema errors clearly.

### Phase 4: Browser + File Nodes

Goal: support real web-to-file workflows without giant agent prompts.

Work:

- browser extract list/article nodes;
- file read/write/patch/diff nodes;
- dry-run/apply write policy.

### Phase 5: Foreach and Approval

Goal: support batch workflows and human gates.

Work:

- foreach node;
- join node;
- approval review node;
- waiting/resume state;
- approve/reject UI.

### Phase 6: Juejin Frontend Template

Goal: ship the first useful template.

Work:

- template graph;
- candidate extraction;
- dedupe/rank;
- document source note draft;
- topic proposals;
- approved apply.

### Phase 7: Scheduling and Sharing

Goal: make flows useful beyond manual runs.

Work:

- scheduled trigger;
- webhook trigger;
- template export/import;
- flow run summaries;
- packaged examples.

## 15. First Milestone Definition

The first milestone is not "all workflows." It is:

> A user can create or load a Juejin Frontend Intake flow, run it in dry-run mode, inspect candidates and proposed document changes, approve selected updates, and see exactly which files were changed.

Acceptance criteria:

- The flow can process at least 5 article candidates.
- Duplicate/low-value articles are skipped with reasons.
- Each selected article has a source summary artifact.
- The workflow produces a proposal report before applying writes.
- Topic-level updates require explicit approval.
- Failed articles do not fail the whole run unless configured.
- The run detail panel shows item states and artifacts.
- The final report lists changed files and skipped items.

## 16. Open Questions

1. Should browser automation use the user's logged-in Chrome, an isolated Playwright browser, or both?
2. Should document workspace writes be direct file writes, patches, or both?
3. Should approval be per item, per file, or per proposal group?
4. Should flow templates be stored in SQLite, JSON files, or both?
5. Should `foreach` create child node runs per item or item runs under one node run?
6. Should long-running flows survive dev server restarts in the first milestone, or is process-local resume acceptable?

## 17. Recommended Immediate Next Step

Start with Phase 1 and Phase 2 together:

1. Add a node registry while preserving existing node behavior.
2. Add artifacts as a generic output layer.
3. Keep item state for the next phase unless it is needed immediately by the first template.

This gives the product a cleaner extension point before we add the browser/document workflow nodes.
