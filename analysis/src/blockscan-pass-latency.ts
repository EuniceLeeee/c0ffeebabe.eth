/**
 * Contiguous pass-latency window analysis for blockscan acceptance.
 *
 * Mirrors the runtime-anchor rules of blockscan-window.ts but measures the
 * whole-block pass pipeline latency (block_scan_timing.total_ms) instead of
 * the N-1 producer generation wall. A pass counts as fast when its total_ms
 * is present and at or below the threshold (default 10000ms); the longest run
 * requires consecutive source blocks inside one process/runtime segment, so a
 * restart or commit switch inside the window disqualifies continuity.
 */

const TIMING_MARKER = "[searcher/blockscan-family] ";
const PROCESS_START_MARKER = "[searcher/live] starting V5 searcher";
const RUNTIME_COMMIT_MARKER = "[searcher/live] runtime_commit=";

type JsonObject = Record<string, unknown>;

export interface PassLatencyRecord {
  readonly line: number;
  readonly processSegment: number;
  readonly runtimeCommit: string | null;
  readonly sourceBlock: number;
  readonly outcome: string | null;
  readonly totalMs: number | null;
  readonly stateMs: number | null;
  readonly enumerationMs: number | null;
  readonly exactRefineMs: number | null;
  readonly plannerSolverMs: number | null;
  readonly plannerBuildMs: number | null;
  readonly solverWallMs: number | null;
  readonly solverQuoteMs: number | null;
  readonly solverPlanBuildMs: number | null;
  readonly solverPlans: number | null;
  readonly solverAmountPoints: number | null;
  readonly solverHopExactCalls: number | null;
  readonly solverGssPoints: number | null;
  readonly preSimMs: number | null;
  readonly finalSimMs: number | null;
  readonly sourceHeadSeenAtMs: number | null;
  readonly fast: boolean;
  readonly invalidReason: string | null;
}

export interface PassLatencyMetricSummary {
  readonly samples: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export interface PassLatencyRunStats {
  readonly count: number;
  readonly fast: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly startBlock: number | null;
  readonly endBlock: number | null;
  readonly blockSpan: number | null;
  readonly consecutiveSourceBlocks: boolean;
  readonly totalMsP50: number | null;
  readonly totalMsP95: number | null;
  readonly totalMsMax: number | null;
  readonly overThreshold: number;
  readonly firstSeenAtUtc: string | null;
  readonly lastSeenAtUtc: string | null;
}

export interface PassLatencyReport {
  readonly schema_version: 1;
  readonly kind: "blockscan_pass_latency_window";
  readonly thresholdMs: number;
  readonly scope: {
    readonly startLine: number;
    readonly endLine: number;
    /** Original log line of the analyzed window start (1 when not sliced). */
    readonly logStartLine: number;
    readonly minRun: number;
    readonly runtimeCommit: string | null;
    readonly processStartLine: number | null;
    readonly processStartCount: number;
    readonly runtimeCommitLines: number;
    readonly recordsBeforeRuntimeCommit: number;
    readonly processIdentityBinding: "log-anchor-only";
    readonly externalPidBindingRequired: true;
    readonly eligibleForQualification: boolean;
    readonly ineligibleReason: string | null;
  };
  readonly totals: {
    readonly passes: number;
    readonly fast: number;
    readonly missingTotalMs: number;
    readonly overThreshold: number;
  };
  readonly metrics: {
    readonly totalMs: PassLatencyMetricSummary;
    readonly stateMs: PassLatencyMetricSummary;
    readonly enumerationMs: PassLatencyMetricSummary;
    readonly exactRefineMs: PassLatencyMetricSummary;
    readonly plannerSolverMs: PassLatencyMetricSummary;
    readonly plannerBuildMs: PassLatencyMetricSummary;
    readonly solverWallMs: PassLatencyMetricSummary;
    /** Aggregate worker quote time; solverWallMs is the concurrent wall clock. */
    readonly solverQuoteMs: PassLatencyMetricSummary;
    readonly solverPlanBuildMs: PassLatencyMetricSummary;
    readonly solverPlans: PassLatencyMetricSummary;
    readonly solverAmountPoints: PassLatencyMetricSummary;
    readonly solverHopExactCalls: PassLatencyMetricSummary;
    readonly solverGssPoints: PassLatencyMetricSummary;
    readonly preSimMs: PassLatencyMetricSummary;
    readonly finalSimMs: PassLatencyMetricSummary;
  };
  readonly invalidByReason: Record<string, number>;
  readonly continuityBreaks: Record<string, number>;
  readonly longestRun: PassLatencyRunStats | null;
  readonly qualifyingRuns: readonly PassLatencyRunStats[];
  readonly productionBoundaries: ReturnType<typeof productionBoundaries>;
}

interface PassLatencyOptions {
  startLine: number;
  endLine?: number;
  minRun: number;
  thresholdMs: number;
  /** Original log line of the window start (slice anchor). */
  logStartLine?: number;
}

export function analyzePassLatency(
  text: string,
  options: PassLatencyOptions,
): PassLatencyReport {
  const analyzer = createPassLatencyAnalyzer(options);
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) analyzer.pushLine(line);
  return analyzer.finish();
}

