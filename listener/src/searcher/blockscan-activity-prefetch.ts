import type { StateCallControl } from "../shared/state/state-backend.js";
import { StateCallAbortedError } from "../shared/state/state-backend.js";
import type { BlockTouchedProvider } from "./blockscan-touched-state.js";
import { isRpcThrottleError } from "./rpc-throttle-guard.js";
import { BlockScanHeaderUnavailableError } from "./blockscan-observed-header.js";
import { setTimeout as delay } from "node:timers/promises";

type Logs = Awaited<ReturnType<BlockTouchedProvider["getLogs"]>>;
type Read<T> = Promise<PromiseSettledResult<T>>;
interface Entry {
  readonly hash: string;
  readonly logs: Read<Logs>;
  readonly traces: Read<unknown>;
  readonly drained: Promise<unknown>;
  logsTaken: boolean;
  tracesTaken: boolean;
  control?: StateCallControl;
}
const settle = <T>(read: () => Promise<T>): Read<T> => Promise.resolve().then(read).then(
  value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }),
);
const unwrap = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === "rejected") throw result.reason;
  return result.value;
};

/** Transport overlap only. WS hashes are hints; the existing by-number header
 * remains authority and the touched reader still validates every log/trace.
 * Only selected heads launch I/O, never all notifications during startup. */
