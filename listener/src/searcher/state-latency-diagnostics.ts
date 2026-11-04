import { PerformanceObserver, performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

interface GcEntry {
  readonly startTime: number;
  readonly duration: number;
  readonly detail?: { readonly kind?: number; readonly flags?: number };
}
interface HeapSample { readonly heapUsed: number; readonly heapTotal: number; readonly external: number; readonly rss: number }
interface CpuSample { readonly user: number; readonly system: number }
/** Injection is for deterministic diagnostics tests, never production policy. */
export interface StateLatencyHost {
  now(): number;
  wallNow(): number;
  cpu(): CpuSample;
  threadCpu?(): CpuSample | null;
  heap(): HeapSample;
  observeGc(accept: (entries: readonly GcEntry[]) => void): { takeRecords(): readonly GcEntry[]; disconnect(): void };
  pulse(callback: () => void, intervalMs: number): () => void;
  defer(callback: () => void): () => void;
  emit(summary: unknown): void;
}
export interface StateLatencySample { finish(status: "ran" | "failed", sourceBlockHash?: string | null): void }
const PULSE_MS = 100, MAX_SAMPLES = 8, MAX_ENTRIES_PER_DELIVERY = 256, MAX_SLOW_EVENTS = 6;
const nativeHost: StateLatencyHost = {
  now: () => performance.now(), wallNow: () => Date.now(),
  cpu: () => process.cpuUsage(), heap: () => process.memoryUsage(),
  threadCpu: () => {
    if (!isMainThread) return null;
    const threadCpuUsage = (process as NodeJS.Process & { threadCpuUsage?: () => CpuSample }).threadCpuUsage;
    return typeof threadCpuUsage === "function" ? threadCpuUsage.call(process) : null;
  },
  observeGc(accept) {
    const observer = new PerformanceObserver(list => accept(list.getEntries() as GcEntry[]));
    observer.observe({ entryTypes: ["gc"] });
    return { takeRecords: () => observer.takeRecords() as GcEntry[], disconnect: () => observer.disconnect() };
  },
  pulse(callback, intervalMs) { const timer = setInterval(callback, intervalMs); timer.unref(); return () => clearInterval(timer); },
  defer(callback) { const immediate = setImmediate(callback); immediate.unref(); return () => clearImmediate(immediate); },
  emit: summary => console.log(`[searcher/state-latency-diagnostics] ${JSON.stringify(summary)}`),
};
interface Snapshot {
  readonly monotonicMs: number; readonly wallMs: number; readonly cpu: CpuSample; readonly heap: HeapSample;
  readonly mainThreadCpuMicros: CpuSample | null;
}
interface GcOverlap { startMonotonicMs: number; durationMs: number; overlapMs: number; kind: number | null; flags: number | null }
interface LoopWindow { startMonotonicMs: number; endMonotonicMs: number; elapsedMs: number; lateByMs: number; overlapWindowMs: number }
interface Sample {
  readonly sampleSequence: number;
  readonly sourceBlock: number;
  readonly timelineStartedAtMs: number;
  readonly before: Snapshot;
  after?: Snapshot;
  status?: "ran" | "failed";
  sourceBlockHash?: string | null;
  gcCount: number; gcOverlapMs: number; gcDropped: number; gcSlowest: GcOverlap[];
  loopCount: number; loopDelayMs: number; loopSlowest: LoopWindow[];
  pendingLoopAtFinish?: { startMonotonicMs: number; sampledAtMonotonicMs: number; elapsedMs: number; lateByMs: number };
  cancelEmit?: () => void;
}
const overlap = (start: number, end: number, sample: Sample) =>
  Math.max(0, Math.min(end, sample.after?.monotonicMs ?? Infinity) - Math.max(start, sample.before.monotonicMs));
function retainSlowest<T>(events: T[], event: T, cost: (item: T) => number): void {
  events.push(event); events.sort((a, b) => cost(b) - cost(a));
  if (events.length > MAX_SLOW_EVENTS) events.length = MAX_SLOW_EVENTS;
}

/** Process-wide overlapping evidence, never exclusive attribution to pricing.
 * No I/O, awaited work, runtime controls or publication state enters this class. */
export class StateLatencyDiagnostics {
  private readonly samples = new Set<Sample>();
  private observer?: ReturnType<StateLatencyHost["observeGc"]>;
  private stopPulse?: () => void;
  private lastPulse: number;
  private closed = false;
  private droppedSamples = 0;
  private sequence = 0;

  constructor(private readonly host: StateLatencyHost) {
    this.lastPulse = host.now();
    try {
      this.observer = host.observeGc(entries => { try { this.acceptGc(entries); } catch { /* Evidence only. */ } });
      this.stopPulse = host.pulse(() => { try { this.acceptPulse(); } catch { /* Evidence only. */ } }, PULSE_MS);
    } catch {
      this.close();
    }
  }

  private snapshot(): Snapshot {
    return { monotonicMs: this.host.now(), wallMs: this.host.wallNow(), cpu: { ...this.host.cpu() }, heap: { ...this.host.heap() },
      mainThreadCpuMicros: diagnosticCpu(() => this.host.threadCpu?.()) };
  }

  begin(sourceBlock: number, timelineStartedAtMs: number): StateLatencySample | undefined {
    try {
      if (this.closed) return undefined;
      if (this.samples.size >= MAX_SAMPLES) { this.droppedSamples++; return undefined; }
      const sample: Sample = { sampleSequence: ++this.sequence, sourceBlock, timelineStartedAtMs, before: this.snapshot(),
        gcCount: 0, gcOverlapMs: 0, gcDropped: 0, gcSlowest: [], loopCount: 0, loopDelayMs: 0, loopSlowest: [] };
      this.samples.add(sample);
      return { finish: (status, sourceBlockHash) => { try { this.finish(sample, status, sourceBlockHash); } catch { this.discard(sample); } } };
    } catch { return undefined; }
  }

  private finish(sample: Sample, status: "ran" | "failed", sourceBlockHash?: string | null): void {
    if (!this.samples.has(sample) || sample.after !== undefined) return;
    // Freeze actual boundaries before any observer drain or asynchronous emit.
    sample.after = this.snapshot(); sample.status = status;
    sample.sourceBlockHash = typeof sourceBlockHash === "string" && /^0x[0-9a-f]{64}$/i.test(sourceBlockHash)
      ? sourceBlockHash.toLowerCase() : null;
    sample.pendingLoopAtFinish = { startMonotonicMs: this.lastPulse, sampledAtMonotonicMs: sample.after.monotonicMs,
      elapsedMs: Math.max(0, sample.after.monotonicMs - this.lastPulse),
      lateByMs: Math.max(0, sample.after.monotonicMs - this.lastPulse - PULSE_MS) };
    this.acceptGc(this.observer?.takeRecords() ?? []);
    // Node can queue a GC entry only on the next turn after synchronous GC.
    // Never wait for it or move the measured finish time. One unref flush can
    // collect it, but does NOT promise complete GC visibility at this boundary.
    sample.cancelEmit = this.host.defer(() => {
      try { this.acceptGc(this.observer?.takeRecords() ?? []); this.emit(sample, "next-turn"); }
      catch { this.discard(sample); }
    });
  }

  private acceptGc(entries: readonly GcEntry[]): void {
    if (this.closed) return;
    const omitted = Math.max(0, entries.length - MAX_ENTRIES_PER_DELIVERY);
    if (omitted) for (const sample of this.samples) sample.gcDropped += omitted;
    for (let index = omitted; index < entries.length; index++) {
      const entry = entries[index]!;
      if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) continue;
      for (const sample of this.samples) {
        const overlapMs = overlap(entry.startTime, entry.startTime + entry.duration, sample);
        if (overlapMs <= 0) continue;
        sample.gcCount++; sample.gcOverlapMs += overlapMs;
        retainSlowest(sample.gcSlowest, { startMonotonicMs: entry.startTime, durationMs: entry.duration, overlapMs,
          kind: Number.isSafeInteger(entry.detail?.kind) ? entry.detail!.kind! : null,
          flags: Number.isSafeInteger(entry.detail?.flags) ? entry.detail!.flags! : null }, item => item.overlapMs);
      }
    }
  }

  private acceptPulse(): void {
    if (this.closed) return;
    const end = this.host.now(), start = this.lastPulse;
    this.lastPulse = end;
    const elapsedMs = Math.max(0, end - start), lateByMs = Math.max(0, elapsedMs - PULSE_MS);
    if (lateByMs < 1) return;
    for (const sample of this.samples) {
      const overlapWindowMs = overlap(start, end, sample);
      if (overlapWindowMs <= 0) continue;
      sample.loopCount++; sample.loopDelayMs += lateByMs;
      retainSlowest(sample.loopSlowest, { startMonotonicMs: start, endMonotonicMs: end, elapsedMs, lateByMs, overlapWindowMs }, item => item.lateByMs);
    }
  }

  private emit(sample: Sample, flush: "next-turn" | "shutdown"): void {
    if (!sample.after || !this.samples.has(sample)) return;
    const { before, after } = sample;
    const summary = {
      sourceBlock: sample.sourceBlock, sourceBlockHash: sample.sourceBlockHash,
      sampleSequence: sample.sampleSequence, scope: "one-state-stage-pass-not-unique-block",
      status: sample.status, attribution: "process-wide-overlap-not-exclusive-cause",
      timelineStartedAtMs: sample.timelineStartedAtMs,
      measurement: { startedAtMs: before.wallMs, finishedAtMs: after.wallMs,
        startedMonotonicMs: before.monotonicMs, finishedMonotonicMs: after.monotonicMs,
        wallMs: Math.max(0, after.monotonicMs - before.monotonicMs), excludesBackdatedSchedulerWait: true },
      processCpu: { userMs: (after.cpu.user - before.cpu.user) / 1_000, systemMs: (after.cpu.system - before.cpu.system) / 1_000 },
      mainThreadCpu: diagnosticCpuDelta("main-thread", before.mainThreadCpuMicros, after.mainThreadCpuMicros),
      processHeap: { before: before.heap, after: after.heap, heapUsedDelta: after.heap.heapUsed - before.heap.heapUsed },
      gc: { visibility: "observed-entries-only-not-proof-of-absence", flush, observedOverlappingEntries: sample.gcCount,
        entryDurationOverlapMs: sample.gcOverlapMs, slowest: sample.gcSlowest,
        omittedSlowEvents: Math.max(0, sample.gcCount - sample.gcSlowest.length), droppedDeliveryEntries: sample.gcDropped,
        durationMeaning: "GC-entry-duration-not-guaranteed-stop-the-world-time" },
      eventLoop: { attribution: "overlapping-timer-windows-not-exact-state-blocked-time", intervalMs: PULSE_MS,
        overlappingDelayedWindows: sample.loopCount, sumWholeWindowLateByMs: sample.loopDelayMs,
        slowest: sample.loopSlowest, omittedSlowWindows: Math.max(0, sample.loopCount - sample.loopSlowest.length),
        pendingTimerAtFinish: sample.pendingLoopAtFinish, visibility: "sampled-windows-may-straddle-boundaries" },
      droppedSamples: this.droppedSamples,
    };
    this.discard(sample); // Sink failure or re-entry cannot duplicate a summary.
    try { this.host.emit(summary); } catch { /* Diagnostics never change the pass. */ }
  }

  private discard(sample: Sample): void {
    this.samples.delete(sample);
    try { sample.cancelEmit?.(); } catch { /* Evidence only. */ }
  }

  close(): void {
    if (this.closed) return;
    try { this.acceptGc(this.observer?.takeRecords() ?? []); } catch { /* Evidence only. */ }
    this.closed = true;
    try { this.stopPulse?.(); } catch { /* Evidence only. */ }
    try { this.observer?.disconnect(); } catch { /* Evidence only. */ }
    for (const sample of this.samples) {
      try { this.emit(sample, "shutdown"); } catch { /* Evidence only. */ }
      this.discard(sample);
    }
  }
}

