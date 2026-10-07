type Json = Record<string, unknown>;
type Source = { number: number; hash: string; generation: number };

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function source(value: unknown): Source {
  if (!object(value) || !Number.isSafeInteger(value.number) || !Number.isSafeInteger(value.generation) ||
      typeof value.hash !== "string" || value.hash.length === 0) throw new Error("invalid effective history source");
  return value as Source;
}
function same(a: Source, b: Source): boolean {
  return a.number === b.number && a.generation === b.generation && a.hash.toLowerCase() === b.hash.toLowerCase();
}
function entries(value: unknown): Array<[string, Json]> {
  if (!Array.isArray(value)) throw new Error("invalid effective history rows");
  const keys = new Set<string>();
  return value.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !object(entry[1]) ||
        entry[1].edge_id !== entry[0] || keys.has(entry[0])) throw new Error("invalid or duplicate effective history row");
    keys.add(entry[0]);
    return [entry[0], entry[1]];
  });
}

/** Read legacy per-block full snapshots and new persisted effective deltas.
 * Missing publications invalidate the state; they never inherit an old table. */
export class EffectiveMidHistoryReplay {
  private at: Source | null = null;
  private rows = new Map<string, Json>();
  reset(): void { this.at = null; this.rows.clear(); }

  apply(value: unknown, expectedSource?: Source): Json | null {
    if (value === undefined) { this.reset(); return null; }
    if (!object(value)) throw new Error("invalid effective history publication");
    const at = source(value.source);
    if (expectedSource !== undefined && !same(at, expectedSource)) throw new Error("effective history source differs from publication");
    let next: Map<string, Json>;
    if (value.encoding === "delta") {
      if (Object.hasOwn(value, "rows") || this.at === null || !same(source(value.previous_source), this.at))
        throw new Error("effective history delta has no matching baseline");
      const updates = entries(value.updates), removals = value.removals;
      if (!Array.isArray(removals) || !removals.every(key => typeof key === "string") || new Set(removals).size !== removals.length)
        throw new Error("invalid effective history removals");
      const updated = new Set(updates.map(([key]) => key));
      if (removals.some(key => updated.has(key) || !this.rows.has(key))) throw new Error("invalid effective history update/removal overlap");
      next = new Map(this.rows);
      for (const [key, row] of updates) next.set(key, row);
      for (const key of removals) next.delete(key);
    } else {
      if (value.encoding !== undefined) throw new Error("unsupported effective history encoding");
      next = new Map(entries(value.rows));
    }
    if (!object(value.summary) || value.summary.directions !== next.size) throw new Error("effective history row count mismatch");
    const { encoding, previous_source, updates, removals, rows, ...metadata } = value;
    const restored = [...next].sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => {
      if (row.quoted_at === undefined) return [key, row];
      const { carried, ...quote } = row;
      const quoted = source(row.quoted_at);
      return [key, { ...quote, ...(same(quoted, at) ? {} : { carried: true }) }];
    });
    this.at = at;
    this.rows = next;
    return { ...metadata, rows: restored };
  }
}