/** Consume a log window without retaining unrelated lines or joining the whole file. */
export function createPassLatencyAnalyzer(options: PassLatencyOptions): {
  pushLine(line: string): void;
  finish(): PassLatencyReport;
} {
  const firstInclusive = Math.max(1, options.startLine);
  let lineNumber = 0;
  let currentRuntimeCommit: string | null = null;
  const runtimeCommits = new Set<string>();
  let runtimeCommitLines = 0;
  const processStartLines: number[] = [];
  let processSegment = -1;
  let recordsBeforeRuntimeCommit = 0;
  const records: PassLatencyRecord[] = [];
  const boundaryPasses: { record: PassLatencyRecord; timing: JsonObject }[] = [];
  const boundaryEvents: BoundaryEvent[] = [];
  const simByIdentity = new Map<string, BoundaryEvent>();
  const invalidByReason = new Map<string, number>();
  let missingTotalMs = 0;
  let overThreshold = 0;
  let fast = 0;

  const pushLine = (line: string): void => {
    const oneBasedLine = ++lineNumber;
    if (oneBasedLine < firstInclusive ||
      (options.endLine !== undefined && oneBasedLine > options.endLine)) return;
    if (line.includes(PROCESS_START_MARKER)) {
      processStartLines.push(oneBasedLine);
      processSegment++;
      currentRuntimeCommit = null;
      return;
    }
    if (processSegment < 0) return;
    const commitAt = line.indexOf(RUNTIME_COMMIT_MARKER);
    if (commitAt >= 0) {
      const nextRuntimeCommit =
        line.slice(commitAt + RUNTIME_COMMIT_MARKER.length).trim() || null;
      runtimeCommitLines++;
      if (nextRuntimeCommit !== null) runtimeCommits.add(nextRuntimeCommit);
      if (
        currentRuntimeCommit !== null &&
        nextRuntimeCommit !== currentRuntimeCommit
      ) {
        processSegment++;
      }
      currentRuntimeCommit = nextRuntimeCommit;
      return;
    }
    if (currentRuntimeCommit === null) {
      if (line.includes(TIMING_MARKER)) recordsBeforeRuntimeCommit++;
      return;
    }
    for (const [kind, marker] of [
      ["head", "[searcher/live-head-window] "], ["publication", "[searcher/pricing-publication] "],
      ["producer-drain", "[searcher/pricing-drain] "], ["source-n-drain", "[searcher/blockscan-source-n-call-stats-final] "],
      ["effective", "[searcher/effective-mid] "], ["sim", "[searcher/sim-amount] "],
    ]) {
      const payload = markerPayload(line, marker!);
      if (payload !== null) {
        const value = parseObject(payload);
        if (value !== null && kind === "sim") {
          // Keep counts per source, never retain every amount trial or its payload.
          const subject = { pid: value.pid, timeOrigin: value.timeOrigin, sourceBlock: value.sourceBlock,
            sourceBlockHash: typeof value.sourceBlockHash === "string" ? value.sourceBlockHash.toLowerCase() : null, generation: value.generation };
          const key = JSON.stringify([processSegment, subject]);
          let aggregate = simByIdentity.get(key);
          if (aggregate === undefined) {
            aggregate = { segment: processSegment, kind, value: { ...subject,
              constructions: 0, runtimeConstructions: 0, quotedConstructions: 0, quotedAttempts: 0, executions: 0, failures: 0, runtimeExecutions: 0, quotedExecutions: 0, minExecutionAt: null, maxExecutionAt: null, invalidExecutionClock: false } };
            simByIdentity.set(key, aggregate); boundaryEvents.push(aggregate);
          }
          const target = aggregate.value;
          if (value.mode === "quoted") target.quotedAttempts = Number(target.quotedAttempts) + 1;
          if (value.type === "sim_amount_construction") {
            target.constructions = Number(target.constructions) + 1;
            if (value.mode === "runtime-actual") target.runtimeConstructions = Number(target.runtimeConstructions) + 1;
            if (value.mode === "quoted") target.quotedConstructions = Number(target.quotedConstructions) + 1;
          }
          if (value.type === "sim_amount_failure") target.failures = Number(target.failures) + 1;
          if (value.type === "sim_amount_execution") {
            target.executions = Number(target.executions) + 1;
            if (value.mode === "runtime-actual") target.runtimeExecutions = Number(target.runtimeExecutions) + 1;
            if (value.mode === "quoted") target.quotedExecutions = Number(target.quotedExecutions) + 1;
            const at = numberOrNull(value.atMonotonicMs);
            if (at === null || at < 0) target.invalidExecutionClock = true;
            else {
              target.minExecutionAt = target.minExecutionAt === null ? at : Math.min(Number(target.minExecutionAt), at);
              target.maxExecutionAt = target.maxExecutionAt === null ? at : Math.max(Number(target.maxExecutionAt), at);
            }
          }
        } else if (value !== null) boundaryEvents.push({ segment: processSegment, kind: kind!, value });
        return;
      }
    }
    const timingPayload = markerPayload(line, TIMING_MARKER);
    if (timingPayload === null || !timingPayload.startsWith("{")) return;
    const timing = parseObject(timingPayload);
    if (!timing || timing.type !== "block_scan_timing") return;
    const sourceBlock = nonNegativeInteger(timing.source_block);
    if (sourceBlock === null) return;
    const totalMs = numberOrNull(timing.total_ms);
    let invalidReason: string | null = null;
    if (totalMs === null) {
      invalidReason = "missing_total_ms";
      missingTotalMs++;
    } else if (totalMs > options.thresholdMs) {
      invalidReason = "over_threshold";
      overThreshold++;
    } else {
      fast++;
    }
    if (invalidReason !== null) {
      invalidByReason.set(
        invalidReason,
        (invalidByReason.get(invalidReason) ?? 0) + 1,
      );
    }
    const record: PassLatencyRecord = {
      line: oneBasedLine,
      processSegment,
      runtimeCommit: currentRuntimeCommit,
      sourceBlock,
      outcome: typeof timing.outcome === "string" ? timing.outcome : null,
      totalMs,
      stateMs: numberOrNull(nestedNumber(timing, "stage_timing_ms", "state")),
      enumerationMs: nestedNumber(timing, "stage_timing_ms", "enumeration"),
      exactRefineMs: nestedNumber(timing, "stage_timing_ms", "exact_refine"),
      plannerSolverMs: nestedNumber(timing, "stage_timing_ms", "planner_solver"),
      plannerBuildMs: nestedNumber(timing, "planner_solver_detail", "plannerBuildMs"),
      solverWallMs: nestedNumber(timing, "planner_solver_detail", "solverWallMs"),
      solverQuoteMs: nestedNumber(timing, "planner_solver_detail", "solverQuoteMs"),
      solverPlanBuildMs: nestedNumber(
        timing,
        "planner_solver_detail",
        "solverPlanBuildMs",
      ),
      solverPlans: nestedNumber(timing, "planner_solver_detail", "solverPlans"),
      solverAmountPoints: nestedNumber(
        timing,
        "planner_solver_detail",
        "solverAmountPoints",
      ),
      solverHopExactCalls: nestedNumber(
        timing,
        "planner_solver_detail",
        "solverHopExactCalls",
      ),
      solverGssPoints: nestedNumber(
        timing,
        "planner_solver_detail",
        "solverGssPoints",
      ),
      preSimMs: nestedNumber(timing, "planner_solver_detail", "preSimMs"),
      finalSimMs: nestedNumber(timing, "planner_solver_detail", "finalSimMs") ??
        nestedNumber(timing, "stage_timing_ms", "final_sim"),
      sourceHeadSeenAtMs: nonNegativeInteger(timing.source_head_seen_at_ms),
      fast: invalidReason === null,
      invalidReason,
    };
    records.push(record);
    boundaryPasses.push({ record, timing });
  };

  const finish = (): PassLatencyReport => {
    const lastInclusive = Math.min(options.endLine ?? lineNumber, lineNumber);
    const runAnalysis = longestContiguousFastRun(records, options.minRun);
    const processStartLine = processStartLines.length === 1
      ? processStartLines[0] as number
      : null;
    const runtimeCommit = runtimeCommits.size === 1
      ? [...runtimeCommits][0] as string
      : null;
    const ineligibleReason =
      processStartLines.length !== 1
        ? `expected_one_process_start:${processStartLines.length}`
        : processStartLine !== firstInclusive
          ? `process_start_not_scope_start:${processStartLine}`
          : runtimeCommitLines !== 1 || runtimeCommits.size !== 1
            ? `expected_one_nonempty_runtime_commit_line:` +
              `${runtimeCommitLines}/${runtimeCommits.size}`
            : recordsBeforeRuntimeCommit !== 0
              ? `records_before_runtime_commit:${recordsBeforeRuntimeCommit}`
              : null;
    const eligibleForQualification = ineligibleReason === null;
    const longestRun = eligibleForQualification
      ? runAnalysis.longestRun
      : null;
    const qualifyingRuns: PassLatencyRunStats[] = [];
    if (longestRun !== null) {
      const split =
        longestRun.count >= options.minRun * 2 ? options.minRun : null;
      if (split !== null) {
        qualifyingRuns.push(
          runStats(records.slice(longestRun.startIndex, longestRun.startIndex + split)),
          runStats(records.slice(longestRun.startIndex + split, longestRun.endIndex + 1)),
        );
      } else {
        qualifyingRuns.push(
          runStats(records.slice(longestRun.startIndex, longestRun.endIndex + 1)),
        );
      }
    }

    return {
      schema_version: 1,
      kind: "blockscan_pass_latency_window",
      thresholdMs: options.thresholdMs,
      scope: {
        startLine: firstInclusive,
        endLine: lastInclusive,
        logStartLine: options.logStartLine ?? firstInclusive,
        minRun: options.minRun,
        runtimeCommit,
        processStartLine,
        processStartCount: processStartLines.length,
        runtimeCommitLines,
        recordsBeforeRuntimeCommit,
        processIdentityBinding: "log-anchor-only",
        externalPidBindingRequired: true,
        eligibleForQualification,
        ineligibleReason,
      },
      totals: {
        passes: records.length,
        fast,
        missingTotalMs,
        overThreshold,
      },
      metrics: summarizeMetrics(records),
      productionBoundaries: productionBoundaries(boundaryPasses, boundaryEvents),
      invalidByReason: Object.fromEntries(invalidByReason),
      continuityBreaks: runAnalysis.continuityBreaks,
      longestRun:
        longestRun === null
          ? null
          : runStats(records.slice(longestRun.startIndex, longestRun.endIndex + 1)),
      qualifyingRuns,
    };
  };
  return { pushLine, finish };
}

