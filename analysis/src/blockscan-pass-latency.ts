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
  readonly sourceHeadSeenAtMs: number | null;
  readonly fast: boolean;
  readonly invalidReason: string | null;
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
  readonly invalidByReason: Record<string, number>;
  readonly continuityBreaks: Record<string, number>;
  readonly longestRun: PassLatencyRunStats | null;
  readonly qualifyingRuns: readonly PassLatencyRunStats[];
}

export function analyzePassLatency(
  text: string,
  options: {
    startLine: number;
    endLine?: number;
    minRun: number;
    thresholdMs: number;
  },
): PassLatencyReport {
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const lastInclusive = Math.min(
    options.endLine ?? lines.length,
    lines.length,
  );
  const firstInclusive = Math.max(1, options.startLine);
  let currentRuntimeCommit: string | null = null;
  const runtimeCommits = new Set<string>();
  let runtimeCommitLines = 0;
  const processStartLines: number[] = [];
  let processSegment = -1;
  let recordsBeforeRuntimeCommit = 0;
  const records: PassLatencyRecord[] = [];
  const invalidByReason = new Map<string, number>();
  let missingTotalMs = 0;
  let overThreshold = 0;
  let fast = 0;

  for (let index = firstInclusive - 1; index < lastInclusive; index++) {
    const line = lines[index] ?? "";
    const oneBasedLine = index + 1;
    if (line.includes(PROCESS_START_MARKER)) {
      processStartLines.push(oneBasedLine);
      processSegment++;
      currentRuntimeCommit = null;
      continue;
    }
    if (processSegment < 0) continue;
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
      continue;
    }
    if (currentRuntimeCommit === null) {
      if (line.includes(TIMING_MARKER)) recordsBeforeRuntimeCommit++;
      continue;
    }
    const timingPayload = markerPayload(line, TIMING_MARKER);
    if (timingPayload === null || !timingPayload.startsWith("{")) continue;
    const timing = parseObject(timingPayload);
    if (!timing || timing.type !== "block_scan_timing") continue;
    const sourceBlock = nonNegativeInteger(timing.source_block);
    if (sourceBlock === null) continue;
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
    records.push({
      line: oneBasedLine,
      processSegment,
      runtimeCommit: currentRuntimeCommit,
      sourceBlock,
      outcome: typeof timing.outcome === "string" ? timing.outcome : null,
      totalMs,
      stateMs: numberOrNull(nestedNumber(timing, "stage_timing_ms", "state")),
      sourceHeadSeenAtMs: nonNegativeInteger(timing.source_head_seen_at_ms),
      fast: invalidReason === null,
      invalidReason,
    });
  }

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
    invalidByReason: Object.fromEntries(invalidByReason),
    continuityBreaks: runAnalysis.continuityBreaks,
    longestRun:
      longestRun === null
        ? null
        : runStats(records.slice(longestRun.startIndex, longestRun.endIndex + 1)),
    qualifyingRuns,
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
