import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { keccak256 } from "ethers";

type DaemonProc = ChildProcessByStdio<Writable, Readable, null>;

export interface OverlayPreCall {
  from: string;
  to: string;
  calldata: string;
  gasLimit?: number;
  allowanceSlot?: number;
}

export interface OverlayTokenDeal {
  token: string;
  to: string;
  amount: string;
  balanceSlot?: number;
}

export interface TokenBalanceHint {
  token: string;
  account: string;
  balanceSlot?: number;
}

export interface TokenAllowanceHint {
  token: string;
  owner: string;
  spender: string;
  allowanceSlot?: number;
}

export interface OverlayStateOverride {
  address: string;
  slot: string;
  value: string;
}

export interface PrepareRequest {
  blockNumber: number;
  rpcUrl?: string;
  funded?: string[];
  stateOverrides?: OverlayStateOverride[];
  tokenDeals?: OverlayTokenDeal[];
  preCalls?: OverlayPreCall[];
  prewarm?: string[];
  /** View calls traced alongside the last preCall (route-hop quoters) so the
   *  solver's first quotes start warm. Results are discarded. */
  prewarmCalls?: OverlayPreCall[];
}

export interface WarmRequest {
  blockNumber: number;
  rpcUrl?: string;
  /** Basic accounts/code to fetch before a same-block prepare. */
  prewarm?: string[];
  /** ERC20 balance slots likely to be touched by tokenDeals in final overlay. */
  tokenBalanceHints?: TokenBalanceHint[];
  /** ERC20 allowance slots likely to be touched by victim-overlay approve. */
  tokenAllowanceHints?: TokenAllowanceHint[];
  /** Representative quote view-calls, one per recurring hot pool, traced to
   *  seed each pool's slots into the warm cache ahead of any hint. */
  prewarmCalls: OverlayPreCall[];
}

export interface QuoteCallRequest {
  from?: string;
  to: string;
  data: string;
  gasLimit?: number;
}

export interface SimulatePreparedRequest {
  owner: string;
  executor: string;
  calldata: string;
  profitToken: string;
  gasLimit?: number;
}

export interface DaemonResponse {
  sourceAttestation?: RevmSourceAttestation;
  ok: boolean;
  error?: string;
  errorKind?: "validation" | "execution" | "observation";
  success?: boolean;
  output?: string;
  profit?: string;
  gasUsed?: string;
  revertReason?: string;
  latencyMs: number;
  missingStateKeys?: string[];
  cacheStats?: {
    warmHits: number;
    coldMisses: number;
  };
  seedStats?: {
    tracedCalls: number;
    traceErrors: number;
    seededAccounts: number;
    seededSlots: number;
    traceMs: number;
    roundTrips: number;
  };
  strict?: {
    counterfactualExecutorCode?: { address: string; keccak256: string };
    outcome: StrictExecutionOutcome;
    /** Unrefunded execution gas; inner mode excludes outer/intrinsic gas. */
    executionGasUsed: string;
    nativeDeltas: { account: string; before: string; after: string; delta: string }[];
    tokenDeltas: {
      token: string;
      account: string;
      delta: string;
    }[];
    totalSupplyDeltas: {
      token: string;
      delta: string;
    }[];
    logs: {
      address: string;
      topics: string[];
      data: string;
    }[];
  };
}

export type StrictExecutionOutcome = (
  | { kind: "Success" | "Revert"; output: string }
  | { kind: "Halt"; reason: string }
) & ({ phase: "main" } | { phase: "preCall"; preCallIndex: number });

export class RevmStrictError extends Error {
  constructor(readonly kind: "validation" | "execution" | "observation", message: string) {
    super(message); this.name = "RevmStrictError";
  }
}

/** Counterfactual code for the strict request's `to` only; never account state. */
export interface ExecutorRuntimeCode { code: string; keccak256: string }

