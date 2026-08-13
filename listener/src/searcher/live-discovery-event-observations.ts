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
    const dedupeKey = event.kind === "log"
      ? `log:${event.blockNumber}:${event.transactionHash ?? ""}:` +
          `${event.topics?.[0]?.toLowerCase() ?? ""}`
      : `call:${event.blockNumber}:${event.transactionHash ?? ""}:` +
          `${event.data.slice(0, 10).toLowerCase()}`;
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