function summarizeMetrics(
  records: readonly PassLatencyRecord[],
): PassLatencyReport["metrics"] {
  return {
    totalMs: metricSummary(records.map((record) => record.totalMs)),
    stateMs: metricSummary(records.map((record) => record.stateMs)),
    enumerationMs: metricSummary(records.map((record) => record.enumerationMs)),
    exactRefineMs: metricSummary(records.map((record) => record.exactRefineMs)),
    plannerSolverMs: metricSummary(records.map((record) => record.plannerSolverMs)),
    plannerBuildMs: metricSummary(records.map((record) => record.plannerBuildMs)),
    solverWallMs: metricSummary(records.map((record) => record.solverWallMs)),
    solverQuoteMs: metricSummary(records.map((record) => record.solverQuoteMs)),
    solverPlanBuildMs: metricSummary(
      records.map((record) => record.solverPlanBuildMs),
    ),
    solverPlans: metricSummary(records.map((record) => record.solverPlans)),
    solverAmountPoints: metricSummary(
      records.map((record) => record.solverAmountPoints),
    ),
    solverHopExactCalls: metricSummary(
      records.map((record) => record.solverHopExactCalls),
    ),
    solverGssPoints: metricSummary(
      records.map((record) => record.solverGssPoints),
    ),
    preSimMs: metricSummary(records.map((record) => record.preSimMs)),
    finalSimMs: metricSummary(records.map((record) => record.finalSimMs)),
  };
}

