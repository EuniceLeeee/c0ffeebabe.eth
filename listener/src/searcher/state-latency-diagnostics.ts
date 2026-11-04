import { PerformanceObserver, performance } from "node:perf_hooks";

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
  observeGc(accept) {
    const observer = new PerformanceObserver(list => accept(list.getEntries() as GcEntry[]));
    observer.observe({ entryTypes: ["gc"] });
    return { takeRecords: () => observer.takeRecords() as GcEntry[], disconnect: () => observer.disconnect() };
  },
  pulse(callback, intervalMs) { const timer = setInterval(callback, intervalMs); timer.unref(); return () => clearInterval(timer); },
  defer(callback) { const immediate = setImmediate(callback); immediate.unref(); return () => clearImmediate(immediate); },
  emit: summary => console.log(`[searcher/state-latency-diagnostics] ${JSON.stringify(summary)}`),
};
interface Snapshot { readonly monotonicMs: number; readonly wallMs: number; readonly cpu: CpuSample; readonly heap: HeapSample }
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
    return { monotonicMs: this.host.now(), wallMs: this.host.wallNow(), cpu: { ...this.host.cpu() }, heap: { ...this.host.heap() } };
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
