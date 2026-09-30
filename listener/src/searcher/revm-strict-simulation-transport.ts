import { keccak256 } from "ethers";
import { snapshotCentralCallerAuthority, type AdapterWorkControl,
  type CentralCallerAuthority } from "./adapter-work-intent.js";
import { RevmFatalError, RevmStrictError, type RevmFatalReason,
  type ExecutorRuntimeCode, type RevmSourcePin, type StrictSimulateRequest } from "./revm-sim-client.js";
import type { RevmStrictSourceLease } from "./revm-strict-source-owner.js";
import type { StrictSimulationTransport } from "./strict-central-adapter-runtime.js";
import type { CanonicalSource, ObservedEffects } from "./venues/adapter-request-program.js";
import { logRevmFault, type RevmFaultStage } from "./revm-fault-diagnostics.js";

type WireCall = Omit<StrictSimulateRequest, "rpcUrl" | "blockNumber" | "sourcePin">;
type ExactPrefixFailure = Readonly<{
  phase: "main" | "preCall";
  kind: "Revert" | "Halt";
  preCallIndex?: number;
  reason?: string;
  output?: string;
}>;
const UINT256 = 1n << 256n;
const EFFECTS = ["return-data", "revert-data", "token-delta", "native-delta", "total-supply-delta", "logs"];

/** Source admission/retirement belongs to the resolver's owner, never a quote.
 * No implicit endpoint, caller authority, source lease or daemon fallback.
 */
