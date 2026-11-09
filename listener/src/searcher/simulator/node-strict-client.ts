import { buildNodeProgramQuote, isCanonicalNodeRuntimeCall, type NodeObservation } from "./node-program-quote.js";
import { keccak256 } from "ethers";
import { postJsonRpc, StateCallAbortedError } from "../../shared/state/state-backend.js";
import { RevmFatalError, RevmStrictError, type DaemonResponse, type RevmRequestControl,
  type StrictSimulateRequest, type ExecutorRuntimeCode } from "../revm-sim-client.js";
import { RethTransportScheduler, type RethTransportLoad, type RethTransportAttempt,
  type RethTransportRetryState } from "../reth-transport-scheduler.js";
import { isRpcThrottleError, isRpcQuotaExhaustedError } from "../rpc-throttle-guard.js";
import { assertCallTrace, successfulTraceLogs, traceNodeTopLevel, nodeNestedHalt } from "./node-trace-simulation.js";
import { NodeInputFunding, createNodeFundingCache, type NodeFundingCache } from "./node-input-funding.js";

const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const addr = (v: string) => { if (!/^0x[0-9a-f]{40}$/i.test(v)) throw new RevmStrictError("validation", "invalid node address"); return v.toLowerCase(); };
const delay = async (ms: number, signal: AbortSignal) => {
  const { setTimeout } = await import("node:timers/promises");
  await setTimeout(Math.max(0, ms), undefined, { signal });
};

/** Compatibility at the existing strict request/receipt boundary. This class
 * never starts a process or calls a local EVM. All work, including input funding,
 * executes on the configured node and carries the exact source block hash.
 */
