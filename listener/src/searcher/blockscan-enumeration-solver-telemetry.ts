import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import type { BlockScanOpportunity } from "./detector/detector.js";
import {
  blockScanRouteLocator,
  blockScanRouteLocatorCacheKey,
  type BlockScanRouteLocator,
} from "./blockscan-route-identity.js";

const DEFAULT_QUEUE_CREDITS = 5;
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024;
const DEFAULT_MAX_ROUTES = 512;
const DEFAULT_MAX_LEGS = 8;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const ROUTE_LOCATOR_CACHE_ENTRIES = 2_048;

export interface BlockScanRouteTelemetryFinish {
  readonly sourceBlockHash: string | null;
  readonly pricingMode:
    | "source_n"
    | "n_minus_one_coarse_current_n_exact"
    | null;
  readonly passOutcome: string;
  readonly passReason: string | null;
}

export interface BlockScanRouteTelemetryPass {
  recordEnumeration(opportunities: readonly BlockScanOpportunity[]): void;
  recordSolver(opportunity: BlockScanOpportunity): void;
  finish(input: BlockScanRouteTelemetryFinish): void;
}

export interface BlockScanRouteTelemetrySink {
  readonly enabled: boolean;
  beginPass(sourceBlock: number): BlockScanRouteTelemetryPass | null;
  recordNotStarted(input: {
    readonly sourceBlock: number;
    readonly sourceBlockHash: null;
    readonly pricingMode: null;
    readonly passOutcome: "not_started";
    readonly passReason:
      | "scheduler_coalesced"
      | "shutdown_pending_dropped";
  }): void;
  shutdown(timeoutMs?: number): Promise<void>;
  telemetry(): BlockScanRouteWriterTelemetry;
}

export interface BlockScanRouteWriterTelemetry {
  readonly enabled: boolean;
  readonly accepting: boolean;
  readonly failed: boolean;
  readonly reserved: number;
  readonly queued: number;
  readonly outstanding: boolean;
  readonly scheduled: number;
  readonly acknowledged: number;
  readonly droppedBatches: number;
  readonly bytesWritten: number;
}

export interface InitBlockScanRouteTelemetryOptions {
  readonly path?: string;
  readonly eventsPath: string;
  readonly runId: string;
  readonly queueCredits?: number;
  readonly maxBatchBytes?: number;
  readonly maxRoutes?: number;
  readonly maxLegs?: number;
  readonly maxFileBytes?: number;
  readonly maxCatalogEntries?: number;
  readonly minFreeBytes?: number;
  readonly epochMs?: number;
  readonly workerUrl?: URL;
  readonly workerExecArgv?: readonly string[];
  readonly onWarning?: (message: string) => void;
}

interface RawRouteBatch {
  readonly sequence: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string | null;
  readonly pricingMode: BlockScanRouteTelemetryFinish["pricingMode"];
  readonly passOutcome: string;
  readonly passReason: string | null;
  readonly routes: readonly BlockScanRouteLocator[];
  readonly enumeration: readonly number[];
  readonly solver: readonly number[];
  readonly gapBefore: RouteGap | null;
}

interface RouteGap {
  readonly droppedBatches: number;
  readonly firstDroppedBlock: number;
  readonly lastDroppedBlock: number;
}

type WorkerReply =
  | {
      readonly type: "ready";
      readonly enabled: boolean;
      readonly reason?: string;
    }
  | {
      readonly type: "ack";
      readonly sequence: number;
      readonly ok: boolean;
      readonly bytesWritten: number;
      readonly reason?: string;
    }
  | { readonly type: "shutdown-complete" };

class DisabledBlockScanRouteTelemetry implements BlockScanRouteTelemetrySink {
  readonly enabled = false;

  beginPass(_sourceBlock: number): null {
    return null;
  }

  recordNotStarted(_input: Parameters<BlockScanRouteTelemetrySink["recordNotStarted"]>[0]): void {}

