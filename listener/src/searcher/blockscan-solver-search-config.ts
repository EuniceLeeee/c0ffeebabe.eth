import { resolveBlockScanExecutionRounding } from "../shared/executor/amount-rounding.js";

export interface BlockScanSolverSearchConfig {
  readonly amountGrid: "multiples" | "geometric";
  readonly gridHalfWidth: number;
  readonly gssMaxTries: number;
  readonly quoteConcurrency: number;
  /** Per-hop output tolerance in token raw units: 0 disables, 1 allows +/-1. */
  readonly quoteToleranceRawUnits: bigint;
}

const DEFAULT_GRID_HALF_WIDTH = 2;
const DEFAULT_GSS_MAX_TRIES = 8;
const DEFAULT_QUOTE_CONCURRENCY = 16;

/**
 * Block-scan has a smaller search budget than the generic/offline solver.
 * Bounds current-source exact traversals and optional conservative amount
 * propagation. Pass scheduling and mandatory final simulation are unchanged.
 */
export function resolveBlockScanSolverSearchConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BlockScanSolverSearchConfig {
  return Object.freeze({
    amountGrid: readAmountGrid(env.SEARCHER_BLOCKSCAN_SOLVER_AMOUNT_GRID),
    gridHalfWidth: readInteger(
      env.SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH,
      DEFAULT_GRID_HALF_WIDTH,
      "SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH",
      0,
      16,
    ),
    gssMaxTries: readInteger(
      env.SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES,
      DEFAULT_GSS_MAX_TRIES,
      "SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES",
      2,
      64,
    ),
    quoteConcurrency: readInteger(
      env.SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY,
      DEFAULT_QUOTE_CONCURRENCY,
      "SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY",
      1,
      64,
    ),
    // One raw unit by default; explicit 0 retains exact checks. Never haircut
    // nominal quotes or change the working input sent to the next operation.
    quoteToleranceRawUnits: resolveBlockScanExecutionRounding(env),
  });
}

function readAmountGrid(
  raw: string | undefined,
): BlockScanSolverSearchConfig["amountGrid"] {
  if (raw === undefined) return "multiples";
  if (raw === "multiples" || raw === "geometric") return raw;
  throw new Error(
    "SEARCHER_BLOCKSCAN_SOLVER_AMOUNT_GRID must be multiples or geometric",
  );
}

function readInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}