/** Disabled callers allocate neither observers nor timers. Import is inert. */
export function createStateLatencyDiagnostics(enabled: boolean, host: StateLatencyHost = nativeHost): StateLatencyDiagnostics | undefined {
  if (!enabled) return undefined;
  try { return new StateLatencyDiagnostics(host); } catch { return undefined; }
}

/** Boundary-only synchronous evidence. CPU counters are cumulative microseconds;
 * uptime is seconds, and performance.now/timeOrigin are milliseconds. No hooks,
 * timers, observers, heap reads or samples are created by a disabled caller. */
export interface PricingPhaseHost {
  now(): number;
  timeOrigin(): number;
  uptime(): number;
  threadCpu?(): CpuSample | null;
  cpu(): CpuSample;
  emit(channel: "coverage-phase-diagnostics" | "pricing-local-phase", summary: unknown): void;
}
export type PricingPhaseStatus = "returned" | "failed";
const nativePricingHost: PricingPhaseHost = {
  now: () => performance.now(), timeOrigin: () => performance.timeOrigin,
  uptime: () => process.uptime(),
  threadCpu: () => {
    // Older Node typings/runtimes need feature detection. Never use process CPU
    // as a substitute, nor mislabel a worker's current-thread CPU as main-thread.
    const threadCpuUsage = (process as NodeJS.Process & { threadCpuUsage?: () => CpuSample }).threadCpuUsage;
    return isMainThread && typeof threadCpuUsage === "function" ? threadCpuUsage.call(process) : null;
  },
  cpu: () => process.cpuUsage(),
  emit: (channel, summary) => console.log(`[searcher/${channel}] ${JSON.stringify(summary)}`),
};
interface PricingBoundary {
  readonly beforeSamplingMonotonicMs: number | null;
  readonly afterSamplingMonotonicMs: number | null;
  readonly wallOriginMs: number | null;
  readonly processUptimeMs: number | null;
  readonly mainThreadCpuMicros: CpuSample | null;
  readonly processCpuMicros: CpuSample | null;
}
function diagnosticNumber(read: () => number): number | null {
  try { const value = read(); return Number.isFinite(value) ? value : null; } catch { return null; }
}
function diagnosticCpu(read: () => CpuSample | null | undefined): CpuSample | null {
  try {
    const value = read();
    if (!value || !Number.isFinite(value.user) || !Number.isFinite(value.system) || value.user < 0 || value.system < 0) return null;
    return { user: value.user, system: value.system };
  } catch { return null; }
}
function diagnosticElapsed(start: number | null, end: number | null): number | null {
  return start !== null && end !== null && end >= start ? end - start : null;
}
function diagnosticCpuDelta(scope: "main-thread" | "process-wide-all-threads", before: CpuSample | null, after: CpuSample | null) {
  const user = diagnosticElapsed(before?.user ?? null, after?.user ?? null);
  const system = diagnosticElapsed(before?.system ?? null, after?.system ?? null);
  const available = user !== null && system !== null;
  return { scope, availability: available ? "available" : "unavailable",
    userMs: available ? user / 1_000 : null, systemMs: available ? system / 1_000 : null };
}

