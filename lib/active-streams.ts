/**
 * 进程内的 active-stream 注册表。支撑 resume：
 *
 * - POST /api/chat 开流时 register(chatId) → 把 AI SDK 的 SSE 流 tee 一份塞进 buffer
 * - GET /api/chat/[chatId]/stream → subscribe(chatId) 返回一个 ReadableStream：
 *   先 replay 已累积的 chunks，再跟随后续 live chunks；流结束就 close
 * - onFinish 一触发就 cleanup(chatId)，下次 subscribe 直接返回 null
 *
 * 作用域：**进程内**。多实例部署（Vercel / 多 worker）需要 Redis pub/sub 才能跨进程，
 * 见 `resumable-stream` npm 包。本仓库是本地单进程 dev，Map 够用。
 */

type StreamEntry = {
  chunks: Uint8Array[];
  ended: boolean;
  error: Error | null;
  listeners: Set<() => void>;
};

const registry = new Map<string, StreamEntry>();

export function register(chatId: string): {
  push: (chunk: Uint8Array) => void;
  end: () => void;
  fail: (error: Error) => void;
  cleanup: () => void;
} {
  // 如果同一个 chatId 已有旧 entry（极少见：前一次请求没正常收尾），直接覆盖。
  const entry: StreamEntry = {
    chunks: [],
    ended: false,
    error: null,
    listeners: new Set(),
  };
  registry.set(chatId, entry);

  function notify() {
    for (const listener of entry.listeners) listener();
  }

  return {
    push(chunk) {
      if (entry.ended) return;
      entry.chunks.push(chunk);
      notify();
    },
    end() {
      if (entry.ended) return;
      entry.ended = true;
      notify();
    },
    fail(error) {
      if (entry.ended) return;
      entry.error = error;
      entry.ended = true;
      notify();
    },
    cleanup() {
      registry.delete(chatId);
    },
  };
}

export function subscribe(chatId: string): ReadableStream<Uint8Array> | null {
  const entry = registry.get(chatId);
  if (!entry) return null;

  let closed = false;
  let listener: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = 0;

      listener = () => {
        if (closed) return;
        while (cursor < entry.chunks.length) {
          controller.enqueue(entry.chunks[cursor]);
          cursor++;
        }
        if (entry.error) {
          controller.error(entry.error);
          closed = true;
          return;
        }
        if (entry.ended) {
          controller.close();
          closed = true;
        }
      };

      // 先 replay 已有的 chunks；如果流已结束这一下就 close 了。
      listener();
      if (!closed) entry.listeners.add(listener);
    },
    cancel() {
      closed = true;
      if (listener) entry.listeners.delete(listener);
    },
  });
}
