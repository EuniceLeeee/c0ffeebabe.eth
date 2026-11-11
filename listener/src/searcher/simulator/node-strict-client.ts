import { buildNodeProgramQuote, isCanonicalNodeRuntimeCall, type NodeObservation } from "./node-program-quote.js";
import { keccak256 } from "ethers";
import { postJsonRpc, StateCallAbortedError } from "../../shared/state/state-backend.js";
import { RevmFatalError, RevmStrictError, type DaemonResponse, type RevmRequestControl,
  type StrictSimulateRequest, type ExecutorRuntimeCode } from "../revm-sim-client.js";
import { RethTransportScheduler, type RethTransportLoad, type RethTransportAttempt,
  type RethTransportRetryState } from "../reth-transport-scheduler.js";
import { isRpcThrottleError, isRpcQuotaExhaustedError } from "../rpc-throttle-guard.js";
import { assertCallTrace, successfulTraceLogs, traceNodeTopLevel, nodeNestedHalt } from "./node-trace-simulation.js";
import { NodeInputFunding, createNodeFundingCache, type NodeFundingCache, type NodeFundingProof } from "./node-input-funding.js";

const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const addr = (v: string) => { if (!/^0x[0-9a-f]{40}$/i.test(v)) throw new RevmStrictError("validation", "invalid node address"); return v.toLowerCase(); };
const delay = async (ms: number, signal: AbortSignal) => {
  const { setTimeout } = await import("node:timers/promises");
  await setTimeout(Math.max(0, ms), undefined, { signal });
};
interface SourceRead {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  waiters: number;
}

/** Compatibility at the existing strict request/receipt boundary. This class
 * never starts a process or calls a local EVM. All work, including input funding,
 * executes on the configured node and carries the exact source block hash.
 */