  async shutdown(_timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {}

  telemetry(): BlockScanRouteWriterTelemetry {
    return Object.freeze({
      enabled: false,
      accepting: false,
      failed: false,
      reserved: 0,
      queued: 0,
      outstanding: false,
      scheduled: 0,
      acknowledged: 0,
      droppedBatches: 0,
      bytesWritten: 0,
    });
  }
}

class BoundedRouteLocatorCache {
  private readonly entries = new Map<string, BlockScanRouteLocator>();

  get(opportunity: BlockScanOpportunity): BlockScanRouteLocator {
    const key = blockScanRouteLocatorCacheKey(opportunity);
    const cached = this.entries.get(key);
    if (cached) return cached;
    const locator = blockScanRouteLocator(opportunity);
    if (this.entries.size < ROUTE_LOCATOR_CACHE_ENTRIES) {
      this.entries.set(key, locator);
    }
    return locator;
  }
}

class RoutePass implements BlockScanRouteTelemetryPass {
  private readonly routes: BlockScanRouteLocator[] = [];
  private readonly indexByRouteId = new Map<string, number>();
  private readonly indexByOpportunity =
    new WeakMap<BlockScanOpportunity, number>();
  private readonly enumeration: number[] = [];
  private readonly solver: number[] = [];
  private enumerationRecorded = false;
  private finished = false;
  private invalid = false;

  constructor(
    private readonly sourceBlock: number,
    private readonly maxRoutes: number,
    private readonly maxLegs: number,
    private readonly locate: (
      opportunity: BlockScanOpportunity,
    ) => BlockScanRouteLocator,
    private readonly finishReserved: (
      sourceBlock: number,
      routes: readonly BlockScanRouteLocator[],
      enumeration: readonly number[],
      solver: readonly number[],
      input: BlockScanRouteTelemetryFinish,
      invalid: boolean,
    ) => void,
  ) {}

  recordEnumeration(opportunities: readonly BlockScanOpportunity[]): void {
    if (this.finished || this.enumerationRecorded) return;
    this.enumerationRecorded = true;
    if (opportunities.length > this.maxRoutes) {
      this.invalid = true;
      return;
    }
    for (const opportunity of opportunities) {
      this.enumeration.push(this.routeIndex(opportunity));
    }
  }

  recordSolver(opportunity: BlockScanOpportunity): void {
    if (this.finished || this.invalid) return;
    this.solver.push(this.routeIndex(opportunity));
  }

  finish(input: BlockScanRouteTelemetryFinish): void {
    if (this.finished) return;
    this.finished = true;
    this.finishReserved(
      this.sourceBlock,
      this.routes,
      this.enumeration,
      this.solver,
      input,
      this.invalid,
    );
  }

  private routeIndex(opportunity: BlockScanOpportunity): number {
    const opportunityIndex = this.indexByOpportunity.get(opportunity);
    if (opportunityIndex !== undefined) return opportunityIndex;
    const locator = this.locate(opportunity);
    if (locator.venuePath.length > this.maxLegs) {
      this.invalid = true;
    }
    const existing = this.indexByRouteId.get(locator.routeId);
    if (existing !== undefined) {
      this.indexByOpportunity.set(opportunity, existing);
      return existing;
    }
    const index = this.routes.length;
    this.routes.push(locator);
    this.indexByRouteId.set(locator.routeId, index);
    this.indexByOpportunity.set(opportunity, index);
    if (this.routes.length > this.maxRoutes) this.invalid = true;
    return index;
  }
}

class WorkerBlockScanRouteTelemetry implements BlockScanRouteTelemetrySink {
  readonly enabled = true;
  private accepting = true;
  private failed = false;
  private nextSequence = 1;
  private reserved = 0;
  private readonly queue: RawRouteBatch[] = [];
  private outstanding: {
    readonly batch: RawRouteBatch;
    readonly gap: RouteGap | null;
  } | null = null;
  private pendingGap: RouteGap | null = null;
  private scheduled = 0;
  private acknowledged = 0;
  private droppedBatches = 0;
  private bytesWritten = 0;
  private warned = false;
  private shutdownResolve: (() => void) | null = null;
  private shutdownTask: Promise<void> | null = null;
  private readonly routeLocatorCache = new BoundedRouteLocatorCache();

