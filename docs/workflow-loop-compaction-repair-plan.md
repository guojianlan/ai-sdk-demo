# Workflow Loop and Codex-Style Compaction Repair Plan

## Summary

Fix the token-budget blow-up by removing the duplicated client-side tool-call continuation path and redesigning compaction around Codex's replacement-history model. The backend workflow should own all server-side tool loops within one assistant turn; the client should only start new user turns or send human interaction results.

## Current Diagnosis

The current system still has two continuation mechanisms:

- Backend loop: `app/workflows/chat.ts` runs an outer loop up to `CHAT_OUTER_STEP_LIMIT` and appends each AI SDK step to the same assistant message.
- Frontend auto-resubmit: `app/page.tsx` still uses `sendAutomaticallyWhen` with `lastAssistantMessageIsCompleteWithToolCalls`.

That means a completed server-side tool call can still be interpreted by the client as "send another POST". When that happens, the next request starts a new workflow run with a new assistant id instead of continuing the existing backend loop. This matches the observed corrupted session shape: one user message followed by many large assistant snapshots.

The current compaction path also has a structural failure mode:

- `app/api/chat/route.ts` stores full UI history and uses `thread_summaries.compacted_count` to slice `agentViewMessages`.
- `lib/compaction.ts` refuses to compact if the retained tail would start with `assistant`.
- In a corrupted history shaped like `user + assistant + assistant + ...`, the split walks back to the first user, produces `toCompact=[]`, and therefore cannot compact anything.
- If compaction fails, the route falls back to the original large history and the workflow then stops at the token guard.

## Codex Reference Points

Codex's current compaction model in `tmp/codex-latest` has several important invariants:

- `ModelInfo::auto_compact_token_limit()` derives the auto compact limit from the model context window and clamps configured limits to 90% of that window.
- `session/turn.rs` runs compaction both before sampling and mid-turn when token usage crosses the limit and the model still needs follow-up.
- `compact.rs` builds replacement history, then installs it with `replace_compacted_history`; compaction is a semantic history rewrite, not just a summary side table plus a slice count.
- Inline compaction keeps recent real user messages up to a token budget, appends a prefixed handoff summary as the final user-style item, and recomputes token usage.
- Remote compaction filters unsafe/stale items, drops stale developer messages and tool/function call details, installs the compacted replacement history, and recomputes token usage.
- If the compaction request itself exceeds context, Codex trims oldest history items or generated tool history rather than blindly sending the original oversized history onward.

The useful translation for this app: keep full UI history for display, but maintain a separate compacted active model history for the agent. Do not rely on `compacted_count` over the visible UI transcript as the source of truth.

## Target Invariants

1. One user submission creates at most one backend workflow run unless the user explicitly submits another message or answers an interactive tool.
2. Server-executed tools continue only inside `runAgentWorkflow`; the frontend must not auto-resubmit just because server tool calls are complete.
3. Human-interaction tools still post back to the server after the user answers, but that should be a distinct "human response continuation" path.
4. The model-visible transcript after compaction is a bounded replacement history: summary plus selected recent user intent, not a fragile slice of the UI transcript.
5. When context is already above the hard budget, compaction must fail closed: compact deterministically, trim generated history, or return a clear terminal error before starting a new workflow.
6. Token accounting should be based on the active model history plus system prompt layers, and should be recomputed after each compaction.

## Approach

### 1. Collapse Continuation Ownership Into The Backend

Make backend workflow the only owner of server-side tool continuation.

Planned changes:

- In `app/page.tsx`, remove `lastAssistantMessageIsCompleteWithToolCalls` from `sendAutomaticallyWhen`.
- Keep or replace `lastAssistantMessageIsCompleteWithApprovalResponses` only for approval-response POSTs.
- Add a narrow predicate for interactive tools with no server-side `execute` (`ask_user_question`, `ask_choice`, approvals, or future explicitly marked client tools). This predicate should trigger only after the user has supplied output, not after ordinary server-side tool output.
- Update stale comments in `lib/tool-helpers.ts`, `app/page.tsx`, and `app/workflows/chat.ts` so they no longer describe client tool-call continuation as the normal server-tool path.

