import type {
  ProtocolDiscoveryContext,
  ProtocolDiscoveryReadBackend,
  ProtocolDiscoveryReadControl,
} from "./venues/route-leg-adapter.js";

const DEFAULT_FAMILY_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_FAMILY_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_CONCURRENT_PER_FAMILY = 4;

export interface ProtocolDiscoveryFamilyGuardOptions {
  readonly timeoutMs?: number;
  readonly failureThreshold?: number;
  /** Absolute pass deadline. A family-local timeout never aborts this owner. */
  readonly deadlineAtMs?: number;
  /** Parent pass cancellation. Child callbacks observe it but never own it. */
  readonly signal?: AbortSignal;
  /** Shared provider-read budget inherited by every family backend call. */
  readonly run?: ProtocolDiscoveryReadControl["run"];
  /** Shared cap across every stage currently executing for one family. */
  readonly maxConcurrentPerFamily?: number;
}

export interface ProtocolDiscoveryFamilyCallControl {
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  readonly run?: ProtocolDiscoveryReadControl["run"];
}

interface FamilyStageState {
  consecutiveFailures: number;
  open: boolean;
}

interface FamilyWaiter {
  active: boolean;
  grant(): boolean;
  cancel(error: unknown): void;
}

/**
 * Bounds execution-family callbacks inside one discovery pass. A broken
 * matcher/probe can exhaust only its own stage budget; sibling families keep
 * settling normally. The callback receives a child signal and absolute
 * deadline suitable for a context-bound backend.
 */
export class ProtocolDiscoveryFamilyGuard {
  private readonly states = new Map<string, FamilyStageState>();
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly deadlineAtMs: number | undefined;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly readRunner: ProtocolDiscoveryReadControl["run"];
  private readonly maxConcurrentPerFamily: number;
  private readonly activeByFamily = new Map<string, number>();
  private readonly waitersByFamily = new Map<string, FamilyWaiter[]>();

  constructor(options: ProtocolDiscoveryFamilyGuardOptions = {}) {
    this.timeoutMs = positiveInteger(
      options.timeoutMs ??
        envInteger(
          "SEARCHER_PROTOCOL_DISCOVERY_FAMILY_TIMEOUT_MS",
          DEFAULT_FAMILY_CALL_TIMEOUT_MS,
        ),
      "protocol discovery family timeout",
    );
    this.failureThreshold = positiveInteger(
      options.failureThreshold ??
        envInteger(
          "SEARCHER_PROTOCOL_DISCOVERY_FAMILY_FAILURE_THRESHOLD",
          DEFAULT_FAMILY_FAILURE_THRESHOLD,
        ),
      "protocol discovery family failure threshold",
    );
    this.maxConcurrentPerFamily = positiveInteger(
      options.maxConcurrentPerFamily ??
        envInteger(
          "SEARCHER_PROTOCOL_DISCOVERY_FAMILY_CONCURRENCY",
          DEFAULT_MAX_CONCURRENT_PER_FAMILY,
        ),
      "protocol discovery family concurrency",
    );
    if (
      options.deadlineAtMs !== undefined &&
      !Number.isFinite(options.deadlineAtMs)
    ) {
      throw new Error("protocol discovery family deadline must be finite");
    }
    this.deadlineAtMs = options.deadlineAtMs;
    this.parentSignal = options.signal;
    this.readRunner = options.run;
  }

  async run<T>(
    familyId: string,
    stage: string,
    work: (control: ProtocolDiscoveryFamilyCallControl) => Promise<T>,
  ): Promise<T> {
    const key = familyStageKey(familyId, stage);
    const state = this.states.get(key) ?? {
      consecutiveFailures: 0,
      open: false,
    };
    this.states.set(key, state);
    if (state.open) {
      throw new ProtocolDiscoveryFamilyCircuitOpen(familyId, stage);
    }

    await this.acquireFamily(familyId);
    try {
      // The circuit may have opened while this callback waited for its family
      // slot. Do not start work merely because it was queued earlier.
      if (state.open) {
        throw new ProtocolDiscoveryFamilyCircuitOpen(familyId, stage);
      }
      const parentCancellation = this.parentCancellation();
      if (parentCancellation !== null) throw parentCancellation;
      const deadlineAtMs = Math.min(
        Date.now() + this.timeoutMs,
        this.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      );
      try {
        const value = await boundedFamilyCall(
          work,
          deadlineAtMs,
          this.timeoutMs,
          `${familyId}/${stage}`,
          this.parentSignal,
          this.readRunner,
        );
        state.consecutiveFailures = 0;
        return value;
      } catch (error) {
        // Pass cancellation is not evidence that this family is broken.
        if (this.parentCancellation() === null) {
          state.consecutiveFailures++;
          if (state.consecutiveFailures >= this.failureThreshold) {
            state.open = true;
          }
        }
        throw error;
      }
    } finally {
      this.releaseFamily(familyId);
    }
  }

