export interface BlockScanMidBatchResult<T> {
  results: Array<T | undefined>;
  deadlineHit: boolean;
  started: number;
}

/**
 * Run block-pinned mid reads with bounded concurrency while preserving input
 * order in the returned array. Callers merge the results only after the whole
 * batch completes, so concurrent RPC completion order cannot change which
 * duplicate key wins.
 */
export async function runBlockScanMidBatch<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  deadlineAtMs: number,
  read: (input: Input, index: number) => Promise<Output>,
): Promise<BlockScanMidBatchResult<Output>> {
  const results = new Array<Output | undefined>(inputs.length);
  const workerCount = Math.min(
    inputs.length,
    Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1),
  );
  let cursor = 0;
  let deadlineHit = false;

  const worker = async (): Promise<void> => {
    while (true) {
      if (Date.now() >= deadlineAtMs) {
        if (cursor < inputs.length) deadlineHit = true;
        return;
      }
      const index = cursor++;
      if (index >= inputs.length) return;
      results[index] = await read(inputs[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (Date.now() >= deadlineAtMs) deadlineHit = true;
  return {
    results,
    deadlineHit,
    started: Math.min(cursor, inputs.length),
  };
}
