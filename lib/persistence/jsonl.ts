import { promises as fs } from "node:fs";
import path from "node:path";

import type { UIMessage } from "ai";

/**
 * JSONL 行格式 —— 借 codex `RolloutLine` 的形状（timestamp + tagged union）。
 *
 * 每行是一个独立 JSON 对象，换行分隔。append-only。
 * 三种 type 起手；将来要加 compaction / turn_context 之类的事件可以平滑扩展，
 * 老 reader 把不认识的 type 忽略掉即可。
 *
 * - `session_meta`：每个文件第一行，元数据（thread id / cwd / model / created_at）
 * - `message`：payload 直接是 AI SDK 的 `UIMessage`（含 role + parts，含 tool calls）
 *              这样恢复 = `setMessages(lines.filter(type==='message').map(payload))`，零变换
 * - `event`：预留事件流（沙箱 violation / compaction / 错误）；当前不写但 reader 兼容
 */

export type SessionMetaPayload = {
  threadId: string;
  workspaceRoot: string;
  workspaceName?: string;
  model?: string;
  createdAt: number;
};

export type SessionLine =
  | { timestamp: string; type: "session_meta"; payload: SessionMetaPayload }
  | { timestamp: string; type: "message"; payload: UIMessage }
  | { timestamp: string; type: "event"; payload: Record<string, unknown> };

/**
 * 追加一行到 jsonl。父目录可能还不存在（YYYY/MM/DD 嵌套）——用 mkdir recursive 兜底。
 *
 * 注意：append 是 fs 原子操作（O_APPEND）的近似——单次写小于 PIPE_BUF (4KB) 时
 * 多进程并发追加不会互相穿插。会话行通常远超 4KB（含 tool result 内容），所以
 * 这里假设单进程写。Next.js 单 server 进程 + 同会话不并发请求，符合实际。
 */
export async function appendJsonlLine(
  filePath: string,
  line: SessionLine,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, "utf-8");
}

/**
 * 批量追加多行 —— 一次 mkdir + 一次 appendFile，避免 N 次 fs syscall。
 * 用于 saveMessages 镜像场景：每步可能要写 5~20 条 message 行，单调用一次 appendFile
 * 比循环 appendFile 快一个数量级（一次 stat+write+close vs N 次）。
 */
export async function appendJsonlLines(
  filePath: string,
  lines: SessionLine[],
): Promise<void> {
  if (lines.length === 0) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  await fs.appendFile(filePath, payload, "utf-8");
}

/**
 * 读出整个 jsonl 文件并解析。
 * 文件不存在 → 返回空数组（按"新会话还没写过"处理，调用方拿 thread 元数据决定）。
 * 单行解析失败 → 跳过该行 + console.warn，避免一行坏字节让整个会话不可读。
 */
export async function readJsonl(filePath: string): Promise<SessionLine[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const lines: SessionLine[] = [];
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as SessionLine);
    } catch (error) {
      console.warn(
        `[jsonl] skipped malformed line in ${filePath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return lines;
}
