export class BlockScanPassDeadlineError extends Error {
  constructor(readonly stage: string) {
    super(`block-scan ${stage} exceeded the absolute pass deadline`);
    this.name = "BlockScanPassDeadlineError";
  }
}

/**
 * Hard wall-clock fence for non-cooperative stage promises. Late settlement
 * is ignored. A stateful worker supplies onTerminate to synchronously begin
 * reaping on either deadline expiry or caller cancellation.
 */
export function awaitBlockScanDeadline<T>(
  promise: Promise<T>,
  deadlineAtMs: number,
  stage: string,
  onTerminate?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    onTerminate?.();
    void promise.catch(() => {});
    return Promise.reject(
      signal.reason ?? new Error(`block-scan ${stage} aborted`),
    );
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    onTerminate?.();
    void promise.catch(() => {});
    return Promise.reject(new BlockScanPassDeadlineError(stage));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      run();
    };
    const terminate = (error: unknown): void => {
      finish(() => {
        try {
          onTerminate?.();
        } finally {
          reject(error);
        }
      });
    };
    const abort = (): void =>
      terminate(signal?.reason ?? new Error(`block-scan ${stage} aborted`));
    const timer = setTimeout(() => {
      terminate(new BlockScanPassDeadlineError(stage));
    }, remainingMs);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) abort();
  });
}
