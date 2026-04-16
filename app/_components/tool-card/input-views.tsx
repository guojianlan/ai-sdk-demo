/**
 * 工具调用发起时（approval-requested / input-available 等状态）显示给用户看的"输入预览"。
 * 专门给两个写入工具（write_file / edit_file）做了定制视图：
 * - write_file：整文件预览 + 行数 + 字节数
 * - edit_file：红绿双栏 diff
 * 其它工具走通用 JSON 兜底。
 */

function previewText(value: string, maxLines = 12, maxChars = 600) {
  const lines = value.split("\n");
  const trimmed = lines.slice(0, maxLines).join("\n");
  const display =
    trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
  const truncated = lines.length > maxLines || trimmed.length > maxChars;

  return { display, truncated, totalLines: lines.length };
}

function WriteFileCard({
  input,
  state,
}: {
  input: { relativePath?: string; content?: string; reason?: string };
  state: "pending" | "approved";
}) {
  const content = input.content ?? "";
  const { display, truncated, totalLines } = previewText(content);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-sm border border-slate-300 bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-700">
          write_file
        </span>
        <span className="font-mono text-[12px] text-slate-700">
          {input.relativePath ?? "(missing path)"}
        </span>
        <span className="font-mono text-[11px] text-slate-500">
          · {totalLines} lines · {new TextEncoder().encode(content).byteLength} B
        </span>
      </div>
      {input.reason && (
        <div className="border-l-2 border-slate-200 pl-3 text-[13px] leading-6 text-slate-600">
          {input.reason}
        </div>
      )}
      <pre
        className={[
          "max-h-64 overflow-auto rounded-sm border bg-slate-50 p-3 font-mono text-[12px] leading-6 text-slate-800",
          state === "pending" ? "border-sky-300" : "border-slate-200",
        ].join(" ")}
      >
        {display || "(empty file)"}
        {truncated && (
          <span className="mt-2 block font-mono text-[11px] text-slate-500">
            …({totalLines - display.split("\n").length} more lines hidden)
          </span>
        )}
      </pre>
    </div>
  );
}

function EditFileCard({
  input,
  state,
}: {
  input: {
    relativePath?: string;
    oldString?: string;
    newString?: string;
    replaceAll?: boolean;
    reason?: string;
  };
  state: "pending" | "approved";
}) {
  const oldStr = input.oldString ?? "";
  const newStr = input.newString ?? "";
  const oldPreview = previewText(oldStr);
  const newPreview = previewText(newStr);
  const borderPending = state === "pending" ? "border-sky-300" : "border-slate-200";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-sm border border-slate-300 bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-700">
          edit_file
        </span>
        <span className="font-mono text-[12px] text-slate-700">
          {input.relativePath ?? "(missing path)"}
        </span>
        {input.replaceAll && (
          <span className="inline-flex items-center rounded-sm border border-amber-400 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-amber-700">
            replaceAll
          </span>
        )}
      </div>
      {input.reason && (
        <div className="border-l-2 border-slate-200 pl-3 text-[13px] leading-6 text-slate-600">
          {input.reason}
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-rose-600">
              − old
            </span>
            <span className="h-px flex-1 bg-rose-200" />
          </div>
          <pre
            className={`max-h-48 overflow-auto rounded-sm border ${borderPending} bg-rose-50/60 p-2.5 font-mono text-[12px] leading-6 text-rose-900`}
          >
            {oldPreview.display}
            {oldPreview.truncated && (
              <span className="mt-1 block text-[11px] text-rose-600/70">…</span>
            )}
          </pre>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-700">
              + new
            </span>
            <span className="h-px flex-1 bg-emerald-200" />
          </div>
          <pre
            className={`max-h-48 overflow-auto rounded-sm border ${borderPending} bg-emerald-50/60 p-2.5 font-mono text-[12px] leading-6 text-emerald-900`}
          >
            {newPreview.display || "(empty)"}
            {newPreview.truncated && (
              <span className="mt-1 block text-[11px] text-emerald-700/70">
                …
              </span>
            )}
          </pre>
        </div>
      </div>
    </div>
  );
}

function GenericToolCard({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) {
  return (
    <div className="space-y-2">
      <span className="inline-flex items-center rounded-sm border border-slate-300 bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-700">
        {toolName}
      </span>
      <pre className="max-h-48 overflow-auto rounded-sm border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] leading-5 text-slate-700">
        {JSON.stringify(input ?? {}, null, 2)}
      </pre>
    </div>
  );
}

/**
 * 工具输入预览的分发器：按工具名挑一个最合适的视图渲染。
 */
export function renderToolInput(
  toolName: string,
  input: unknown,
  state: "pending" | "approved",
) {
  if (toolName === "write_file") {
    return (
      <WriteFileCard
        input={(input ?? {}) as Parameters<typeof WriteFileCard>[0]["input"]}
        state={state}
      />
    );
  }

  if (toolName === "edit_file") {
    return (
      <EditFileCard
        input={(input ?? {}) as Parameters<typeof EditFileCard>[0]["input"]}
        state={state}
      />
    );
  }

  return <GenericToolCard toolName={toolName} input={input} />;
}
