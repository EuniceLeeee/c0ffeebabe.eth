import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import type { FamilyId } from
  "./venues/adapter-family-identifiers.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type { UnifiedObservation } from
  "./venues/adapter-family-plugin.js";

export interface StrictLiveObservedEvent {
  readonly kind: "log" | "call";
  readonly address: string;
  readonly topics?: readonly string[];
  readonly data: string;
  readonly transactionHash?: string;
  readonly blockNumber: number;
  /**
   * Log position within its transaction receipt. Part of the full log
   * identity for deduplication: a multi-hop transaction can emit several
   * same-topic Swap logs from different pools, and several V4 poolId swaps
   * all share the PoolManager address.
   */
  readonly logIndex?: number;
}

/**
 * Full-identity dedupe key for one observed event. Logs key on block +
 * transaction hash + logIndex + address + every topic (not just topic0), so
 * distinct pool swaps inside one transaction never collapse; calls key on
 * block + transaction hash + target + selector. Deduplication by the
 * plugin-produced canonical candidate/instance key happens later inside the
 * family lifecycle, never here.
 */
export function strictObservedEventDedupeKey(
  event: StrictLiveObservedEvent,
): string {
  if (event.kind === "log") {
    return "log:" + event.blockNumber + ":" +
      (event.transactionHash ?? "") + ":" +
      (event.logIndex === undefined ? "?" : String(event.logIndex)) + ":" +
      event.address.toLowerCase() + ":" +
      (event.topics ?? []).map((topic) => topic.toLowerCase()).join(",");
  }
  return "call:" + event.blockNumber + ":" +
    (event.transactionHash ?? "") + ":" +
    event.address.toLowerCase() + ":" +
    event.data.slice(0, 10).toLowerCase();
}

/**
 * F2-b core: convert raw observed call/log events at one canonical source
 * into source-bound UnifiedObservations, bucketed per Family by the
 * central catalog matcher (selector for calls, topic0 for logs). Identical
 * events collapse to one observation; events beyond the source are skipped
 * so a stale buffer can never mint an observation ahead of its anchor.
 */
export function deriveLiveDiscoveryEventObservations(input: {
  readonly events: readonly StrictLiveObservedEvent[];
  readonly source: CanonicalSource;
  readonly catalog: FamilyCapabilityCatalog;
}): ReadonlyMap<FamilyId, readonly UnifiedObservation[]> {
  const byFamily = new Map<FamilyId, UnifiedObservation[]>();
  const seen = new Set<string>();
  for (const event of input.events) {
    if (!Number.isSafeInteger(event.blockNumber) ||
        event.blockNumber > input.source.number) {
      continue;
    }
    const observation: UnifiedObservation = event.kind === "log"
      ? Object.freeze({
        kind: "log" as const,
        source: input.source,
        address: event.address.toLowerCase(),
        topics: Object.freeze([...(event.topics ?? [])]),
        data: event.data,
        ...(event.transactionHash === undefined
          ? {}
          : { transactionHash: event.transactionHash }),
      })
      : Object.freeze({
        kind: "call" as const,
        source: input.source,
        target: event.address.toLowerCase(),
        data: event.data,
        ...(event.transactionHash === undefined
          ? {}
          : { transactionHash: event.transactionHash }),
      });
    const dedupeKey = strictObservedEventDedupeKey(event);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    for (const match of input.catalog.matches(observation)) {
      const existing = byFamily.get(match.familyId);
      if (existing === undefined) {
        byFamily.set(match.familyId, [observation]);
      } else {
        existing.push(observation);
      }
    }
  }
  for (const observations of byFamily.values()) {
    Object.freeze(observations);
  }
  return byFamily;
}

/**
 * Merge per-Family observation maps. Later maps append to earlier ones; the
 * same observation instance is never duplicated across producers within one
 * map because each derivation dedupes its own event space.
 */
export function mergeFamilyObservations(
  ...maps: readonly (ReadonlyMap<FamilyId, readonly UnifiedObservation[]>)[]
): ReadonlyMap<FamilyId, readonly UnifiedObservation[]> {
  const merged = new Map<FamilyId, UnifiedObservation[]>();
  for (const map of maps) {
    for (const [familyId, observations] of map) {
      const existing = merged.get(familyId);
      if (existing === undefined) {
        merged.set(familyId, [...observations]);
      } else {
        existing.push(...observations);
      }
    }
  }
  for (const observations of merged.values()) {
    Object.freeze(observations);
  }
  return merged;
}
