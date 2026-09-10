import {
  RevmFatalError,
  type DaemonResponse,
  type RevmFatalReason,
  type RevmRequestControl,
  type RevmSimClient,
  type RevmSourcePin,
  type StrictSimulateRequest,
} from "./revm-sim-client.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";

export interface RevmStrictSourceIdentity {
  readonly source: CanonicalSource;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly stateRoot?: string;
}

export interface RevmStrictSourceLease {
  readonly source: CanonicalSource;
  readonly sourcePin: Readonly<RevmSourcePin>;
  /** Every request must name this lease's exact endpoint and physical source. */
  strictSimulate(request: StrictSimulateRequest, control?: RevmRequestControl): Promise<DaemonResponse>;
  closeAndDrain(reason?: Error): Promise<void>;
}

type OwnedClient = Pick<RevmSimClient, "strictSimulate" | "closeAndDrain" | "isTerminal">;
type Binding = Readonly<{ source: CanonicalSource; pin: Readonly<RevmSourcePin>; rpcUrl: string }>;
interface Slot {
  readonly binding: Binding;
  readonly controller: AbortController;
  readonly ready: ReturnType<typeof deferred<void>>;
  readonly pending: Set<Promise<DaemonResponse>>;
  readonly control: Readonly<RevmRequestControl>;
  detach: () => void;
  client?: OwnedClient;
  terminal?: Error;
  draining?: Promise<void>;
}

/**
 * One existing source-work slot, not a scheduler or a retry owner. Callers
 * retain a lease across quotes and explicitly retire it at their settle fence.
 * A factory must return a NEW strict-only client, never a prepared/backrun one.
 */
export class RevmStrictSourceOwner {
  private slot?: Slot;
  private admission?: Slot;
  private highestGeneration = -1;
  private readonly clients = new WeakSet<OwnedClient>();
  private terminal?: Error;
  private fatal?: RevmFatalError;
  private shutdownTask?: Promise<void>;
  private readonly createClient: (input: { readonly onFatal: (reason: RevmFatalReason) => void }) => OwnedClient;
  private readonly onFatal: (reason: RevmFatalReason) => void;

  constructor(input: {
    readonly createClient: (input: { readonly onFatal: (reason: RevmFatalReason) => void }) => OwnedClient;
    readonly onFatal: (reason: RevmFatalReason) => void;
  }) {
    this.createClient = input.createClient;
    this.onFatal = input.onFatal;
  }

  async acquire(identity: RevmStrictSourceIdentity, control?: RevmRequestControl): Promise<RevmStrictSourceLease> {
    const binding = snapshotBinding(identity);
    const capturedControl = snapshotControl(control);
    this.assertOpen();
    assertControl(capturedControl);
    if (this.admission || (this.slot && !this.slot.terminal)) throw new Error("strict source slot is occupied");
    if (binding.source.generation <= this.highestGeneration) throw new Error("strict source generation already admitted or retired");
    // Consume admission before the first await/factory call. Cancelled admissions
    // cannot be retried under the same generation, even if no client was created.
    this.highestGeneration = binding.source.generation;
    const slot: Slot = { binding, control: capturedControl, controller: new AbortController(),
      ready: deferred<void>(), pending: new Set(), detach() {} };
    this.admission = slot;
    slot.detach = watchControl(capturedControl, error => { void this.retire(slot, error); });
    if (slot.terminal) slot.detach();
    try {
      await untilAbort(this.slot?.draining ?? Promise.resolve(), slot.controller.signal);
      this.assertLeaseOpen(slot);
      try {
        slot.client = this.createClient({ onFatal: reason => this.latchFatal(reason) });
      } catch (error) {
        if (error instanceof RevmFatalError) this.latchFatal(error.fatal);
        throw this.fatal ?? new Error("strict source client creation failed");
      }
      if (this.clients.has(slot.client)) {
        this.latchFatal({ kind: "protocol-fault" });
      }
      this.clients.add(slot.client);
      slot.ready.resolve();
      this.assertLeaseOpen(slot); // Factory callbacks may reenter/cancel/shut down.
      this.slot = slot;
      return Object.freeze({
        source: binding.source,
        sourcePin: binding.pin,
        strictSimulate: (request: StrictSimulateRequest, workControl?: RevmRequestControl) =>
          this.simulate(slot, request, workControl),
        closeAndDrain: (reason = new Error("strict source lease closed")) => this.retire(slot, reason),
      });
    } catch (error) {
      slot.ready.resolve();
      await this.retire(slot, asError(error));
      throw this.fatal ?? slot.terminal;
    } finally {
      slot.ready.resolve();
      if (this.admission === slot) this.admission = undefined;
    }
  }