  private acquireFamily(familyId: string): Promise<void> {
    const cancellation = this.parentCancellation();
    if (cancellation !== null) return Promise.reject(cancellation);
    const active = this.activeByFamily.get(familyId) ?? 0;
    if (active < this.maxConcurrentPerFamily) {
      this.activeByFamily.set(familyId, active + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let detachParent = (): void => {};
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        detachParent();
      };
      const waiter: FamilyWaiter = {
        active: true,
        grant: () => {
          if (!waiter.active) return false;
          waiter.active = false;
          cleanup();
          this.activeByFamily.set(
            familyId,
            (this.activeByFamily.get(familyId) ?? 0) + 1,
          );
          resolve();
          return true;
        },
        cancel: (error) => {
          if (!waiter.active) return;
          waiter.active = false;
          cleanup();
          reject(error);
        },
      };
      const queue = this.waitersByFamily.get(familyId) ?? [];
      queue.push(waiter);
      this.waitersByFamily.set(familyId, queue);
      if (this.parentSignal) {
        const abort = (): void =>
          waiter.cancel(
            this.parentSignal?.reason ??
              new ProtocolDiscoveryParentCancelled(),
          );
        if (this.parentSignal.aborted) abort();
        else {
          this.parentSignal.addEventListener("abort", abort, { once: true });
          detachParent = () =>
            this.parentSignal?.removeEventListener("abort", abort);
        }
      }
      if (this.deadlineAtMs !== undefined) {
        timer = setTimeout(
          () => waiter.cancel(new ProtocolDiscoveryParentDeadline()),
          Math.max(0, this.deadlineAtMs - Date.now()),
        );
      }
    });
  }

  private releaseFamily(familyId: string): void {
    const active = (this.activeByFamily.get(familyId) ?? 1) - 1;
    if (active <= 0) this.activeByFamily.delete(familyId);
    else this.activeByFamily.set(familyId, active);
    const queue = this.waitersByFamily.get(familyId);
    if (!queue) return;
    while (queue.length > 0) {
      const waiter = queue.shift()!;
      if (waiter.grant()) break;
    }
    if (queue.length === 0) this.waitersByFamily.delete(familyId);
  }

  private parentCancellation(): unknown | null {
    if (this.parentSignal?.aborted) {
      return new ProtocolDiscoveryParentCancelled(this.parentSignal.reason);
    }
    if (
      this.deadlineAtMs !== undefined &&
      Date.now() >= this.deadlineAtMs
    ) {
      return new ProtocolDiscoveryParentDeadline();
    }
    return null;
  }
}

export class ProtocolDiscoveryFamilyCircuitOpen extends Error {
  readonly code = "FAMILY_CIRCUIT_OPEN";

  constructor(familyId: string, stage: string) {
    super(`protocol discovery family circuit open for ${familyId}/${stage}`);
    this.name = "ProtocolDiscoveryFamilyCircuitOpen";
  }
}

export class ProtocolDiscoveryFamilyTimeout extends Error {
  readonly code = "TIMEOUT";

  constructor(label: string, timeoutMs: number) {
    super(`protocol discovery family callback ${label} timed out after ${timeoutMs}ms`);
    this.name = "ProtocolDiscoveryFamilyTimeout";
  }
}

class ProtocolDiscoveryParentCancelled extends Error {
  readonly code = "ABORTED";

  constructor(cause?: unknown) {
    super(
      "protocol discovery parent signal aborted",
      cause === undefined ? undefined : { cause },
    );
    this.name = "ProtocolDiscoveryParentCancelled";
  }
}

class ProtocolDiscoveryParentDeadline extends Error {
  readonly code = "TIMEOUT";

  constructor() {
    super("protocol discovery parent deadline reached");
    this.name = "ProtocolDiscoveryParentDeadline";
  }
}

