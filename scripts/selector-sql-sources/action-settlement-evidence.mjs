// Quantities are in the native integer units of each asset. Source-specific
// witnesses establish ownership before this common two-sided acceptance check.
export function matchesActionSettlement(legs) {
  if (!Array.isArray(legs) || legs.length !== 2 || legs[0]?.asset === legs[1]?.asset) return false;
  const used = new Set();
  for (const leg of legs) {
    if (!leg || !/^0x[0-9a-f]{40}$/.test(leg.asset) || typeof leg.expected !== 'bigint' ||
        leg.expected <= 0n || leg.observed !== leg.expected ||
        !Array.isArray(leg.evidenceKeys) || !leg.evidenceKeys.length) return false;
    for (const key of leg.evidenceKeys) {
      if (typeof key !== 'string' || !key.length || used.has(key)) return false;
      used.add(key);
    }
  }
  return true;
}
