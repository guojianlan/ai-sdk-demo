# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Build & Dev Commands

- `npm run dev` — start Next.js dev server
- `npm run dev:devtools` — AI SDK devtools UI at http://localhost:4983
- `npm run dev:all` — run both concurrently
- `npm run build` — production build
- `npm run lint` — ESLint
- No test framework is configured

## Architecture

This is an AI-powered workspace explorer built with **Next.js 16**, **Vercel AI SDK v6**, and **Tailwind v4**. The UI is entirely in Chinese.

### API Routes

- **POST `/api/chat`** — Main chat endpoint. Uses `ToolLoopAgent` via `createChatAgent` builder with an OpenAI-compatible gateway (configured via `GEMINI_*` or `OPENAI_COMPAT_*` env vars). Supports two access modes:
  - `workspace-tools` — agent has file system tools (list_files, search_code, read_file), write tools (write_file, edit_file with approval), subagent tool (explore_workspace), and dynamic weather MCP tools
  - `no-tools` — knowledge-only, no file access
- **GET `/api/workspaces`** — Returns available workspaces for the picker UI
- **POST `/api/plan`** — Plan generator using `streamObject` for structured output

### Library (`lib/`)

- `env.ts` — Sole `process.env` entry point; crashes at module load if no API key is configured
- `gateway.ts` — Shared OpenAI-compatible gateway instance
- `chat-agent/{builder,system-prompt}.ts` — `createChatAgent` generic builder + unified `buildSystemPrompt` entry
- `chat/sanitize-messages.ts` — UI message cleanup (strip orphan tool parts + *Metadata)
- `tool-result.ts` — `ToolResult<T>` discriminated union + `toolOk` / `toolErr` helpers; all self-owned tools return this shape
- `workspaces.ts` — File system operations (listing, reading, ripgrep search) with strict path validation that rejects `..` escapes
- `workspace-tools.ts` / `write-tools.ts` — AI SDK tool definitions
- `subagents/explorer.ts` — Read-only explorer subagent exposed as `explore_workspace` tool
- `mcp/weather-client.ts` — Per-request stdio MCP client spawner for the weather server
- `chat-access-mode.ts` — Access mode type (`WorkspaceAccessMode`) and normalization

### Frontend (`app/page.tsx`)

Single-page chat UI. Multi-session management persisted to localStorage. Uses `useChat()` from `@ai-sdk/react` with `DefaultChatTransport` and passes workspace context via `experimental_context`. All tool-card rendering is in `app/_components/tool-card/`.

### Environment Variables

See `.env.example`. Required: `GEMINI_API_KEY` (or `OPENAI_COMPAT_API_KEY`). Optional: `GEMINI_BASE_URL`, `GEMINI_MODEL`, `WORKSPACE_BASE_DIR`, `AI_SDK_LOGGING`.

## Key Conventions

- TypeScript strict mode; schemas validated with Zod v4
- All env reads go through `lib/env.ts` — never touch `process.env` directly in app code
- Self-owned tools return `ToolResult<T>`; use `toolOk` / `toolErr` from `lib/tool-result.ts`
- New chat agents use `createChatAgent` from `lib/chat-agent/builder.ts`, with persona/rules in a sibling `agent-config.ts` next to `route.ts`
- Streaming responses use `createAgentUIStreamResponse` with smooth Chinese character chunking
- Path alias: `@/*` maps to the project root