  constructor(
    private readonly worker: Worker,
    private readonly queueCredits: number,
    private readonly maxBatchBytes: number,
    private readonly maxRoutes: number,
    private readonly maxLegs: number,
    private readonly onWarning: (message: string) => void,
  ) {
    worker.on("message", (message: WorkerReply) => this.onMessage(message));
    worker.on("error", (error) =>
      this.fail(`route telemetry worker error: ${error.message}`)
    );
    worker.on("exit", (code) => {
      if (!this.failed && (this.accepting || this.outstanding || this.queue.length > 0)) {
        this.fail(`route telemetry worker exited code=${code}`);
      }
      this.shutdownResolve?.();
      this.shutdownResolve = null;
    });
    worker.unref();
  }

  beginPass(sourceBlock: number): BlockScanRouteTelemetryPass | null {
    if (!this.reserve(sourceBlock)) return null;
    return new RoutePass(
      sourceBlock,
      this.maxRoutes,
      this.maxLegs,
      (opportunity) => this.routeLocatorCache.get(opportunity),
      (
        block,
        routes,
        enumeration,
        solver,
        input,
        invalid,
      ) => {
        if (invalid || !this.validBatch(routes, enumeration, solver)) {
          this.releaseReserved();
          this.recordDrop(block);
          return;
        }
        this.enqueueReserved({
          sequence: this.nextSequence++,
          sourceBlock: block,
          sourceBlockHash: input.sourceBlockHash,
          pricingMode: input.pricingMode,
          passOutcome: bounded(input.passOutcome, 80),
          passReason: input.passReason === null
            ? null
            : bounded(input.passReason, 160),
          routes: Object.freeze([...routes]),
          enumeration: Object.freeze([...enumeration]),
          solver: Object.freeze([...solver]),
          gapBefore: null,
        });
      },
    );
  }

  recordNotStarted(
    input: Parameters<BlockScanRouteTelemetrySink["recordNotStarted"]>[0],
  ): void {
    if (!this.reserve(input.sourceBlock)) return;
    this.enqueueReserved({
      sequence: this.nextSequence++,
      sourceBlock: input.sourceBlock,
      sourceBlockHash: null,
      pricingMode: null,
      passOutcome: input.passOutcome,
      passReason: input.passReason,
      routes: Object.freeze([]),
      enumeration: Object.freeze([]),
      solver: Object.freeze([]),
      gapBefore: null,
    });
  }

  shutdown(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.shutdownTask = this.shutdownWorker(timeoutMs);
    return this.shutdownTask;
  }

