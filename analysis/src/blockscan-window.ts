/**
 * Contiguous-valid-window analysis for blockscan N-1 acceptance.
 *
 * Mirrors the per-pass validity rules of blockscan-kpi.ts:
 * periodic, non-warm pass + enumeration ran + latest preceding published
 * N-1 state for the coarse source block (hash matched when both sides expose
 * it) + expected > 0 + priced/expected > 0.80.
 */

const TIMING_MARKER = "[searcher/blockscan-family] ";
const STATE_MARKER = "[searcher/blockscan-nminus1-state] ";
const GRAPH_MARKER = "[searcher/blockscan] graph built: ";
const PROCESS_START_MARKER = "[searcher/live] starting V5 searcher";
const RUNTIME_COMMIT_MARKER = "[searcher/live] runtime_commit=";

type JsonObject = Record<string, unknown>;

interface PublishedState {
  readonly line: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string | null;
  readonly generation: number | null;
  readonly priced: number;
  readonly expected: number;
  readonly generationWallMs: number | null;
}

interface GraphSnapshot {
  readonly line: number;
  readonly edges: number | null;
  readonly view: number | null;
  readonly hash: string | null;
}

interface PassRecord {
  readonly line: number;
  readonly processSegment: number;
  readonly runtimeCommit: string;
  readonly sourceBlock: number;
  readonly outcome: string | null;
  readonly coarseSourceBlock: number | null;
  readonly enumeration: string | null;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly joinedPriced: number | null;
  readonly joinedExpected: number | null;
  readonly joinedGenerationWallMs: number | null;
  readonly sourceHeadSeenAtMs: number | null;
  readonly graphEdges: number | null;
  readonly graphHash: string | null;
}

export interface RunStats {
  readonly count: number;
  readonly valid: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly startBlock: number | null;
  readonly endBlock: number | null;
  readonly blockSpan: number | null;
  readonly consecutiveSourceBlocks: boolean;
  readonly pricedExpectedMin: number | null;
  readonly pricedExpectedAvg: number | null;
  readonly generationWallMsP50: number | null;
  readonly generationWallMsP95: number | null;
  readonly generationWallMsMax: number | null;
  readonly graphEdgesMin: number | null;
  readonly graphEdgesMax: number | null;
  readonly firstSeenAtUtc: string | null;
  readonly lastSeenAtUtc: string | null;
}

export interface WindowReport {
  readonly schema_version: 2;
  readonly kind: "blockscan_contiguous_window";
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
    readonly valid: number;
    readonly enumerationNotRan: number;
    readonly ranMissingState: number;
    readonly ranLowCoverage: number;
  };
  readonly invalidByReason: Record<string, number>;
  readonly continuityBreaks: Record<string, number>;
  readonly longestRun: RunStats | null;
  readonly qualifyingRuns: readonly RunStats[];
}