/** Four coarse intervals at most; a transition shares one boundary sample.
 * Sampling is bracketed separately from the work intervals. CPU reads within a
 * boundary are sequential, not atomic, and include some diagnostic CPU cost. */
class PricingPhaseDiagnostics {
  private readonly boundaries: PricingBoundary[] = [];
  private readonly phases: string[];
  private finished = false;

  constructor(phase: string, private readonly host: PricingPhaseHost) {
    this.phases = [phase];
    this.boundaries.push(this.sample());
  }

  private sample(): PricingBoundary {
    const beforeSamplingMonotonicMs = diagnosticNumber(() => this.host.now());
    const wallOriginMs = diagnosticNumber(() => this.host.timeOrigin());
    const processUptimeMs = diagnosticNumber(() => this.host.uptime() * 1_000);
    const mainThreadCpuMicros = diagnosticCpu(() => this.host.threadCpu?.());
    const processCpuMicros = diagnosticCpu(() => this.host.cpu());
    const afterSamplingMonotonicMs = diagnosticNumber(() => this.host.now());
    return { beforeSamplingMonotonicMs, afterSamplingMonotonicMs, wallOriginMs, processUptimeMs,
      mainThreadCpuMicros, processCpuMicros };
  }

  enter(phase: string): void {
    try {
      if (this.finished || this.phases.length >= 4) return;
      this.boundaries.push(this.sample());
      this.phases.push(phase);
    } catch { /* Evidence cannot change the work or its original error. */ }
  }