Expected effect: ordinary read/glob/shell/update_plan/write/edit tool outputs stay inside the existing workflow loop and do not create new assistant messages or new workflow runs.

### 2. Introduce Active Model History As The Agent Source Of Truth

Stop deriving model input solely from full UI history plus `compacted_count`.

Planned changes:

- Replace or extend `thread_summaries` with an active-context record, for example:
  - `summary`: latest handoff summary text
  - `replacement_messages`: JSON array of bounded UI/model messages used as agent input
  - `tokens_before`, `tokens_after`
  - `compacted_message_count` for UI/debug only
  - `updated_at`
- Keep `messages` as the full UI transcript for rendering and audit.
- In `app/api/chat/route.ts`, build `agentMessages` from active-context replacement history when it exists, then append only new user/human-response messages since that active context.
- Treat `compacted_count` as debug metadata, not as the mechanism that reconstructs model input.

This follows Codex's `replace_compacted_history` idea: after compaction, the compacted replacement is the live model history.

### 3. Redesign `lib/compaction.ts` Around Replacement History

Change the helper API from "split old messages and return kept tail" to "build a bounded replacement model history".

Planned API shape:

```ts
type CompactionResult = {
  summary: string;
  replacementMessages: UIMessage[];
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  strategy: "llm" | "deterministic-fallback";
};
```

Replacement rules:

- Summarize model-visible history into a concise handoff using the Codex-style prompt: current progress, decisions, constraints/preferences, next steps, critical references.
- Select recent real user messages under a token budget, similar to Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`.
- Drop generated assistant/tool payloads from replacement history by default; their durable facts should live in the summary.
- Add the summary as a dedicated synthetic context message or prompt layer. In this app, the existing `conversationSummary` prompt layer can remain the summary carrier, while `replacementMessages` contains recent user intent.
- Ensure replacement history is valid even for corrupted shapes like `user + many assistant`; do not require the retained tail to start with a real user message from the original suffix.

### 4. Add Fail-Closed Budget Handling

The current route catches compaction failure and continues with original history. That is unsafe once history is already above budget.

Planned changes:

- If token estimate exceeds the compaction threshold and LLM compaction fails, run deterministic fallback compaction:
  - keep recent real user messages under budget;
  - insert a summary placeholder that says automatic LLM compaction failed and old generated/tool details were omitted;
  - persist the fallback active context and a visible warning notice.
- If the fallback still exceeds budget, return a clear HTTP error before `start(runAgentWorkflow, ...)`.
- In `app/workflows/chat.ts`, replace the "token budget tripped -> stop" path with a mid-turn compaction attempt when there is pending tool continuation. If mid-turn compaction fails, finish with an explicit user-visible budget message rather than silently writing a blank finish.

This mirrors Codex's pre-turn and mid-turn compaction split.

### 5. Repair Existing Corrupted Sessions Safely

This plan should include a one-off maintenance script or admin route, not an automatic destructive migration.

Planned script:

- Detect sessions with suspicious shape:
  - many assistant messages after one user message;
  - repeated assistant payloads with similar byte size;
  - active context missing while UI history is over threshold.
- Rebuild active context using deterministic fallback plus optional LLM summary.
- Leave full UI messages untouched unless the user explicitly chooses to prune them.

For the observed session `09834029-5816-48a0-b8de-9e7e4b4327bc`, this would create active model context from the first user request and a compact summary of the useful assistant/tool work, without needing to delete the visible transcript.

## Files To Change

- `app/page.tsx`
  - Remove general `lastAssistantMessageIsCompleteWithToolCalls` auto-resubmit.
  - Keep a narrow human-response continuation predicate.
  - Update comments around `addToolOutput` and stream resumption.

- `lib/tool-helpers.ts`
  - Mark interactive tools with explicit client-continuation metadata or document a static list.
  - Remove comments implying all no-execute tool outputs rely on generic completed-tool auto-submit.

- `app/workflows/chat.ts`
  - Keep server-side outer loop as the only server-tool continuation loop.
  - Add mid-turn compaction before stopping on token budget.
  - Emit a user-visible budget/compaction failure message when continuation cannot proceed.

- `app/api/chat/route.ts`
  - Build agent input from active replacement context plus new user/human messages.
  - Fail closed when compaction is required but unavailable.
  - Persist active-context metadata before starting workflow.

- `lib/compaction.ts`
  - Replace split/tail API with replacement-history API.
  - Add Codex-style summary prompt and deterministic fallback.
  - Add tests for corrupted `user + assistant*` histories.

- `lib/persistence/summaries.ts` and `lib/persistence/migrations.ts`
  - Extend `thread_summaries` or add a new `thread_active_context` table.
  - Store replacement messages and strategy metadata.

- `app/_components/MessageBubble.tsx`
  - Keep compaction notice rendering, but include strategy/warning when deterministic fallback was used.

- `tests/*`
  - Add unit tests for frontend continuation predicate.
  - Add compaction tests for normal multi-turn, assistant-only tail, failed summarizer fallback, and over-budget fallback.
  - Add route/workflow tests proving server tool output does not trigger a second workflow POST.

## Verification Plan

1. Unit tests:
   - `lib/compaction.ts` replacement history stays below budget and handles `user + assistant*`.
   - frontend continuation predicate returns false for server-side completed tool calls and true for completed human interaction output.
   - persistence loads active replacement context independently from full UI messages.

2. Targeted integration:
   - Start a chat that calls several server-side tools. Confirm one user message maps to one workflow run and one assistant id.
   - Trigger approval or ask-user interaction. Confirm user response creates exactly one continuation POST.
   - Force `COMPACTION_THRESHOLD_TOKENS` low, run a tool-heavy chat, and confirm compaction produces active replacement history and the workflow continues.
   - Simulate summarizer failure and confirm deterministic fallback prevents oversized original history from entering workflow.

3. Regression check for the current failure:
   - Load or synthesize a transcript shaped like the corrupted session.
   - Confirm the route creates active compacted context instead of stopping at `step=1 token budget tripped`.
   - Confirm no repeated assistant messages are appended after a terminal `finish`.

4. Light project checks:
   - `npm run lint`
   - targeted test command for the new tests

## Open Decisions Before Implementation

1. Whether to store `replacementMessages` in the existing `thread_summaries` table or create a clearer `thread_active_context` table. I recommend a new table if this codebase will keep evolving toward Codex's active-history model.
2. Whether the summary should be injected only through `conversationSummary` system prompt layer or also represented as a synthetic `UIMessage`. I recommend keeping it in `conversationSummary` for model input and using a separate system notice only for UI.
3. Whether to repair existing corrupted sessions automatically on first load or expose a script. I recommend an explicit script first to avoid surprising history rewrites.

## Implementation Decisions Applied

Implemented direction:

- Use a new `thread_active_context` table for active model history. Full UI messages remain untouched in `messages`.
- Treat `replacement_messages` as the live model-history base after compaction, then append only new tail events from the visible transcript.
- Keep the handoff summary in the `conversationSummary` prompt layer; UI receives a compact system notice with strategy metadata.
- Remove generic `lastAssistantMessageIsCompleteWithToolCalls` auto-resubmit from the frontend. Client auto-submit is now limited to approval responses and explicit client-continuation tools.
- Add deterministic fallback compaction. Once the active context is over threshold, the route must compact or return a clear 413 instead of starting workflow with oversized original history.
- Add workflow-level mid-turn compaction before the budget stop path. If the compacted active context still exceeds budget, emit and persist visible budget stop text instead of finishing as a blank assistant message.