function metricSummary(
  values: readonly (number | null)[],
): PassLatencyMetricSummary {
  const present = values.filter((value): value is number => value !== null);
  return {
    samples: present.length,
    p50: percentile(present, 0.5),
    p95: percentile(present, 0.95),
    max: present.length === 0 ? null : Math.max(...present),
  };
}

function longestContiguousFastRun(
  records: readonly PassLatencyRecord[],
  minRun: number,
): {
  readonly longestRun: {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly count: number;
  } | null;
  readonly continuityBreaks: Record<string, number>;
} {
  let bestStart = -1;
  let bestEnd = -1;
  let bestCount = 0;
  let runStart = -1;
  const continuityBreaks = new Map<string, number>();
  const finishRun = (endIndex: number): void => {
    if (runStart < 0) return;
    const count = endIndex - runStart + 1;
    if (count > bestCount) {
      bestStart = runStart;
      bestEnd = endIndex;
      bestCount = count;
    }
    runStart = -1;
  };
  const recordBreak = (reason: string): void => {
    continuityBreaks.set(reason, (continuityBreaks.get(reason) ?? 0) + 1);
  };
  for (let index = 0; index <= records.length; index++) {
    const record = records[index];
    if (record?.fast === true) {
      if (runStart < 0) {
        runStart = index;
        continue;
      }
      const previous = records[index - 1] as PassLatencyRecord;
      if (
        record.processSegment === previous.processSegment &&
        record.runtimeCommit === previous.runtimeCommit &&
        record.sourceBlock === previous.sourceBlock + 1
      ) {
        continue;
      }
      finishRun(index - 1);
      if (record.processSegment !== previous.processSegment) {
        recordBreak("process_or_runtime_boundary");
      } else if (record.sourceBlock > previous.sourceBlock + 1) {
        recordBreak("source_block_gap");
      } else {
        recordBreak("source_block_duplicate_or_regression");
      }
      runStart = index;
      continue;
    }
    finishRun(index - 1);
  }
  return {
    longestRun: bestCount >= minRun
      ? { startIndex: bestStart, endIndex: bestEnd, count: bestCount }
      : null,
    continuityBreaks: Object.fromEntries(continuityBreaks),
  };
}

