import type { InferUIMessageChunk, UIMessage } from "ai";

export type ChatUIMessageChunk = InferUIMessageChunk<UIMessage>;

export type ActiveChatRunStatus =
  | "running"
  | "finished"
  | "failed"
  | "cancelled";

type Subscriber = ReadableStreamDefaultController<ChatUIMessageChunk>;

type ActiveChatRun = {
  id: string;
  chatId: string;
  controller: AbortController;
  status: ActiveChatRunStatus;
  buffer: ChatUIMessageChunk[];
  subscribers: Set<Subscriber>;
  error: unknown;
  createdAt: number;
  updatedAt: number;
};

const GLOBAL_KEY = "__local_agent_active_chat_runs__";
type GlobalWithRuns = typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, ActiveChatRun>;
};

function getRuns(): Map<string, ActiveChatRun> {
  const g = globalThis as GlobalWithRuns;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map();
  }
  return g[GLOBAL_KEY];
}

export function registerActiveChatRun(params: {
  id: string;
  chatId: string;
  controller: AbortController;
  source: ReadableStream<ChatUIMessageChunk>;
}): ActiveChatRun {
  const run: ActiveChatRun = {
    id: params.id,
    chatId: params.chatId,
    controller: params.controller,
    status: "running",
    buffer: [],
    subscribers: new Set(),
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  getRuns().set(run.id, run);
  void pumpSource(run, params.source);
  return run;
}

export function getActiveChatRun(runId: string): ActiveChatRun | null {
  return getRuns().get(runId) ?? null;
}

export function cancelActiveChatRun(runId: string): boolean {
  const run = getRuns().get(runId);
  if (!run) return false;
  if (run.status === "running") {
    run.status = "cancelled";
    run.updatedAt = Date.now();
  }
  run.controller.abort();
  return true;
}

export function createActiveChatRunReadable(
  run: ActiveChatRun,
): ReadableStream<ChatUIMessageChunk> {
  let subscriber: Subscriber | null = null;

  return new ReadableStream<ChatUIMessageChunk>({
    start(controller) {
      subscriber = controller;

      for (const chunk of run.buffer) {
        controller.enqueue(chunk);
      }

      if (run.status === "finished" || run.status === "cancelled") {
        controller.close();
        return;
      }

      if (run.status === "failed") {
        controller.error(run.error ?? new Error("Chat run failed."));
        return;
      }

      run.subscribers.add(controller);
    },
    cancel() {
      if (subscriber) {
        run.subscribers.delete(subscriber);
      }
    },
  });
}

function publish(run: ActiveChatRun, chunk: ChatUIMessageChunk) {
  run.buffer.push(chunk);
  run.updatedAt = Date.now();
  for (const subscriber of run.subscribers) {
    try {
      subscriber.enqueue(chunk);
    } catch {
      run.subscribers.delete(subscriber);
    }
  }
}

function closeSubscribers(run: ActiveChatRun) {
  for (const subscriber of run.subscribers) {
    try {
      subscriber.close();
    } catch {
      // Connection is already gone.
    }
  }
  run.subscribers.clear();
}

function errorSubscribers(run: ActiveChatRun, error: unknown) {
  for (const subscriber of run.subscribers) {
    try {
      subscriber.error(error);
    } catch {
      // Connection is already gone.
    }
  }
  run.subscribers.clear();
}

async function pumpSource(
  run: ActiveChatRun,
  source: ReadableStream<ChatUIMessageChunk>,
) {
  try {
    const reader = source.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      publish(run, value);
    }
    if (run.status === "running") {
      run.status = "finished";
    }
    run.updatedAt = Date.now();
    closeSubscribers(run);
  } catch (error) {
    if (run.status === "cancelled") {
      closeSubscribers(run);
    } else {
      run.status = "failed";
      run.error = error;
      run.updatedAt = Date.now();
      errorSubscribers(run, error);
    }
  } finally {
    setTimeout(() => {
      const current = getRuns().get(run.id);
      if (current === run && current.status !== "running") {
        getRuns().delete(run.id);
      }
    }, 5 * 60 * 1000);
  }
}
