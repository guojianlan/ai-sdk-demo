/**
 * Assistant text 里的 XML 块解析。
 *
 * 设计：codex 的两类标签语义模式（block-level finalization 卡 + inline-hidden 引用）
 * 在我们项目里映射成几个特殊渲染卡。这里集中维护"哪些标签 → 哪种 segment kind"
 * 的映射，让 MessageBubble 用一个 splitOnBlocks 一把梭，避免 splitOnProposedPlan
 * + splitOnImplementationSummary + … 一连串嵌套调用。
 *
 * 当前支持的块（都是 block-level finalization 模式，不嵌套）：
 *   <proposed_plan>...</proposed_plan>          —— plan mode 收尾的方案卡（紫）
 *   <implementation_summary>...</implementation_summary> —— default mode 多文件改动收尾的总结卡（绿）
 *
 * 未来扩展（按 ROI 排）：
 *   <oai-mem-citation>...</oai-mem-citation>    —— Feature A memory 落地后接入
 *   <error_diagnosis>...</error_diagnosis>      —— bug 排查模式（中 ROI）
 */

export type BlockKind = "proposed_plan" | "implementation_summary";

export type AssistantSegment =
  | { kind: "text"; content: string }
  | { kind: BlockKind; content: string };

/**
 * 主入口：把 assistant text 切成 [text, block, text, block, …]。
 *
 * 健壮性：
 * - 没匹配到任何块 → 返回 [{ kind: "text", content: text }]
 * - 流式中只到了开标签、闭标签还在路上 → 当前 chunk 里发现未闭合的开标签：
 *   **把开标签和后面的内容都隐藏掉**（不渲染成生 XML），等闭标签到了下一次
 *   重渲染才切成 block 段。否则用户会短暂看到 `<proposed_plan>` 这串裸标签。
 * - 不支持嵌套（codex 也不支持）
 * - 标签内外空白 trim 掉，避免渲染时多余空行
 */
export function splitOnBlocks(text: string): AssistantSegment[] {
  // 单个组合正则：`<(tag1|tag2)>(content)</\1>`，反向引用 \1 保证开闭标签对齐
  const regex =
    /<(proposed_plan|implementation_summary)>([\s\S]*?)<\/\1>/g;
  const out: AssistantSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) {
      const before = text.slice(last, m.index).trim();
      if (before) out.push({ kind: "text", content: before });
    }
    const tag = m[1] as BlockKind;
    const inner = m[2].trim();
    if (inner) out.push({ kind: tag, content: inner });
    last = m.index + m[0].length;
  }

  // 处理 tail：可能含未闭合的开标签（流式中）。如果有，把开标签前的"干净文本"
  // 当 text 段输出，标签开始之后的全部内容（含开标签自身）丢弃不渲染——等闭标签
  // 到了下一次重渲染时 regex 会匹配整对然后切成卡。
  const tail = text.slice(last);
  if (tail.length > 0) {
    const unclosedMatch = tail.match(
      /<(proposed_plan|implementation_summary)>/,
    );
    if (unclosedMatch && unclosedMatch.index !== undefined) {
      const beforeOpenTag = tail.slice(0, unclosedMatch.index).trim();
      if (beforeOpenTag) out.push({ kind: "text", content: beforeOpenTag });
      // 故意不输出未闭合的标签部分 —— 等闭合到了再渲染
    } else {
      const trimmed = tail.trim();
      if (trimmed) out.push({ kind: "text", content: trimmed });
    }
  }

  if (out.length === 0) {
    return [{ kind: "text", content: text }];
  }
  return out;
}