  private async shutdownWorker(timeoutMs: number): Promise<void> {
    this.accepting = false;
    this.drain();
    const completed = new Promise<void>((resolve) => {
      const deadline = setTimeout(() => resolve(), Math.max(1, timeoutMs));
      deadline.unref();
      const poll = (): void => {
        if (this.outstanding === null && this.queue.length === 0 && this.reserved === 0) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(poll, 5).unref();
      };
      poll();
    });
    await completed;
    if (this.outstanding !== null || this.queue.length > 0 || this.reserved > 0) {
      this.fail("route telemetry shutdown timed out");
      await this.worker.terminate();
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
    try {
      this.worker.postMessage({ type: "shutdown" });
    } catch {
      await this.worker.terminate();
      return;
    }
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, timeoutMs));
        timer.unref();
      }),
    ]);
    if (this.shutdownResolve !== null) {
      this.shutdownResolve = null;
      await this.worker.terminate();
    }
  }

  telemetry(): BlockScanRouteWriterTelemetry {
    return Object.freeze({
      enabled: true,
      accepting: this.accepting,
      failed: this.failed,
      reserved: this.reserved,
      queued: this.queue.length,
      outstanding: this.outstanding !== null,
      scheduled: this.scheduled,
      acknowledged: this.acknowledged,
      droppedBatches: this.droppedBatches,
      bytesWritten: this.bytesWritten,
    });
  }

  private reserve(sourceBlock: number): boolean {
    if (!this.accepting || this.failed || this.reserved >= this.queueCredits) {
      this.recordDrop(sourceBlock);
      return false;
    }
    this.reserved++;
    return true;
  }

  private releaseReserved(): void {
    this.reserved = Math.max(0, this.reserved - 1);
  }

  private enqueueReserved(batch: RawRouteBatch): void {
    if (!this.accepting || this.failed) {
      this.releaseReserved();
      this.recordDrop(batch.sourceBlock);
      return;
    }
    this.scheduled++;
    this.queue.push(batch);
    this.drain();
  }

  private drain(): void {
    if (this.failed || this.outstanding !== null || this.queue.length === 0) return;
    const batch = this.queue.shift()!;
    const gap = this.pendingGap;
    this.pendingGap = null;
    const messageBatch = Object.freeze({ ...batch, gapBefore: gap });
    this.outstanding = { batch: messageBatch, gap };
    setImmediate(() => {
      if (this.failed || this.outstanding?.batch.sequence !== messageBatch.sequence) return;
      try {
        this.worker.postMessage({ type: "batch", batch: messageBatch });
      } catch (error) {
        this.fail(
          `route telemetry postMessage failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  private onMessage(message: WorkerReply): void {
    if (message.type === "shutdown-complete") {
      this.shutdownResolve?.();
      this.shutdownResolve = null;
      return;
    }
    if (message.type !== "ack") return;
    const outstanding = this.outstanding;
    if (!outstanding || outstanding.batch.sequence !== message.sequence) {
      this.fail(`route telemetry ack sequence mismatch ${message.sequence}`);
      return;
    }
    this.outstanding = null;
    this.releaseReserved();
    if (!message.ok) {
      this.recordDrop(outstanding.batch.sourceBlock);
      this.fail(`route telemetry write failed: ${message.reason ?? "unknown"}`);
      return;
    }
    this.acknowledged++;
    this.bytesWritten = message.bytesWritten;
    this.drain();
  }

  private validBatch(
    routes: readonly BlockScanRouteLocator[],
    enumeration: readonly number[],
    solver: readonly number[],
  ): boolean {
    if (routes.length > this.maxRoutes) return false;
    const validIndex = (index: number): boolean =>
      Number.isSafeInteger(index) && index >= 0 && index < routes.length;
    if (!enumeration.every(validIndex) || !solver.every(validIndex)) return false;
    let estimated = 512 + (enumeration.length + solver.length) * 8;
    for (const route of routes) {
      if (
        route.routeId.length > 80 ||
        route.flashToken.length > 80 ||
        route.tokenRing.length > this.maxLegs + 1 ||
        route.venuePath.length > this.maxLegs
      ) return false;
      estimated += route.routeId.length + route.flashToken.length + 64;
      for (const token of route.tokenRing) {
        if (token.length > 80) return false;
        estimated += token.length;
      }
      for (const [adapterId, venueId] of route.venuePath) {
        if (adapterId.length > 160 || venueId.length > 96) return false;
        estimated += adapterId.length + venueId.length + 8;
      }
    }
    return estimated <= this.maxBatchBytes;
  }

  private recordDrop(sourceBlock: number): void {
    this.droppedBatches++;
    const previous = this.pendingGap;
    this.pendingGap = previous
      ? {
          droppedBatches: previous.droppedBatches + 1,
          firstDroppedBlock: Math.min(previous.firstDroppedBlock, sourceBlock),
          lastDroppedBlock: Math.max(previous.lastDroppedBlock, sourceBlock),
        }
      : {
          droppedBatches: 1,
          firstDroppedBlock: sourceBlock,
          lastDroppedBlock: sourceBlock,
        };
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.accepting = false;
    if (this.outstanding) {
      this.recordDrop(this.outstanding.batch.sourceBlock);
    }
    for (const batch of this.queue) {
      this.recordDrop(batch.sourceBlock);
    }
    this.outstanding = null;
    this.queue.length = 0;
    this.reserved = 0;
    this.warnOnce(`${message}; sidecar is incomplete`);
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.onWarning(message);
  }
}

export async function initBlockScanEnumerationSolverTelemetry(
  options: InitBlockScanRouteTelemetryOptions,
): Promise<BlockScanRouteTelemetrySink> {
  const routePath = (options.path ?? "").trim();
  const eventsPath = options.eventsPath.trim();
  if (!routePath) return new DisabledBlockScanRouteTelemetry();
  const warn = options.onWarning ?? ((message: string) =>
    console.warn(`[searcher/blockscan-route-telemetry] ${message}`));
  if (!eventsPath || options.runId === "unknown") {
    warn("disabled: SEARCHER_EVENTS_PATH and shared run_id are required");
    return new DisabledBlockScanRouteTelemetry();
  }
  if (resolve(routePath) === resolve(eventsPath)) {
    warn("disabled: route sidecar path equals SEARCHER_EVENTS_PATH");
    return new DisabledBlockScanRouteTelemetry();
  }
  const isSource = import.meta.url.endsWith(".ts");
  const workerUrl = options.workerUrl ?? new URL(
    `./blockscan-enumeration-solver-worker.${isSource ? "ts" : "js"}`,
    import.meta.url,
  );
  const workerExecArgv = options.workerExecArgv ??
    (isSource ? ["--import", "tsx"] : []);
  let worker: Worker | null = null;
  try {
    const queueCredits = positiveInteger(
      options.queueCredits ?? DEFAULT_QUEUE_CREDITS,
      "queue credits",
    );
    const maxBatchBytes = positiveInteger(
      options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
      "batch bytes",
    );
    const maxRoutes = positiveInteger(
      options.maxRoutes ?? DEFAULT_MAX_ROUTES,
      "max routes",
    );
    const maxLegs = positiveInteger(
      options.maxLegs ?? DEFAULT_MAX_LEGS,
      "max legs",
    );
    worker = new Worker(workerUrl, {
      execArgv: [...workerExecArgv],
      workerData: {
        routePath,
        eventsPath,
        runId: options.runId,
        maxFileBytes: options.maxFileBytes ?? 100 * 1024 * 1024,
        maxCatalogEntries: options.maxCatalogEntries ?? 50_000,
        minFreeBytes: options.minFreeBytes ?? 1024 * 1024 * 1024,
        epochMs: options.epochMs ?? 24 * 60 * 60 * 1000,
        maxEncodedBatchBytes: maxBatchBytes,
      },
    });
    const ready = await waitForReady(worker, 5_000);
    if (!ready.enabled) {
      throw new Error(ready.reason ?? "worker initialization failed");
    }
    return new WorkerBlockScanRouteTelemetry(
      worker,
      queueCredits,
      maxBatchBytes,
      maxRoutes,
      maxLegs,
      warn,
    );
  } catch (error) {
    if (worker) {
      await worker.terminate().catch(() => {});
    }
    warn(
      `disabled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new DisabledBlockScanRouteTelemetry();
  }
}

function waitForReady(worker: Worker, timeoutMs: number): Promise<Extract<WorkerReply, { type: "ready" }>> {
  return new Promise((resolveReady) => {
    let settled = false;
    const finish = (reply: Extract<WorkerReply, { type: "ready" }>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      resolveReady(reply);
    };
    const onMessage = (message: WorkerReply): void => {
      if (message.type === "ready") finish(message);
    };
    const onError = (error: Error): void =>
      finish({ type: "ready", enabled: false, reason: error.message });
    const onExit = (code: number): void =>
      finish({ type: "ready", enabled: false, reason: `worker exit ${code}` });
    const timer = setTimeout(
      () => finish({ type: "ready", enabled: false, reason: "worker ready timeout" }),
      timeoutMs,
    );
    timer.unref();
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${label} ${value}`);
  }
  return value;
}

function bounded(value: string, max: number): string {
  return value.replace(/\s+/g, " ").slice(0, max);
}