export function createRevmStrictSimulationTransport(input: {
  readonly rpcUrl: string;
  readonly executionGasLimit: number;
  /** Trusted executor bytecode, never supplied by a Family request. */
  readonly executorRuntimeCode?: ExecutorRuntimeCode;
  readonly leaseFor: (source: CanonicalSource) => Promise<RevmStrictSourceLease>;
  readonly onFatal: (reason: RevmFatalReason) => void;
}): StrictSimulationTransport {
  record(input, ["rpcUrl", "executionGasLimit", "executorRuntimeCode", "leaseFor", "onFatal"]);
  const { rpcUrl, executionGasLimit, leaseFor, onFatal } = input;
  const executorRuntimeCode = input.executorRuntimeCode === undefined ? undefined : codeSnapshot(input.executorRuntimeCode);
  try {
    if (typeof rpcUrl !== "string" || /\s/.test(rpcUrl)) invalid();
    const url = new URL(rpcUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.hash) invalid();
  } catch { invalid(); }
  if (!positiveInteger(executionGasLimit) || typeof leaseFor !== "function" || typeof onFatal !== "function") invalid();
  let terminal: RevmFatalError | undefined;
  function fatal(reason: RevmFatalReason, stage: RevmFaultStage = "transport-operation"): never {
    if (!terminal) {
      terminal = new RevmFatalError(freeze(fatalSnapshot(reason)));
      logRevmFault(stage, terminal.fatal);
      // Publish the latch BEFORE invoking a possibly throwing/reentrant owner.
      try { onFatal(terminal.fatal); } catch { /* Owner failure cannot undo the latch. */ }
    }
    throw terminal;
  }
  function open(control?: AdapterWorkControl): void {
    if (terminal) throw terminal;
    // Never propagate an abort reason carrying CALL_EXCEPTION or credentials.
    if (control?.signal?.aborted) throw new RevmStrictError("execution", "strict simulation cancelled");
    if (control?.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs) {
      throw new RevmStrictError("execution", "strict simulation deadline reached");
    }
  }
  async function owned<T>(operation: () => Promise<T>, control?: AdapterWorkControl): Promise<T> {
    try { return await operation(); } catch (error) {
      // Fatal delivery wins even if the quote was cancelled concurrently.
      if (error instanceof RevmFatalError) fatal(error.fatal);
      open(control);
      const message = error instanceof Error ? error.message : undefined;
      const safeMessage = message === "revm-sim request deadline timed out" ? "strict simulation deadline reached"
        : message === "revm-sim request aborted" ? "strict simulation cancelled"
        : "strict simulation transport failed";
      throw new RevmStrictError(error instanceof RevmStrictError ? error.kind : "execution",
        safeMessage);
    }
  }
  function leasePin(lease: RevmStrictSourceLease, source: CanonicalSource): Readonly<RevmSourcePin> {
    try {
      record(lease, ["source", "sourcePin", "strictSimulate", "closeAndDrain"]);
      const actual = sourceSnapshot(lease.source);
      if (!sameSource(actual, source) || typeof lease.strictSimulate !== "function" || typeof lease.closeAndDrain !== "function") invalid();
      const p = record(lease.sourcePin, ["chainId", "blockHash", "stateRoot"]);
      if (!positiveInteger(p.chainId) || !hash32(p.blockHash) || p.blockHash.toLowerCase() !== source.hash ||
        (p.stateRoot !== undefined && !hash32(p.stateRoot))) invalid();
      return freeze({ chainId: p.chainId, blockHash: p.blockHash.toLowerCase(),
        ...(p.stateRoot === undefined ? {} : { stateRoot: (p.stateRoot as string).toLowerCase() }) });
    } catch { return fatal({ kind: "source-fault" }, "transport-lease-pin"); }
  }
  async function execute(invocation: Parameters<StrictSimulationTransport["simulate"]>[0] |
    Parameters<NonNullable<StrictSimulationTransport["simulatePrefix"]>>[0], prefix: boolean) {
      open();
      // All caller-owned values are validated and detached before leaseFor can
      // yield. Source controls stay with the resolver; only quote controls go
      // to strictSimulate. Do not introduce a detached deadline race here.
      const source = sourceSnapshot(invocation.source);
      const control = controlSnapshot(invocation.control);
      let authority: CentralCallerAuthority;
      try { authority = snapshotCentralCallerAuthority(invocation.callerAuthority); } catch { invalid(); }
      const { wire, observe } = prefix
        ? prefixRequestSnapshot(invocation as Parameters<NonNullable<StrictSimulationTransport["simulatePrefix"]>>[0],
          authority, executionGasLimit, executorRuntimeCode)
        : requestSnapshot(invocation.request, authority, executionGasLimit);
      const reportEffects = invocation.request.kind === "state-override-simulation" || invocation.request.kind === "effect-delta-simulation";
      open(control);
      const lease = await owned(() => leaseFor(source), control);
      const pin = leasePin(lease, source);
      open(control);
      const request = freeze({ ...wire, rpcUrl, blockNumber: source.number, sourcePin: pin });
      const response = await owned(() => lease.strictSimulate(request, control), control);
      const currentPin = leasePin(lease, source);
      if (currentPin.chainId !== pin.chainId || currentPin.blockHash !== pin.blockHash || currentPin.stateRoot !== pin.stateRoot) {
        fatal({ kind: "source-fault" }, "transport-pin-changed");
      }
      // Validate BEFORE either Success or Revert can become Family evidence.
      // A late integrity fault is not hidden by an expired quote deadline.
      const checked = responseSnapshot(response, request, source, observe, fatal);
      open(control);
      return { ...checked, reportEffects };
  }
  return Object.freeze({
    async simulate(invocation: Parameters<StrictSimulationTransport["simulate"]>[0]) {
      const checked = await execute(invocation, false);
      if (checked.kind === "Revert") {
        throw Object.assign(new Error("revm strict main call reverted"), { code: "CALL_EXCEPTION", data: checked.data });
      }
      if (checked.kind !== "Success") throw new RevmStrictError("execution", "strict simulation did not complete main call");
      return freeze({ data: checked.data, effects: checked.effects });
    },
    async simulatePrefix(invocation: Parameters<NonNullable<StrictSimulationTransport["simulatePrefix"]>>[0]) {
      const checked = await execute(invocation, true);
      if (checked.kind !== "Success" && checked.kind !== "Revert") {
        // Failure detail is diagnostic only. Never expose CALL_EXCEPTION or
        // top-level data that could turn a prefix revert into current evidence.
        throw Object.assign(new RevmStrictError("execution", "strict prefix simulation did not complete current request"),
          { exactPrefixFailure: checked.failure });
      }
      return freeze({ data: checked.data, ...(checked.reportEffects ? { effects: checked.effects } : {}),
        completion: checked.kind === "Success" ? "returned" as const : "reverted-as-declared" as const });
    },
  });
}

