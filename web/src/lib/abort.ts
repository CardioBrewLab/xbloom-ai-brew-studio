/**
 * AbortSignal.any / AbortSignal.timeout are absent from some older mobile WebViews.
 * Keep request cancellation predictable by composing signals with plain AbortController.
 */
export function createAbortScope(
  signals: Array<AbortSignal | null | undefined>,
  timeoutMs?: number,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timeoutReached = false;
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));

  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const listeners = activeSignals.map((signal) => {
    const listener = (): void => abortFrom(signal);
    if (signal.aborted) abortFrom(signal);
    else signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });

  if (timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timeoutReached = true;
      const reason = new Error(`request timeout after ${timeoutMs}ms`);
      reason.name = "TimeoutError";
      if (!controller.signal.aborted) controller.abort(reason);
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      listeners.forEach(({ signal, listener }) => signal.removeEventListener("abort", listener));
    },
  };
}
