export function createDeadlineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; dispose(): void } {
  const hasTimeout = timeoutMs !== undefined
    && Number.isFinite(timeoutMs)
    && timeoutMs > 0;

  if (parent === undefined && !hasTimeout) {
    return {
      signal: undefined,
      dispose() {},
    };
  }

  const controller = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentListener: (() => void) | undefined;

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (parent !== undefined && parentListener !== undefined) {
      parent.removeEventListener("abort", parentListener);
      parentListener = undefined;
    }
  };

  const abort = (reason?: unknown): void => {
    if (disposed || controller.signal.aborted) return;
    cleanup();
    controller.abort(reason);
  };

  if (parent?.aborted) {
    abort(parent.reason);
    return {
      signal: controller.signal,
      dispose() {},
    };
  }

  if (parent !== undefined) {
    parentListener = () => abort(parent.reason);
    parent.addEventListener("abort", parentListener, { once: true });
  }

  if (hasTimeout) {
    timer = setTimeout(() => abort(), timeoutMs);
  }

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  };
}
