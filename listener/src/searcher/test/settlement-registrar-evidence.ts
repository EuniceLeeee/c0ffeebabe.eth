const own = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The retired registrars wrote transaction summaries, not single-leg receipts.
 * Recognize both their complete output and partially missing summary fields.
 * Other historical evidence formats retain their existing validation contract. */
export function isLegacySettlementRegistrarEvidence(value: unknown): boolean {
  if (!record(value)) return false;
  const positive = value.positive;
  if (record(positive) && own(positive, "success") && own(positive, "grossProfit")) return true;
  const negative = own(value, "rejected") || own(value, "impossible");
  return own(value, "positive") && (negative || own(value, "assertions") || own(value, "runSource")) ||
    negative && own(value, "assertions") && own(value, "runSource");
}

export const LEGACY_SETTLEMENT_REGISTRAR_REASON =
  "legacy whole-transaction registrar evidence cannot verify single-leg debit, receipt or old inventory; " +
  "it also does not bind the measured leg to the executed source and plan pin. " +
  "Use the shared single-leg acceptance with actual balance-delta evidence; retain the old report as historical data.";

export function legacySettlementRegistrarEvidenceFailures(value: unknown): string[] {
  if (!isLegacySettlementRegistrarEvidence(value)) return [];
  // No assertion-label, successful transaction, positive profit or added pin can
  // supply the measurements this format never recorded. Do not invent a new
  // acceptance schema here or silently grandfather all-true legacy summaries.
  return [LEGACY_SETTLEMENT_REGISTRAR_REASON];
}

/** Explicit contradictory facts cannot be hidden by a different report shape.
 * Absent facts in older formats remain subject to their existing validators. */
export function explicitSettlementAssertionFailures(value: unknown, required: readonly string[]): string[] {
  if (!record(value) || !own(value, "assertions")) return [];
  if (!record(value.assertions)) return ["explicit settlement assertions must be a record"];
  const assertions = value.assertions;
  return required.filter(key => own(assertions, key) && assertions[key] !== true)
    .map(key => `explicit settlement assertion is not true: ${key}`);
}

/** Runs before importing any former registrar dependencies or reading secrets. */
export function refuseLegacySettlementRegistrar(): never {
  throw new Error("Settlement registrar disabled: " + LEGACY_SETTLEMENT_REGISTRAR_REASON);
}