export interface StrictSimulateRequest {
  blockNumber: number;
  sourcePin?: RevmSourcePin;
  executorRuntimeCode?: ExecutorRuntimeCode;
  rpcUrl?: string;
  from: string;
  to: string;
  data: string;
  gasLimit?: number;
  /** Required for inner mode. Shared execution budget; per-call limits only cap it. */
  executionGasLimit?: number;
  /** Explicit ORIGIN for inner mode, never inferred from a contract actor. */
  transactionOrigin?: string;
  /** Exact caller balance before the envelope, not call value or profit. */
  nativeBalanceWei?: string;
  /** Omitted means no native probes. Explicit [] is empty. */
  observeNativeBalances?: string[];
  /** Exact ordered pairs. Cannot coexist with either legacy observation list. */
  observeTokenBalances?: { token: string; account: string }[];
  preCalls?: OverlayPreCall[];
  tokenDeals?: OverlayTokenDeal[];
  observeTokens?: string[];
  observeAccounts?: string[];
  observeTotalSupply?: string[];
  observeLogs?: boolean;
  /**
   * Caller execution mode: "top-level" (default, EIP-3607 enforced) or
   * "impersonated-call-frame" (one isolated atomic CALL envelope with a
   * separately bound origin). This does not replay the unknown outer caller.
   */
  callerMode?: "top-level" | "impersonated-call-frame";
}

const address20 = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const bytesHex = (v: unknown): v is string => typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
const uint256 = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)
  && v.length <= 78 && BigInt(v) < (1n << 256n);
const gasAmount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
function strictRequest(req: StrictSimulateRequest): void {
  const bad = () => { throw new RevmStrictError("validation", "invalid strict simulation request"); };
  const record = (v: unknown, keys: string[]) => v !== null && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).every(k => keys.includes(k));
  if (!record(req, ["blockNumber", "sourcePin", "rpcUrl", "from", "to", "data", "gasLimit", "executionGasLimit",
    "transactionOrigin", "nativeBalanceWei", "observeNativeBalances", "observeTokenBalances", "preCalls", "tokenDeals",
    "observeTokens", "observeAccounts", "observeTotalSupply", "observeLogs", "callerMode", "executorRuntimeCode"])
    || !Number.isSafeInteger(req.blockNumber) || req.blockNumber < 0 || !address20(req.from) || !address20(req.to)
    || (req.rpcUrl !== undefined && (typeof req.rpcUrl !== "string" || !req.rpcUrl.trim()))
    || !bytesHex(req.data) || (req.gasLimit !== undefined && !gasAmount(req.gasLimit))
    || (req.executionGasLimit !== undefined && !gasAmount(req.executionGasLimit))
    || (req.nativeBalanceWei !== undefined && !uint256(req.nativeBalanceWei))
    || (req.callerMode !== undefined && !["top-level", "impersonated-call-frame"].includes(req.callerMode))
    || (req.transactionOrigin !== undefined && !address20(req.transactionOrigin))
    || (req.observeLogs !== undefined && typeof req.observeLogs !== "boolean")) bad();
  if (req.executorRuntimeCode !== undefined) {
    const v = req.executorRuntimeCode;
    if (!req.sourcePin || req.to.toLowerCase() === req.from.toLowerCase()
      || !record(v, ["code", "keccak256"]) || !bytesHex(v.code) || v.code === "0x"
      || !hash32(v.keccak256) || keccak256(v.code) !== v.keccak256.toLowerCase()) bad();
  }
  if (req.callerMode === "impersonated-call-frame") {
    if (req.transactionOrigin === undefined || req.executionGasLimit === undefined) bad();
  } else if (req.transactionOrigin !== undefined && req.transactionOrigin.toLowerCase() !== req.from.toLowerCase()) bad();
  const uniqueAddresses = (values: unknown) => {
    if (values === undefined) return;
    if (!Array.isArray(values) || ![...values].every(address20)
      || new Set(values.map(v => v.toLowerCase())).size !== values.length) bad();
  };
  for (const values of [req.observeNativeBalances, req.observeTokens, req.observeAccounts, req.observeTotalSupply]) uniqueAddresses(values);
  if (req.observeTokenBalances !== undefined) {
    if (req.observeTokens !== undefined || req.observeAccounts !== undefined || !Array.isArray(req.observeTokenBalances)) bad();
    const seen = new Set<string>();
    for (const pair of req.observeTokenBalances) {
      if (!record(pair, ["token", "account"]) || !address20(pair.token) || !address20(pair.account)) bad();
      const key = `${pair.token.toLowerCase()}:${pair.account.toLowerCase()}`;
      if (seen.has(key)) bad(); seen.add(key);
    }
  }
  if (req.preCalls !== undefined) {
    if (!Array.isArray(req.preCalls)) bad();
    for (const call of req.preCalls) {
      if (!record(call, ["from", "to", "calldata", "gasLimit", "allowanceSlot"]) || !address20(call.from)
        || call.from.toLowerCase() !== req.from.toLowerCase() || !address20(call.to) || !bytesHex(call.calldata)
        || (call.gasLimit !== undefined && !gasAmount(call.gasLimit))
        || (call.allowanceSlot !== undefined && (!Number.isSafeInteger(call.allowanceSlot) || call.allowanceSlot < 0))) bad();
    }
  }
  if (req.tokenDeals !== undefined) {
    if (!Array.isArray(req.tokenDeals)) bad();
    const seen = new Set<string>();
    for (const deal of req.tokenDeals) {
      if (!record(deal, ["token", "to", "amount", "balanceSlot"]) || !address20(deal.token) || !address20(deal.to)
        || deal.to.toLowerCase() !== req.from.toLowerCase() || !uint256(deal.amount)
        || (deal.balanceSlot !== undefined && (!Number.isSafeInteger(deal.balanceSlot) || deal.balanceSlot < 0))) bad();
      if (seen.has(deal.token.toLowerCase())) bad(); seen.add(deal.token.toLowerCase());
    }
  }
}