function prefixRequestSnapshot(invocation: Parameters<NonNullable<StrictSimulationTransport["simulatePrefix"]>>[0],
  authority: CentralCallerAuthority, gas: number, executorRuntimeCode?: ExecutorRuntimeCode): { wire: WireCall; observe: ReadonlySet<string> } {
  const p = record(invocation.prefix, ["executor", "calldata", "inputToken", "inputAmount"]);
  const executor = address(p.executor), inputToken = address(p.inputToken), calldata = bytes(p.calldata), inputAmount = amount(p.inputAmount);
  if (executor !== address(authority.executor) || /^0x0{40}$/.test(executor) || /^0x0{40}$/.test(inputToken) || inputAmount === "0" || calldata === "0x" ||
    authority.transactionOrigin === undefined) invalid();
  const trialPrefix = freeze({ executor, inputToken, calldata, inputAmount,
    ...(executorRuntimeCode === undefined ? {} : { executorRuntimeCode }) });
  const value = invocation.request;
  if (!object(value)) invalid();
  if (value.kind === "state-override-simulation" || value.kind === "effect-delta-simulation") {
    const result = requestSnapshot(value, authority, gas);
    // The prefix owns the trial's sole initial balance. A current-leg override
    // must never erase the balance changes produced by preceding execution.
    const { tokenDeals, nativeBalanceWei, ...wire } = result.wire;
    if (wire.callerMode !== "impersonated-call-frame" || (tokenDeals?.length ?? 0) > 1 ||
      (nativeBalanceWei !== undefined && nativeBalanceWei !== "0")) invalid();
    return { observe: result.observe, wire: freeze({ ...wire, trialPrefix,
      callerMode: "impersonated-call-frame", transactionOrigin: authority.transactionOrigin }) };
  }
  const r = record(value, value.kind === "eth-call"
    ? ["id", "required", "kind", "to", "data", "caller", "completion"]
    : value.kind === "get-storage" ? ["id", "required", "kind", "address", "slot"]
    : ["id", "required", "kind", "address"]);
  if (typeof r.id !== "string" || !r.id.length || (r.required !== undefined && typeof r.required !== "boolean")) invalid();
  let from = `0x${"0".repeat(40)}`, to: string, data = "0x", stateRead: StrictSimulateRequest["stateRead"];
  if (r.kind === "eth-call") {
    if (r.completion !== "return-data" && r.completion !== "return-or-revert-data") invalid();
    from = callerSnapshot(r.caller === undefined ? { kind: "none" } : r.caller, authority).address;
    to = address(r.to); data = bytes(r.data);
  } else if (r.kind === "get-code" || r.kind === "get-storage") {
    to = address(r.address);
    if (r.kind === "get-storage") {
      if (typeof r.slot !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(r.slot)) invalid();
      stateRead = { kind: r.kind, address: to, slot: `0x${r.slot.slice(2).padStart(64, "0").toLowerCase()}` };
    } else stateRead = { kind: r.kind, address: to };
  } else invalid();
  return { observe: new Set(), wire: freeze({ from, to, data, trialPrefix, callerMode: "impersonated-call-frame",
    transactionOrigin: authority.transactionOrigin, gasLimit: gas, executionGasLimit: gas,
    ...(stateRead === undefined ? {} : { stateRead }), preCalls: [], observeTokenBalances: [],
    observeNativeBalances: [], observeTotalSupply: [], observeLogs: false }) };
}