async function boundedFamilyCall<T>(
  work: (control: ProtocolDiscoveryFamilyCallControl) => Promise<T>,
  deadlineAtMs: number,
  timeoutMs: number,
  label: string,
  parentSignal?: AbortSignal,
  readRunner?: ProtocolDiscoveryReadControl["run"],
): Promise<T> {
  const controller = new AbortController();
  const detachParent = parentSignal
    ? linkAbort(
        parentSignal,
        controller,
        () => new ProtocolDiscoveryParentCancelled(parentSignal.reason),
      )
    : () => {};
  const timeoutError = new ProtocolDiscoveryFamilyTimeout(label, timeoutMs);
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    Math.max(0, deadlineAtMs - Date.now()),
  );
  const pending = Promise.resolve().then(() =>
    work(Object.freeze({
      deadlineAtMs,
      signal: controller.signal,
      ...(readRunner === undefined ? {} : { run: readRunner }),
    }))
  );
  try {
    try {
      const value = await awaitWithAbort(pending, controller.signal);
      if (Date.now() >= deadlineAtMs) {
        controller.abort(timeoutError);
        throw timeoutError;
      }
      return value;
    } catch (error) {
      // The controlled backend shares this exact absolute deadline and may
      // reject its fetch in the same timer turn just before our timer runs.
      // Normalize that boundary as the family timeout and abort the child so
      // late adapter work cannot continue with a live signal.
      if (!controller.signal.aborted && Date.now() >= deadlineAtMs) {
        controller.abort(timeoutError);
        throw timeoutError;
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
    detachParent();
    // A callback that ignores cancellation may settle later. Observe that
    // settlement, but never let it mutate coordinator-owned state after run().
    pending.catch(() => undefined);
  }
}

/**
 * Existing family callbacks keep receiving ProtocolDiscoveryContext. The guard
 * swaps in this backend wrapper so their ordinary ctx.backend calls inherit the
 * child deadline/signal without changing each adapter signature.
 */
export function withProtocolDiscoveryFamilyContext(
  context: ProtocolDiscoveryContext,
  familyControl: ProtocolDiscoveryFamilyCallControl,
): ProtocolDiscoveryContext {
  const base = context.backend;
  const backend: ProtocolDiscoveryReadBackend = {
    call: (req, control) =>
      withReadControl(familyControl, control, (merged) =>
        base.call(req, merged)
      ),
    getCode: (address, control) =>
      withReadControl(familyControl, control, (merged) =>
        base.getCode(address, merged)
      ),
    getStorageAt: (address, position, control) =>
      withReadControl(familyControl, control, (merged) =>
        base.getStorageAt(address, position, merged)
      ),
    getLogs: (req, control) =>
      withReadControl(familyControl, control, (merged) =>
        base.getLogs(req, merged)
      ),
    getTransactionReceipt: (txHash, control) =>
      withReadControl(familyControl, control, (merged) =>
        base.getTransactionReceipt(txHash, merged)
      ),
    traceTransaction: (txHash, control) =>
      withReadControl(familyControl, control, (merged) =>
        base.traceTransaction(txHash, merged)
      ),
    ...(base.simulateCalls
      ? {
          simulateCalls: (req, control) =>
            withReadControl(familyControl, control, (merged) =>
              base.simulateCalls!(req, merged)
            ),
        }
      : {}),
    ...(base.createAccessList
      ? {
          createAccessList: (req, control) =>
            withReadControl(familyControl, control, (merged) =>
              base.createAccessList!(req, merged)
            ),
        }
      : {}),
  };
  return Object.freeze({ ...context, backend: Object.freeze(backend) });
}

async function withReadControl<T>(
  familyControl: ProtocolDiscoveryFamilyCallControl,
  operationControl: ProtocolDiscoveryReadControl | undefined,
  work: (control: ProtocolDiscoveryReadControl) => Promise<T>,
): Promise<T> {
  const deadlineAtMs = Math.min(
    familyControl.deadlineAtMs,
    operationControl?.deadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
  const run = composeProtocolDiscoveryReadRunners(
    familyControl.run,
    operationControl?.run,
  );
  if (
    !operationControl?.signal ||
    operationControl.signal === familyControl.signal
  ) {
    return work({
      deadlineAtMs,
      signal: familyControl.signal,
      ...(run === undefined ? {} : { run }),
    });
  }
  const controller = new AbortController();
  const detachFamily = linkAbort(familyControl.signal, controller);
  const detachOperation = linkAbort(operationControl.signal, controller);
  try {
    return await work({
      deadlineAtMs,
      signal: controller.signal,
      ...(run === undefined ? {} : { run }),
    });
  } finally {
    detachFamily();
    detachOperation();
  }
}

function composeProtocolDiscoveryReadRunners(
  first: ProtocolDiscoveryReadControl["run"],
  second: ProtocolDiscoveryReadControl["run"],
): ProtocolDiscoveryReadControl["run"] {
  if (!first) return second;
  if (!second || first === second) return first;
  return async <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    first((firstSignal) =>
      second((secondSignal) =>
        work(
          firstSignal === secondSignal
            ? firstSignal
            : AbortSignal.any([firstSignal, secondSignal]),
        )
      )
    );
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw signal.reason ?? new ProtocolDiscoveryParentCancelled();
  }
  let remove = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void =>
      reject(signal.reason ?? new ProtocolDiscoveryParentCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    remove();
  }
}

function linkAbort(
  source: AbortSignal,
  target: AbortController,
  reason: () => unknown = () => source.reason,
): () => void {
  if (source.aborted) {
    target.abort(reason());
    return () => {};
  }
  const abort = (): void => target.abort(reason());
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function familyStageKey(familyId: string, stage: string): string {
  if (!familyId || !stage) {
    throw new Error("protocol discovery family guard requires family and stage");
  }
  return `${familyId}|${stage}`;
}

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return Number(raw);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
