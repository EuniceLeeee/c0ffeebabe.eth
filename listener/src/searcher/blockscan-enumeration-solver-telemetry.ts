import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import type { BlockScanOpportunity } from "./detector/detector.js";
import type { BlockScanProbeDiagnostic } from
  "./detector/blockscan-candidate-refinement.js";
import {
  blockScanRouteLocator,
  blockScanRouteLocatorCacheKey,
  type BlockScanRouteLocator,
} from "./blockscan-route-identity.js";
import type {
  StrictPricingPublication,
} from "./strict-current-runtime-coordinator.js";
import type { RouteVenueMid } from "./venues/mid-readers.js";

const DEFAULT_QUEUE_CREDITS = 5;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_ROUTES = 512;
const DEFAULT_MAX_LEGS = 8;
const DEFAULT_MAX_MID_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MID_RECORD_BYTES = 128 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const ROUTE_LOCATOR_CACHE_ENTRIES = 2_048;

type CompactExactValue = number | null;

export interface BlockScanRouteTelemetryFinish {
  readonly sourceBlockHash: string | null;
  readonly midSourceBlock: number | null;
  readonly midSourceBlockHash: string | null;
  readonly pricingMode:
    | "source_n"
    | "n_minus_one_coarse_current_n_exact"
    | null;
  readonly passOutcome: string;
  readonly passReason: string | null;
}

export interface BlockScanRouteTelemetryPass {
  recordEnumeration(opportunities: readonly BlockScanOpportunity[]): void;
  recordExact(
    opportunity: BlockScanOpportunity,
    diagnostic: BlockScanProbeDiagnostic,
  ): void;
  recordPlanner(opportunity: BlockScanOpportunity): void;
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
  recordPricing(publication: StrictPricingPublication): void;
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
  readonly midBaselines: number;
  readonly midDeltas: number;
  readonly droppedMidPublications: number;
  readonly midBytesWritten: number;
}

export interface InitBlockScanRouteTelemetryOptions {
  readonly path?: string;
  readonly midHistoryPath?: string;
  readonly eventsPath: string;
  readonly runId: string;
  readonly queueCredits?: number;
  readonly maxBatchBytes?: number;
  readonly maxRoutes?: number;
  readonly maxLegs?: number;
  readonly maxFileBytes?: number;
  readonly maxMidFileBytes?: number;
  readonly maxMidRecordBytes?: number;
  readonly maxCatalogEntries?: number;
  readonly minFreeBytes?: number;
  readonly epochMs?: number;
  readonly workerUrl?: URL;
  readonly workerExecArgv?: readonly string[];
  readonly onWarning?: (message: string) => void;
}

interface RawRouteBatch {
  readonly kind: "route";
  readonly sequence: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string | null;
  readonly midSourceBlock: number | null;
  readonly midSourceBlockHash: string | null;
  readonly pricingMode: BlockScanRouteTelemetryFinish["pricingMode"];
  readonly passOutcome: string;
  readonly passReason: string | null;
  readonly routes: readonly BlockScanRouteLocator[];
  readonly enumeration: readonly number[];
  readonly exact: readonly CompactExactValue[] | null;
  readonly planner: readonly number[];
  readonly solver: readonly number[];
  readonly gapBefore: RouteGap | null;
}

interface CompactRouteVenueMid {
  readonly kind: RouteVenueMid["kind"];
  readonly mid: number;
  readonly fee_bps: number;
  readonly reserve_a?: string;
  readonly reserve_b?: string;
  readonly sqrt_ab_x96?: string;
  readonly liquidity?: string;
  readonly depth_proxy: number;
}

interface MidHistoryAnchor {
  readonly generation: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
  readonly graphFingerprint: string;
}

interface MidHistoryGap {
  readonly droppedPublications: number;
  readonly firstDroppedBlock: number;
  readonly lastDroppedBlock: number;
}

type RawMidBatch =
  | (MidHistoryAnchor & {
      readonly kind: "mid-baseline";
      readonly sequence: number;
      readonly mids: readonly (readonly [string, CompactRouteVenueMid])[];
      readonly gapBefore: MidHistoryGap | null;
    })
  | (MidHistoryAnchor & {
      readonly kind: "mid-delta";
      readonly sequence: number;
      readonly previousGeneration: number;
      readonly previousSourceBlock: number;
      readonly previousSourceBlockHash: string;
      readonly updates: readonly (readonly [string, CompactRouteVenueMid])[];
      readonly removals: readonly string[];
      readonly gapBefore: null;
    });