function requestSnapshot(value: unknown, authority: CentralCallerAuthority, gas: number): { wire: WireCall; observe: ReadonlySet<string> } {
  const r = record(value, ["id", "required", "kind", "call", "preCalls", "overrideIntent", "observe", "observeTokenBalances"]);
  if (typeof r.id !== "string" || r.id.length === 0 || (r.required !== undefined && typeof r.required !== "boolean") ||
    typeof r.kind !== "string" || !["state-override-simulation", "effect-delta-simulation"].includes(r.kind)) invalid();
  const call = record(r.call, ["caller", "executionMode", "to", "data"]);
  const caller = callerSnapshot(call.caller, authority);
  const from = caller.address, to = address(call.to), data = bytes(call.data);
  const mode = call.executionMode === undefined ? "top-level" : call.executionMode;
  if (mode !== "top-level" && mode !== "impersonated-call-frame") invalid();
  if (mode === "impersonated-call-frame" && authority.transactionOrigin === undefined) invalid();
  const override = record(r.overrideIntent, ["caller", "nativeBalanceWei", "tokenBalances"]);
  if (callerSnapshot(override.caller, authority).key !== caller.key) invalid();
  const tokenDeals = array(override.tokenBalances === undefined ? [] : override.tokenBalances).map(value => {
    const d = record(value, ["token", "amount"]);
    return { token: address(d.token), to: from, amount: amount(d.amount) };
  });
  unique(tokenDeals.map(d => d.token));
  const preCalls = array(r.preCalls === undefined ? [] : r.preCalls).map(value => {
    const c = record(value, ["caller", "to", "data"]);
    if (callerSnapshot(c.caller, authority).key !== caller.key) invalid();
    return { from, to: address(c.to), calldata: bytes(c.data) };
  });
  const observations = array(r.observe);
  if (!observations.every(e => typeof e === "string" && EFFECTS.includes(e))) invalid();
  unique(observations);
  const observe = new Set(observations as string[]);
  let pairs: { token: string; account: string }[];
  if (r.observeTokenBalances !== undefined) {
    if (!observe.has("token-delta")) invalid();
    pairs = array(r.observeTokenBalances).map(value => {
      const p = record(value, ["token", "account"]);
      let account: string;
      if (typeof p.account === "string") account = address(p.account);
      else {
        const bound = callerSnapshot(p.account, authority);
        // Preserve the request-program's homogeneous symbolic caller role.
        if (bound.kind === "none" || bound.kind !== caller.kind) invalid();
        account = bound.address;
      }
      return { token: address(p.token), account };
    });
    unique(pairs.map(p => `${p.token}:${p.account}`));
  } else {
    // Undefined keeps the existing default scope, but only for a declared
    // token-delta observation. Explicit [] never falls back to this scope.
    pairs = observe.has("token-delta") ? [...new Set([...tokenDeals.map(d => d.token), to])].map(token => ({ token, account: from })) : [];
  }
  return { observe, wire: freeze({ from, to, data, callerMode: mode, gasLimit: gas, executionGasLimit: gas,
    ...(mode === "impersonated-call-frame" ? { transactionOrigin: authority.transactionOrigin! } : {}),
    ...(override.nativeBalanceWei === undefined ? {} : { nativeBalanceWei: amount(override.nativeBalanceWei) }),
    tokenDeals, preCalls, observeTokenBalances: pairs,
    observeNativeBalances: observe.has("native-delta") ? [from] : [],
    observeTotalSupply: observe.has("total-supply-delta") ? [to] : [], observeLogs: observe.has("logs") }) };
}

function callerSnapshot(value: unknown, authority: CentralCallerAuthority): { key: string; kind: string; address: string } {
  const c = record(value, ["kind", "evidenceId"]);
  if (c.kind !== "verified-actor" && Reflect.ownKeys(c).includes("evidenceId")) invalid();
  let resolved: unknown;
  switch (c.kind) {
    case "none": resolved = `0x${"0".repeat(40)}`; break;
    case "executor": resolved = authority.executor; break;
    case "transaction-origin": resolved = authority.transactionOrigin; break;
    case "observed-sender": resolved = authority.observedSender; break;
    case "verified-actor":
      if (typeof c.evidenceId !== "string" || !c.evidenceId.length || !Object.hasOwn(authority.verifiedActors ?? {}, c.evidenceId)) invalid();
      resolved = authority.verifiedActors![c.evidenceId]; break;
    default: invalid();
  }
  return { key: JSON.stringify([c.kind, c.evidenceId ?? null]), kind: c.kind, address: address(resolved) };
}

