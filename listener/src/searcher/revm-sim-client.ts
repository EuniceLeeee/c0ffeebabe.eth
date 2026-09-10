import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

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
  ok: boolean;
  error?: string;
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

export interface StrictSimulateRequest {
  blockNumber: number;
  rpcUrl?: string;
  from: string;
  to: string;
  data: string;
  gasLimit?: number;
  preCalls?: OverlayPreCall[];
  tokenDeals?: OverlayTokenDeal[];
  observeTokens?: string[];
  observeAccounts?: string[];
  observeTotalSupply?: string[];
  observeLogs?: boolean;
  /**
   * Caller execution mode: "top-level" (default, EIP-3607 enforced) or
   * "impersonated-call-frame" (EIP-3607 disabled for this frame only; the
   * caller acts as an inner CALL msg.sender, matching observed executor/
   * router actors).
   */
  callerMode?: "top-level" | "impersonated-call-frame";
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

export type RevmFatalReason = Readonly<{
  kind: "rpc-throttle";
  category: "http429" | "rpc-limit-code" | "rpc-rate-limit" | "rpc-quota";
  httpStatus?: 429;
  rpcCode?: number;
}>;

export class RevmFatalError extends Error {
  constructor(readonly fatal: RevmFatalReason) {
    super("revm-sim fatal rpc-throttle");
    this.name = "RevmFatalError";
  }
}

interface Pending {
  id: string;
  line: string;
  resolve: (value: DaemonResponse) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
  expired: () => Error | undefined;
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
  private drained: Promise<void> = Promise.resolve();
  private killTimer?: NodeJS.Timeout;
  private fullyClosed = false;
  private ownedGroup = false;
  private readonly onFatal?: (reason: RevmFatalReason) => void;
  private readonly timeoutMs: number;
  private readonly manifestPath: string;
  private readonly executablePath?: string;

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
        clearTimeout(this.killTimer);
        resolveDrain();
      };
      proc.once("close", () => { childClosed = true; check(); });
      proc.stdin.once("close", check);
      proc.stdout.once("close", check);
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.on("error", () => this.fail(new Error("revm-sim daemon process failed")));
    proc.stdin.on("error", () => this.fail(new Error("revm-sim stdin failed")));
    proc.stdout.on("error", () => this.fail(new Error("revm-sim stdout failed")));
    proc.stdout.on("end", () => this.fail(new Error("revm-sim stdout ended")));
    proc.on("exit", () => this.fail(new Error("revm-sim daemon exited")));
    proc.on("close", () => this.fail(new Error("revm-sim daemon closed")));
    return proc;
  }

  private onData(chunk: string): void {
    if (this.terminal) return;
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
        if (resp.fatal !== undefined) {
          const fatal = resp.fatal;
          if (!fatal || fatal.kind !== "rpc-throttle"
            || !["http429", "rpc-limit-code", "rpc-rate-limit", "rpc-quota"].includes(fatal.category)
            || (fatal.category === "http429" ? fatal.httpStatus !== 429 || fatal.rpcCode !== undefined : fatal.httpStatus !== undefined)
            || (fatal.category === "rpc-limit-code" && fatal.rpcCode !== 429 && fatal.rpcCode !== -32005)
            || (fatal.rpcCode !== undefined && !Number.isSafeInteger(fatal.rpcCode))) throw new Error("fatal");
          const reason: RevmFatalReason = Object.freeze({ kind: "rpc-throttle", category: fatal.category,
            ...(fatal.httpStatus === undefined ? {} : { httpStatus: fatal.httpStatus }),
            ...(fatal.rpcCode === undefined ? {} : { rpcCode: fatal.rpcCode }) });
          this.fail(new RevmFatalError(reason));
          return;
        }
      } catch {
        this.fail(new Error("revm-sim response protocol violation"));
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

  private fail(err: Error): void {
    if (this.terminal) return;
    this.terminal = err;
    // Surface physical throttle before promises can become domain failures.
    if (err instanceof RevmFatalError) {
      try { this.onFatal?.(err.fatal); } catch { /* Observers cannot undo the latch. */ }
    }
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue.length = 0;
    this.buffer = "";
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
    try {
      const proc = this.ensureProc();
      proc.stdin.write(pending.line, (err) => {
        if (err) this.fail(new Error("revm-sim request write failed"));
      });
    } catch { this.fail(new Error("revm-sim daemon start/write failed")); }
  }

  private request(payload: Record<string, unknown>, control: RevmRequestControl = {}): Promise<DaemonResponse> {
    if (this.terminal) return Promise.reject(this.terminal);
    if (control.deadlineAtMs !== undefined && !Number.isFinite(control.deadlineAtMs)) {
      return Promise.reject(new Error("invalid revm-sim deadline"));
    }
    const signal = control.signal;
    const deadline = Math.min(Date.now() + this.timeoutMs, control.deadlineAtMs ?? Infinity);
    const expired = () => signal?.aborted ? new Error("revm-sim request aborted")
      : Date.now() >= deadline ? new Error("revm-sim request deadline timed out") : undefined;
    const early = expired();
    if (early) return Promise.reject(early);
    const id = (++this.nextId).toString();
    const line = JSON.stringify({ ...payload, epoch: this.epoch, requestId: id }) + "\n";
    return new Promise<DaemonResponse>((resolveP, rejectP) => {
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
      const pending: Pending = { id, line, resolve: resolveP, reject: rejectP, expired,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); } };
      this.queue.push(pending);
      signal?.addEventListener("abort", cancel, { once: true });
      arm();
      this.pump();
    });
  }

  private expectOk(resp: DaemonResponse): DaemonResponse {
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