function runStats(records: readonly PassLatencyRecord[]): PassLatencyRunStats {
  const total = records
    .map((record) => record.totalMs)
    .filter((value): value is number => value !== null);
  const seen = records
    .map((record) => record.sourceHeadSeenAtMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const startBlock = records[0]?.sourceBlock ?? null;
  const endBlock = records.at(-1)?.sourceBlock ?? null;
  const blockSpan = startBlock === null || endBlock === null
    ? null
    : endBlock - startBlock + 1;
  return {
    count: records.length,
    fast: records.filter((record) => record.fast).length,
    startLine: records[0]?.line ?? -1,
    endLine: records.at(-1)?.line ?? -1,
    startBlock,
    endBlock,
    blockSpan,
    consecutiveSourceBlocks: blockSpan === records.length,
    totalMsP50: percentile(total, 0.5),
    totalMsP95: percentile(total, 0.95),
    totalMsMax: total.length === 0 ? null : Math.max(...total),
    overThreshold: records.filter((record) =>
      record.totalMs !== null && !record.fast
    ).length,
    firstSeenAtUtc:
      seen.length === 0 ? null : new Date(seen[0]).toISOString(),
    lastSeenAtUtc:
      seen.length === 0 ? null : new Date(seen.at(-1) as number).toISOString(),
  };
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * sorted.length)),
  );
  return sorted[index];
}