function responseSnapshot(value: unknown, request: StrictSimulateRequest, source: CanonicalSource,
  observe: ReadonlySet<string>, fatal: (reason: RevmFatalReason, stage?: RevmFaultStage) => never): {
    kind: string; data: string; effects: ObservedEffects; failure?: ExactPrefixFailure;
  } {
  const bad = (): never => fatal({ kind: "protocol-fault" }, "transport-response");
  const r = object(value) ? value : bad();
  if (r.ok === false) {
    if (typeof r.errorKind !== "string" || !["validation", "execution", "observation"].includes(r.errorKind) ||
      [r.strict, r.sourceAttestation, r.success, r.output, r.gasUsed, r.revertReason, r.fatal].some(v => v !== undefined)) bad();
    throw new RevmStrictError(r.errorKind as "validation" | "execution" | "observation", "strict simulation transport failed");
  }
  if (r.ok !== true || r.fatal !== undefined) bad();
  const att = r.sourceAttestation, pin = request.sourcePin!;
  if (!object(att) || att.kind !== "node-attested" || att.blockNumber !== source.number || att.chainId !== pin.chainId ||
    !hash32(att.blockHash) || att.blockHash.toLowerCase() !== source.hash || !hash32(att.parentHash) || !hash32(att.stateRoot) ||
    (pin.stateRoot !== undefined && pin.stateRoot !== att.stateRoot.toLowerCase())) fatal({ kind: "source-fault" }, "transport-attestation");
  try {
    record(att, ["kind", "blockNumber", "chainId", "blockHash", "parentHash", "stateRoot"]);
  } catch { fatal({ kind: "source-fault" }, "transport-attestation-shape"); }
  // Never retain mutable response objects across the evidence boundary.
  try {
    const s = record(r.strict, ["outcome", "executionGasUsed", "tokenDeltas", "nativeDeltas", "totalSupplyDeltas", "logs", "counterfactualExecutorCode"]);
    const code = request.trialPrefix?.executorRuntimeCode;
    if (code !== undefined) {
      const proof = record(s.counterfactualExecutorCode, ["address", "keccak256"]);
      if (address(proof.address) !== request.trialPrefix!.executor || proof.keccak256 !== code.keccak256) invalid();
    } else if (s.counterfactualExecutorCode !== undefined) invalid();
    const o = record(s.outcome, ["kind", "phase", "preCallIndex", "output", "reason"]);
    if (typeof o.kind !== "string" || !["Success", "Revert", "Halt"].includes(o.kind) || r.success !== (o.kind === "Success") ||
      r.error !== undefined || r.errorKind !== undefined || !uint(s.executionGasUsed) || r.gasUsed !== s.executionGasUsed ||
      BigInt(s.executionGasUsed) > BigInt(request.executionGasLimit!) ||
      typeof r.latencyMs !== "number" || !Number.isFinite(r.latencyMs) || r.latencyMs < 0) invalid();
    if (o.phase === "preCall") {
      if (!nonnegativeInteger(o.preCallIndex) || o.preCallIndex >= (request.preCalls?.length ?? 0) + (request.trialPrefix ? 1 : 0) || o.kind === "Success") invalid();
    } else if (o.phase !== "main" || Object.hasOwn(o, "preCallIndex")) invalid();
    if (o.kind === "Halt") {
      if (typeof o.reason !== "string" || !o.reason.length || Object.hasOwn(o, "output") || r.output !== undefined) invalid();
    } else if (r.output !== bytes(o.output) || Object.hasOwn(o, "reason")) invalid();
    if (r.revertReason !== (o.kind === "Revert" ? o.output : undefined)) invalid();
    if (request.stateRead !== undefined && o.phase === "main" &&
      (o.kind !== "Success" || (request.stateRead.kind === "get-storage" && !hash32(o.output)))) invalid();
    const tokens = array(s.tokenDeltas), natives = array(s.nativeDeltas), supplies = array(s.totalSupplyDeltas), logs = array(s.logs);
    if (o.kind !== "Success") {
      if (tokens.length || natives.length || supplies.length || logs.length) invalid();
      const failure: ExactPrefixFailure = freeze({ kind: o.kind as "Revert" | "Halt", phase: o.phase as "main" | "preCall",
        ...(o.phase === "preCall" ? { preCallIndex: o.preCallIndex as number } : {}),
        ...(o.kind === "Revert" ? { output: o.output as string } : { reason: o.reason as string }) });
      return freeze({ kind: o.phase === "main" ? String(o.kind) : "preCall", data: o.kind === "Revert" ? o.output as string : "0x", failure, effects: {
        ...(observe.has("token-delta") ? { tokenDeltas: [] } : {}), ...(observe.has("native-delta") ? { nativeDeltas: [] } : {}),
        ...(observe.has("total-supply-delta") ? { totalSupplyDeltas: [] } : {}), ...(observe.has("logs") ? { logs: [] } : {}) } });
    }
    const pairs = request.observeTokenBalances!, accounts = request.observeNativeBalances!, totalSupply = request.observeTotalSupply!;
    if (tokens.length !== pairs.length || natives.length !== accounts.length || supplies.length !== totalSupply.length || (!request.observeLogs && logs.length)) invalid();
    const tokenDeltas = tokens.map((value, i) => {
      const d = record(value, ["token", "account", "delta"]), token = address(d.token), account = address(d.account);
      if (token !== pairs[i]!.token || account !== pairs[i]!.account) invalid();
      return { token, account, delta: signed(d.delta) };
    });
    const nativeDeltas = natives.map((value, i) => {
      const d = record(value, ["account", "before", "after", "delta"]), account = address(d.account), delta = signed(d.delta);
      if (account !== accounts[i] || !uint(d.before) || !uint(d.after) || BigInt(d.after) - BigInt(d.before) !== delta) invalid();
      return { account, delta };
    });
    const totalSupplyDeltas = supplies.map((value, i) => {
      const d = record(value, ["token", "delta"]), token = address(d.token);
      if (token !== totalSupply[i]) invalid();
      return { token, delta: signed(d.delta) };
    });
    const observedLogs = logs.map(value => {
      const log = record(value, ["address", "topics", "data"]), topics = array(log.topics);
      if (topics.length > 4 || !topics.every(hash32)) invalid();
      return { address: address(log.address), data: bytes(log.data), topics: (topics as string[]).map(t => t.toLowerCase()) };
    });
    return freeze({ kind: "Success", data: bytes(o.output), effects: {
      ...(observe.has("token-delta") ? { tokenDeltas } : {}), ...(observe.has("native-delta") ? { nativeDeltas } : {}),
      ...(observe.has("total-supply-delta") ? { totalSupplyDeltas } : {}), ...(observe.has("logs") ? { logs: observedLogs } : {}) } });
  } catch { return bad(); }
}

