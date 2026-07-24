export class BlockScanPassDeadlineError extends Error {
  constructor(readonly stage: string) {
    super(`block-scan ${stage} exceeded the absolute pass deadline`);
    this.name = "BlockScanPassDeadlineError";
  }
}

/**
 * Hard wall-clock fence for non-cooperative stage promises. Late settlement
 * is ignored. A stateful worker supplies onTimeout to synchronously begin
 * reaping before the caller marks that worker unavailable.
 */
export function awaitBlockScanDeadline<T>(
  promise: Promise<T>,
  deadlineAtMs: number,
  stage: string,
  onTimeout?: () => void,
): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    onTimeout?.();
    void promise.catch(() => {});
    return Promise.reject(new BlockScanPassDeadlineError(stage));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new BlockScanPassDeadlineError(stage));
    }, remainingMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