  finish(source: { readonly sourceBlock: number; readonly sourceBlockHash: string; readonly generation: number },
    status: PricingPhaseStatus, channel: "coverage-phase-diagnostics" | "pricing-local-phase",
  ): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.boundaries.push(this.sample()); // Freeze all timing before summary construction or I/O.
      const first = this.boundaries[0]!, last = this.boundaries[this.boundaries.length - 1]!;
      const interval = (before: PricingBoundary, after: PricingBoundary, envelope = false) => {
        const startedMonotonicMs = envelope ? before.beforeSamplingMonotonicMs : before.afterSamplingMonotonicMs;
        const finishedMonotonicMs = envelope ? after.afterSamplingMonotonicMs : after.beforeSamplingMonotonicMs;
        return {
          startedAtMs: before.wallOriginMs !== null && startedMonotonicMs !== null ? before.wallOriginMs + startedMonotonicMs : null,
          finishedAtMs: after.wallOriginMs !== null && finishedMonotonicMs !== null ? after.wallOriginMs + finishedMonotonicMs : null,
          startedMonotonicMs, finishedMonotonicMs, wallMs: diagnosticElapsed(startedMonotonicMs, finishedMonotonicMs),
          mainThreadCpu: diagnosticCpuDelta("main-thread", before.mainThreadCpuMicros, after.mainThreadCpuMicros),
          processCpu: diagnosticCpuDelta("process-wide-all-threads", before.processCpuMicros, after.processCpuMicros),
        };
      };
      const total = interval(first, last, true);
      const intervals = this.phases.map((phase, i) => ({ phase,
        status: i === this.phases.length - 1 ? status : "returned",
        startBoundary: i, endBoundary: i + 1, ...interval(this.boundaries[i]!, this.boundaries[i + 1]!) }));
      const sum = (values: readonly (number | null)[]) => values.reduce<number | null>(
        (total, value) => total === null || value === null ? null : total + value, 0);
      const intervalSumWallMs = sum(intervals.map(item => item.wallMs));
      const boundarySamplingWallMs = sum(this.boundaries.map(item =>
        diagnosticElapsed(item.beforeSamplingMonotonicMs, item.afterSamplingMonotonicMs)));
      this.host.emit(channel, {
        sourceBlock: source.sourceBlock, sourceBlockHash: source.sourceBlockHash, generation: source.generation,
        phase: channel === "pricing-local-phase" ? this.phases[0] : "coverage-assembly", status,
        ...total, timingModel: "sync-wall-includes-gc",
        boundaries: this.boundaries, intervals,
        accounting: { sampleCount: this.boundaries.length, intervalSumWallMs, boundarySamplingWallMs,
          residualWallMs: total.wallMs !== null && intervalSumWallMs !== null ? total.wallMs - intervalSumWallMs : null,
          residualMeaning: "same-call-envelope-minus-nonoverlapping-intervals-includes-boundary-sampling",
          instrumentation: "bookkeeping-remains-in-intervals; collector-setup-summary-and-sink-outside-this-envelope; residual-is-not-total-diagnostic-overhead",
          nesting: "outer-pricing-local-phase-may-include-coverage-summary-and-sink; do-not-add-nested-spans" },
        cpuSampling: "sequential-boundary-counters-in-microseconds; deltas-in-ms-include-some-sampling-cost",
        gcAttribution: "not-measured-here; wall-minus-main-thread-cpu-is-not-proof-of-gc-or-scheduling",
      });
    } catch { /* Includes clock, CPU, source metadata, summary and sink failures. */ }
  }
}

export function beginPricingPhaseDiagnostics(enabled: boolean, phase: string,
  host: PricingPhaseHost = nativePricingHost,
): PricingPhaseDiagnostics | undefined {
  if (!enabled) return undefined;
  try { return new PricingPhaseDiagnostics(phase, host); } catch { return undefined; }
}