export class BlockScanActivityPrefetch implements BlockTouchedProvider {
  private readonly hints = new Map<number, string>();
  private readonly observed = new Map<number, string>();
  private readonly confirmed = new Map<string, Entry>();
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly provider: BlockTouchedProvider, private readonly signal: AbortSignal) {}

  noteHead(number: number, hash: string): void {
    if (this.closed || this.signal.aborted || !Number.isSafeInteger(number) || number < 0 ||
        !/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
    hash = hash.toLowerCase();
    if (this.observed.get(number) === hash) return;
    this.hints.set(number, hash);
    while (this.hints.size > 32) this.hints.delete(this.hints.keys().next().value!);
  }

  async observeHeader<T extends { number: number; hash: string }>(
    number: number, read: () => Promise<T>, control?: StateCallControl,
  ): Promise<T> {
    this.assertOpen(control);
    const hint = this.hints.get(number);
    this.hints.delete(number);
    // Bound speculative work independently of queued heads/reorgs. Falling
    // back changes latency only; it cannot change the observed source.
    const entry = hint === undefined || this.active.size >= 2 ? undefined : this.start(hint);
    try {
      const header = await this.readAvailableHeader(read, hint !== undefined, control);
      this.assertOpen(control);
      this.observed.set(number, header.hash.toLowerCase());
      while (this.observed.size > 32) this.observed.delete(this.observed.keys().next().value!);
      if (entry !== undefined) {
        if (header.number === number && header.hash.toLowerCase() === entry.hash) {
          this.confirmed.set(entry.hash, entry);
          while (this.confirmed.size > 2) this.confirmed.delete(this.confirmed.keys().next().value!);
        } else {
          // An orphan hint never binds the canonical header to orphan activity.
          // Drain the unused siblings before allowing canonical fallback reads.
          await entry.drained;
          this.assertOpen(control);
        }
      }
      return header;
    } catch (error) {
      if (entry !== undefined) await entry.drained;
      throw error;
    }
  }

  getLogs(filter: Parameters<BlockTouchedProvider["getLogs"]>[0]): Promise<Logs> {
    this.assertOpen();
    const entry = "blockHash" in filter ? this.confirmed.get(filter.blockHash.toLowerCase()) : undefined;
    if (!entry || entry.logsTaken) return this.provider.getLogs(filter);
    entry.logsTaken = true;
    this.release(entry);
    return this.consume(entry, entry.logs, () => this.provider.getLogs(filter));
  }

  send(method: string, params: unknown[]): Promise<unknown> {
    this.assertOpen();
    const entry = typeof params[0] === "string" ? this.confirmed.get(params[0].toLowerCase()) : undefined;
    const options = params[1] as { tracer?: unknown; tracerConfig?: { onlyTopCall?: unknown } } | undefined;
    if (!entry || entry.tracesTaken || method !== "debug_traceBlockByHash" || params.length !== 2 ||
        options?.tracer !== "callTracer" || options.tracerConfig?.onlyTopCall !== false ||
        Object.keys(options).length !== 2 || Object.keys(options.tracerConfig).length !== 1) {
      return this.provider.send(method, params);
    }
    entry.tracesTaken = true;
    this.release(entry);
    return this.consume(entry, entry.traces, () => this.provider.send(method, params));
  }

  /** Even an already-cancelled range may reject before asking for either raw
   * response. Its owner still joins all the speculative I/O for this hash. */
  async withBlockActivity<T>(hash: string | undefined, read: () => Promise<T>, control?: StateCallControl): Promise<T> {
    const entry = hash === undefined ? undefined : this.confirmed.get(hash.toLowerCase());
    if (entry) entry.control = control;
    try { return await read(); }
    finally {
      if (entry) {
        await entry.drained;
        if (this.confirmed.get(entry.hash) === entry) this.confirmed.delete(entry.hash);
      }
    }
  }

  async closeAndDrain(): Promise<void> {
    this.closed = true;
    this.hints.clear();
    this.observed.clear();
    this.confirmed.clear();
    await Promise.allSettled([...this.active]);
  }

  private start(hash: string): Entry {
    const logs = settle(() => { this.assertOpen(); return this.provider.getLogs({ blockHash: hash }); });
    const traces = settle(() => {
      this.assertOpen();
      return this.provider.send("debug_traceBlockByHash", [hash,
        { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }]);
    });
    const drained = Promise.all([logs, traces]);
    this.active.add(drained);
    void drained.then(() => this.active.delete(drained));
    return { hash, logs, traces, drained, logsTaken: false, tracesTaken: false };
  }

  private async consume<T>(entry: Entry, pending: Read<T>, fallback: () => Promise<T>): Promise<T> {
    const result = await pending;
    if (result.status === "fulfilled") return result.value;
    // newHeads can beat availability on an HTTP backend. Only a transport
    // rejection gets one normal read after the full canonical header arrived.
    // Malformed successful responses still reach the existing validator, and
    // throttle/cancellation never gets hidden behind this availability retry.
    if (isRpcThrottleError(result.reason) || result.reason instanceof StateCallAbortedError) return unwrap(result);
    this.assertOpen(entry.control);
    return fallback();
  }

  private async readAvailableHeader<T>(read: () => Promise<T>, hinted: boolean, control?: StateCallControl): Promise<T> {
    // Do not schedule another search or wait for the next block. A WS hint can
    // precede HTTP availability; retry only this typed absence twice within the
    // original pass budget. Malformed state, source faults and 429 stay fatal.
    for (let attempt = 0; ; attempt++) {
      this.assertOpen(control);
      try { return await read(); }
      catch (error) {
        if (!hinted || !(error instanceof BlockScanHeaderUnavailableError) || attempt >= 2) throw error;
        this.assertOpen(control);
        const remaining = control?.deadlineAtMs === undefined ? Infinity : control.deadlineAtMs - Date.now();
        const signal = control?.signal === undefined ? this.signal : AbortSignal.any([this.signal, control.signal]);
        await delay(Math.min(attempt === 0 ? 100 : 250, remaining), undefined, { signal }).catch(() => {});
        this.assertOpen(control);
      }
    }
  }

  private release(entry: Entry): void {
    if (entry.logsTaken && entry.tracesTaken && this.confirmed.get(entry.hash) === entry) {
      this.confirmed.delete(entry.hash);
    }
  }

  private assertOpen(control?: StateCallControl): void {
    if (this.closed || this.signal.aborted || control?.signal?.aborted) {
      throw new StateCallAbortedError("activity observation aborted", "signal");
    }
    if (control?.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs) {
      throw new StateCallAbortedError("activity observation deadline exceeded", "deadline");
    }
  }
}