function markerPayload(line: string, marker: string): string | null {
  const at = line.indexOf(marker);
  return at < 0 ? null : line.slice(at + marker.length).trim();
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedNumber(
  value: JsonObject,
  first: string,
  second: string,
): number | null {
  const one = value[first];
  if (!one || typeof one !== "object" || Array.isArray(one)) return null;
  return numberOrNull((one as JsonObject)[second]);
}

type BoundaryEvent = { segment: number; kind: string; value: JsonObject };

/** Same-process, exact-source joins only. These clocks supplement timing-only fast statistics. */
function productionBoundaries(
  passes: readonly { record: PassLatencyRecord; timing: JsonObject }[],
  events: readonly BoundaryEvent[],
) {
  const domain = (value: JsonObject): string | null => {
    const pid = nonNegativeInteger(value.pid), origin = numberOrNull(value.timeOrigin ?? value.time_origin);
    return pid && origin !== null && origin >= 0 ? `${pid}:${origin}` : null;
  };
  const hash = (value: unknown): string | null => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
  const identity = (value: JsonObject): string | null => {
    const block = nonNegativeInteger(value.sourceBlock), generation = nonNegativeInteger(value.generation), sourceHash = hash(value.sourceBlockHash);
    return block !== null && generation !== null && sourceHash ? `${block}:${sourceHash}:${generation}` : null;
  };
  const mono = (value: unknown): number | null => {
    const at = numberOrNull(value); return at !== null && at >= 0 ? at : null;
  };
  const rows = passes.map(({ record, timing }) => {
    const clock = domain(timing), sourceHash = hash(timing.source_block_hash);
    const sourceGeneration = nonNegativeInteger(timing.source_generation);
    const pricingSource = { sourceBlock: nonNegativeInteger(timing.pricing_source_block), sourceBlockHash: hash(timing.pricing_source_block_hash),
      generation: nonNegativeInteger(timing.pricing_source_generation) };
    const priceKey = identity(pricingSource);
    const sameClock = (event: BoundaryEvent) => event.segment === record.processSegment && clock !== null && domain(event.value) === clock;
    const matching = (kind: string) => events.filter(event => sameClock(event) && event.kind === kind && priceKey !== null && identity(event.value) === priceKey);
    const heads = events.filter(event => sameClock(event) && event.kind === "head" && event.value.event === "head" && event.value.number === record.sourceBlock);
    const head = heads.length === 1 ? heads[0]!.value : null;
    const headAt = head === null ? null : mono(head.observedAtMonotonicMs);
    const declaredHeadAt = mono(timing.source_head_seen_at_monotonic_ms);
    const observedHeadHashes = events.filter(event => sameClock(event) && event.kind === "head" && event.value.number === record.sourceBlock)
      .map(event => hash(event.value.hash)).filter((value): value is string => value !== null);
    const headValid = headAt !== null && headAt === declaredHeadAt && sourceHash !== null &&
      sourceGeneration !== null && observedHeadHashes.every(value => value === sourceHash);
    const reorg = events.some(event => sameClock(event) && event.kind === "head" && event.value.event === "reorg" && event.value.number === record.sourceBlock);
    const pricingHeads = events.filter(event => sameClock(event) && event.kind === "head" && event.value.event === "head" && event.value.number === pricingSource.sourceBlock);
    const pricingHead = pricingHeads.length === 1 ? pricingHeads[0]!.value : null;
    const pricingHeadAt = pricingHead === null ? null : mono(pricingHead.observedAtMonotonicMs);
    const pricingHeadHashes = events.filter(event => sameClock(event) && event.kind === "head" && event.value.number === pricingSource.sourceBlock)
      .map(event => hash(event.value.hash)).filter((value): value is string => value !== null);
    const pricingHeadValid = priceKey !== null && pricingHeadAt !== null && pricingHeadHashes.every(value => value === pricingSource.sourceBlockHash);
    const pricingReorg = events.some(event => sameClock(event) && event.kind === "head" && event.value.event === "reorg" && event.value.number === pricingSource.sourceBlock);
    const publications = matching("publication"), drains = matching("producer-drain");
    const sourceNDrains = matching("source-n-drain"), effective = matching("effective");
    const publication = publications.length === 1 ? publications[0]!.value : null;
    const publishedAt = publication?.effectiveComplete === true ? mono(publication.atMonotonicMs) : null;
    const passDrainedAt = mono(timing.pass_drained_at_monotonic_ms);
    let pricingDrainedAt: number | null = null;
    let pricingDrainScope: string | null = null;
    if (drains.length === 1 && sourceNDrains.length === 0 && drains[0]!.value.backendDrained === true && drains[0]!.value.simulationDrained === true) {
      pricingDrainedAt = mono(drains[0]!.value.atMonotonicMs);
      pricingDrainScope = "producer-backend-and-simulation";
    } else if (drains.length === 0 && sourceNDrains.length === 1 && passDrainedAt !== null) {
      const backendAt = mono(sourceNDrains[0]!.value.atMonotonicMs);
      if (backendAt !== null) pricingDrainedAt = Math.max(backendAt, passDrainedAt);
      pricingDrainScope = "source-n-backend-and-shared-pass-simulation";
    }
    const missing: string[] = [];
    if (clock === null || sourceHash === null || sourceGeneration === null) missing.push("pass_identity_or_clock");
    if (!headValid) missing.push("matching_head_receipt");
    if (!pricingHeadValid) missing.push("matching_pricing_head_receipt");
    if (pricingReorg) missing.push("pricing_head_reorg");
    if (reorg) missing.push("head_reorg");
    if (priceKey === null) missing.push("pricing_source_identity");
    if (publishedAt === null) missing.push(publications.length > 1 ? "ambiguous_publication" : "complete_publication");
    if (pricingDrainedAt === null) missing.push("complete_pricing_drain");
    if (pricingHeadAt !== null && publishedAt !== null && publishedAt < pricingHeadAt) missing.push("publication_precedes_observed_head");
    if (publishedAt !== null && pricingDrainedAt !== null && pricingDrainedAt < publishedAt) missing.push("pricing_drain_precedes_publication");
    const delta = (end: number | null, start: number | null) => end !== null && start !== null && end >= start ? end - start : null;
    const headToPublicationMs = pricingHeadValid && !pricingReorg ? delta(publishedAt, pricingHeadAt) : null;
    const headToPricingDrainMs = pricingHeadValid && !pricingReorg && publishedAt !== null && pricingDrainedAt !== null && pricingDrainedAt >= publishedAt
      ? delta(pricingDrainedAt, pricingHeadAt) : null;
    const sizingAt = mono(timing.sizing_started_at_monotonic_ms);
    const exactKey = identity({ sourceBlock: record.sourceBlock, sourceBlockHash: sourceHash, generation: sourceGeneration });
    const simEvents = events.filter(event => sameClock(event) && event.kind === "sim" && exactKey !== null && identity(event.value) === exactKey);
    const sim = simEvents.length === 1 ? simEvents[0]!.value : null;
    const constructions = sim === null ? 0 : nonNegativeInteger(sim.constructions) ?? 0;
    const runtimeConstructions = sim === null ? 0 : nonNegativeInteger(sim.runtimeConstructions) ?? 0;
    const quotedConstructions = sim === null ? 0 : nonNegativeInteger(sim.quotedConstructions) ?? 0;
    const quotedAttempts = sim === null ? 0 : nonNegativeInteger(sim.quotedAttempts) ?? 0;
    const failures = sim === null ? 0 : nonNegativeInteger(sim.failures) ?? 0;
    const totalExecutions = sim === null ? 0 : nonNegativeInteger(sim.executions) ?? 0;
    const minExecutionAt = sim === null ? null : mono(sim.minExecutionAt), maxExecutionAt = sim === null ? null : mono(sim.maxExecutionAt);
    const executionClockValid = sim?.invalidExecutionClock !== true && sizingAt !== null && passDrainedAt !== null &&
      minExecutionAt !== null && maxExecutionAt !== null && minExecutionAt >= sizingAt && maxExecutionAt <= passDrainedAt;
    const runtimeExecutions = sim === null ? 0 : nonNegativeInteger(sim.runtimeExecutions) ?? 0;
    const quotedExecutions = sim === null ? 0 : nonNegativeInteger(sim.quotedExecutions) ?? 0;
    const simWork = totalExecutions > 0 && executionClockValid;
    const constructionModesKnown = constructions > 0 && runtimeConstructions + quotedConstructions === constructions;
    const executionModesKnown = totalExecutions > 0 && runtimeExecutions + quotedExecutions === totalExecutions;
    const runtimeViolation = quotedAttempts > 0 || (record.solverHopExactCalls !== null && record.solverHopExactCalls > 0);
    const runtimeNoQuotedFallback = runtimeViolation ? false : !simWork || !constructionModesKnown || !executionModesKnown || record.solverHopExactCalls === null
      ? null : runtimeConstructions === constructions && runtimeExecutions === totalExecutions && record.solverHopExactCalls === 0;
    const sizingToPassDrainMs = headValid && !reorg && simWork ? delta(passDrainedAt, sizingAt) : null;
    const nextHeads = events.filter(event => sameClock(event) && event.kind === "head" &&
      (event.value.event === "head" || event.value.event === "next_head") &&
      typeof event.value.number === "number" && event.value.number > record.sourceBlock &&
      headAt !== null && (mono(event.value.observedAtMonotonicMs) ?? -1) > headAt);
    const next = nextHeads.sort((a, b) => Number(a.value.observedAtMonotonicMs) - Number(b.value.observedAtMonotonicMs))[0]?.value;
    const nextAt = next === undefined ? null : mono(next.observedAtMonotonicMs);
    const effectiveSummary = effective.length === 1 ? effective[0]!.value : null;
    const quoted = effectiveSummary === null ? null : nonNegativeInteger(effectiveSummary.quoted);
    const carried = effectiveSummary === null ? null : nonNegativeInteger(effectiveSummary.carried);
    const fresh = quoted !== null && carried !== null && carried <= quoted ? quoted - carried : null;
    return {
      sourceBlock: record.sourceBlock, sourceHash, sourceGeneration, pricingSource, clockDomain: clock,
      headHashSource: observedHeadHashes.length > 0 ? "observed-feed-and-validated-pass" : "validated-pass-header",
      headObservedAtMs: head === null ? null : numberOrNull(head.observedAtMs),
      pricingHeadBlock: pricingSource.sourceBlock, pricingHeadObservedAtMs: pricingHead === null ? null : numberOrNull(pricingHead.observedAtMs),
      pricingHeadObservedAtMonotonicMs: pricingHeadAt,
      publicationAtMs: publication === null ? null : numberOrNull(publication.atMs),
      pricingDrainAtMonotonicMs: pricingDrainedAt, passDrainedAtMs: numberOrNull(timing.pass_drained_at_ms),
      sizingStartedAtMs: numberOrNull(timing.sizing_started_at_ms),
      startupWarm: timing.startup_warm === true || record.outcome === "startup_warm", outcome: record.outcome,
      failed: record.outcome !== "ran" && record.outcome !== "complete" && record.outcome !== "startup_warm",
      noSimWork: !simWork, solverPlans: record.solverPlans, solverAmountPoints: record.solverAmountPoints,
      simConstructions: constructions, simExecutions: totalExecutions, simFailures: failures,
      simExecutionClockValid: executionClockValid,
      runtimeConstructions, quotedConstructions, quotedAttempts, runtimeExecutions, quotedExecutions, simHopExactCalls: record.solverHopExactCalls,
      runtimeNoQuotedFallback, runtimeConstructionStatus: runtimeNoQuotedFallback === null ? "unverified" : runtimeNoQuotedFallback ? "verified-observation" : "violated",
      pricingStatus: headToPublicationMs !== null && headToPricingDrainMs !== null ? "verified-boundaries" : "unverified",
      simStatus: !simWork ? constructions || failures || totalExecutions ? "unverified" : "not-run" : sizingToPassDrainMs === null ? "unverified" : "verified-boundaries",
      headToPublicationMs, headToPricingDrainMs, pricingDrainScope, sizingToPassDrainMs,
      nextObservedHead: next?.number ?? null, nextObservedHeadAtMonotonicMs: nextAt,
      completedBeforeNextHead: passDrainedAt !== null && nextAt !== null ? passDrainedAt < nextAt : null,
      nextHeadContiguous: next === undefined ? null : next.number === record.sourceBlock + 1,
      effectiveFreshQuoted: fresh, effectiveCarriedQuoted: carried,
      effectiveByStatus: effectiveSummary?.byStatus ?? null,
      missing,
    };
  });
  const ordinary = rows.filter(row => !row.startupWarm);
  const headEvents = events.filter(event => event.kind === "head" && event.value.event === "head");
  return {
    scope: "supplemental same-process boundary evidence; not Family coverage or acceptance; startup and failures retained",
    rows, observedHeads: headEvents.length,
    unboundSimEvents: events.filter(event => event.kind === "sim" && (domain(event.value) === null || identity(event.value) === null))
      .reduce((sum, event) => sum + Number(event.value.constructions) + Number(event.value.executions) + Number(event.value.failures), 0),
    inputClosures: events.filter(event => event.kind === "head" && event.value.event === "input_closed").map(event => event.value),
    nextHeadObservations: events.filter(event => event.kind === "head" && event.value.event === "next_head").map(event => event.value),
    headIssues: events.filter(event => event.kind === "head" && ["gap", "reorg", "out_of_order"].includes(String(event.value.event))).map(event => event.value),
    headsWithoutPass: headEvents.filter(event => !passes.some(({ record, timing }) => event.segment === record.processSegment &&
      domain(event.value) !== null && domain(event.value) === domain(timing) && event.value.number === record.sourceBlock)).map(event => event.value.number),
    counts: { startupWarm: rows.length - ordinary.length, failed: ordinary.filter(row => row.failed).length,
      noSimWork: ordinary.filter(row => row.noSimWork).length, pricingUnverified: ordinary.filter(row => row.pricingStatus === "unverified").length,
      carriedOnly: ordinary.filter(row => row.effectiveFreshQuoted === 0 && (row.effectiveCarriedQuoted ?? 0) > 0).length },
    metrics: { headToPublicationMs: metricSummary(ordinary.map(row => row.headToPublicationMs)),
      headToPricingDrainMs: metricSummary(ordinary.map(row => row.headToPricingDrainMs)),
      sizingToPassDrainMs: metricSummary(ordinary.map(row => row.sizingToPassDrainMs)) },
  };
}