export function analyzeWindow(
  text: string,
  options: { startLine: number; endLine?: number; minRun: number },
): WindowReport {
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
  let latestGraph: GraphSnapshot | null = null;
  const publishedStatesByBlock = new Map<number, PublishedState>();
  const passes: PassRecord[] = [];
  const invalidByReason = new Map<string, number>();
  let enumerationNotRan = 0;
  let ranMissingState = 0;
  let ranLowCoverage = 0;
  let valid = 0;

  for (let index = firstInclusive - 1; index < lastInclusive; index++) {
    const line = lines[index] ?? "";
    const oneBasedLine = index + 1;
    if (line.includes(PROCESS_START_MARKER)) {
      processStartLines.push(oneBasedLine);
      processSegment++;
      currentRuntimeCommit = null;
      latestGraph = null;
      publishedStatesByBlock.clear();
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
        latestGraph = null;
        publishedStatesByBlock.clear();
      }
      currentRuntimeCommit = nextRuntimeCommit;
      continue;
    }
    if (currentRuntimeCommit === null) {
      if (
        line.includes(GRAPH_MARKER) ||
        line.includes(STATE_MARKER) ||
        line.includes(TIMING_MARKER)
      ) {
        recordsBeforeRuntimeCommit++;
      }
      continue;
    }
    const graphAt = line.indexOf(GRAPH_MARKER);
    if (graphAt >= 0) {
      const payload = line.slice(graphAt + GRAPH_MARKER.length);
      latestGraph = {
        line: oneBasedLine,
        edges: integerPattern(payload, /(?:^|\s)edges=(\d+)/),
        view: integerPattern(payload, /(?:^|\s)view=(\d+)/),
        hash: hashPattern(payload, /blockscan_graph_hash=(0x[0-9a-f]{64})/i),
      };
      continue;
    }
    const statePayload = markerPayload(line, STATE_MARKER);
    if (statePayload !== null) {
      const parsed = parseObject(statePayload);
      if (!parsed) continue;
      const sourceBlock = nonNegativeInteger(parsed.sourceBlock);
      const priced = nonNegativeInteger(parsed.priced);
      const expected = nonNegativeInteger(parsed.expected);
      if (sourceBlock === null || priced === null || expected === null) continue;
      const status = typeof parsed.status === "string" ? parsed.status : null;
      if (status === "incomplete" || status === "failed") continue;
      publishedStatesByBlock.set(sourceBlock, {
        line: oneBasedLine,
        sourceBlock,
        sourceBlockHash: normalizedHash(
          parsed.sourceBlockHash ?? parsed.source_block_hash,
        ),
        generation: nonNegativeInteger(parsed.generation),
        priced,
        expected,
        generationWallMs: nonNegativeInteger(parsed.generationWallMs),
      });
      continue;
    }
    const timingPayload = markerPayload(line, TIMING_MARKER);
    if (timingPayload === null || !timingPayload.startsWith("{")) continue;
    const timing = parseObject(timingPayload);
    if (!timing || timing.type !== "block_scan_timing") continue;
    if (timing.pass_mode !== "periodic") continue;
    if (timing.startup_warm !== false) continue;
    const sourceBlock = nonNegativeInteger(timing.source_block);
    const coarseSourceBlock = nonNegativeInteger(timing.coarse_source_block);
    const enumeration = nestedString(timing, "stages", "enumeration", "status");
    const timingHash = normalizedHash(timing.coarse_source_block_hash);
    let validPass = false;
    let invalidReason: string | null = null;
    let joined: PublishedState | null = null;
    if (enumeration !== "ran") {
      invalidReason = "enumeration_not_ran";
      enumerationNotRan++;
    } else if (sourceBlock === null) {
      invalidReason = "missing_source_block";
      ranMissingState++;
    } else if (coarseSourceBlock === null) {
      invalidReason = "missing_coarse_source_block";
      ranMissingState++;
    } else if (
      sourceBlock === 0 ||
      coarseSourceBlock !== sourceBlock - 1
    ) {
      invalidReason = "coarse_source_not_predecessor";
      ranMissingState++;
    } else {
      const state = publishedStatesByBlock.get(coarseSourceBlock) ?? null;
      if (!state || state.line >= oneBasedLine) {
        invalidReason = "no_preceding_published_state";
        ranMissingState++;
      } else if (
        timingHash !== null &&
        state.sourceBlockHash !== null &&
        timingHash !== state.sourceBlockHash
      ) {
        invalidReason = "source_block_hash_mismatch";
        ranMissingState++;
      } else if (state.expected <= 0) {
        invalidReason = "expected_non_positive";
        ranLowCoverage++;
      } else if (
        BigInt(state.priced) * 5n <= BigInt(state.expected) * 4n
      ) {
        // Keep the legacy reason spelling for report compatibility; it also
        // includes the exact 80% boundary under the strict >80% contract.
        invalidReason = "below_eighty_percent";
        ranLowCoverage++;
      } else {
        joined = state;
        validPass = true;
        valid++;
      }
    }
    if (!validPass && invalidReason !== null) {
      invalidByReason.set(
        invalidReason,
        (invalidByReason.get(invalidReason) ?? 0) + 1,
      );
    }
    passes.push({
      line: oneBasedLine,
      processSegment,
      runtimeCommit: currentRuntimeCommit,
      sourceBlock: sourceBlock ?? -1,
      outcome: typeof timing.outcome === "string" ? timing.outcome : null,
      coarseSourceBlock,
      enumeration,
      valid: validPass,
      invalidReason,
      joinedPriced: joined?.priced ?? null,
      joinedExpected: joined?.expected ?? null,
      joinedGenerationWallMs: joined?.generationWallMs ?? null,
      sourceHeadSeenAtMs: nonNegativeInteger(timing.source_head_seen_at_ms),
      graphEdges: latestGraph?.edges ?? null,
      graphHash: latestGraph?.hash ?? null,
    });
  }

  const runAnalysis = longestContiguousValidRun(passes, options.minRun);
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
  const longestRun = eligibleForQualification ? runAnalysis.longestRun : null;
  const qualifyingRuns: RunStats[] = [];
  if (longestRun !== null) {
    const split =
      longestRun.count >= options.minRun * 2 ? options.minRun : null;
    if (split !== null) {
      qualifyingRuns.push(
        runStats(
          passes.slice(longestRun.startIndex, longestRun.startIndex + split),
        ),
        runStats(
          passes.slice(longestRun.startIndex + split, longestRun.endIndex + 1),
        ),
      );
    } else {
      qualifyingRuns.push(
        runStats(passes.slice(longestRun.startIndex, longestRun.endIndex + 1)),
      );
    }
  }

  return {
    schema_version: 2,
    kind: "blockscan_contiguous_window",
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
      passes: passes.length,
      valid,
      enumerationNotRan,
      ranMissingState,
      ranLowCoverage,
    },
    invalidByReason: Object.fromEntries(invalidByReason),
    continuityBreaks: runAnalysis.continuityBreaks,
    longestRun:
      longestRun === null
        ? null
        : runStats(
            passes.slice(longestRun.startIndex, longestRun.endIndex + 1),
          ),
    qualifyingRuns,
  };
}

