const PROCESS_START_MARKER = "[searcher/live] starting V5 searcher";
const RUNTIME_COMMIT_MARKER = "[searcher/live] runtime_commit=";
const TIMING_MARKER = "[searcher/blockscan-family] ";
const STATE_MARKER = "[searcher/blockscan-nminus1-state] ";

type JsonObject = Record<string, unknown>;

type StateRecord = {
  readonly line: number;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string | null;
  readonly generation: number | null;
  readonly status: string | null;
  readonly priced: number;
  readonly expected: number;
};

export interface BlockScanKpiReport {
  readonly schema_version: 1;
  readonly kind: "blockscan_nminus1_kpi";
  readonly scope: {
    readonly requested_start_line: number;
    readonly process_window_start_line: number;
    readonly end_line: number;
    readonly process_window: "latest";
    readonly process_start_marker_found: boolean;
    readonly runtime_commit: string | null;
  };
  readonly cohort_definition: {
    readonly pass_mode: "periodic";
    readonly startup_warm: false;
    readonly join: "latest preceding published state with matching sourceBlock in the same process window";
    readonly threshold: "expected > 0 and priced / expected >= 0.80";
  };
  readonly counts: {
    readonly cohort: number;
    readonly valid: number;
    readonly ran_low_coverage: number;
    readonly ran_missing_state: number;
    readonly enumeration_not_ran: number;
    readonly valid_bps: number;
  };
  readonly exclusions: {
    readonly non_periodic_or_missing_mode: number;
    readonly startup_warm: number;
    readonly malformed_timing_json: number;
    readonly malformed_state_json: number;
  };
  readonly join: {
    readonly hash_matched: number;
    readonly block_number_only: number;
    readonly hash_mismatch: number;
    readonly latest_preceding_generation: number;
    readonly caveats: readonly string[];
  };
  readonly ran_missing_state_reasons: {
    readonly missing_coarse_source_block: number;
    readonly no_preceding_published_state: number;
    readonly source_block_hash_mismatch: number;
  };
  readonly ran_low_coverage_reasons: {
    readonly expected_non_positive: number;
    readonly below_eighty_percent: number;
  };
}

export interface AnalyzeBlockScanKpiOptions {
  /** One-based inclusive line number. The latest process start at or after it wins. */
  readonly startLine?: number;
}

/**
 * Summarize the live N-1 block-scan KPI without joining across process starts.
 *
 * The timing event does not currently carry the coarse snapshot generation, so
 * generation binding is the latest published state event for that source block
 * that precedes the pass. Hash equality is required when both events expose it.
 */