export class NodeStrictClient {
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<DaemonResponse>>();
  private readonly sourceReads = new Map<string, SourceRead>();
  private readonly pendingReads = new Set<Promise<unknown>>();
  private binding?: string;
  private header?: any;
  private readonly fundingCache: NodeFundingCache;
  private readonly scheduler: Pick<RethTransportScheduler, "run">;
  private readonly code = new Map<string, string>();
  private readonly fundingProofs = new Map<string, NodeFundingProof>();
  private verifiedExecutorCode?: ExecutorRuntimeCode;
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
  async closeAndDrain() {
    this.abort.abort(new Error("node simulation closed"));
    await Promise.allSettled([...this.pending, ...this.pendingReads]);
  }
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
        h = await this.sourceRead("header", signal, async readSignal => {
          const results = await Promise.allSettled([
            this.rpc(req.rpcUrl!, "eth_getBlockByHash", [pin.blockHash, false], readSignal),
            this.rpc(req.rpcUrl!, "eth_chainId", [], readSignal),
          ]);
          const failure = results.find(result => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          const [loaded, chain] = results.map(result => (result as PromiseFulfilledResult<any>).value);
          if (!loaded || loaded.hash?.toLowerCase() !== pin.blockHash.toLowerCase() || Number(BigInt(loaded.number)) !== req.blockNumber ||
              Number(BigInt(chain)) !== pin.chainId || !hash(loaded.stateRoot) || !hash(loaded.parentHash) ||
              pin.stateRoot && loaded.stateRoot.toLowerCase() !== pin.stateRoot.toLowerCase()) throw new RevmFatalError({ kind: "source-fault" });
          readSignal.throwIfAborted();
          return this.header = loaded;
        });
      }
      const sourceAttestation = { kind: "node-attested" as const, blockNumber: req.blockNumber,
        chainId: pin.chainId, blockHash: h.hash.toLowerCase(), parentHash: h.parentHash.toLowerCase(), stateRoot: h.stateRoot.toLowerCase() };
      const codeAt = async (a: string, reuse = true): Promise<string> => {
        const cached = reuse ? this.code.get(a) : undefined;
        if (cached !== undefined) return cached;
        const read = async (readSignal: AbortSignal): Promise<string> => {
          const v = await this.rpc(req.rpcUrl!, "eth_getCode", [a, block], readSignal);
          if (typeof v !== "string" || !/^0x(?:[a-f0-9]{2})*$/i.test(v)) throw new Error("invalid node code");
          readSignal.throwIfAborted();
          if (reuse) this.code.set(a, v);
          return v;
        };
        return reuse ? this.sourceRead(`code:${a}`, signal, read) : read(signal);
      };
      const requestedCode = req.trialPrefix?.executorRuntimeCode ?? req.executorRuntimeCode;
      const configuredCode = this.options.executorRuntimeCode ?? requestedCode;
      // Snapshot primitive values: callers may reuse or mutate their option
      // object, but a cache hit must bind the exact code AND its expected hash.
      const executorCode = configuredCode && { code: configuredCode.code, keccak256: configuredCode.keccak256 };
      const executor = addr(this.options.executor ?? req.trialPrefix?.executor ?? req.to);
      if (requestedCode && (requestedCode.keccak256 !== executorCode?.keccak256 ||
          addr(req.trialPrefix?.executor ?? req.to) !== executor)) throw new RevmStrictError("validation", "node executor capability mismatch");
      const proof = requestedCode ? { counterfactualExecutorCode: { address: executor, keccak256: requestedCode.keccak256 } } : {};
      if (executorCode && (executorCode.code !== this.verifiedExecutorCode?.code ||
          executorCode.keccak256 !== this.verifiedExecutorCode?.keccak256)) {
        if (keccak256(executorCode.code) !== executorCode.keccak256) throw new RevmStrictError("validation", "node executor hash mismatch");
        this.verifiedExecutorCode = executorCode;
      }
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
      const funder = new NodeInputFunding(rpc, block, this.fundingCache, this.fundingProofs,
        (key, prove) => this.sourceRead(`funding:${key}`, signal, async readSignal => {
          const result = await prove((method, params) => this.rpc(req.rpcUrl!, method, params, readSignal));
          readSignal.throwIfAborted();
          this.fundingProofs.set(key, result);
          return result;
        }));
      const prepared = await funder.prepare(deals);
      signal.throwIfAborted();
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
        if (used.has(quote.recorder) || await codeAt(quote.recorder, false) !== "0x") throw new RevmStrictError("validation", "node recorder address already occupied");
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
  /** Coalesce immutable reads only within this client's pinned source. A
   * request's cancellation detaches its waiter; it must not cancel another
   * quote's proof. The last waiter cancels unused work, and failed reads retry.
   */
  private sourceRead<T>(key: string, signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    this.abort.signal.throwIfAborted();
    let entry = this.sourceReads.get(key);
    if (!entry) {
      const controller = new AbortController();
      const readSignal = AbortSignal.any([this.abort.signal, controller.signal]);
      // Every waiter already has execute()'s own timeout. A shared timer
      // starting with the first waiter would shorten a later quote's budget.
      const promise = Promise.resolve().then(() => {
        readSignal.throwIfAborted();
        return read(readSignal);
      }).finally(() => {
        if (this.sourceReads.get(key) === created) this.sourceReads.delete(key);
        this.pendingReads.delete(promise);
      });
      const created: SourceRead = { controller, promise, waiters: 0 };
      this.sourceReads.set(key, created);
      this.pendingReads.add(promise);
      entry = created;
    }
    const shared = entry;
    shared.waiters++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (--shared.waiters === 0 && this.sourceReads.get(key) === shared) {
          this.sourceReads.delete(key);
          shared.controller.abort(new Error("node source read has no waiters"));
        }
        return true;
      };
      const cancel = () => { if (finish()) reject(signal.reason); };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      void shared.promise.then(value => { if (finish()) resolve(value as T); }, error => { if (finish()) reject(error); });
    });
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