  shutdown(reason = new Error("strict source owner shut down")): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    const done = deferred<void>();
    this.shutdownTask = done.promise;
    this.terminal ??= reason;
    const slots = new Set([this.slot, this.admission]);
    void Promise.allSettled([...slots].flatMap(slot => slot ? [this.retire(slot, reason)] : []))
      .then(results => {
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") done.reject(failed.reason);
        else done.resolve();
      });
    return done.promise;
  }

  private assertOpen(): void {
    if (this.terminal) throw this.terminal;
  }

  private assertLeaseOpen(slot: Slot): void {
    this.assertOpen();
    if (slot.terminal) throw slot.terminal;
    try {
      assertControl(slot.control);
      if (slot.client?.isTerminal) throw new Error("strict source client is terminal");
    } catch (error) {
      void this.retire(slot, asError(error));
      throw error;
    }
  }

  private async simulate(slot: Slot, request: StrictSimulateRequest, control?: RevmRequestControl): Promise<DaemonResponse> {
    this.assertLeaseOpen(slot);
    const { binding } = slot;
    const pin = request.sourcePin;
    if (request.blockNumber !== binding.source.number || request.rpcUrl !== binding.rpcUrl ||
      !pin || pin.chainId !== binding.pin.chainId || typeof pin.blockHash !== "string" ||
      pin.blockHash.toLowerCase() !== binding.pin.blockHash ||
      (pin.stateRoot !== undefined && typeof pin.stateRoot !== "string") ||
      pin.stateRoot?.toLowerCase() !== binding.pin.stateRoot ||
      Object.keys(pin).some(key => !["chainId", "blockHash", "stateRoot"].includes(key))) {
      throw new Error("strict simulation escaped its source lease");
    }
    const capturedControl = snapshotControl(control);
    try {
      this.assertLeaseOpen(slot);
      assertControl(capturedControl);
      const signal = capturedControl.signal === undefined ? slot.controller.signal
        : AbortSignal.any([slot.controller.signal, capturedControl.signal]);
      const callControl = Object.freeze({ signal,
        deadlineAtMs: Math.min(slot.control.deadlineAtMs ?? Infinity, capturedControl.deadlineAtMs ?? Infinity) });
      const pending = slot.client!.strictSimulate({ ...request, blockNumber: binding.source.number,
        sourcePin: binding.pin, rpcUrl: binding.rpcUrl },
        Number.isFinite(callControl.deadlineAtMs) ? callControl : { signal: callControl.signal });
      slot.pending.add(pending);
      void pending.then(() => slot.pending.delete(pending), () => slot.pending.delete(pending));
      const response = await untilAbort(pending, signal);
      this.assertLeaseOpen(slot);
      assertControl(capturedControl);
      return response;
    } catch (error) {
      if (error instanceof RevmFatalError) this.latchFatal(error.fatal);
      // E2a keeps the client healthy after queued cancellation or an ordinary
      // daemon ok:false response. Only actual terminal state retires siblings.
      if (slot.client?.isTerminal) void this.retire(slot, asError(error));
      throw this.fatal ?? slot.terminal ?? error;
    }
  }

  private retire(slot: Slot, reason: Error): Promise<void> {
    if (slot.draining) return slot.draining;
    const done = deferred<void>();
    slot.draining = done.promise;
    // Event listeners and factory callbacks can reenter. Publish terminal/drain
    // state first, and join factory settlement before inspecting its client.
    slot.terminal = reason;
    slot.detach();
    slot.controller.abort(reason);
    void (async () => {
      await slot.ready.promise;
      await slot.client?.closeAndDrain();
      await Promise.allSettled([...slot.pending]);
    })().then(done.resolve, () => {
      this.latchFatal({ kind: "protocol-fault" });
      done.reject(new Error("strict source client drain failed"));
    });
    // Retirement is also initiated from synchronous abort/fatal callbacks.
    void done.promise.catch(() => {});
    return done.promise;
  }

  private latchFatal(reason: RevmFatalReason): void {
    if (this.fatal) return;
    const captured: RevmFatalReason = Object.freeze(reason.kind === "rpc-throttle"
      ? { kind: reason.kind, category: reason.category,
          ...(reason.httpStatus === undefined ? {} : { httpStatus: reason.httpStatus }),
          ...(reason.rpcCode === undefined ? {} : { rpcCode: reason.rpcCode }) }
      : { kind: reason.kind });
    this.fatal = new RevmFatalError(captured);
    this.terminal = this.fatal;
    if (this.slot) void this.retire(this.slot, this.fatal);
    if (this.admission) void this.retire(this.admission, this.fatal);
    // Never ignore a late fatal from a retired client: it also bars replacement.
    try { this.onFatal(captured); } catch { /* The permanent latch already won. */ }
  }
}

