export type SseSender = (event: unknown) => void;

export interface SseStreamOptions {
  clientSignal?: AbortSignal;
  heartbeatMs?: number;
  onProducerError?: (error: unknown, send: SseSender) => void;
}

const encoder = new TextEncoder();

/**
 * 立即返回可读流，让候选进度在模型请求仍运行时就到达浏览器。
 * 心跳使用 SSE 注释，不进入前端事件状态机，只用于维持长连接与代理刷新。
 */
export function createSseResponse(
  producer: (send: SseSender, signal: AbortSignal) => Promise<void>,
  options: SseStreamOptions = {},
): Response {
  const cancelled = new AbortController();
  const signal = options.clientSignal
    ? AbortSignal.any([options.clientSignal, cancelled.signal])
    : cancelled.signal;
  const heartbeatMs = Math.max(5_000, options.heartbeatMs ?? 12_000);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
          cancelled.abort(new Error("SSE consumer closed"));
        }
      };
      const send: SseSender = (event) => enqueue(`data: ${JSON.stringify(event)}\n\n`);
      const heartbeat = setInterval(() => enqueue(": keep-alive\n\n"), heartbeatMs);

      void producer(send, signal)
        .catch((error) => {
          if (!signal.aborted) options.onProducerError?.(error, send);
        })
        .finally(() => {
          clearInterval(heartbeat);
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // 消费端已经结束时无需再次处理。
          }
        });
    },
    cancel(reason) {
      cancelled.abort(reason ?? new Error("SSE consumer cancelled"));
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