export class NodeStrictClient {
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<DaemonResponse>>();
  private binding?: string;
  private header?: any;
  private readonly fundingCache: NodeFundingCache;
  private readonly scheduler: Pick<RethTransportScheduler, "run">;
  private readonly code = new Map<string, string>();
  private readonly fundingProofs = new Map<string, { slot: string; balance: bigint }>();
  constructor(private readonly options: {
    timeoutMs: number;
    scheduler?: Pick<RethTransportScheduler, "run">;
    lane?: "exact" | "discovery";
    fundingCache?: NodeFundingCache;
    /** Explicit production executor only; arbitrary contract actors aren't
     * replaced by an impersonation trampoline. */
    executor?: string;
    executorRuntimeCode?: ExecutorRuntimeCode;
    allowExecutorCodeOverride?: boolean;
  }) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("invalid node simulation timeout");
    this.scheduler = options.scheduler ?? new RethTransportScheduler({ capacity: 1, producerReserved: 1 });
    this.fundingCache = options.fundingCache ?? createNodeFundingCache();
  }
  get isTerminal() { return this.abort.signal.aborted; }
  async closeAndDrain() { this.abort.abort(new Error("node simulation closed")); await Promise.allSettled([...this.pending]); }
  strictSimulate(input: StrictSimulateRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    const request = JSON.parse(JSON.stringify(input)) as StrictSimulateRequest;
    const task = this.execute(request, control); this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {}); return task;
  }
  private async execute(req: StrictSimulateRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    const started = performance.now(), pin = req.sourcePin;
    if (!pin || !hash(pin.blockHash) || !Number.isSafeInteger(pin.chainId) || !req.rpcUrl ||
        !Number.isSafeInteger(req.blockNumber)) throw new RevmStrictError("validation", "node simulation requires pinned source");
    const binding = JSON.stringify([req.rpcUrl, req.blockNumber, pin]);
    if (this.binding && this.binding !== binding) throw new RevmFatalError({ kind: "source-fault" });
    this.binding = binding;
    const remaining = Math.min(this.options.timeoutMs, (control?.deadlineAtMs ?? Infinity) - Date.now());
    if (remaining <= 0) throw new StateCallAbortedError("node simulation deadline", "deadline");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new StateCallAbortedError("node simulation deadline", "deadline")), remaining);
    const signal = AbortSignal.any([this.abort.signal, deadline.signal, ...(control?.signal ? [control.signal] : [])]);
    const block = { blockHash: pin.blockHash, requireCanonical: true };
    const rpc = (method: string, params: readonly unknown[]) => this.rpc(req.rpcUrl!, method, params, signal);
    try {
      signal.throwIfAborted();
      let h = this.header;
      if (!h) {
        const [loaded, chain] = await Promise.all([rpc("eth_getBlockByHash", [pin.blockHash, false]), rpc("eth_chainId", [])]);
        if (!loaded || loaded.hash?.toLowerCase() !== pin.blockHash.toLowerCase() || Number(BigInt(loaded.number)) !== req.blockNumber ||
            Number(BigInt(chain)) !== pin.chainId || !hash(loaded.stateRoot) || !hash(loaded.parentHash) ||
            pin.stateRoot && loaded.stateRoot.toLowerCase() !== pin.stateRoot.toLowerCase()) throw new RevmFatalError({ kind: "source-fault" });
        signal.throwIfAborted();
        h = this.header = loaded;
      }
      const sourceAttestation = { kind: "node-attested" as const, blockNumber: req.blockNumber,
        chainId: pin.chainId, blockHash: h.hash.toLowerCase(), parentHash: h.parentHash.toLowerCase(), stateRoot: h.stateRoot.toLowerCase() };
      const codeAt = async (a: string): Promise<string> => {
        const cached = this.code.get(a);
        if (cached !== undefined) return cached;
        const v = await rpc("eth_getCode", [a, block]);
        if (typeof v !== "string" || !/^0x(?:[a-f0-9]{2})*$/i.test(v)) throw new Error("invalid node code");
        signal.throwIfAborted(); this.code.set(a, v); return v;
      };
      const requestedCode = req.trialPrefix?.executorRuntimeCode ?? req.executorRuntimeCode;
      const executorCode = this.options.executorRuntimeCode ?? requestedCode;
      const executor = addr(this.options.executor ?? req.trialPrefix?.executor ?? req.to);
      if (requestedCode && (requestedCode.keccak256 !== executorCode?.keccak256 ||
          addr(req.trialPrefix?.executor ?? req.to) !== executor)) throw new RevmStrictError("validation", "node executor capability mismatch");
      const proof = requestedCode ? { counterfactualExecutorCode: { address: executor, keccak256: requestedCode.keccak256 } } : {};
      if (executorCode && keccak256(executorCode.code) !== executorCode.keccak256) throw new RevmStrictError("validation", "node executor hash mismatch");
      // Code capability is verified at this exact state before funding or any
      // execution. A startup/latest code snapshot never substitutes history.
      const codeOverrides: Record<string, { code: string }> = {};
      if (executorCode) {
        const onChain = await codeAt(executor);
        if (onChain.toLowerCase() !== executorCode.code.toLowerCase()) {
          if (!this.options.allowExecutorCodeOverride) throw new RevmStrictError("validation", "node executor code differs at source");
          codeOverrides[executor] = { code: executorCode.code };
        }
      }
      const empty = { tokenDeltas: [], nativeDeltas: [], totalSupplyDeltas: [], logs: [] };
      const deals = req.trialPrefix ? [{ token: req.trialPrefix.inputToken, to: req.trialPrefix.executor, amount: req.trialPrefix.inputAmount }] : req.tokenDeals ?? [];
      const funder = new NodeInputFunding(rpc, block, this.fundingCache, this.fundingProofs);
      const prepared = await funder.prepare(deals);
      if (req.inputStateOnly) return { ok: true, latencyMs: performance.now() - started, sourceAttestation,
        strict: { ...proof, ...empty, executionGasUsed: "0", outcome: { kind: "InputPrepared", stateOverrides: prepared.overrides } } };
      if (req.stateRead) throw new RevmStrictError("validation", "node prefix storage/code observation unavailable");
      const from = addr(req.from), to = addr(req.to), origin = addr(req.callerMode === "impersonated-call-frame" ? req.transactionOrigin! : req.from);
      const originCode = await codeAt(origin);
      if (originCode !== "0x" && !/^0xef0100[0-9a-f]{40}$/i.test(originCode)) throw new RevmStrictError("validation", "node origin must be EOA or EIP-7702 authority");
      const calls = [...(req.trialPrefix ? [{ from: req.trialPrefix.executor, to: req.trialPrefix.executor, calldata: req.trialPrefix.calldata }] : []), ...(req.preCalls ?? [])];
      if (calls.some(c => addr(c.from) !== from)) throw new RevmStrictError("validation", "node prefix caller differs from observed frame");
      const plan = [...calls.map(c => ({ to: addr(c.to), data: c.calldata })), { to, data: req.data }];
      const observations: NodeObservation[] = [
        ...(req.observeTokenBalances ?? []).map(x => ({ kind: "token" as const, token: addr(x.token), account: addr(x.account) })),
        ...(req.observeNativeBalances ?? []).map(account => ({ kind: "native" as const, account: addr(account) })),
        ...(req.observeTotalSupply ?? []).map(token => ({ kind: "supply" as const, token: addr(token) })),
      ];
      for (const funded of prepared.expected) if (!observations.some(o => o.kind === "token" && o.token === funded.token && o.account === funded.account))
        observations.push({ kind: "token", token: funded.token, account: funded.account });
      const gas = req.executionGasLimit ?? req.gasLimit ?? 0x1000000;
      const overrides: Record<string, any> = { ...prepared.overrides, ...codeOverrides };
      if (req.nativeBalanceWei !== undefined) overrides[from] = { ...overrides[from], balance: hex(BigInt(req.nativeBalanceWei)) };
      let receipt: { before: bigint[]; after: bigint[]; output: string; gasUsed: bigint;
        logs: { address: string; topics: string[]; data: string }[]; failure?: { index: number; nestedHalt: string | null } };
      if (req.callerMode !== "impersonated-call-frame") {
        if (req.trialPrefix) throw new RevmStrictError("validation", "node prefix requires executor frame");
        receipt = await traceNodeTopLevel({ rpc, block, from, calls: plan, observations, overrides, gas });
      } else {
        if (!this.options.executor || !executorCode || from !== addr(this.options.executor) || origin === from ||
            (await codeAt(from)) === "0x" && !codeOverrides[from]) throw new RevmStrictError("validation", "node frame requires configured deployed executor and distinct origin");
        const fast = !req.trialPrefix && !calls.length && !req.observeLogs && from === to && isCanonicalNodeRuntimeCall(req.data);
        const quote = buildNodeProgramQuote({ executor: from, calls: plan, observations, baselineAfterPrefix: !!req.trialPrefix, terminalRevert: fast });
        const used = new Set([from, origin, ...plan.map(c => c.to), ...observations.flatMap(o => o.kind === "supply" ? [o.token] : o.kind === "native" ? [o.account] : [o.token, o.account])]);
        if (used.has(quote.recorder) || await codeAt(quote.recorder) !== "0x") throw new RevmStrictError("validation", "node recorder address already occupied");
        overrides[quote.recorder] = { code: quote.code };
        overrides[from] = { ...overrides[from], stateDiff: { ...overrides[from]?.stateDiff, [quote.diagnosticSlot]: quote.key } };
        const tx = { from: origin, to: from, data: quote.data, gas: hex(gas), gasPrice: "0x0" };
        if (fast) {
          let bytes: string | undefined;
          try { await rpc("eth_call", [tx, block, overrides]); }
          catch (error) { if (error instanceof NodeCallRevert) bytes = error.data; else throw error; }
          if (!bytes) throw new RevmStrictError("observation", "node quote missing terminal receipt");
          try { receipt = { ...quote.decode(bytes), output: "0x", gasUsed: 0n, logs: [] }; }
          catch (error) {
            // A real protocol revert is different from a transport/observation
            // failure. Only a completed traced main revert may become evidence.
            const trace = await rpc("debug_traceCall", [tx, block, { tracer: "callTracer", stateOverrides: overrides }]);
            assertCallTrace(trace, tx);
            const at = observations.reduce((n, o) => n + (o.kind === "native" ? 1 : 2), 0);
            const failed = trace.calls?.[at]; assertCallTrace(failed, { from, ...plan[0]! });
            if (!failed.error || !trace.error) throw error;
            receipt = { before: [], after: [], output: failed.output ?? "0x", gasUsed: BigInt(trace.gasUsed), logs: [],
              failure: { index: 0, nestedHalt: nodeNestedHalt(failed) } };
          }
        } else {
          const trace = await rpc("debug_traceCall", [tx, block, { tracer: "callTracer", tracerConfig: { withLog: true }, stateOverrides: overrides }]);
          assertCallTrace(trace, tx);
          // Runtime VM calls are direct children. Snapshot programs use internal
          // register frames, not new EVM calls. Match by position AND call data.
          const probeCount = observations.reduce((n, o) => n + (o.kind === "native" ? 1 : 2), 0);
          let offset = req.trialPrefix ? 0 : probeCount;
          const mainTraces = [];
          for (let i = 0; i < plan.length; i++) {
            const child = trace.calls?.[offset++];
            const expected = { from, ...plan[i]! };
            assertCallTrace(child, expected);
            mainTraces.push(child);
            if (child.error) break;
            if (i === 0 && req.trialPrefix) offset += probeCount;
          }
          const failedIndex = mainTraces.findIndex(c => !!c.error);
          if (failedIndex >= 0) {
            const failed = mainTraces[failedIndex]!;
            receipt = { before: [], after: [], output: failed.output ?? "0x", gasUsed: BigInt(trace.gasUsed), logs: [],
              failure: { index: failedIndex, nestedHalt: nodeNestedHalt(failed) } };
          } else {
            const terminal = trace.calls?.[offset + probeCount];
            if (trace.error || trace.calls?.length !== offset + probeCount + 1 || terminal?.from?.toLowerCase() !== from ||
                terminal?.to?.toLowerCase() !== quote.recorder || terminal.input !== "0x00000002" || terminal.error)
              throw new RevmStrictError("observation", "node program terminal receipt missing");
            receipt = { ...quote.read(terminal.output), output: mainTraces.at(-1)?.output ?? "0x", gasUsed: BigInt(trace.gasUsed),
              logs: mainTraces.slice(req.trialPrefix ? 1 : 0).flatMap(successfulTraceLogs) };
          }
        }
      }
      if (receipt.failure) return { ok: true, success: false, sourceAttestation, output: receipt.output,
        revertReason: receipt.output, gasUsed: receipt.gasUsed.toString(), latencyMs: performance.now() - started,
        strict: { ...empty, ...proof, executionGasUsed: receipt.gasUsed.toString(), outcome: {
          kind: "Revert", ...(receipt.failure.index < plan.length - 1 ? { phase: "preCall" as const, preCallIndex: receipt.failure.index } : { phase: "main" as const }),
          output: receipt.output, nestedHalt: receipt.failure.nestedHalt } } };
      if (!req.trialPrefix) for (const funded of prepared.expected) {
        const i = observations.findIndex(o => o.kind === "token" && o.token === funded.token && o.account === funded.account);
        if (receipt.before[i] !== funded.balance) throw new RevmStrictError("observation", "node funded balance differs for execution caller");
      }
      const delta = (i: number) => (receipt.after[i]! - receipt.before[i]!).toString();
      let at = 0;
      const tokenDeltas = (req.observeTokenBalances ?? []).map(x => ({ ...x, delta: delta(at++) }));
      const nativeDeltas = (req.observeNativeBalances ?? []).map(account => { const i = at++; return {
        account, before: receipt.before[i]!.toString(), after: receipt.after[i]!.toString(), delta: delta(i) }; });
      const totalSupplyDeltas = (req.observeTotalSupply ?? []).map(token => ({ token, delta: delta(at++) }));
      return { ok: true, success: true, sourceAttestation, output: receipt.output, gasUsed: receipt.gasUsed.toString(), latencyMs: performance.now() - started,
        strict: { ...proof, executionGasUsed: receipt.gasUsed.toString(), tokenDeltas, nativeDeltas, totalSupplyDeltas,
          logs: req.observeLogs ? receipt.logs : [], outcome: { kind: "Success", phase: "main", output: receipt.output } } };
    } finally { clearTimeout(timer); }
  }
  private async rpc(url: string, method: string, params: readonly unknown[], signal: AbortSignal): Promise<any> {
    const retry: RethTransportRetryState = {};
    for (;;) {
      signal.throwIfAborted();
      let load: RethTransportLoad | undefined, attempt: RethTransportAttempt | undefined;
      try {
        return await this.scheduler.run(this.options.lane ?? "exact", signal, async lease => {
          load = lease.load; attempt = load?.limits(1, 1, [retry]);
          const response = await postJsonRpc(url, { jsonrpc: "2.0", id: 1, method, params: [...params] } as never, signal);
          signal.throwIfAborted();
          const b: any = response.body;
          if (response.statusCode === 200 && method === "eth_call" && b?.jsonrpc === "2.0" && b.id === 1 &&
              (b.error?.code === 3 || b.error?.code === -32000 && /^execution reverted/i.test(b.error?.message ?? "")) &&
              typeof b.error.data === "string" && /^0x(?:[a-f0-9]{2})*$/i.test(b.error.data))
            throw new NodeCallRevert(b.error.data);
          if (response.statusCode !== 200 || b?.error) {
            const throttle = isRpcThrottleError({ ...b?.error, statusCode: response.statusCode });
            const exhausted = isRpcQuotaExhaustedError({ ...b?.error, statusCode: response.statusCode });
            throw Object.assign(new Error(exhausted ? "node simulation quota exhausted" : throttle ? "node simulation RPC 429" : "node simulation RPC failed"), {
              statusCode: response.statusCode, code: typeof b?.error?.code === "number" ? b.error.code : undefined });
          }
          if (b?.jsonrpc !== "2.0" || b.id !== 1 || !Object.hasOwn(b, "result")) throw new Error("invalid node RPC response");
          return b.result;
        });
      } catch (error) {
        signal.throwIfAborted();
        if (!load || !attempt || !load.retry(error, [retry], attempt)) throw error;
        await delay(load.retryDelayMs([retry]), signal);
      }
    }
  }
}

class NodeCallRevert extends Error { constructor(readonly data: string) { super("node call reverted"); } }
