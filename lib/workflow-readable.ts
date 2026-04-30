export function createCancelableReadableStream<T>(
  source: ReadableStream<T>,
  onCancel?: () => void | Promise<void>,
): ReadableStream<T> {
  const reader = source.getReader();

  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await Promise.allSettled([reader.cancel(reason), onCancel?.()]);
    },
  });
}

export function dropReasoningChunks<T extends { type?: string }>(
  source: ReadableStream<T>,
): ReadableStream<T> {
  return source.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        if (
          chunk.type === "reasoning-start" ||
          chunk.type === "reasoning-delta" ||
          chunk.type === "reasoning-end"
        ) {
          return;
        }

        controller.enqueue(chunk);
      },
    }),
  );
}

export function orderStatefulUIMessageChunks<
  T extends { id?: string; toolCallId?: string; type?: string },
>(source: ReadableStream<T>): ReadableStream<T> {
  const startedText = new Set<string>();
  const startedReasoning = new Set<string>();
  const startedToolInputs = new Set<string>();
  const pendingText = new Map<string, T[]>();
  const pendingReasoning = new Map<string, T[]>();
  const pendingToolInputs = new Map<string, T[]>();

  function flushPending(
    controller: TransformStreamDefaultController<T>,
    pending: Map<string, T[]>,
    key: string,
  ) {
    const chunks = pending.get(key);
    if (!chunks) return;
    pending.delete(key);
    for (const chunk of chunks) {
      controller.enqueue(chunk);
    }
  }

  function bufferPending(
    pending: Map<string, T[]>,
    key: string,
    chunk: T,
  ) {
    const chunks = pending.get(key);
    if (chunks) {
      chunks.push(chunk);
      return;
    }
    pending.set(key, [chunk]);
  }

  return source.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        if (chunk.type === "text-start" && chunk.id) {
          startedText.add(chunk.id);
          controller.enqueue(chunk);
          flushPending(controller, pendingText, chunk.id);
          return;
        }

        if (
          (chunk.type === "text-delta" || chunk.type === "text-end") &&
          chunk.id &&
          !startedText.has(chunk.id)
        ) {
          bufferPending(pendingText, chunk.id, chunk);
          return;
        }

        if (chunk.type === "text-end" && chunk.id) {
          startedText.delete(chunk.id);
        }

        if (chunk.type === "reasoning-start" && chunk.id) {
          startedReasoning.add(chunk.id);
          controller.enqueue(chunk);
          flushPending(controller, pendingReasoning, chunk.id);
          return;
        }

        if (
          (chunk.type === "reasoning-delta" ||
            chunk.type === "reasoning-end") &&
          chunk.id &&
          !startedReasoning.has(chunk.id)
        ) {
          bufferPending(pendingReasoning, chunk.id, chunk);
          return;
        }

        if (chunk.type === "reasoning-end" && chunk.id) {
          startedReasoning.delete(chunk.id);
        }

        if (chunk.type === "tool-input-start" && chunk.toolCallId) {
          startedToolInputs.add(chunk.toolCallId);
          controller.enqueue(chunk);
          flushPending(controller, pendingToolInputs, chunk.toolCallId);
          return;
        }

        if (
          chunk.type === "tool-input-delta" &&
          chunk.toolCallId &&
          !startedToolInputs.has(chunk.toolCallId)
        ) {
          bufferPending(pendingToolInputs, chunk.toolCallId, chunk);
          return;
        }

        controller.enqueue(chunk);
      },
    }),
  );
}
