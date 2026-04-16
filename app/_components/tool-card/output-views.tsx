/**
 * 工具执行完成后（output-available / output-error）展示的"结果视图"。
 * 每个已知工具写一个专门的渲染器，摆脱 `JSON.stringify` 把字符串里 `\n`
 * 转义成 `\\n` 的问题；未知工具落回通用 JSON 兜底。
 *
 * `summarizeToolOutput` 给 ToolPartCard 的折叠 summary 那一行使用。
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

/**
 * 把工具执行结果压成一行摘要，显示在 `<details>` 的 summary 条上。
 */
export function summarizeToolOutput(toolName: string, output: unknown): string {
  if (!output || typeof output !== "object") {
    return "";
  }

  const o = output as Record<string, unknown>;

  if (toolName === "read_file") {
    const p = typeof o.path === "string" ? o.path : "?";
    const chars =
      typeof o.totalChars === "number"
        ? ` · ${o.totalChars.toLocaleString()} chars`
        : "";
    const truncated = o.truncated === true ? " · truncated" : "";
    return `${p}${chars}${truncated}`;
  }

  if (toolName === "list_files") {
    const rel = typeof o.relativePath === "string" ? o.relativePath : ".";
    const count = Array.isArray(o.entries) ? ` · ${o.entries.length} entries` : "";
    return `${rel}${count}`;
  }

  if (toolName === "search_code") {
    const q = typeof o.query === "string" ? `"${o.query}"` : "?";
    const matches = Array.isArray(o.matches) ? ` · ${o.matches.length} matches` : "";
    return `${q}${matches}`;
  }

  if (toolName === "write_file") {
    const p = typeof o.path === "string" ? o.path : "?";
    const op = typeof o.operation === "string" ? o.operation : "wrote";
    const lines = typeof o.lines === "number" ? ` · ${o.lines}L` : "";
    return `${p} · ${op}${lines}`;
  }

  if (toolName === "edit_file") {
    if (o.ok === false && typeof o.error === "string") {
      return o.error.slice(0, 80);
    }
    const p = typeof o.path === "string" ? o.path : "?";
    const added = typeof o.addedLines === "number" ? o.addedLines : 0;
    const removed = typeof o.removedLines === "number" ? o.removedLines : 0;
    const reps = typeof o.replacements === "number" ? ` ×${o.replacements}` : "";
    return `${p} · +${added} −${removed}${reps}`;
  }

  if (toolName === "explore_workspace") {
    if (o.ok === false && typeof o.error === "string") {
      return o.error.slice(0, 80);
    }
    const steps = typeof o.stepsUsed === "number" ? `${o.stepsUsed} steps` : "";
    const files = Array.isArray(o.filesExamined)
      ? `${o.filesExamined.length} files`
      : "";
    return [steps, files].filter(Boolean).join(" · ");
  }

  return "";
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

function ListFilesOutputView({
  output,
}: {
  output: {
    relativePath?: string;
    entries?: Array<{ path?: string; type?: string; size?: number | null }>;
  };
}) {
  const entries = Array.isArray(output.entries) ? output.entries : [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
        <span className="font-medium text-slate-800">
          {output.relativePath || "."}
        </span>
        <span>· {entries.length} entries</span>
      </div>
      <ul className="max-h-80 divide-y divide-slate-100 overflow-auto bg-white font-mono text-[12px]">
        {entries.map((entry, idx) => {
          const isDir = entry.type === "directory";
          return (
            <li
              key={`${entry.path ?? idx}-${idx}`}
              className="flex items-center gap-3 px-3 py-1.5"
            >
              <span
                className={[
                  "inline-flex w-9 shrink-0 justify-center rounded-sm border px-1 text-[10px] uppercase tracking-[0.14em]",
                  isDir
                    ? "border-sky-400 bg-sky-50 text-sky-700"
                    : "border-slate-300 bg-white text-slate-600",
                ].join(" ")}
              >
                {isDir ? "dir" : "file"}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-800">
                {entry.path ?? "?"}
              </span>
              <span className="shrink-0 text-slate-500">
                {isDir ? "" : formatBytes(entry.size ?? undefined)}
              </span>
            </li>
          );
        })}
        {entries.length === 0 && (
          <li className="px-3 py-2 text-slate-500">(no entries)</li>
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
    ok?: boolean;
    error?: string;
    path?: string;
    operation?: string;
    bytesWritten?: number;
    lines?: number;
    previousLines?: number;
  };
}) {
  if (output.ok === false) {
    return (
      <div className="px-3 py-2.5 font-mono text-[12px] leading-6 text-rose-800">
        {output.error ?? "write failed"}
      </div>
    );
  }
  const op = output.operation ?? "wrote";
  return (
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
  );
}

function EditResultView({
  output,
}: {
  output: {
    ok?: boolean;
    error?: string;
    occurrences?: number;
    path?: string;
    replacements?: number;
    startLine?: number;
    addedLines?: number;
    removedLines?: number;
  };
}) {
  if (output.ok === false) {
    return (
      <div className="px-3 py-2.5 font-mono text-[12px] leading-6 text-rose-800">
        {output.error ?? "edit failed"}
        {typeof output.occurrences === "number" && (
          <span className="ml-2 text-rose-600">
            (occurrences: {output.occurrences})
          </span>
        )}
      </div>
    );
  }
  const added = output.addedLines ?? 0;
  const removed = output.removedLines ?? 0;
  return (
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
  );
}

function ExploreWorkspaceOutputView({
  output,
}: {
  output: {
    ok?: boolean;
    error?: string;
    summary?: string;
    filesExamined?: string[];
    stepsUsed?: number;
  };
}) {
  if (output.ok === false) {
    return (
      <div className="px-3 py-2.5 font-mono text-[12px] leading-6 text-rose-800">
        {output.error ?? "explorer failed"}
      </div>
    );
  }

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

/**
 * 工具执行结果的分发器：按工具名挑一个最合适的视图渲染。
 */
export function renderToolOutput(
  toolName: string,
  output: unknown,
): React.ReactNode {
  const o = (output ?? {}) as Record<string, unknown>;

  if (toolName === "read_file") {
    return <ReadFileOutputView output={o} />;
  }
  if (toolName === "list_files") {
    return <ListFilesOutputView output={o} />;
  }
  if (toolName === "search_code") {
    return <SearchCodeOutputView output={o} />;
  }
  if (toolName === "write_file") {
    return <WriteResultView output={o} />;
  }
  if (toolName === "edit_file") {
    return <EditResultView output={o} />;
  }
  if (toolName === "explore_workspace") {
    return <ExploreWorkspaceOutputView output={o} />;
  }

  // 未知工具走兜底 JSON 显示。
  return (
    <pre className="max-h-64 overflow-auto bg-white p-3 font-mono text-[11px] leading-5 text-slate-700">
      {JSON.stringify(output ?? {}, null, 2)}
    </pre>
  );
}
