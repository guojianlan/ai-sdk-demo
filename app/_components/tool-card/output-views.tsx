/**
 * 工具执行完成后（output-available / output-error）展示的"结果视图"。
 * 每个已知工具写一个专门的渲染器，摆脱 `JSON.stringify` 把字符串里 `\n`
 * 转义成 `\\n` 的问题；未知工具落回通用 JSON 兜底。
 *
 * 自家 tool 统一返回 ToolResult<T> = `{ok: true, data: T} | {ok: false, error: string}`；
 * 本文件先做 `unwrapToolResult`，失败走统一的错误视图，成功再分发到每个工具的 view。
 *
 * `summarizeToolOutput` 给 ToolPartCard 的折叠 summary 那一行使用，
 * 自家 tool 从 `.data` 里取字段。MCP / 未知 tool 没有这一层 wrapper，直接读顶层。
 */

function formatBytes(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return "—";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type UnwrapResult =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "err"; error: string }
  | { kind: "raw"; raw: Record<string, unknown> };

/**
 * 把 tool output 解成 ok/err/raw 三态：
 * - ok：自家 tool 成功返回（带 data）
 * - err：自家 tool 失败返回（带 error 字符串）
 * - raw：MCP / 未知 tool 返回的裸对象，交给兜底 renderer
 */
function unwrapToolResult(output: unknown): UnwrapResult {
  if (!output || typeof output !== "object") {
    return { kind: "raw", raw: {} };
  }

  const o = output as Record<string, unknown>;

  if (o.ok === true && "data" in o && typeof o.data === "object" && o.data !== null) {
    return { kind: "ok", data: o.data as Record<string, unknown> };
  }

  if (o.ok === false && typeof o.error === "string") {
    return { kind: "err", error: o.error };
  }

  return { kind: "raw", raw: o };
}

function truncateForSummary(text: string, max = 80): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 把工具执行结果压成一行摘要，显示在 `<details>` 的 summary 条上。
 */
export function summarizeToolOutput(toolName: string, output: unknown): string {
  const unwrapped = unwrapToolResult(output);

  if (unwrapped.kind === "err") {
    return truncateForSummary(unwrapped.error);
  }

  const o = unwrapped.kind === "ok" ? unwrapped.data : unwrapped.raw;

  if (toolName === "read") {
    const p = typeof o.path === "string" ? o.path : "?";
    const chars =
      typeof o.totalChars === "number"
        ? ` · ${o.totalChars.toLocaleString()} chars`
        : "";
    const truncated = o.truncated === true ? " · truncated" : "";
    return `${p}${chars}${truncated}`;
  }

  if (toolName === "glob") {
    const base = typeof o.baseDir === "string" ? o.baseDir : ".";
    const count = typeof o.count === "number" ? ` · ${o.count} files` : "";
    return `${base}${count}`;
  }

  if (toolName === "grep") {
    const q = typeof o.query === "string" ? `"${o.query}"` : "?";
    const matches = Array.isArray(o.matches) ? ` · ${o.matches.length} matches` : "";
    return `${q}${matches}`;
  }

  if (toolName === "write") {
    const p = typeof o.path === "string" ? o.path : "?";
    const op = typeof o.operation === "string" ? o.operation : "wrote";
    const lines = typeof o.lines === "number" ? ` · ${o.lines}L` : "";
    return `${p} · ${op}${lines}`;
  }

  if (toolName === "edit") {
    const p = typeof o.path === "string" ? o.path : "?";
    const added = typeof o.addedLines === "number" ? o.addedLines : 0;
    const removed = typeof o.removedLines === "number" ? o.removedLines : 0;
    const reps = typeof o.replacements === "number" ? ` ×${o.replacements}` : "";
    return `${p} · +${added} −${removed}${reps}`;
  }

  if (toolName === "task") {
    const steps = typeof o.stepsUsed === "number" ? `${o.stepsUsed} steps` : "";
    const files = Array.isArray(o.filesExamined)
      ? `${o.filesExamined.length} files`
      : "";
    return [steps, files].filter(Boolean).join(" · ");
  }

  if (toolName === "shell") {
    const exit = typeof o.exitCode === "number" ? `exit ${o.exitCode}` : "";
    const stdoutLen =
      typeof o.stdout === "string" ? `${o.stdout.length} chars stdout` : "";
    const truncated = o.truncated === true ? " · truncated" : "";
    return [exit, stdoutLen].filter(Boolean).join(" · ") + truncated;
  }

  return "";
}

