import { StateCallAbortedError } from "../shared/state/state-backend.js";
import { readBlockScanObservedHeader } from "./blockscan-observed-header.js";
import { RethTransportScheduler, type RethTransportLoad, type RethTransportAttempt,
  type RethTransportRetryState } from "./reth-transport-scheduler.js";
import { EthSimulateV1Simulator, type StartupPrefixExecutionResult } from "./simulator/eth-simulate-v1.js";
import type { StartupPrefixInput } from "./simulator/startup-prefix-program.js";
import type { BotVmRuntimeCode } from "../shared/executor/botvm-executor.js";
import type { AdapterWorkControl, CentralCallerAuthority } from "./adapter-work-intent.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

export type StartupNodeInvocation = StartupPrefixInput & {
  source: CanonicalSource; control: AdapterWorkControl; callerAuthority: CentralCallerAuthority;
};
export type StartupNodeSimulation = ((input: StartupNodeInvocation) => Promise<StartupPrefixExecutionResult & {
  simulationMs: number; nodeQueueMs: number;
}>) & { stats(): Readonly<{ requests: number; retries: number; simulations: number; headers: number; maxCuIn1000Ms: number }> };

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Production node sim only. All headers, simulations and retries share the
 * existing transport scheduler and one paced outlet, at most 200 requests/s.
 * 40 CU per simulation gives this task an 8,000 CU/s ceiling, with headroom for
 * other work. This is not an account-wide limiter for unrelated processes. */
export function createStartupNodeSimulation(input: {
  rpcUrl: string; chainId: bigint; executor: string; transactionOrigin: string;
  executorRuntimeCode?: BotVmRuntimeCode; rawExecutionEntry?: boolean;
  scheduler: RethTransportScheduler; requestsPerSecond?: number;
}): StartupNodeSimulation {
  const rate = input.requestsPerSecond ?? 200;
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 200) throw new Error("invalid startup node request rate");
  const simulator = new EthSimulateV1Simulator(input.rpcUrl, input.executor, input.transactionOrigin,
    input.executorRuntimeCode, input.rawExecutionEntry);
  let admission = Promise.resolve(), dispatchedAt = -Infinity;
  let headerKey = "", header: Promise<Awaited<ReturnType<typeof readBlockScanObservedHeader>>> | undefined;
  const stats = { requests: 0, retries: 0, simulations: 0, headers: 0, maxCuIn1000Ms: 0 };
  const window: { time: number; cu: number }[] = [];
  const pace = (signal: AbortSignal, method: "header" | "simulate") => {
    const next = admission.then(async () => {
      signal.throwIfAborted();
      while (performance.now() < dispatchedAt + 1000 / rate) await pause(dispatchedAt + 1000 / rate - performance.now(), signal);
      signal.throwIfAborted(); dispatchedAt = performance.now();
      stats.requests++; if (method === "header") stats.headers++; else stats.simulations++;
      while (window[0] && window[0].time <= dispatchedAt - 1000) window.shift();
      window.push({ time: dispatchedAt, cu: method === "header" ? 20 : 40 });
      stats.maxCuIn1000Ms = Math.max(stats.maxCuIn1000Ms, window.reduce((sum, r) => sum + r.cu, 0));
    });
    admission = next.catch(() => {}); return next;
  };
  async function dispatch<T>(signal: AbortSignal, method: "header" | "simulate", operation: () => Promise<T>): Promise<T> {
    const retry: RethTransportRetryState = {};
    for (;;) {
      let load: RethTransportLoad | undefined, attempt: RethTransportAttempt | undefined;
      try {
        return await input.scheduler.run("producer-bulk", signal, async lease => {
          load = lease.load; attempt = load?.limits(1, 1, [retry]);
          await pace(signal, method); return operation();
        });
      } catch (error) {
        signal.throwIfAborted();
        if (!load || !attempt || !load.retry(error, [retry], attempt)) throw error;
        stats.retries++; await pause(load.retryDelayMs([retry]), signal);
      }
    }
  }
  const run = async (invocation: StartupNodeInvocation) => {
    const { source, control, callerAuthority } = invocation;
    if (!control.signal || !Number.isSafeInteger(control.deadlineAtMs) ||
      callerAuthority.executor?.toLowerCase() !== input.executor.toLowerCase() ||
      callerAuthority.transactionOrigin?.toLowerCase() !== input.transactionOrigin.toLowerCase()) {
      throw new Error("invalid startup node simulation authority or control");
    }
    const remaining = control.deadlineAtMs! - Date.now();
    if (remaining <= 0) throw new StateCallAbortedError("startup node simulation deadline", "deadline");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new StateCallAbortedError("startup node simulation deadline", "deadline")),
      Math.min(remaining, 2_147_483_647));
    const signal = AbortSignal.any([control.signal, deadline.signal]);
    const started = performance.now(); let simulationMs = 0;
    try {
      signal.throwIfAborted();
      const key = `${source.number}:${source.hash.toLowerCase()}:${source.generation}`;
      if (headerKey !== key || !header) {
        headerKey = key;
        const current = dispatch(signal, "header", () => readBlockScanObservedHeader(input.rpcUrl, input.chainId, source.number,
          { signal, deadlineAtMs: control.deadlineAtMs! }));
        header = current;
        void current.catch(() => { if (header === current) header = undefined; });
      }
      const observed = await header;
      if (observed.hash.toLowerCase() !== source.hash.toLowerCase()) throw new Error("startup node source header mismatch");
      const result = await dispatch(signal, "simulate", async () => {
        const dispatched = performance.now();
        try { return await simulator.simulateStartupPrefix({ source, header: observed, amount: invocation.amount, legs: invocation.legs },
          { signal, deadlineAtMs: control.deadlineAtMs! }); }
        finally { simulationMs += performance.now() - dispatched; }
      });
      return { ...result, simulationMs, nodeQueueMs: Math.max(0, performance.now() - started - simulationMs) };
    } finally { clearTimeout(timer); }
  };
  return Object.assign(run, { stats: () => Object.freeze({ ...stats }) });
}
