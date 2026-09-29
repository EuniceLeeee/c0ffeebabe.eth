import assert from "node:assert/strict";
import type { ExactQuoteResult, ExactTrialState, ExactTrialStateChange } from "../../adapter-family-plugin.js";

/** Unit-only view. Source, prefix authority and dirty-resource rejection are
 * tested through the production issuer, not manufactured by this math fixture. */
export function trialView(...quotes: readonly ExactQuoteResult<unknown>[]): ExactTrialState {
  const cells = new Map<string, ExactTrialStateChange>();
  for (const quote of quotes) for (const cell of quote.stateChanges ?? []) cells.set(cell.ref.key, cell);
  return { get(ref) {
    const cell = cells.get(ref.key);
    if (!cell) return undefined;
    assert.equal(ref.schema, cell.ref.schema, "trial schema mismatch");
    assert.equal(ref.binding, cell.ref.binding, "trial binding mismatch");
    return cell.value;
  } };
}