type RawTelemetryBatch = RawRouteBatch | RawMidBatch;

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
      readonly midBytesWritten: number;
      readonly reason?: string;
    }
  | { readonly type: "shutdown-complete" };

class DisabledBlockScanRouteTelemetry implements BlockScanRouteTelemetrySink {
  readonly enabled = false;

  beginPass(_sourceBlock: number): null {
    return null;
  }

  recordNotStarted(_input: Parameters<BlockScanRouteTelemetrySink["recordNotStarted"]>[0]): void {}

  recordPricing(_publication: StrictPricingPublication): void {}

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
      midBaselines: 0,
      midDeltas: 0,
      droppedMidPublications: 0,
      midBytesWritten: 0,
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
  private readonly enumerationRouteIndexes = new Set<number>();
  private readonly enumerationOpportunities: BlockScanOpportunity[] = [];
  private readonly exact: Array<CompactExactValue | undefined> = [];
  private exactCount = 0;
  private readonly planner: number[] = [];
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
      exact: readonly CompactExactValue[] | null,
      planner: readonly number[],
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
      const index = this.routeIndex(opportunity);
      this.enumeration.push(index);
      this.enumerationRouteIndexes.add(index);
      this.enumerationOpportunities.push(opportunity);
    }
    this.exact.length = opportunities.length * 4;
  }

  recordExact(
    opportunity: BlockScanOpportunity,
    diagnostic: BlockScanProbeDiagnostic,
  ): void {
    if (this.finished || this.invalid) return;
    const rankIndex = diagnostic.index;
    const exactOffset = rankIndex * 4;
    if (
      !this.enumerationRecorded ||
      !Number.isSafeInteger(rankIndex) ||
      rankIndex < 0 ||
      rankIndex >= this.enumeration.length ||
      this.exact[exactOffset] !== undefined ||
      this.enumerationOpportunities[rankIndex] !== opportunity
    ) {
      this.invalid = true;
      return;
    }
    if (!writeCompactExactDiagnostic(this.exact, exactOffset, diagnostic)) {
      this.invalid = true;
      return;
    }
    this.exactCount++;
  }

  recordPlanner(opportunity: BlockScanOpportunity): void {
    if (this.finished || this.invalid) return;
    const index = this.routeIndex(opportunity);
    if (!this.enumerationRouteIndexes.has(index)) {
      this.invalid = true;
      return;
    }
    this.planner.push(index);
  }

  recordSolver(opportunity: BlockScanOpportunity): void {
    if (this.finished || this.invalid) return;
    const index = this.routeIndex(opportunity);
    if (!this.enumerationRouteIndexes.has(index)) {
      this.invalid = true;
      return;
    }
    this.solver.push(index);
  }

  finish(input: BlockScanRouteTelemetryFinish): void {
    if (this.finished) return;
    this.finished = true;
    let exact: readonly CompactExactValue[] | null =
      this.enumeration.length === 0 ? Object.freeze([]) : null;
    if (this.exactCount > 0) {
      if (this.exactCount !== this.enumeration.length) {
        this.invalid = true;
      } else {
        exact = Object.freeze(this.exact) as readonly CompactExactValue[];
      }
    }
    this.finishReserved(
      this.sourceBlock,
      this.routes,
      this.enumeration,
      exact,
      this.planner,
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
  private readonly queue: RawTelemetryBatch[] = [];
  private outstanding: RawTelemetryBatch | null = null;
  private pendingGap: RouteGap | null = null;
  private pendingMidGap: MidHistoryGap | null = null;
  private midAnchor: MidHistoryAnchor | null = null;
  private scheduled = 0;
  private acknowledged = 0;
  private droppedBatches = 0;
  private bytesWritten = 0;
  private midBaselines = 0;
  private midDeltas = 0;
  private droppedMidPublications = 0;
  private midBytesWritten = 0;
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
    private readonly midEnabled: boolean,
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
    if (!this.reserve(sourceBlock, "route")) return null;
    return new RoutePass(
      sourceBlock,
      this.maxRoutes,
      this.maxLegs,
      (opportunity) => this.routeLocatorCache.get(opportunity),
      (
        block,
        routes,
        enumeration,
        exact,
        planner,
        solver,
        input,
        invalid,
      ) => {
        if (
          invalid ||
          !this.validBatch(routes, enumeration, exact, planner, solver) ||
          !validFinish(input)
        ) {
          this.releaseReserved();
          this.recordDrop(block);
          return;
        }
        this.enqueueReserved({
          kind: "route",
          sequence: this.nextSequence++,
          sourceBlock: block,
          sourceBlockHash: input.sourceBlockHash,
          midSourceBlock: input.midSourceBlock,
          midSourceBlockHash: input.midSourceBlockHash,
          pricingMode: input.pricingMode,
          passOutcome: bounded(input.passOutcome, 80),
          passReason: input.passReason === null
            ? null
            : bounded(input.passReason, 160),
          routes: Object.freeze([...routes]),
          enumeration: Object.freeze([...enumeration]),
          exact,
          planner: Object.freeze([...planner]),
          solver: Object.freeze([...solver]),
          gapBefore: null,
        });
      },
    );
  }

  recordNotStarted(
    input: Parameters<BlockScanRouteTelemetrySink["recordNotStarted"]>[0],
  ): void {
    if (!this.reserve(input.sourceBlock, "route")) return;
    this.enqueueReserved({
      kind: "route",
      sequence: this.nextSequence++,
      sourceBlock: input.sourceBlock,
      sourceBlockHash: null,
      midSourceBlock: null,
      midSourceBlockHash: null,
      pricingMode: null,
      passOutcome: input.passOutcome,
      passReason: input.passReason,
      routes: Object.freeze([]),
      enumeration: Object.freeze([]),
      exact: Object.freeze([]),
      planner: Object.freeze([]),
      solver: Object.freeze([]),
      gapBefore: null,
    });
  }

  recordPricing(publication: StrictPricingPublication): void {
    if (!this.midEnabled) return;
    const sourceBlock = publication.snapshot.sourceBlock;
    if (!this.reserve(sourceBlock, "mid")) return;
    try {
      const anchor: MidHistoryAnchor = Object.freeze({
        generation: publication.snapshot.generation,
        sourceBlock,
        sourceBlockHash: publication.snapshot.sourceBlockHash,
        graphFingerprint: publication.graphFingerprint,
      });
      const writeDelta = publication.kind === "delta" &&
        this.midAnchor !== null &&
        publication.previousGeneration === this.midAnchor.generation &&
        publication.previousSourceBlock === this.midAnchor.sourceBlock &&
        publication.previousSourceBlockHash.toLowerCase() ===
          this.midAnchor.sourceBlockHash.toLowerCase() &&
        publication.graphFingerprint === this.midAnchor.graphFingerprint &&
        this.pendingMidGap === null;
      const batch: RawMidBatch = writeDelta
        ? Object.freeze({
            kind: "mid-delta" as const,
            sequence: this.nextSequence++,
            ...anchor,
            previousGeneration: publication.previousGeneration,
            previousSourceBlock: publication.previousSourceBlock,
            previousSourceBlockHash: publication.previousSourceBlockHash,
            updates: compactMids(publication.updates),
            removals: Object.freeze([...publication.removals]),
            gapBefore: null,
          })
        : Object.freeze({
            kind: "mid-baseline" as const,
            sequence: this.nextSequence++,
            ...anchor,
            mids: compactMids(publication.snapshot.mids),
            gapBefore: this.pendingMidGap,
          });
      this.pendingMidGap = null;
      this.midAnchor = anchor;
      if (batch.kind === "mid-baseline") this.midBaselines++;
      else this.midDeltas++;
      this.enqueueReserved(batch);
    } catch (error) {
      this.releaseReserved();
      this.recordMidDrop(sourceBlock);
      this.warnOnce(
        `mid publication rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      midBaselines: this.midBaselines,
      midDeltas: this.midDeltas,
      droppedMidPublications: this.droppedMidPublications,
      midBytesWritten: this.midBytesWritten,
    });
  }

  private reserve(sourceBlock: number, kind: "route" | "mid"): boolean {
    if (!this.accepting || this.failed || this.reserved >= this.queueCredits) {
      if (kind === "route") this.recordDrop(sourceBlock);
      else this.recordMidDrop(sourceBlock);
      return false;
    }
    this.reserved++;
    return true;
  }

  private releaseReserved(): void {
    this.reserved = Math.max(0, this.reserved - 1);
  }

  private enqueueReserved(batch: RawTelemetryBatch): void {
    if (!this.accepting || this.failed) {
      this.releaseReserved();
      this.recordBatchDrop(batch);
      return;
    }
    this.scheduled++;
    this.queue.push(batch);
    this.drain();
  }

  private drain(): void {
    if (this.failed || this.outstanding !== null || this.queue.length === 0) return;
    const batch = this.queue.shift()!;
    const messageBatch = batch.kind === "route"
      ? Object.freeze({ ...batch, gapBefore: this.takeRouteGap() })
      : batch;
    this.outstanding = messageBatch;
    setImmediate(() => {
      if (this.failed || this.outstanding?.sequence !== messageBatch.sequence) return;
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
    if (!outstanding || outstanding.sequence !== message.sequence) {
      this.fail(`route telemetry ack sequence mismatch ${message.sequence}`);
      return;
    }
    this.outstanding = null;
    this.releaseReserved();
    if (!message.ok) {
      this.recordBatchDrop(outstanding);
      this.fail(`route telemetry write failed: ${message.reason ?? "unknown"}`);
      return;
    }
    this.acknowledged++;
    this.bytesWritten = message.bytesWritten;
    this.midBytesWritten = message.midBytesWritten;
    this.drain();
  }

  private validBatch(
    routes: readonly BlockScanRouteLocator[],
    enumeration: readonly number[],
    exact: readonly CompactExactValue[] | null,
    planner: readonly number[],
    solver: readonly number[],
  ): boolean {
    if (routes.length > this.maxRoutes) return false;
    const validIndex = (index: number): boolean =>
      Number.isSafeInteger(index) && index >= 0 && index < routes.length;
    if (
      !enumeration.every(validIndex) ||
      !planner.every(validIndex) ||
      !solver.every(validIndex) ||
      (exact !== null &&
        (
          exact.length !== enumeration.length * 4 ||
          !validCompactExactDiagnostics(exact)
        ))
    ) return false;
    let estimated = 640 +
      (enumeration.length + planner.length + solver.length) * 8 +
      (exact?.length ?? 0) * 10;
    for (const route of routes) {
      if (
        route.routeId.length > 80 ||
        route.flashToken.length > 80 ||
        route.edgeIds.length > this.maxLegs ||
        route.tokenRing.length > this.maxLegs + 1 ||
        route.venuePath.length > this.maxLegs ||
        route.edgeIds.length !== route.venuePath.length
      ) return false;
      estimated += route.routeId.length + route.flashToken.length + 64;
      for (const token of route.tokenRing) {
        if (token.length > 80) return false;
        estimated += token.length;
      }
      for (const edgeId of route.edgeIds) {
        if (edgeId.length === 0 || edgeId.length > 512) return false;
        estimated += edgeId.length + 4;
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

  private recordMidDrop(sourceBlock: number): void {
    this.midAnchor = null;
    this.droppedMidPublications++;
    const previous = this.pendingMidGap;
    this.pendingMidGap = previous
      ? {
          droppedPublications: previous.droppedPublications + 1,
          firstDroppedBlock: Math.min(previous.firstDroppedBlock, sourceBlock),
          lastDroppedBlock: Math.max(previous.lastDroppedBlock, sourceBlock),
        }
      : {
          droppedPublications: 1,
          firstDroppedBlock: sourceBlock,
          lastDroppedBlock: sourceBlock,
        };
  }

  private recordBatchDrop(batch: RawTelemetryBatch): void {
    if (batch.kind === "route") this.recordDrop(batch.sourceBlock);
    else this.recordMidDrop(batch.sourceBlock);
  }

  private takeRouteGap(): RouteGap | null {
    const gap = this.pendingGap;
    this.pendingGap = null;
    return gap;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.accepting = false;
    if (this.outstanding) {
      this.recordBatchDrop(this.outstanding);
    }
    for (const batch of this.queue) {
      this.recordBatchDrop(batch);
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
  const midHistoryPath = (options.midHistoryPath ?? "").trim();
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
  if (
    midHistoryPath &&
    (
      resolve(midHistoryPath) === resolve(routePath) ||
      resolve(midHistoryPath) === resolve(eventsPath)
    )
  ) {
    warn("disabled: mid history path equals another telemetry path");
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
        midHistoryPath,
        eventsPath,
        runId: options.runId,
        maxFileBytes: options.maxFileBytes ?? 100 * 1024 * 1024,
        maxMidFileBytes: options.maxMidFileBytes ??
          DEFAULT_MAX_MID_FILE_BYTES,
        maxMidRecordBytes: options.maxMidRecordBytes ??
          DEFAULT_MAX_MID_RECORD_BYTES,
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
      midHistoryPath.length > 0,
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

function writeCompactExactDiagnostic(
  target: Array<CompactExactValue | undefined>,
  offset: number,
  diagnostic: BlockScanProbeDiagnostic,
): boolean {
  const status = diagnostic.status === "positive"
    ? 1
    : diagnostic.status === "negative"
      ? 2
      : diagnostic.status === "failed"
        ? 3
        : 4;
  const reason = diagnostic.failure?.reason;
  const failure = reason === undefined
    ? 0
    : reason === "exact_not_admitted"
      ? 1
      : reason === "family_circuit_open"
        ? 2
        : reason === "instance_circuit_open"
          ? 3
          : reason === "composite_circuit_open"
            ? 4
            : reason === "probe_timeout"
              ? 5
              : reason === "global_deadline"
                ? 6
                : reason === "quote_error"
                  ? 7
                  : -1;
  if (
    failure < 0 ||
    (
      diagnostic.marginBps !== null &&
      !Number.isFinite(diagnostic.marginBps)
    ) ||
    (
      (diagnostic.status === "positive" ||
        diagnostic.status === "negative") !==
      (diagnostic.failure === null)
    )
  ) return false;
  target[offset] = status;
  target[offset + 1] = diagnostic.attempted ? 1 : 0;
  target[offset + 2] = diagnostic.marginBps;
  target[offset + 3] = failure;
  return true;
}

function validCompactExactDiagnostics(
  diagnostics: readonly CompactExactValue[],
): boolean {
  for (let offset = 0; offset < diagnostics.length; offset += 4) {
    const status = diagnostics[offset];
    const attempted = diagnostics[offset + 1];
    const margin = diagnostics[offset + 2];
    const failure = diagnostics[offset + 3];
    if (
      status === null ||
      !Number.isSafeInteger(status) ||
      status < 1 ||
      status > 4 ||
      (attempted !== 0 && attempted !== 1) ||
      (margin !== null && (margin === undefined || !Number.isFinite(margin))) ||
      failure === null ||
      failure === undefined ||
      !Number.isSafeInteger(failure) ||
      failure < 0 ||
      failure > 7
    ) return false;
  }
  return true;
}

function compactMids(
  entries: ReadonlyMap<string, RouteVenueMid> |
    readonly (readonly [string, RouteVenueMid])[],
): readonly (readonly [string, CompactRouteVenueMid])[] {
  const compact: (readonly [string, CompactRouteVenueMid])[] = [];
  const edgeKeys = new Set<string>();
  for (const [edgeKey, mid] of entries) {
    if (!edgeKey || edgeKey.length > 1_024 || edgeKeys.has(edgeKey)) {
      throw new Error("invalid canonical edge key");
    }
    edgeKeys.add(edgeKey);
    compact.push(Object.freeze([edgeKey, compactMid(mid)] as const));
  }
  return Object.freeze(compact);
}

function compactMid(mid: RouteVenueMid): CompactRouteVenueMid {
  if (
    !Number.isFinite(mid.mid) || mid.mid <= 0 ||
    !Number.isFinite(mid.feeBps) || mid.feeBps < 0 ||
    !Number.isFinite(mid.depthProxy) || mid.depthProxy < 0
  ) {
    throw new Error("invalid resolved mid");
  }
  return Object.freeze({
    kind: mid.kind,
    mid: mid.mid,
    fee_bps: mid.feeBps,
    ...(mid.reserveA === undefined ? {} : { reserve_a: mid.reserveA.toString() }),
    ...(mid.reserveB === undefined ? {} : { reserve_b: mid.reserveB.toString() }),
    ...(mid.sqrtABX96 === undefined
      ? {}
      : { sqrt_ab_x96: mid.sqrtABX96.toString() }),
    ...(mid.liquidity === undefined
      ? {}
      : { liquidity: mid.liquidity.toString() }),
    depth_proxy: mid.depthProxy,
  });
}

function validFinish(input: BlockScanRouteTelemetryFinish): boolean {
  const validNullableHash = (value: string | null): boolean =>
    value === null || (value.length > 0 && value.length <= 128);
  return validNullableHash(input.sourceBlockHash) &&
    validNullableHash(input.midSourceBlockHash) &&
    (
      input.midSourceBlock === null ||
      (Number.isSafeInteger(input.midSourceBlock) && input.midSourceBlock >= 0)
    ) &&
    ((input.midSourceBlock === null) === (input.midSourceBlockHash === null));
}
