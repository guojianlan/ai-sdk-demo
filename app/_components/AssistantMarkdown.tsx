"use client";

import { memo } from "react";
import { Streamdown, type Components } from "streamdown";

/**
 * Assistant 消息里的 text part 专用 markdown 渲染器。
 *
 * 为什么不用 `@tailwindcss/typography` 的 prose：
 * - 项目 wireframe 美学有具体要求（mono 代码块、1px 边、sky-500 链接色、
 *   浅蓝引用条），prose 的默认样式会覆盖太多，反而要再写一层 override 抵消。
 * - 自己写 Components override 字数比 prose override 还少，可控性更高。
 *
 * 只对 assistant 消息用。User 消息保持纯文本，避免用户不小心打的 `*foo*`
 * 被吃成斜体，或者 code fence 意外生效。
 */

const components: Components = {
  // 段落：沿用 bubble 的字号 + leading，不加额外间距（bubble 外层已经 space-y-3）。
  p: ({ children }) => (
    <p className="text-[15px] leading-7 text-slate-800">{children}</p>
  ),

  // 标题：保持工程感 — 粗一点、深一点、下面一条 1px 分割。
  h1: ({ children }) => (
    <h1 className="mt-2 border-b border-slate-200 pb-1 text-[17px] font-semibold text-slate-900">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 text-[16px] font-semibold text-slate-900">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-1.5 text-[15px] font-semibold text-slate-900">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-1.5 text-[14px] font-semibold text-slate-900">
      {children}
    </h4>
  ),

  // 粗体 / 斜体 / 划线：不搞花样。
  strong: ({ children }) => (
    <strong className="font-semibold text-slate-900">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-slate-800">{children}</em>,
  del: ({ children }) => (
    <del className="text-slate-500 line-through">{children}</del>
  ),

  // 列表：markdown 默认缩进就可以，项目这里把 space-y 收紧。
  ul: ({ children }) => (
    <ul className="list-disc space-y-1 pl-5 text-[15px] leading-7 text-slate-800 marker:text-slate-400">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1 pl-5 text-[15px] leading-7 text-slate-800 marker:text-slate-400">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,

  // 引用：sky-500 accent 色竖条。
  blockquote: ({ children }) => (
    <blockquote className="border-l-[3px] border-sky-400 bg-sky-50/40 px-3 py-1.5 text-[14px] italic leading-7 text-slate-700">
      {children}
    </blockquote>
  ),

  // 链接:项目 accent = sky-500；外链统一 new tab。
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-700 underline decoration-sky-300 underline-offset-2 hover:decoration-sky-600"
    >
      {children}
    </a>
  ),

  inlineCode: ({ children, ...props }) => (
    <code
      className="rounded-sm border border-slate-200 bg-slate-50 px-1 py-[1px] font-mono text-[12.5px] text-slate-800"
      {...props}
    >
      {children}
    </code>
  ),
  code: ({ className, children, ...props }) => (
    <code
      className={[
        "block font-mono text-[12.5px] leading-[1.6] text-slate-800",
        className ?? "",
      ].join(" ")}
      {...props}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
      {children}
    </pre>
  ),

  // 表格：GFM 里来的，给一个简朴的 1px 边表格。
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-slate-50 text-left font-mono text-[11px] uppercase tracking-[0.14em] text-slate-600">
      {children}
    </thead>
  ),
  th: ({ children }) => (
    <th className="border border-slate-200 px-2 py-1.5 font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-slate-200 px-2 py-1.5 text-slate-700">
      {children}
    </td>
  ),

  // hr：轻一点的分割线。
  hr: () => <hr className="my-2 border-slate-200" />,
};

/**
 * 渲染 assistant 的一段 text part。streaming 期间文本会频繁变长，memo 避免
 * 兄弟段落重复 re-parse。
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <div className="space-y-2.5">
      <Streamdown mode="streaming" components={components}>
        {text}
      </Streamdown>
    </div>
  );
});
