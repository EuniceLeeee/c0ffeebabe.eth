import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

type DaemonProc = ChildProcessByStdio<Writable, Readable, null>;

export interface OverlayPreCall {
  from: string;
  to: string;
  calldata: string;
  gasLimit?: number;
}

export interface OverlayTokenDeal {
  token: string;
  to: string;
  amount: string;
}

export interface TokenBalanceHint {
  token: string;
  account: string;
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

interface Pending {
  resolve: (value: DaemonResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Persistent transport to the `revm-sim serve` daemon. One long-lived process
 * holds the warm per-block chain cache, so the many quote/simulate calls inside
 * a single hint reuse fetched state instead of re-spawning a cold process each
 * time (which is what made every prior sim pay full RPC latency).
 *
 * Requests are JSON lines on stdin; responses are JSON lines on stdout, FIFO.
 */
export class RevmSimClient {
  private proc: DaemonProc | null = null;
  private buffer = "";
  private readonly queue: Pending[] = [];
  private readonly timeoutMs: number;
  private readonly manifestPath: string;

  constructor(options: { manifestPath?: string; timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.manifestPath = options.manifestPath ?? resolve("revm-sim", "Cargo.toml");
  }

  private ensureProc(): DaemonProc {
    if (this.proc) return this.proc;
    const binary = resolve(this.manifestPath, "..", "target", "debug", "revm-sim");
    const useBinary = existsSync(binary);
    const command = useBinary ? binary : "cargo";
    const args = useBinary
      ? ["serve"]
      : ["run", "--quiet", "--manifest-path", this.manifestPath, "--", "serve"];
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.on("exit", (code) => this.onExit(code));
    this.proc = proc;
    return proc;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const pending = this.queue.shift();
      if (!pending) continue;
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(line) as DaemonResponse);
      } catch (err) {
        pending.reject(new Error(`revm-sim bad response: ${(err as Error).message}: ${line.slice(0, 200)}`));
      }
    }
  }

  private onExit(code: number | null): void {
    this.proc = null;
    const err = new Error(`revm-sim daemon exited (code ${code})`);
    while (this.queue.length > 0) {
      const pending = this.queue.shift()!;
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private request(payload: Record<string, unknown>): Promise<DaemonResponse> {
    const proc = this.ensureProc();
    return new Promise<DaemonResponse>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.queue.splice(idx, 1);
        rejectP(new Error(`revm-sim request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.queue.push({ resolve: resolveP, reject: rejectP, timer });
      proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          const idx = this.queue.findIndex((p) => p.timer === timer);
          if (idx >= 0) this.queue.splice(idx, 1);
          rejectP(err);
        }
      });
    });
  }

  private expectOk(resp: DaemonResponse): DaemonResponse {
    if (!resp.ok) throw new Error(resp.error ?? "revm-sim daemon error");
    return resp;
  }

  async health(): Promise<{ ok: boolean; engine: string; implemented: boolean }> {
    const resp = await this.request({ op: "health" });
    return { ok: resp.ok, engine: "revm", implemented: true };
  }

  async prepare(req: PrepareRequest): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ op: "prepare", ...req }));
  }

  async warm(req: WarmRequest): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ op: "warm", ...req }));
  }

  async quote(req: QuoteCallRequest): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ op: "quote", ...req }));
  }

  async simulatePrepared(req: SimulatePreparedRequest): Promise<DaemonResponse> {
    return this.expectOk(await this.request({ op: "simulate", ...req }));
  }

  async reset(): Promise<void> {
    await this.request({ op: "reset" });
  }

  /**
   * One-shot: prepare the victim overlay + arb sim in a single round, then drop
   * the prepared state. Used by offline replay where each fixture is independent.
   */
  async simulate(req: RevmSimRequest): Promise<RevmSimResponse> {
    const funded = new Set<string>([req.owner]);
    for (const c of req.preCalls ?? []) funded.add(c.from);
    await this.prepare({
      blockNumber: req.blockNumber,
      rpcUrl: req.rpcUrl,
      funded: [...funded],
      stateOverrides: req.stateOverrides,
      tokenDeals: req.tokenDeals,
      preCalls: req.preCalls,
    });
    const resp = await this.simulatePrepared({
      owner: req.owner,
      executor: req.executor,
      calldata: req.calldata,
      profitToken: req.profitToken,
      gasLimit: req.gasLimit,
    });
    await this.reset();
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
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
