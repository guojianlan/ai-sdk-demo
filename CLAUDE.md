# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Build & Dev Commands

- `npm run dev` — start Next.js dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- No test framework is configured

## Architecture

This is an AI-powered workspace explorer built with **Next.js 16**, **Vercel AI SDK v6**, and **Tailwind v4**. The UI is entirely in Chinese.

### API Routes

- **POST `/api/chat`** — Main chat endpoint. Uses `ToolLoopAgent` from AI SDK with an OpenAI-compatible gateway (configured via env vars for Gemini or OpenAI). Supports two access modes:
  - `workspace-tools` — agent has file system tools (list_files, search_code, read_file)
  - `no-tools` — knowledge-only, no file access
- **GET `/api/workspaces`** — Returns available workspaces for the picker UI
- **POST `/api/chat-openai-experimental`** — Experimental endpoint using OpenAI `responses` API with three tool modes (workspace-toolset, shell, hybrid)

### Library (`lib/`)

- `workspaces.ts` — File system operations (listing, reading, ripgrep search) with strict path validation that rejects `..` escapes to enforce workspace boundaries
- `workspace-tools.ts` — AI SDK tool definitions wrapping the workspace operations
- `chat-access-mode.ts` — Access mode type (`WorkspaceAccessMode`) and normalization

### Frontend (`app/page.tsx`)

Single-page chat UI (~810 lines). Multi-session management persisted to localStorage. Uses `useChat()` from `@ai-sdk/react` with `DefaultChatTransport` and passes workspace context via `experimental_context`.

### Environment Variables

See `.env.example`. Key vars: `GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EXPERIMENT_MODEL`.

## Key Conventions

- TypeScript strict mode; schemas validated with Zod v4
- Streaming responses use `createAgentUIStreamResponse` with smooth Chinese character chunking
- Path alias: `@/*` maps to the project root
