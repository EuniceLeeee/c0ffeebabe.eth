export interface BlockScanSolverSearchConfig {
  readonly gridHalfWidth: number;
  readonly gssMaxTries: number;
}

const DEFAULT_GRID_HALF_WIDTH = 2;
const DEFAULT_GSS_MAX_TRIES = 4;

/**
 * Block-scan has a smaller search budget than the generic/offline solver.
 * These values bound repeated current-source exact traversals; they do not
 * change candidate admission, pass scheduling, or the mandatory final sim.
 */
export function resolveBlockScanSolverSearchConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BlockScanSolverSearchConfig {
  return Object.freeze({
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
  });
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