function strictResponse(resp: DaemonResponse, req: StrictSimulateRequest): void {
  function bad(): never { throw new Error("invalid strict response"); }
  if (!resp.ok) {
    if (!["validation", "execution", "observation"].includes(resp.errorKind ?? "") || resp.strict !== undefined) bad();
    return;
  }
  const s = resp.strict; const o = s?.outcome;
  const override = req.executorRuntimeCode;
  if (override ? s?.counterfactualExecutorCode?.address !== req.to.toLowerCase()
    || s.counterfactualExecutorCode.keccak256 !== override.keccak256.toLowerCase()
    : s?.counterfactualExecutorCode !== undefined) bad();
  if (!s || !o || !["Success", "Revert", "Halt"].includes(o.kind)
    || resp.errorKind !== undefined || resp.error !== undefined
    || (o.phase !== "main" && o.phase !== "preCall")
    || (o.phase === "preCall" && (!Number.isSafeInteger(o.preCallIndex) || o.preCallIndex < 0
      || o.preCallIndex >= (req.preCalls?.length ?? 0) || o.kind === "Success"))
    || (o.phase === "main" && "preCallIndex" in o)
    || resp.success !== (o.kind === "Success") || !uint256(s.executionGasUsed) || resp.gasUsed !== s.executionGasUsed) bad();
  if (o.kind === "Halt") {
    if (typeof o.reason !== "string" || !o.reason || "output" in o || resp.output !== undefined) bad();
  } else if (!bytesHex(o.output) || resp.output !== o.output || "reason" in o) bad();
  if (resp.revertReason !== (o.kind === "Revert" ? o.output : undefined)) bad();
  if (req.callerMode === "impersonated-call-frame" && BigInt(s.executionGasUsed) > BigInt(req.executionGasLimit!)) bad();
  const pairs = req.observeTokenBalances ?? (req.observeTokens ?? []).flatMap(token =>
    ((req.observeAccounts?.length ?? 0) > 0 ? req.observeAccounts! : [req.from]).map(account => ({ token, account })));
  const natives = req.observeNativeBalances ?? []; const supplies = req.observeTotalSupply ?? [];
  const signed = (v: unknown) => typeof v === "string" && /^(0|-?[1-9][0-9]*)$/.test(v) && uint256(v.replace(/^-/, ""));
  const same = (a: unknown, b: string) => address20(a) && a.toLowerCase() === b.toLowerCase();
  if (![s.tokenDeltas, s.nativeDeltas, s.totalSupplyDeltas, s.logs].every(Array.isArray)) bad();
  if (o.kind !== "Success") {
    if (s.tokenDeltas.length || s.nativeDeltas.length || s.totalSupplyDeltas.length || s.logs.length) bad();
    return;
  }
  if (s.tokenDeltas.length !== pairs.length || s.nativeDeltas.length !== natives.length || s.totalSupplyDeltas.length !== supplies.length) bad();
  s.tokenDeltas.forEach((v, i) => { if (!v || !same(v.token, pairs[i]!.token) || !same(v.account, pairs[i]!.account) || !signed(v.delta)) bad(); });
  s.nativeDeltas.forEach((v, i) => { if (!v || !same(v.account, natives[i]!) || !uint256(v.before) || !uint256(v.after)
    || !signed(v.delta) || BigInt(v.after) - BigInt(v.before) !== BigInt(v.delta)) bad(); });
  s.totalSupplyDeltas.forEach((v, i) => { if (!v || !same(v.token, supplies[i]!) || !signed(v.delta)) bad(); });
  if (!req.observeLogs && s.logs.length) bad();
  s.logs.forEach(v => { if (!v || !address20(v.address) || !bytesHex(v.data) || !Array.isArray(v.topics) || !v.topics.every(hash32)) bad(); });
}

