/**
 * Middle-truncate helper —— 移植自 codex 的 `truncate_middle_chars`
 * (`codex-rs/utils/string/src/truncate.rs:7-9 + 38-69`)，行为对齐：
 *
 *   - text 长度 ≤ maxBytes：原样返回
 *   - 否则：保留头 (~ maxBytes/2 字节) + tail (~ maxBytes/2 字节)，中间换成
 *     `[... N bytes omitted ...]` 标记
 *   - UTF-8 边界安全 —— 不会切成半个 code point
 *
 * 为什么 middle 而不是 head：
 *   - tool output 的"任务结论"通常在尾部（如 `find` 最后一行、shell 命令的
 *     exit summary），head-only 截断会把这些信息丢掉
 *   - codex 的取舍：宁可让 agent 看到"中间被剪掉了"的明确提示，也比让它
 *     基于"看上去完整的截断头部"做错误推理强
 *
 * 默认上限 `DEFAULT_TRUNCATE_BYTES = 10_000` 对齐 codex 生产值
 * (`codex-rs/protocol/src/openai_models.rs:579` —— `Bytes(10_000)`)。
 */

export const DEFAULT_TRUNCATE_BYTES = 10_000;

/**
 * 截断字符串到 `maxBytes` 字节预算，保留头+尾，中间替换成 omitted 标记。
 *
 * @param text     待截断的字符串
 * @param maxBytes 预算字节数（按 UTF-8 编码计算）；≤ 0 时全部丢弃只留标记
 * @returns        截断后的字符串；未触发截断时是同一个 string 引用
 */
export function truncateMiddle(text: string, maxBytes: number): string {
  if (text.length === 0) return text;

  // 走字符长度近似 byte 长度——对全 ASCII 串完全一致，对含 CJK 的串会**保守**
  // 截到更短（因为 1 CJK = 3 bytes）。完全准确的字节切分需要 Buffer，但工具
  // 输出基本是 ASCII（日志、命令输出），字符近似已经够用且不依赖 Node.Buffer。
  const byteLen = Buffer.byteLength(text, "utf-8");
  if (byteLen <= maxBytes) return text;

  if (maxBytes <= 0) {
    return `[... ${byteLen} bytes omitted ...]`;
  }

  // head + tail 各占一半预算，给标记本身留 ~64 字节空间
  const markerReserve = 64;
  const usable = Math.max(0, maxBytes - markerReserve);
  const headBudget = Math.floor(usable / 2);
  const tailBudget = usable - headBudget;

  const head = sliceByByteBudget(text, headBudget, /*fromStart*/ true);
  const tail = sliceByByteBudget(text, tailBudget, /*fromStart*/ false);

  const omitted =
    byteLen - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8");

  return `${head}\n\n[... ${omitted} bytes omitted ...]\n\n${tail}`;
}

/**
 * 从头部 / 尾部按字节预算切片，保证停在 UTF-8 code point 边界上。
 *
 * 实现走字符迭代而不是直接 Buffer slice 是因为：JS string 的 `slice(idx)`
 * 用 UTF-16 code unit 索引，对包含 surrogate pair 的 emoji / 罕见字也不安全；
 * 字符迭代天然按 code point 走，配上对每个 code point 的 utf-8 字节数估算
 * 就能停在合法边界。
 */
function sliceByByteBudget(text: string, byteBudget: number, fromStart: boolean): string {
  if (byteBudget <= 0) return "";

  let consumed = 0;
  const chars: string[] = [];
  const iter = fromStart ? text : reverseString(text);

  for (const ch of iter) {
    const chBytes = Buffer.byteLength(ch, "utf-8");
    if (consumed + chBytes > byteBudget) break;
    consumed += chBytes;
    chars.push(ch);
  }

  return fromStart ? chars.join("") : reverseString(chars.join(""));
}

/**
 * 按 code point 反转字符串。`[...s]` 解构会正确分出 surrogate pair，比
 * `s.split('').reverse().join('')` 安全。
 */
function reverseString(s: string): string {
  return [...s].reverse().join("");
}

/**
 * Workflow queue 物理硬墙（1.5 MiB）的传输层兜底：把每个 tool-like part 的
 * `input` / `output` 里的字符串字段截到 `maxBytesPerString`，结构保留。
 *
 * 跟 `truncateMiddle` 的区别：那个是单串的截断算法；这里是消息树的递归套用。
 *
 * 为什么要这层：
 *   - 写入层截断（shell.ts / workspaces.ts 用 truncateMiddle）只覆盖**新产生**
 *     的 tool 输出；DB 里**已存盘**的旧消息（pre-truncation 时代留下的大块
 *     stdout / file content）会被原样回灌进 workflow input
 *   - P4-b compaction 走 LLM 调用，输入本身就大时它自己会超时/失败 → fallback
 *     "continuing without compaction" → 原样灌进 `start(runAgentWorkflow, ...)`
 *     → 序列化 > 1.5 MiB → world-local 队列报
 *     `SyntaxError: Unterminated string in JSON at position 1572864`
 *
 * 所以在 `start()` 前再过一道**不依赖 LLM 的硬截断**，保证 workflow 入参永远进
 * 得了队列。Agent 看到 `[... N bytes omitted ...]` 标记会知道有内容丢失。
 */
const TOOL_PART_FIELDS = ["input", "output"] as const;

export function truncateToolPartsForTransport<T>(
  messages: ReadonlyArray<T>,
  maxBytesPerString: number,
): T[] {
  return messages.map((message) => {
    if (!isPlainObject(message)) return message;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return message;

    const newParts = parts.map((part) => {
      if (!isPlainObject(part)) return part;
      const typeValue = (part as { type?: unknown }).type;
      if (typeof typeValue !== "string") return part;
      if (!typeValue.startsWith("tool-") && typeValue !== "dynamic-tool") {
        return part;
      }

      const next: Record<string, unknown> = { ...(part as Record<string, unknown>) };
      for (const key of TOOL_PART_FIELDS) {
        if (key in next) {
          next[key] = truncateStringsInValue(next[key], maxBytesPerString);
        }
      }
      return next;
    });

    return { ...(message as Record<string, unknown>), parts: newParts } as T;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateStringsInValue(value: unknown, maxBytes: number): unknown {
  if (typeof value === "string") {
    return truncateMiddle(value, maxBytes);
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateStringsInValue(item, maxBytes));
  }
  if (isPlainObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = truncateStringsInValue(v, maxBytes);
    }
    return next;
  }
  return value;
}
