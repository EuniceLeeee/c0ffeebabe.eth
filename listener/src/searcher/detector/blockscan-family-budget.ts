import type { TokenEdge } from "../planner/token-graph.js";

const EDGE_ID_SEPARATOR = "\u001f";
const ROUTE_COMPOSITE_PREFIX = "\u0000blockscan-route:";

/** Three independent failures are enough to stop spending this generation on one family. */
export const BLOCKSCAN_FAMILY_FAILURE_LIMIT = 3;

/**
 * Read the execution-family owner embedded by createVerifiedGraphView. Legacy
 * diagnostic inputs do not carry canonicalEdgeId, so their edge adapter remains
 * the isolation key without affecting the production path.
 */
export function blockScanEdgeFamilyId(edge: TokenEdge): string {
  const canonical = edge.canonicalEdgeId;
  if (canonical) {
    const separator = canonical.indexOf(EDGE_ID_SEPARATOR);
    if (separator > 0) return canonical.slice(0, separator);
  }
  return edge.adapterId;
}

export function blockScanRouteFamilyIds(
  edges: readonly TokenEdge[],
): readonly string[] {
  return Object.freeze([
    ...new Set(edges.map(blockScanEdgeFamilyId)),
  ].sort());
}

export function blockScanRouteCompositeKey(
  edges: readonly TokenEdge[],
): string {
  return `${ROUTE_COMPOSITE_PREFIX}${JSON.stringify(
    blockScanRouteFamilyIds(edges),
  )}`;
}

export function blockScanRouteCircuitKeys(
  edges: readonly TokenEdge[],
): readonly string[] {
  return Object.freeze([
    ...blockScanRouteFamilyIds(edges),
    blockScanRouteCompositeKey(edges),
  ]);
}

/** Typed proof that one route leg, rather than the whole route, failed. */
export class BlockScanFamilyAttributedError extends Error {
  constructor(
    readonly familyId: string,
    readonly stage: string,
    readonly failureCause: unknown,
  ) {
    // Preserve the legacy message contract for callers that classify a known
    // quote/build condition by text; ownership is carried in typed fields.
    super(
      failureCause instanceof Error
        ? failureCause.message
        : String(failureCause),
    );
    this.name = "BlockScanFamilyAttributedError";
  }
}

export function blockScanAttributedFailureFamilyId(
  error: unknown,
): string | null {
  return error instanceof BlockScanFamilyAttributedError
    ? error.familyId
    : null;
}

function failureCircuitKeys(
  edges: readonly TokenEdge[],
  error?: unknown,
): readonly string[] {
  const familyId = blockScanAttributedFailureFamilyId(error);
  return familyId
    ? Object.freeze([familyId])
    : Object.freeze([blockScanRouteCompositeKey(edges)]);
}

/**
 * Stable least-served scheduling across individual family dependencies.
 *
 * Economic order is unchanged within an exact dependency set. Among those
 * bucket heads, the least-served individual family wins and the original rank
 * breaks ties. Counting each dependency separately prevents a bad family from
 * evading its local budget by combining itself with many different siblings.
 */
export function orderByBlockScanFamily<T>(
  items: readonly T[],
  families: (item: T) => readonly string[],
): T[] {
  const work = items.map((item, index) => {
    const familyIds = [...new Set(families(item))].sort();
    return {
      item,
      index,
      familyIds: familyIds.length > 0 ? familyIds : ["<unowned-family>"],
    };
  });
  const buckets = new Map<string, {
    readonly entries: typeof work;
    next: number;
  }>();
  for (const entry of work) {
    const key = JSON.stringify(entry.familyIds);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.entries.push(entry);
    } else {
      buckets.set(key, { entries: [entry], next: 0 });
    }
  }
  const served = new Map<string, number>();
  const ordered: T[] = [];
  while (ordered.length < work.length) {
    let selectedBucket:
      | { readonly entries: typeof work; next: number }
      | undefined;
    let selected: typeof work[number] | undefined;
    let selectedMaxServed = Number.POSITIVE_INFINITY;
    let selectedTotalServed = Number.POSITIVE_INFINITY;
    for (const bucket of buckets.values()) {
      const entry = bucket.entries[bucket.next];
      if (!entry) continue;
      const counts = entry.familyIds.map((familyId) => served.get(familyId) ?? 0);
      const maxServed = Math.max(...counts);
      const totalServed = counts.reduce((sum, count) => sum + count, 0);
      if (
        maxServed < selectedMaxServed ||
        maxServed === selectedMaxServed && totalServed < selectedTotalServed ||
        maxServed === selectedMaxServed &&
          totalServed === selectedTotalServed &&
          entry.index < (selected?.index ?? Number.POSITIVE_INFINITY)
      ) {
        selectedBucket = bucket;
        selected = entry;
        selectedMaxServed = maxServed;
        selectedTotalServed = totalServed;
      }
    }
    if (!selected || !selectedBucket) {
      throw new Error("block-scan family admission deadlocked");
    }
    selectedBucket.next++;
    ordered.push(selected.item);
    for (const familyId of selected.familyIds) {
      served.set(familyId, (served.get(familyId) ?? 0) + 1);
    }
  }
  return ordered;
}