/** Back-compat one-shot request: a fully self-described victim+arb simulation. */
export interface RevmSimRequest {
  blockNumber: number;
  executor: string;
  owner: string;
  calldata: string;
  profitToken: string;
  gasLimit?: number;
  rpcUrl?: string;
  stateOverrides?: OverlayStateOverride[];
  preCalls?: OverlayPreCall[];
  tokenDeals?: OverlayTokenDeal[];
}

export interface RevmSimResponse {
  success: boolean;
  profit: string;
  gasUsed: string;
  revertReason: string | null;
  latencyMs: number;
  missingStateKeys: string[];
}

export interface RevmRequestControl {
  signal?: AbortSignal;
  /** Absolute wall-clock deadline, including time spent in the local queue. */
  deadlineAtMs?: number;
}

/** Node-attested selection, not header-RLP or account/storage proof verification. */
export interface RevmSourcePin {
  chainId: number;
  blockHash: string;
  stateRoot?: string;
}

export interface RevmSourceAttestation extends Readonly<RevmSourcePin> {
  readonly kind: "node-attested";
  readonly blockNumber: number;
  readonly stateRoot: string;
  readonly parentHash: string;
}

const hash32 = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

function sourcePin(payload: Record<string, unknown>): Readonly<RevmSourcePin> | undefined {
  if (payload.sourcePin === undefined) return undefined;
  const pin = payload.sourcePin as RevmSourcePin;
  // The existing VM configuration is mainnet; never attest another chain under it.
  if (payload.op !== "strictSimulate" || !pin || typeof pin !== "object"
    || Object.keys(pin).some(k => !["chainId", "blockHash", "stateRoot"].includes(k))
    || pin.chainId !== 1 || !hash32(pin.blockHash)
    || (pin.stateRoot !== undefined && !hash32(pin.stateRoot))
    || !Number.isSafeInteger(payload.blockNumber) || (payload.blockNumber as number) < 0
    || typeof payload.rpcUrl !== "string" || !payload.rpcUrl.trim()) throw new RevmStrictError("validation", "invalid revm-sim source pin");
  return Object.freeze({ chainId: pin.chainId, blockHash: pin.blockHash.toLowerCase(),
    ...(pin.stateRoot === undefined ? {} : { stateRoot: pin.stateRoot.toLowerCase() }) });
}

export type RevmFatalReason = Readonly<{
  kind: "rpc-throttle";
  category: "http429" | "rpc-limit-code" | "rpc-rate-limit" | "rpc-quota";
  httpStatus?: 429;
  rpcCode?: number;
}> | Readonly<{ kind: "source-fault" | "protocol-fault" }>;

export class RevmFatalError extends Error {
  constructor(readonly fatal: RevmFatalReason) {
    super(`revm-sim fatal ${fatal.kind}`);
    this.name = "RevmFatalError";
  }
}

