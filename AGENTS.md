<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Validation workflow

- Do not run `npm run build` after every change by default.
- Prefer the lightest useful verification first, such as reading the affected files carefully, running `npm run lint`, or using other targeted checks that match the scope of the change.
- Run `npm run build` only when it is actually warranted, such as before a final handoff for substantial framework-level changes, when touching config or build behavior, when changing routing or server rendering behavior, or when the user explicitly asks for a full production verification.
- If no meaningful verification is run, say that clearly in the final update instead of silently skipping it.
