import { goldenSectionMaximize } from "../solver/amount-bounds.js";

/** Execution-profit amount selection. The caller owns authenticated planning,
 * isolated execution, source fencing, final verification and EV. Never scores
 * quote profit or treats an infrastructure failure as an economic rejection. */
export type AmountSimulation<T> =
  | { success: true; profit: bigint; value: T }
  | { success: false; reason: string };

export interface SimAmountTrial<T> {
  amount: bigint;
  phase: "p" | "coarse" | "refine";
  wallMs: number;
  result: AmountSimulation<T>;
}

export async function searchSimAmounts<T>(input: {
  p: bigint;
  maxInput: bigint;
  gssMaxTries?: number;
  /** Bound independent full-transaction simulations, not nested quote calls. */
  concurrency?: number;
  deadlineAtMs: number;
  signal?: AbortSignal;
  /** Must cooperate with cancellation and drain owned work before settling.
   * A cancellation rejects with signal.reason; source/transport faults retain
   * their own identity even after expiry. */
  evaluate(amount: bigint, control: { signal: AbortSignal; deadlineAtMs: number }): Promise<AmountSimulation<T>>;
  onTrial?: (trial: SimAmountTrial<T>) => void;
}) {
  const tries = input.gssMaxTries ?? 8;
  const concurrency = input.concurrency ?? 3;
  if (input.p <= 0n || input.maxInput < input.p || !Number.isSafeInteger(input.deadlineAtMs) ||
      !Number.isInteger(tries) || (tries !== 0 && tries < 2) || tries > 1000 ||
      !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("invalid sim amount search bounds");
  }
  const controller = new AbortController();
  const deadlineError = new Error("sim amount search deadline");
  const externalAbort = () => controller.abort(input.signal?.reason ?? new Error("sim amount search cancelled"));
  if (input.signal?.aborted) externalAbort();
  input.signal?.addEventListener("abort", externalAbort, { once: true });
  const expire = () => controller.abort(deadlineError);
  const timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(0, input.deadlineAtMs - Date.now())));
  const check = () => {
    if (Date.now() >= input.deadlineAtMs && !controller.signal.aborted) expire();
    controller.signal.throwIfAborted();
  };
  const control = { signal: controller.signal, deadlineAtMs: input.deadlineAtMs };
  const cap = input.maxInput < input.p * 1000n ? input.maxInput : input.p * 1000n;
  const trials: SimAmountTrial<T>[] = [];
  const memo = new Map<bigint, Promise<AmountSimulation<T>>>();
  // Nonpositive executions need not be ordered: only profitable amounts refine.
  const score = (result: AmountSimulation<T>) => result.success && result.profit > 0n ? result.profit : 0n;
  let best: SimAmountTrial<T> | null = null;
  const evaluate = (amount: bigint, phase: SimAmountTrial<T>["phase"]): Promise<AmountSimulation<T>> => {
    check();
    if (amount < input.p || amount > cap) throw new Error("amount outside sim search domain");
    const existing = memo.get(amount);
    if (existing) return existing;
    const work = (async () => {
      const start = performance.now();
      const result = await input.evaluate(amount, control);
      check();
      if (result.success && typeof result.profit !== "bigint") throw new Error("simulation profit is not an integer");
      const trial = { amount, phase, wallMs: performance.now() - start, result };
      trials.push(trial);
      if (score(result) > 0n && (best === null || score(result) > score(best.result) ||
          (score(result) === score(best.result) && amount < best.amount))) best = trial;
      input.onTrial?.(trial);
      return result;
    })();
    memo.set(amount, work);
    return work;
  };
  const batch = async (amounts: bigint[], phase: SimAmountTrial<T>["phase"]) => {
    for (let i = 0; i < amounts.length; i += concurrency) {
      check();
      const pending: Promise<AmountSimulation<T>>[] = [];
      let launchFailure: unknown;
      try {
        for (const amount of amounts.slice(i, i + concurrency)) {
          const work = evaluate(amount, phase);
          pending.push(work);
          // Establish ownership before the next launch can synchronously abort.
          void work.catch(error => controller.abort(error));
        }
      } catch (error) { launchFailure = error; controller.abort(error); }
      const settled = await Promise.allSettled(pending);
      const errors = settled.flatMap(item => item.status === "rejected" ? [item.reason] : []);
      if (launchFailure !== undefined) errors.push(launchFailure);
      // A source fault received during drain outranks deadline cancellation.
      const fault = errors.find(error => error !== controller.signal.reason);
      if (fault !== undefined) throw fault;
      if (errors.length) throw errors[0];
    }
  };
  let status: "complete" | "p-nonpositive" | "deadline" = "complete";
  let bracket: { lo: bigint; hi: bigint } | null = null;
  try {
    const first = await evaluate(input.p, "p");
    if (score(first) <= 0n) status = "p-nonpositive";
    else {
      const grid = [...new Set([10n, 100n, 1000n].map(x => input.p * x > cap ? cap : input.p * x))]
        .filter(x => x !== input.p);
      await batch(grid, "coarse");
      const winner = best as SimAmountTrial<T> | null;
      if (winner && tries > 0) {
        const lo = winner.amount / 10n > input.p ? winner.amount / 10n : input.p;
        const hi = winner.amount * 10n < cap ? winner.amount * 10n : cap;
        bracket = { lo, hi };
        if (lo < hi) {
          // Same production golden-section helper. Warm its independent first
          // pair in parallel; its subsequent reads consume the per-search memo.
          await batch([...new Set([hi - (hi - lo) * 618n / 1000n, lo + (hi - lo) * 618n / 1000n])], "refine");
          await goldenSectionMaximize(lo, hi, async amount => score(await evaluate(amount, "refine")), {
            maxTries: tries, shouldStop: () => controller.signal.aborted || Date.now() >= input.deadlineAtMs,
          });
          check();
        }
      }
    }
  } catch (error) {
    if (error === deadlineError && !input.signal?.aborted) status = "deadline";
    else throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", externalAbort);
  }
  const candidates = trials.filter(trial => score(trial.result) > 0n).sort((a, b) =>
    score(a.result) === score(b.result) ? (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)
      : score(a.result) > score(b.result) ? -1 : 1);
  return { status, complete: status !== "deadline", best: candidates[0] ?? null,
    candidates, trials, bracket, domain: { lo: input.p, hi: cap }, objective: "simulated-token-profit-before-gas" as const };
}