function normalizedFatal(fatal: RevmFatalReason | undefined): RevmFatalReason | undefined {
  if (fatal === undefined) return undefined;
  if (fatal?.kind === "source-fault" || fatal?.kind === "protocol-fault") {
    if (Object.keys(fatal).some(k => k !== "kind")) throw new Error("fatal shape");
    return Object.freeze({ kind: fatal.kind });
  }
  if (!fatal || fatal.kind !== "rpc-throttle"
    || Object.keys(fatal).some(k => !["kind", "category", "httpStatus", "rpcCode"].includes(k))
    || !["http429", "rpc-limit-code", "rpc-rate-limit", "rpc-quota"].includes(fatal.category)
    || (fatal.category === "http429" ? fatal.httpStatus !== 429 || fatal.rpcCode !== undefined : fatal.httpStatus !== undefined)
    || (fatal.category === "rpc-limit-code" && fatal.rpcCode !== 429 && fatal.rpcCode !== -32005)
    || (fatal.rpcCode !== undefined && !Number.isSafeInteger(fatal.rpcCode))) throw new Error("fatal shape");
  return Object.freeze({ kind: fatal.kind, category: fatal.category,
    ...(fatal.httpStatus === undefined ? {} : { httpStatus: fatal.httpStatus }),
    ...(fatal.rpcCode === undefined ? {} : { rpcCode: fatal.rpcCode }) });
}

interface Pending {
  id: string;
  line: string;
  dispatchedAtMs?: number;
  resolve: (value: DaemonResponse) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
  expired: () => Error | undefined;
  pin?: Readonly<RevmSourcePin>;
  blockNumber?: number;
  strictRequest?: StrictSimulateRequest;
}

/**
 * Persistent transport to the `revm-sim serve` daemon. One long-lived process
 * holds the warm per-block chain cache, so the many quote/simulate calls inside
 * a single hint reuse fetched state instead of re-spawning a cold process each
 * time (which is what made every prior sim pay full RPC latency).
 *
 * Epoch/ID-correlated JSON lines, with only one physical request outstanding.
 * Cancellation invalidates the owned daemon and its prepared state permanently;
 * callers must explicitly create a new client, never replay implicitly.
 */
export class RevmSimClient {
  private proc: DaemonProc | null = null;
  private buffer = "";
  private readonly queue: Pending[] = [];
  private active?: Pending;
  private readonly epoch = randomUUID();
  private nextId = 0n;
  private terminal?: Error;
  private retiredActiveId?: string;
  private fatalReported = false;
  private drained: Promise<void> = Promise.resolve();
  private killTimer?: NodeJS.Timeout;
  private fullyClosed = false;
  private ownedGroup = false;
  private readonly onFatal?: (reason: RevmFatalReason) => void;
  private readonly timeoutMs: number;
  private readonly manifestPath: string;
  private readonly executablePath?: string;

  get isTerminal(): boolean {
    return this.terminal !== undefined;
  }

  constructor(options: { manifestPath?: string; executablePath?: string; timeoutMs?: number;
    onFatal?: (reason: RevmFatalReason) => void } = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("invalid revm-sim timeout");
    this.manifestPath = options.manifestPath ?? resolve("revm-sim", "Cargo.toml");
    this.executablePath = options.executablePath;
    this.onFatal = options.onFatal;
  }