function ToolErrorView({ message }: { message: string }) {
  return (
    <div className="px-3 py-2.5 font-mono text-[12px] leading-6 text-rose-800 whitespace-pre-wrap">
      {message}
    </div>
  );
}

function DiffPreviewPanel({
  diff,
  source,
}: {
  diff?: string;
  source?: string;
}) {
  const lines = typeof diff === "string" && diff.trim() ? diff.split("\n") : [];

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-slate-200">
      <div className="flex items-center gap-2 bg-slate-950 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-200">
          git diff
        </span>
        {source && (
          <span className="rounded-sm border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
            {source}
          </span>
        )}
      </div>
      <pre className="max-h-96 overflow-auto bg-slate-950 px-3 py-2 font-mono text-[12px] leading-6">
        {lines.map((line, idx) => {
          const color =
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-emerald-300"
              : line.startsWith("-") && !line.startsWith("---")
                ? "text-rose-300"
                : line.startsWith("@@")
                  ? "text-sky-300"
                  : line.startsWith("diff ") ||
                      line.startsWith("index ") ||
                      line.startsWith("---") ||
                      line.startsWith("+++")
                    ? "text-slate-400"
                    : "text-slate-200";
          return (
            <span key={`${idx}-${line}`} className={`${color} block whitespace-pre`}>
              {line || " "}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function ReadFileOutputView({
  output,
}: {
  output: {
    path?: string;
    content?: string;
    truncated?: boolean;
    totalChars?: number;
  };
}) {
  const content = output.content ?? "";
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
        <span className="font-medium text-slate-800">{output.path ?? "?"}</span>
        <span>· {output.totalChars?.toLocaleString() ?? "?"} chars</span>
        {output.truncated && (
          <span className="inline-flex items-center rounded-sm border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-amber-700">
            truncated
          </span>
        )}
      </div>
      <pre className="max-h-80 overflow-auto bg-white p-3 font-mono text-[12px] leading-[1.55] text-slate-800">
        {content || "(empty)"}
      </pre>
    </div>
  );
}

function GlobOutputView({
  output,
}: {
  output: {
    pattern?: string;
    baseDir?: string;
    count?: number;
    files?: Array<{ path?: string; size?: number; modifiedAt?: string }>;
  };
}) {
  const files = Array.isArray(output.files) ? output.files : [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
        <span className="font-medium text-slate-800">
          {output.pattern || "(no pattern)"}
        </span>
        <span>· base {output.baseDir || "."}</span>
        <span>· {files.length} files</span>
      </div>
      <ul className="max-h-80 divide-y divide-slate-100 overflow-auto bg-white font-mono text-[12px]">
        {files.map((file, idx) => (
          <li
            key={`${file.path ?? idx}-${idx}`}
            className="flex items-center gap-3 px-3 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-slate-800">
              {file.path ?? "?"}
            </span>
            <span className="shrink-0 text-slate-500">
              {formatBytes(file.size)}
            </span>
          </li>
        ))}
        {files.length === 0 && (
          <li className="px-3 py-2 text-slate-500">(no matches)</li>
        )}
      </ul>
    </div>
  );
}

function SearchCodeOutputView({
  output,
}: {
  output: {
    query?: string;
    matches?: Array<{
      path?: string;
      line?: number;
      column?: number;
      preview?: string;
    }>;
  };
}) {
  const matches = Array.isArray(output.matches) ? output.matches : [];

  // 按 path 分组，便于一眼看出"这个查询命中了哪几个文件"。
  const grouped = new Map<string, typeof matches>();
  for (const m of matches) {
    const key = m.path ?? "?";
    const existing = grouped.get(key) ?? [];
    existing.push(m);
    grouped.set(key, existing);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
        <span className="font-medium text-slate-800">
          &ldquo;{output.query ?? "?"}&rdquo;
        </span>
        <span>· {matches.length} matches</span>
        <span>· {grouped.size} files</span>
      </div>
      <div className="max-h-80 overflow-auto bg-white">
        {[...grouped.entries()].map(([path, rows]) => (
          <div key={path} className="border-b border-slate-100 last:border-b-0">
            <div className="bg-slate-50/60 px-3 py-1.5 font-mono text-[11px] font-medium text-slate-700">
              {path}{" "}
              <span className="font-normal text-slate-500">({rows.length})</span>
            </div>
            <ul className="divide-y divide-slate-100 font-mono text-[12px]">
              {rows.map((m, idx) => (
                <li
                  key={`${m.line}-${m.column}-${idx}`}
                  className="flex gap-3 px-3 py-1.5"
                >
                  <span className="w-16 shrink-0 text-right text-slate-500">
                    {m.line ?? "?"}:{m.column ?? "?"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-800">
                    {m.preview ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {matches.length === 0 && (
          <div className="px-3 py-2 font-mono text-[12px] text-slate-500">
            (no matches)
          </div>
        )}
      </div>
    </div>
  );
}

function WriteResultView({
  output,
}: {
  output: {
    path?: string;
    operation?: string;
    bytesWritten?: number;
    lines?: number;
    previousLines?: number;
    diff?: string;
    diffSource?: string;
  };
}) {
  const op = output.operation ?? "wrote";
  return (
    <div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2.5 font-mono text-[12px] text-slate-700">
        <dt className="text-slate-500">path</dt>
        <dd className="text-slate-900">{output.path ?? "?"}</dd>
        <dt className="text-slate-500">op</dt>
        <dd>{op}</dd>
        <dt className="text-slate-500">lines</dt>
        <dd>
          {output.previousLines ?? 0} → {output.lines ?? 0}
        </dd>
        <dt className="text-slate-500">bytes</dt>
        <dd>{formatBytes(output.bytesWritten)}</dd>
      </dl>
      <DiffPreviewPanel diff={output.diff} source={output.diffSource} />
    </div>
  );
}

function EditResultView({
  output,
}: {
  output: {
    path?: string;
    replacements?: number;
    startLine?: number;
    addedLines?: number;
    removedLines?: number;
    diff?: string;
    diffSource?: string;
  };
}) {
  const added = output.addedLines ?? 0;
  const removed = output.removedLines ?? 0;
  return (
    <div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2.5 font-mono text-[12px] text-slate-700">
        <dt className="text-slate-500">path</dt>
        <dd className="text-slate-900">{output.path ?? "?"}</dd>
        <dt className="text-slate-500">at</dt>
        <dd>line {output.startLine ?? "?"}</dd>
        <dt className="text-slate-500">diff</dt>
        <dd>
          <span className="text-emerald-700">+{added}</span>{" "}
          <span className="text-rose-700">−{removed}</span>
        </dd>
        <dt className="text-slate-500">×</dt>
        <dd>{output.replacements ?? 1}</dd>
      </dl>
      <DiffPreviewPanel diff={output.diff} source={output.diffSource} />
    </div>
  );
}

function ExploreWorkspaceOutputView({
  output,
}: {
  output: {
    summary?: string;
    filesExamined?: string[];
    stepsUsed?: number;
  };
}) {
  const files = Array.isArray(output.filesExamined) ? output.filesExamined : [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
        <span className="font-medium text-slate-800">explorer subagent</span>
        {typeof output.stepsUsed === "number" && (
          <span>· {output.stepsUsed} steps</span>
        )}
        <span>· {files.length} files examined</span>
      </div>
      <div className="border-b border-slate-200 px-3 py-3 text-[13px] leading-7 text-slate-800 whitespace-pre-wrap">
        {output.summary || "(no summary returned)"}
      </div>
      {files.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 bg-slate-50/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-slate-500">
            <span>files examined</span>
            <svg
              viewBox="0 0 24 24"
              className="ml-auto h-3 w-3 shrink-0 transition-transform duration-200 group-open:rotate-90"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </summary>
          <ul className="max-h-48 divide-y divide-slate-100 overflow-auto bg-white font-mono text-[12px]">
            {files.map((file, idx) => (
              <li key={`${file}-${idx}`} className="truncate px-3 py-1.5 text-slate-700">
                {file}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ShellOutputView({
  output,
}: {
  output: {
    command?: string;
    cwd?: string;
    success?: boolean;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
  };
}) {
  const command = output.command ?? "";
  const cwd = output.cwd ?? ".";
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  const exit = output.exitCode;
  const success = output.success !== false;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
        <span
          className={[
            "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em]",
            success
              ? "border-emerald-400 bg-emerald-50 text-emerald-700"
              : "border-rose-400 bg-rose-50 text-rose-700",
          ].join(" ")}
        >
          exit {exit ?? "?"}
        </span>
        <span className="font-medium text-slate-800">cwd · {cwd}</span>
        {output.truncated && (
          <span className="text-amber-700">truncated</span>
        )}
      </div>
      <pre className="overflow-x-auto bg-slate-900 px-3 py-2 font-mono text-[12px] leading-6 text-slate-100">
        $ {command}
      </pre>
      {stdout && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-slate-200 bg-white px-3 py-2 font-mono text-[12px] leading-6 text-slate-800">
          {stdout}
        </pre>
      )}
      {stderr && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-rose-200 bg-rose-50/40 px-3 py-2 font-mono text-[12px] leading-6 text-rose-800">
          {stderr}
        </pre>
      )}
      {!stdout && !stderr && (
        <div className="border-t border-slate-200 px-3 py-2 font-mono text-[11px] text-slate-500">
          (no output)
        </div>
      )}
    </div>
  );
}

function renderKnownOutput(
  toolName: string,
  data: Record<string, unknown>,
): React.ReactNode | null {
  if (toolName === "read") {
    return <ReadFileOutputView output={data} />;
  }
  if (toolName === "glob") {
    return <GlobOutputView output={data} />;
  }
  if (toolName === "grep") {
    return <SearchCodeOutputView output={data} />;
  }
  if (toolName === "shell") {
    return <ShellOutputView output={data} />;
  }
  if (toolName === "write") {
    return <WriteResultView output={data} />;
  }
  if (toolName === "edit") {
    return <EditResultView output={data} />;
  }
  if (toolName === "task") {
    return <ExploreWorkspaceOutputView output={data} />;
  }
  return null;
}

/**
 * 工具执行结果的分发器：
 * 1. unwrap ToolResult — 失败走统一 ErrorView，成功把 data 传下去；
 * 2. 没有 ok 标志的（MCP / 未知 tool）直接按 raw 对象分发 / JSON 兜底。
 */
export function renderToolOutput(
  toolName: string,
  output: unknown,
): React.ReactNode {
  const unwrapped = unwrapToolResult(output);

  if (unwrapped.kind === "err") {
    return <ToolErrorView message={unwrapped.error} />;
  }

  const payload = unwrapped.kind === "ok" ? unwrapped.data : unwrapped.raw;
  const known = renderKnownOutput(toolName, payload);
  if (known) {
    return known;
  }

  return (
    <pre className="max-h-64 overflow-auto bg-white p-3 font-mono text-[11px] leading-5 text-slate-700">
      {JSON.stringify(output ?? {}, null, 2)}
    </pre>
  );
}
