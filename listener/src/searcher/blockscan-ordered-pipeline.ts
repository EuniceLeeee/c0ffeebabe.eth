/**
 * A fixed pass's existing quote workers produce one complete result per plan.
 * The single consumer retains plan order unless a ready-result priority is supplied.
 * Priority mode never waits for an unfinished plan ahead of an available result.
 * Slots are bounded by the original plan count; no admission policy lives here.
 */
export async function runOrderedBlockScanPipeline<Worker, Result>(input: {
  readonly count: number;
  readonly workers: readonly Worker[];
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly produce: (index: number, worker: Worker, signal: AbortSignal) => Promise<Result>;
  /** Higher absolute values first among completed plans. Null stays eligible,
   * after priced results. Ties use original plan order; no admission change. */
  readonly priority?: (result: Result, index: number) => bigint | null;
  /** false ends the pass after an admitted submission; outstanding producers are drained. */
  readonly consume: (index: number, result: Result, signal: AbortSignal) => Promise<void | boolean>;
  readonly onProducersSettled?: (completed: boolean) => void;
}): Promise<boolean> {
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
  type Ready = { index: number; priority: bigint | null };
  const ready: Ready[] = [];
  const better = (a: Ready, b: Ready): boolean => a.priority === b.priority
    ? a.index < b.index : a.priority === null ? false : b.priority === null || a.priority > b.priority;
  const pushReady = (item: Ready) => {
    let i = ready.length;
    ready.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!better(item, ready[parent]!)) break;
      ready[i] = ready[parent]!; i = parent;
    }
    ready[i] = item;
  };
  const popReady = (): number => {
    const first = ready[0]!, last = ready.pop()!;
    if (ready.length) {
      let i = 0;
      while (i * 2 + 1 < ready.length) {
        let child = i * 2 + 1;
        if (child + 1 < ready.length && better(ready[child + 1]!, ready[child]!)) child++;
        if (!better(ready[child]!, last)) break;
        ready[i] = ready[child]!; i = child;
      }
      ready[i] = last;
    }
    return first.index;
  };
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
        if (input.priority) pushReady({ index, priority: input.priority(result, index) });
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
    for (let consumed = 0; consumed < input.count; consumed++) {
      while (input.priority ? ready.length === 0 : !slots.has(consumed)) {
        assertActive();
        if (producersDone) throw new Error("ordered block-scan pipeline missing result");
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      assertActive();
      const index = input.priority ? popReady() : consumed;
      const result = slots.get(index)!;
      slots.delete(index);
      const keepGoing = await input.consume(index, result, signal);
      if (keepGoing === false) {
        stop(new Error("ordered candidate pipeline completed early"));
        await producers;
        return false;
      }
    }
    await producers;
    assertActive();
    return true;
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
    ready.length = 0;
  }
}
