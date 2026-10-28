/** One token raw unit, never a percentage or a change to the requested input.
 * Input dust may be retained; spending old inventory is never tolerated. */
export const MAX_EXECUTION_ROUNDING_RAW_UNITS = 1n;

export function assertExecutionRounding(value: bigint): void {
  if (value !== 0n && value !== MAX_EXECUTION_ROUNDING_RAW_UNITS) {
    throw new Error("execution tolerance must be 0 or 1 token raw unit");
  }
}

export function readExecutionRoundingFlag(raw: string | undefined, name: string): bigint {
  if (raw === undefined || raw === "1" || raw === "true") return MAX_EXECUTION_ROUNDING_RAW_UNITS;
  if (raw === "0" || raw === "false") return 0n;
  throw new Error(`${name} must be 0, 1, false or true`);
}

/** Existing Blockscan policy switch, also forwarded to quote-free runtime
 * input-dust checks. Admission separately attests the fixed maximum above;
 * changing a lane setting cannot invalidate or widen an identity cache. */
export function resolveBlockScanExecutionRounding(
  env: Readonly<Record<string, string | undefined>> = process.env,
): bigint {
  return readExecutionRoundingFlag(env.SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED,
    "SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED");
}

export function minimumExecutionOutput(quoted: bigint, tolerance: bigint): bigint {
  assertExecutionRounding(tolerance);
  if (quoted <= 0n) throw new Error("execution tolerance has no positive minimum output");
  return quoted > tolerance ? quoted - tolerance : 1n;
}

export function executionInputMatches(spent: bigint, requested: bigint, tolerance: bigint): boolean {
  assertExecutionRounding(tolerance);
  return requested > 0n && spent > 0n && spent <= requested && requested - spent <= tolerance;
}

export function executionOutputMatches(received: bigint, quoted: bigint, tolerance: bigint): boolean {
  assertExecutionRounding(tolerance);
  return quoted > 0n && received > 0n &&
    (received >= quoted ? received - quoted : quoted - received) <= tolerance;
}