function snapshotBinding(input: RevmStrictSourceIdentity): Binding {
  const { source: original, chainId, rpcUrl, stateRoot } = input;
  const source = original && { number: original.number, hash: original.hash, generation: original.generation };
  const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
  if (!source || !Number.isSafeInteger(source.number) || source.number < 0 || !hash(source.hash) ||
    !Number.isSafeInteger(source.generation) || source.generation < 0 ||
    !Number.isSafeInteger(chainId) || chainId <= 0 ||
    (stateRoot !== undefined && !hash(stateRoot))) throw new Error("invalid strict source identity");
  try {
    if (typeof rpcUrl !== "string" || /\s/.test(rpcUrl)) throw new Error();
    const endpoint = new URL(rpcUrl);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.hash) throw new Error();
  } catch { throw new Error("invalid strict source endpoint"); }
  return Object.freeze({ rpcUrl,
    source: Object.freeze({ number: source.number, hash: source.hash.toLowerCase(), generation: source.generation }),
    pin: Object.freeze({ chainId, blockHash: source.hash.toLowerCase(),
      ...(stateRoot === undefined ? {} : { stateRoot: stateRoot.toLowerCase() }) }) });
}

function snapshotControl(control: RevmRequestControl | undefined): Readonly<RevmRequestControl> {
  if (control?.deadlineAtMs !== undefined && !Number.isFinite(control.deadlineAtMs)) throw new Error("invalid strict source deadline");
  return Object.freeze({ ...(control?.signal === undefined ? {} : { signal: control.signal }),
    ...(control?.deadlineAtMs === undefined ? {} : { deadlineAtMs: control.deadlineAtMs }) });
}

function assertControl(control: RevmRequestControl): void {
  if (control.signal?.aborted) throw new Error("strict source work cancelled");
  if (control.deadlineAtMs !== undefined && Date.now() >= control.deadlineAtMs) throw new Error("strict source deadline reached");
}

function watchControl(control: RevmRequestControl, cancel: (error: Error) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => cancel(new Error("strict source work cancelled"));
  const arm = () => {
    if (control.deadlineAtMs === undefined) return;
    const remaining = control.deadlineAtMs - Date.now();
    if (remaining <= 0) cancel(new Error("strict source deadline reached"));
    else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
  };
  control.signal?.addEventListener("abort", abort, { once: true });
  if (control.signal?.aborted) abort();
  else arm();
  return () => { clearTimeout(timer); control.signal?.removeEventListener("abort", abort); };
}

function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("strict source client operation failed");
}