export function analyzeBlockScanKpiLog(
  text: string,
  options: AnalyzeBlockScanKpiOptions = {},
): BlockScanKpiReport {
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const requestedStartLine = readStartLine(options.startLine);
  let processWindowStartIndex = requestedStartLine - 1;
  let processStartMarkerFound = false;
  for (let index = processWindowStartIndex; index < lines.length; index++) {
    if (lines[index]?.includes(PROCESS_START_MARKER)) {
      processWindowStartIndex = index;
      processStartMarkerFound = true;
    }
  }

  let runtimeCommit: string | null = null;
  let malformedTimingJson = 0;
  let malformedStateJson = 0;
  let nonPeriodicOrMissingMode = 0;
  let startupWarm = 0;
  let cohort = 0;
  let valid = 0;
  let ranLowCoverage = 0;
  let ranMissingState = 0;
  let enumerationNotRan = 0;
  let hashMatched = 0;
  let blockNumberOnly = 0;
  let hashMismatch = 0;
  let latestPrecedingGeneration = 0;
  let missingCoarseSourceBlock = 0;
  let noPrecedingPublishedState = 0;
  let sourceBlockHashMismatch = 0;
  let expectedNonPositive = 0;
  let belowEightyPercent = 0;
  const publishedStatesByBlock = new Map<number, StateRecord[]>();

  for (let index = processWindowStartIndex; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const oneBasedLine = index + 1;
    const commitAt = line.indexOf(RUNTIME_COMMIT_MARKER);
    if (commitAt >= 0) {
      runtimeCommit = line.slice(commitAt + RUNTIME_COMMIT_MARKER.length).trim() || null;
    }

    const statePayload = markerPayload(line, STATE_MARKER);
    if (statePayload !== null) {
      const value = parseObject(statePayload);
      if (!value) {
        malformedStateJson++;
        continue;
      }
      const state = parseStateRecord(value, oneBasedLine);
      if (!state) {
        malformedStateJson++;
        continue;
      }
      if (state.status === "incomplete" || state.status === "failed") continue;
      const records = publishedStatesByBlock.get(state.sourceBlock) ?? [];
      records.push(state);
      publishedStatesByBlock.set(state.sourceBlock, records);
      continue;
    }

    const timingPayload = markerPayload(line, TIMING_MARKER);
    if (timingPayload === null) continue;
    if (!timingPayload.startsWith("{")) continue;
    const timing = parseObject(timingPayload);
    if (!timing) {
      malformedTimingJson++;
      continue;
    }
    if (timing.type !== "block_scan_timing") continue;
    if (timing.pass_mode !== "periodic") {
      nonPeriodicOrMissingMode++;
      continue;
    }
    if (timing.startup_warm !== false) {
      startupWarm++;
      continue;
    }

    cohort++;
    if (nestedString(timing, "stages", "enumeration", "status") !== "ran") {
      enumerationNotRan++;
      continue;
    }

    const coarseSourceBlock = nonNegativeInteger(timing.coarse_source_block);
    if (coarseSourceBlock === null) {
      ranMissingState++;
      missingCoarseSourceBlock++;
      continue;
    }
    const candidates = publishedStatesByBlock.get(coarseSourceBlock) ?? [];
    const state = candidates.at(-1);
    if (!state || state.line >= oneBasedLine) {
      ranMissingState++;
      noPrecedingPublishedState++;
      continue;
    }

    const timingHash = normalizedHash(timing.coarse_source_block_hash);
    if (timingHash && state.sourceBlockHash) {
      if (timingHash !== state.sourceBlockHash) {
        ranMissingState++;
        hashMismatch++;
        sourceBlockHashMismatch++;
        continue;
      }
      hashMatched++;
    } else {
      blockNumberOnly++;
    }
    if (state.generation !== null) latestPrecedingGeneration++;

    if (state.expected <= 0) {
      ranLowCoverage++;
      expectedNonPositive++;
      continue;
    }
    if (BigInt(state.priced) * 5n < BigInt(state.expected) * 4n) {
      ranLowCoverage++;
      belowEightyPercent++;
      continue;
    }
    valid++;
  }

  const caveats: string[] = [];
  if (blockNumberOnly > 0) {
    caveats.push(
      `${blockNumberOnly} join(s) used source block number only because one or both records omitted the source block hash`,
    );
  }
  if (latestPrecedingGeneration > 0) {
    caveats.push(
      "timing telemetry omits the coarse snapshot generation; joins use the latest preceding published state record within the same process window",
    );
  }
  if (!processStartMarkerFound) {
    caveats.push(
      "no process-start marker was present at or after requested_start_line; that line is treated as the process boundary",
    );
  }

  return {
    schema_version: 1,
    kind: "blockscan_nminus1_kpi",
    scope: {
      requested_start_line: requestedStartLine,
      process_window_start_line: processWindowStartIndex + 1,
      end_line: lines.length,
      process_window: "latest",
      process_start_marker_found: processStartMarkerFound,
      runtime_commit: runtimeCommit,
    },
    cohort_definition: {
      pass_mode: "periodic",
      startup_warm: false,
      join: "latest preceding published state with matching sourceBlock in the same process window",
      threshold: "expected > 0 and priced / expected >= 0.80",
    },
    counts: {
      cohort,
      valid,
      ran_low_coverage: ranLowCoverage,
      ran_missing_state: ranMissingState,
      enumeration_not_ran: enumerationNotRan,
      valid_bps: cohort === 0 ? 0 : Math.floor((valid * 10_000) / cohort),
    },
    exclusions: {
      non_periodic_or_missing_mode: nonPeriodicOrMissingMode,
      startup_warm: startupWarm,
      malformed_timing_json: malformedTimingJson,
      malformed_state_json: malformedStateJson,
    },
    join: {
      hash_matched: hashMatched,
      block_number_only: blockNumberOnly,
      hash_mismatch: hashMismatch,
      latest_preceding_generation: latestPrecedingGeneration,
      caveats,
    },
    ran_missing_state_reasons: {
      missing_coarse_source_block: missingCoarseSourceBlock,
      no_preceding_published_state: noPrecedingPublishedState,
      source_block_hash_mismatch: sourceBlockHashMismatch,
    },
    ran_low_coverage_reasons: {
      expected_non_positive: expectedNonPositive,
      below_eighty_percent: belowEightyPercent,
    },
  };
}

function readStartLine(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`startLine must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function markerPayload(line: string, marker: string): string | null {
  const at = line.indexOf(marker);
  return at < 0 ? null : line.slice(at + marker.length).trim();
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

function parseStateRecord(value: JsonObject, line: number): StateRecord | null {
  const sourceBlock = nonNegativeInteger(value.sourceBlock);
  const priced = nonNegativeInteger(value.priced);
  const expected = nonNegativeInteger(value.expected);
  if (sourceBlock === null || priced === null || expected === null) return null;
  return {
    line,
    sourceBlock,
    sourceBlockHash:
      normalizedHash(value.sourceBlockHash) ?? normalizedHash(value.source_block_hash),
    generation: nonNegativeInteger(value.generation),
    status: typeof value.status === "string" ? value.status : null,
    priced,
    expected,
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
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