function invalid(): never { throw new RevmStrictError("validation", "invalid strict simulation binding or request"); }
function codeSnapshot(value: unknown): ExecutorRuntimeCode {
  const c = record(value, ["code", "keccak256"]), code = bytes(c.code);
  if (code === "0x" || !hash32(c.keccak256) || keccak256(code) !== c.keccak256.toLowerCase()) invalid();
  return freeze({ code, keccak256: c.keccak256.toLowerCase() });
}
function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && !Array.isArray(v); }
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(v) || Reflect.ownKeys(v).some(k => typeof k !== "string" || !keys.includes(k))) invalid();
  return v;
}
function array(v: unknown): unknown[] {
  if (!Array.isArray(v) || Reflect.ownKeys(v).some(k => k !== "length" &&
    (typeof k !== "string" || !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length))) invalid();
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) invalid();
  return v;
}
function unique(v: readonly unknown[]): void { if (new Set(v).size !== v.length) invalid(); }
function address(v: unknown): string { if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) invalid(); return v.toLowerCase(); }
function bytes(v: unknown): string { if (typeof v !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(v)) invalid(); return v; }
function hash32(v: unknown): v is string { return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v); }
function nonnegativeInteger(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function positiveInteger(v: unknown): v is number { return nonnegativeInteger(v) && v > 0; }
function amount(v: unknown): string { if (typeof v !== "bigint" || v < 0n || v >= UINT256) invalid(); return v.toString(); }
function uint(v: unknown): v is string { return typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 78 && BigInt(v) < UINT256; }
function signed(v: unknown): bigint { if (typeof v !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(v) || !uint(v.replace(/^-/, ""))) invalid(); return BigInt(v); }
function sourceSnapshot(value: unknown): CanonicalSource {
  const s = record(value, ["number", "hash", "generation"]);
  if (!nonnegativeInteger(s.number) || !nonnegativeInteger(s.generation) || !hash32(s.hash)) invalid();
  return freeze({ number: s.number, hash: s.hash.toLowerCase(), generation: s.generation });
}
function sameSource(a: CanonicalSource, b: CanonicalSource): boolean { return a.number === b.number && a.hash === b.hash && a.generation === b.generation; }
function controlSnapshot(control: AdapterWorkControl | undefined): AdapterWorkControl | undefined {
  if (control === undefined) return undefined;
  const c = record(control, ["signal", "deadlineAtMs"]);
  if ((c.signal !== undefined && !(c.signal instanceof AbortSignal)) ||
    (c.deadlineAtMs !== undefined && (typeof c.deadlineAtMs !== "number" || !Number.isFinite(c.deadlineAtMs)))) invalid();
  return Object.freeze({ signal: c.signal as AbortSignal | undefined, deadlineAtMs: c.deadlineAtMs as number | undefined });
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fatalSnapshot(reason: RevmFatalReason): RevmFatalReason {
  if (reason?.kind === "source-fault" || reason?.kind === "protocol-fault") return { kind: reason.kind };
  if (reason?.kind === "rpc-throttle" && ["http429", "rpc-limit-code", "rpc-rate-limit", "rpc-quota"].includes(reason.category) &&
    (reason.httpStatus === undefined || reason.httpStatus === 429) && (reason.rpcCode === undefined || Number.isSafeInteger(reason.rpcCode))) {
    return { kind: reason.kind, category: reason.category, ...(reason.httpStatus === undefined ? {} : { httpStatus: reason.httpStatus }),
      ...(reason.rpcCode === undefined ? {} : { rpcCode: reason.rpcCode }) };
  }
  return { kind: "protocol-fault" };
}
