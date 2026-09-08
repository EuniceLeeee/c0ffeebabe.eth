/**
 * A fixed pass's existing quote workers produce one complete result per plan.
 * The single consumer retains plan order, but need not wait for later plans.
 * Slots are bounded by the original plan count; no admission policy lives here.
 */
export async function runOrderedBlockScanPipeline<Worker, Result>(input: {
  readonly count: number;
  readonly workers: readonly Worker[];
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly produce: (index: number, worker: Worker, signal: AbortSignal) => Promise<Result>;
  readonly consume: (index: number, result: Result, signal: AbortSignal) => Promise<void>;
  readonly onProducersSettled?: (completed: boolean) => void;
}): Promise<void> {
  if (!Number.isSafeInteger(input.count) || input.count < 0 ||
    (input.count > 0 && input.workers.length === 0) ||
    !Number.isFinite(input.deadlineAtMs)) {
    throw new Error("invalid ordered block-scan pipeline input");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  const signal = controller.signal;
  const slots = new Map<number, Result>();
  let cursor = 0;
  let produced = 0;
  let producersDone = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  const assertActive = () => {
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= input.deadlineAtMs) {
      throw new Error("ordered block-scan pipeline deadline elapsed");
    }
  };
  const stop = (reason: unknown) => {
    if (!signal.aborted) controller.abort(reason);
    notify();
  };
  signal.addEventListener("abort", notify);
  const timer = setTimeout(
    () => stop(new Error("ordered block-scan pipeline deadline elapsed")),
    Math.max(0, input.deadlineAtMs - Date.now()),
  );
  const producers = Promise.allSettled(input.workers.map(async (worker) => {
    try {
      for (;;) {
        assertActive();
        const index = cursor++;
        if (index >= input.count) return;
        const result = await input.produce(index, worker, signal);
        assertActive();
        slots.set(index, result);
        produced++;
        notify();
      }
    } catch (error) {
      stop(error);
      throw error;
    }
  })).then((settled) => {
    producersDone = true;
    notify();
    input.onProducersSettled?.(
      !signal.aborted && produced === input.count &&
      settled.every((result) => result.status === "fulfilled"),
    );
  });
  // Observe callback failures immediately even if the consumer is still busy.
  void producers.catch(stop);
  try {
    for (let index = 0; index < input.count; index++) {
      while (!slots.has(index)) {
        assertActive();
        if (producersDone) throw new Error("ordered block-scan pipeline missing result");
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      assertActive();
      const result = slots.get(index)!;
      slots.delete(index);
      await input.consume(index, result, signal);
    }
    await producers;
    assertActive();
  } catch (error) {
    stop(error);
    throw error;
  } finally {
    // Do not release source-bound backends/forks while a producer still uses them.
    await producers.catch(() => {});
    clearTimeout(timer);
    signal.removeEventListener("abort", notify);
    input.signal.removeEventListener("abort", abort);
    slots.clear();
  }
}
