/** Immutable price-table update, shared by raw and amount-sensitive columns. */
export function deltaMap<K, V>(
  previous: ReadonlyMap<K, V>,
  updates: readonly (readonly [K, V])[],
  removals: readonly K[],
): ReadonlyMap<K, V> {
  if (updates.length === 0 && removals.length === 0) return previous;
  const next = new Map(previous);
  for (const [key, value] of updates) next.set(key, value);
  for (const key of removals) next.delete(key);
  return next;
}

export function scannerConsumesEdge(edge: {
  readonly slotKind: string;
  readonly leavesStandingPosition: boolean;
}): boolean {
  return edge.slotKind === "swap" ||
    (edge.slotKind === "protocol" && !edge.leavesStandingPosition);
}