function longestContiguousValidRun(
  passes: readonly PassRecord[],
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
  for (let index = 0; index <= passes.length; index++) {
    const pass = passes[index];
    if (pass?.valid === true) {
      if (runStart < 0) {
        runStart = index;
        continue;
      }
      const previous = passes[index - 1] as PassRecord;
      if (
        pass.processSegment === previous.processSegment &&
        pass.runtimeCommit === previous.runtimeCommit &&
        pass.sourceBlock === previous.sourceBlock + 1
      ) {
        continue;
      }
      finishRun(index - 1);
      if (pass.processSegment !== previous.processSegment) {
        recordBreak("process_or_runtime_boundary");
      } else if (pass.sourceBlock > previous.sourceBlock + 1) {
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

function runStats(passes: readonly PassRecord[]): RunStats {
  const ratios = passes
    .filter(
      (pass) =>
        pass.joinedPriced !== null &&
        pass.joinedExpected !== null &&
        pass.joinedExpected > 0,
    )
    .map(
      (pass) =>
        (pass.joinedPriced as number) / (pass.joinedExpected as number),
    );
  const wall = passes
    .map((pass) => pass.joinedGenerationWallMs)
    .filter((value): value is number => value !== null);
  const edges = passes
    .map((pass) => pass.graphEdges)
    .filter((value): value is number => value !== null);
  const seen = passes
    .map((pass) => pass.sourceHeadSeenAtMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const startBlock = passes[0]?.sourceBlock ?? null;
  const endBlock = passes.at(-1)?.sourceBlock ?? null;
  const blockSpan = startBlock === null || endBlock === null
    ? null
    : endBlock - startBlock + 1;
  return {
    count: passes.length,
    valid: passes.filter((pass) => pass.valid).length,
    startLine: passes[0]?.line ?? -1,
    endLine: passes.at(-1)?.line ?? -1,
    startBlock,
    endBlock,
    blockSpan,
    consecutiveSourceBlocks: blockSpan === passes.length,
    pricedExpectedMin: ratios.length === 0 ? null : Math.min(...ratios),
    pricedExpectedAvg:
      ratios.length === 0
        ? null
        : ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
    generationWallMsP50: percentile(wall, 0.5),
    generationWallMsP95: percentile(wall, 0.95),
    generationWallMsMax: wall.length === 0 ? null : Math.max(...wall),
    graphEdgesMin: edges.length === 0 ? null : Math.min(...edges),
    graphEdgesMax: edges.length === 0 ? null : Math.max(...edges),
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

function integerPattern(value: string, pattern: RegExp): number | null {
  const match = pattern.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function hashPattern(value: string, pattern: RegExp): string | null {
  const match = pattern.exec(value);
  return match ? normalizedHash(match[1]) : null;
}

function normalizedHash(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function nestedString(
  value: JsonObject,
  first: string,
  second: string,
  third: string,
): string | null {
  const one = value[first];
  if (!one || typeof one !== "object" || Array.isArray(one)) return null;
  const two = (one as JsonObject)[second];
  if (!two || typeof two !== "object" || Array.isArray(two)) return null;
  const result = (two as JsonObject)[third];
  return typeof result === "string" ? result : null;
}