export function selectByBlockScanFamily<T>(
  items: readonly T[],
  limit: number,
  families: (item: T) => readonly string[],
): T[] {
  if (limit <= 0) return [];
  return orderByBlockScanFamily(items, families).slice(0, limit);
}

/**
 * Per-generation consecutive-failure breaker over opaque isolation keys.
 */
export class BlockScanFamilyFailureCircuit {
  private readonly failures = new Map<string, number>();
  private readonly open = new Set<string>();

  constructor(
    private readonly failureLimit = BLOCKSCAN_FAMILY_FAILURE_LIMIT,
  ) {
    if (!Number.isSafeInteger(failureLimit) || failureLimit <= 0) {
      throw new Error(`invalid block-scan family failure limit ${failureLimit}`);
    }
  }

  blocks(familyIds: readonly string[]): boolean {
    return familyIds.some((familyId) => this.open.has(familyId));
  }

  recordSuccess(familyIds: readonly string[]): void {
    for (const familyId of new Set(familyIds)) {
      this.failures.delete(familyId);
      this.open.delete(familyId);
    }
  }

  recordFailure(familyIds: readonly string[]): void {
    for (const familyId of new Set(familyIds)) {
      const failures = (this.failures.get(familyId) ?? 0) + 1;
      this.failures.set(familyId, failures);
      if (failures >= this.failureLimit) this.open.add(familyId);
    }
  }

  openKeys(): readonly string[] {
    return Object.freeze([...this.open].sort());
  }
}

/**
 * One stage-local budget. Unattributed route failures strike only the exact
 * dependency-set composite. A typed per-leg failure strikes only its owner.
 */
export class BlockScanFamilyStageBudget {
  private readonly circuit: BlockScanFamilyFailureCircuit;

  constructor(failureLimit = BLOCKSCAN_FAMILY_FAILURE_LIMIT) {
    this.circuit = new BlockScanFamilyFailureCircuit(failureLimit);
  }

  order<T>(
    items: readonly T[],
    edges: (item: T) => readonly TokenEdge[],
  ): T[] {
    return orderByBlockScanFamily(
      items,
      (item) => blockScanRouteFamilyIds(edges(item)),
    );
  }

  blocks(edges: readonly TokenEdge[]): boolean {
    return this.circuit.blocks(blockScanRouteCircuitKeys(edges));
  }

  recordSuccess(edges: readonly TokenEdge[]): void {
    this.circuit.recordSuccess(blockScanRouteCircuitKeys(edges));
  }

  recordFailure(
    edges: readonly TokenEdge[],
    error?: unknown,
  ): void {
    this.circuit.recordFailure(failureCircuitKeys(edges, error));
  }

  openFamilyIds(): readonly string[] {
    return Object.freeze(
      this.circuit.openKeys().filter(
        (key) => !key.startsWith(ROUTE_COMPOSITE_PREFIX),
      ),
    );
  }

  openCompositeKeys(): readonly string[] {
    return Object.freeze(
      this.circuit.openKeys().filter(
        (key) => key.startsWith(ROUTE_COMPOSITE_PREFIX),
      ),
    );
  }
}