  /** Overridable only for deterministic child/stdio fixtures. */
  protected spawnDaemon(command: string, args: string[], detached: boolean): DaemonProc {
    return spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], detached });
  }

  private ensureProc(): DaemonProc {
    if (this.terminal) throw this.terminal;
    if (this.proc) return this.proc;
    if (this.executablePath && !existsSync(this.executablePath)) {
      throw new Error("configured revm-sim executable missing");
    }
    const binary = resolve(this.manifestPath, "..", "target", "debug", "revm-sim");
    const useBinary = Boolean(this.executablePath) || existsSync(binary);
    const command = this.executablePath ?? (useBinary ? binary : "cargo");
    const args = useBinary
      ? ["serve"]
      : ["run", "--quiet", "--manifest-path", this.manifestPath, "--", "serve"];
    // The legacy cargo launcher can own a descendant daemon. Isolate that
    // launch in its own POSIX group; never kill an ambient process/group.
    if (!useBinary && process.platform === "win32") throw new Error("revm-sim requires a direct binary on Windows");
    this.ownedGroup = !useBinary;
    const proc = this.spawnDaemon(command, args, this.ownedGroup);
    this.proc = proc;
    let childClosed = false;
    this.drained = new Promise<void>((resolveDrain) => {
      const check = () => {
        if (!childClosed || !proc.stdin.closed || !proc.stdout.closed) return;
        this.fullyClosed = true;
        this.retiredActiveId = undefined;
        this.buffer = "";
        clearTimeout(this.killTimer);
        resolveDrain();
      };
      proc.once("close", () => { childClosed = true; check(); });
      proc.stdin.once("close", check);
      proc.stdout.once("close", check);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    const interrupted = (message: string) => this.fail(this.buffer.trim()
      ? new RevmFatalError(Object.freeze({ kind: "protocol-fault" })) : new Error(message));
    proc.on("error", () => interrupted("revm-sim daemon process failed"));
    proc.stdin.on("error", () => interrupted("revm-sim stdin failed"));
    proc.stdout.on("error", () => interrupted("revm-sim stdout failed"));
    proc.stdout.on("end", () => interrupted("revm-sim stdout ended"));
    proc.on("exit", () => interrupted("revm-sim daemon exited"));
    proc.on("close", () => interrupted("revm-sim daemon closed"));
    return proc;
  }

  private onData(chunk: string): void {
    if (this.terminal) { this.onRetiredData(chunk); return; }
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const pending = this.active;
      let resp: DaemonResponse & { epoch: string; requestId: string; fatal?: RevmFatalReason };
      try {
        resp = JSON.parse(line);
        if (!resp || !pending || resp.epoch !== this.epoch || resp.requestId !== pending.id
          || typeof resp.ok !== "boolean") throw new Error("identity");
        const fatal = normalizedFatal(resp.fatal);
        if (fatal) { this.fail(new RevmFatalError(fatal)); return; }
        const att = resp.sourceAttestation;
        if (pending.pin && resp.ok) {
          if (!att || att.kind !== "node-attested" || att.chainId !== pending.pin.chainId
            || att.blockNumber !== pending.blockNumber || !hash32(att.blockHash)
            || att.blockHash.toLowerCase() !== pending.pin.blockHash
            || !hash32(att.stateRoot) || !hash32(att.parentHash)
            || (pending.pin.stateRoot !== undefined && att.stateRoot.toLowerCase() !== pending.pin.stateRoot)) {
            this.fail(new RevmFatalError(Object.freeze({ kind: "source-fault" })));
            return;
          }
          resp.sourceAttestation = Object.freeze({ kind: "node-attested", chainId: att.chainId,
            blockNumber: att.blockNumber, blockHash: att.blockHash.toLowerCase(),
            stateRoot: att.stateRoot.toLowerCase(), parentHash: att.parentHash.toLowerCase() });
        } else if (att !== undefined) throw new Error("unexpected attestation");
        if (pending.strictRequest) strictResponse(resp, pending.strictRequest);
      } catch {
        this.fail(new RevmFatalError(Object.freeze({ kind: "protocol-fault" })));
        return;
      }
      const expired = pending.expired();
      if (expired) { this.fail(expired); return; }
      this.active = undefined;
      pending.cleanup();
      pending.resolve(resp);
    }
    // Defer dispatch until all lines in this chunk are checked, so a duplicate
    // cannot cause another physical operation before being detected.
    this.pump();
  }

  private signalOwned(signal: NodeJS.Signals): void {
    const proc = this.proc;
    if (!proc || this.fullyClosed) return;
    try {
      if (this.ownedGroup && proc.pid) process.kill(-proc.pid, signal);
      else if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
    } catch { /* Already gone; close/stdio events, not kill(), establish drain. */ }
  }

  private reportFatal(reason: RevmFatalReason): void {
    if (this.fatalReported) return;
    this.fatalReported = true;
    try { this.onFatal?.(reason); } catch { /* Observers cannot undo evidence. */ }
  }

  private onRetiredData(chunk: string): void {
    if (this.fullyClosed || this.retiredActiveId === undefined || this.fatalReported) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        if (!response || response.epoch !== this.epoch || response.requestId !== this.retiredActiveId
          || typeof response.ok !== "boolean") throw new Error("retired identity");
        const fatal = normalizedFatal(response.fatal);
        if (fatal) this.reportFatal(fatal);
        // Never accept late success/attestation/effects, resolve a promise or
        // dispatch queued work. Only already-issued physical fatal evidence
        // survives local cancellation until the actual child/stdio drain.
      } catch { this.reportFatal(Object.freeze({ kind: "protocol-fault" })); }
    }
  }

  private fail(err: Error): void {
    if (this.terminal) {
      if (err instanceof RevmFatalError && !this.fullyClosed) this.reportFatal(err.fatal);
      return;
    }
    this.terminal = err;
    this.retiredActiveId = this.active?.id;
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue.length = 0;
    // Terminalize and detach work before invoking an owner that may reenter
    // request/stop/drain. Still report fatal evidence before rejecting work.
    if (err instanceof RevmFatalError && !this.fullyClosed) this.reportFatal(err.fatal);
    if (this.retiredActiveId === undefined || this.fatalReported) this.buffer = "";
    // Expiry can be noticed midway through a chunk. Validate its remaining
    // complete frames now, not on another data event or as truncation on exit.
    // Incomplete frames retain the retired identity through child/stdio drain.
    else this.onRetiredData("");
    for (const p of pending) { p.cleanup(); p.reject(err); }
    if (!this.proc || this.fullyClosed) return;
    this.proc.stdin.destroy();
    this.signalOwned("SIGTERM");
    this.killTimer = setTimeout(() => this.signalOwned("SIGKILL"), 1_000);
    this.killTimer.unref();
  }

  private pump(): void {
    if (this.terminal || this.active) return;
    const pending = this.queue.shift();
    if (!pending) return;
    const expired = pending.expired();
    if (expired) { pending.cleanup(); pending.reject(expired); this.pump(); return; }
    this.active = pending;
    pending.dispatchedAtMs = Date.now();
    try {
      const proc = this.ensureProc();
      proc.stdin.write(pending.line, (err) => {
        if (err) this.fail(new Error("revm-sim request write failed"));
      });
    } catch { this.fail(new Error("revm-sim daemon start/write failed")); }
  }

  private request(payload: Record<string, unknown>, control: RevmRequestControl = {}): Promise<DaemonResponse> {
    if (this.terminal) return Promise.reject(this.terminal);
    const pin = sourcePin(payload);
    if (control.deadlineAtMs !== undefined && !Number.isFinite(control.deadlineAtMs)) {
      return Promise.reject(new Error("invalid revm-sim deadline"));
    }
    const signal = control.signal;
    const deadline = Math.min(Date.now() + this.timeoutMs, control.deadlineAtMs ?? Infinity);
    const expired = () => signal?.aborted ? new Error("revm-sim request aborted")
      : Date.now() >= deadline ? new Error("revm-sim request deadline timed out") : undefined;
    const early = expired();
    if (early) return Promise.reject(early);
    if (payload.op === "strictSimulate") {
      const { op: _, ...body } = payload;
      strictRequest(body as unknown as StrictSimulateRequest);
    }
    const id = (++this.nextId).toString();
    const line = JSON.stringify({ ...payload, ...(pin ? { sourcePin: pin } : {}), epoch: this.epoch, requestId: id }) + "\n";
    const enqueuedAtMs = Date.now();
    return new Promise<DaemonResponse>((resolveP, rejectP) => {
      const timing = (status: string, response?: DaemonResponse): void => {
        try {
          if (process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS !== "1" || !pin) return;
          const finishedAtMs = Date.now();
          const metric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
          console.log(`[revm-request-timing] ${JSON.stringify({
            sourceBlock: pending.blockNumber, sourceBlockHash: pin.blockHash, epoch: this.epoch, requestId: id,
            target: pending.strictRequest?.to, enqueuedAtMs, dispatchedAtMs: pending.dispatchedAtMs ?? null,
            queueMs: (pending.dispatchedAtMs ?? finishedAtMs) - enqueuedAtMs,
            serviceMs: pending.dispatchedAtMs === undefined ? null : finishedAtMs - pending.dispatchedAtMs,
            status, aborted: signal?.aborted === true,
            daemonLatencyMs: metric(response?.latencyMs), warmHits: metric(response?.cacheStats?.warmHits),
            coldMisses: metric(response?.cacheStats?.coldMisses), traceMs: metric(response?.seedStats?.traceMs),
            traceRoundTrips: metric(response?.seedStats?.roundTrips),
          })}`);
        } catch { /* Observability must never prevent settling or draining work. */ }
      };
      let timer: NodeJS.Timeout;
      const cancel = () => {
        const err = expired();
        if (!err) { arm(); return; }
        if (this.active === pending) { this.fail(err); return; }
        const idx = this.queue.indexOf(pending);
        if (idx < 0) return;
        this.queue.splice(idx, 1); pending.cleanup(); pending.reject(err);
      };
      const arm = () => { timer = setTimeout(cancel, Math.min(2_147_483_647, Math.max(1, deadline - Date.now()))); };
      const pending: Pending = { id, line,
        resolve: response => { timing(response.ok ? "returned" : "not-ok", response); resolveP(response); },
        reject: error => { timing("rejected"); rejectP(error); }, expired,
        pin, blockNumber: payload.blockNumber as number | undefined,
        strictRequest: payload.op === "strictSimulate" ? JSON.parse(line) : undefined,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } };
      this.queue.push(pending);
      signal?.addEventListener("abort", cancel, { once: true });
      arm();
      this.pump();
    });
  }

  private expectOk(resp: DaemonResponse): DaemonResponse {
    if (!resp.ok && resp.errorKind) throw new RevmStrictError(resp.errorKind, resp.error ?? "strict simulation failed");
    if (!resp.ok) throw new Error(resp.error ?? "revm-sim daemon error");
    return resp;
  }

  async health(control?: RevmRequestControl): Promise<{ ok: boolean; engine: string; implemented: boolean }> {
    const resp = await this.request({ op: "health" }, control);
    return { ok: resp.ok, engine: "revm", implemented: true };
  }

  async prepare(req: PrepareRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ ...req, op: "prepare" }, control));
  }

  async warm(req: WarmRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ ...req, op: "warm" }, control));
  }

  async quote(req: QuoteCallRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ ...req, op: "quote" }, control));
  }

  async simulatePrepared(req: SimulatePreparedRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ ...req, op: "simulate" }, control));
  }

  async strictSimulate(req: StrictSimulateRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    return this.expectOk(await this.request({
      ...req,
      op: "strictSimulate",
    }, control));
  }

  async reset(control?: RevmRequestControl): Promise<void> {
    this.expectOk(await this.request({ op: "reset" }, control));
  }

  /**
   * One-shot: prepare the victim overlay + arb sim in a single round, then drop
   * the prepared state. Used by offline replay where each fixture is independent.
   */
  async simulate(req: RevmSimRequest, control?: RevmRequestControl): Promise<RevmSimResponse> {
    const funded = new Set<string>([req.owner]);
    for (const c of req.preCalls ?? []) funded.add(c.from);
    await this.prepare({
      blockNumber: req.blockNumber,
      rpcUrl: req.rpcUrl,
      funded: [...funded],
      stateOverrides: req.stateOverrides,
      tokenDeals: req.tokenDeals,
      preCalls: req.preCalls,
    }, control);
    const resp = await this.simulatePrepared({
      owner: req.owner,
      executor: req.executor,
      calldata: req.calldata,
      profitToken: req.profitToken,
      gasLimit: req.gasLimit,
    }, control);
    await this.reset(control);
    return {
      success: resp.success ?? false,
      profit: resp.profit ?? "0",
      gasUsed: resp.gasUsed ?? "0",
      revertReason: resp.revertReason ?? null,
      latencyMs: resp.latencyMs,
      missingStateKeys: resp.missingStateKeys ?? [],
    };
  }

  stop(): void {
    this.fail(new Error("revm-sim client stopped"));
  }

  /** Initiate shutdown, then wait for the owned child AND both pipes to close. */
  async closeAndDrain(): Promise<void> {
    this.stop();
    await this.drained;
  }
}
