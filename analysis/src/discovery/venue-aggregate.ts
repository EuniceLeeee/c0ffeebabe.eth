import type { EdgeKind, ProtocolAction } from "../../../listener/src/searcher/strategy-taxonomy.js";
import type { VenueCandidate } from "./venue-evidence.js";

export interface AggregatedVenue {
  address: string;
  edgeKinds: EdgeKind[];
  protocolActions: ProtocolAction[];
  txCount: number;
  totalLogCount: number;
}

const EDGE_KIND_ORDER: readonly EdgeKind[] = ["flash", "swap", "credit", "lp", "protocol"];
const PROTOCOL_ACTION_ORDER: readonly ProtocolAction[] = [
  "mint",
  "redeem",
  "wrap",
  "unwrap",
  "convert",
  "stake",
  "unstake",
];

export function aggregateVenueCandidates(perTx: VenueCandidate[][]): AggregatedVenue[] {
  const byAddress = new Map<string, AggregatedVenue>();

  for (const txCandidates of perTx) {
    const seenInTx = new Set<string>();

    for (const candidate of txCandidates) {
      const address = candidate.address.toLowerCase();
      if (!address) continue;

      let aggregate = byAddress.get(address);
      if (!aggregate) {
        aggregate = {
          address,
          edgeKinds: [],
          protocolActions: [],
          txCount: 0,
          totalLogCount: 0,
        };
        byAddress.set(address, aggregate);
      }

      if (!seenInTx.has(address)) {
        aggregate.txCount++;
        seenInTx.add(address);
      }
      aggregate.totalLogCount += candidate.logCount;
      unionInto(aggregate.edgeKinds, candidate.edgeKinds);
      unionInto(aggregate.protocolActions, candidate.protocolActions);
    }
  }

  return sortAggregates([...byAddress.values()].map(normalizeAggregate));
}

export function mergeAggregates(
  existing: AggregatedVenue[],
  incoming: AggregatedVenue[],
): AggregatedVenue[] {
  const byAddress = new Map<string, AggregatedVenue>();

  for (const source of [existing, incoming]) {
    for (const candidate of source) {
      const address = candidate.address.toLowerCase();
      if (!address) continue;

      let aggregate = byAddress.get(address);
      if (!aggregate) {
        aggregate = {
          address,
          edgeKinds: [],
          protocolActions: [],
          txCount: 0,
          totalLogCount: 0,
        };
        byAddress.set(address, aggregate);
      }

      aggregate.txCount += candidate.txCount;
      aggregate.totalLogCount += candidate.totalLogCount;
      unionInto(aggregate.edgeKinds, candidate.edgeKinds);
      unionInto(aggregate.protocolActions, candidate.protocolActions);
    }
  }

  return sortAggregates([...byAddress.values()].map(normalizeAggregate));
}

function sortAggregates(items: AggregatedVenue[]): AggregatedVenue[] {
  return items.sort(
    (a, b) =>
      b.txCount - a.txCount
      || b.totalLogCount - a.totalLogCount
      || a.address.localeCompare(b.address),
  );
}

function normalizeAggregate(aggregate: AggregatedVenue): AggregatedVenue {
  return {
    ...aggregate,
    edgeKinds: sortedUniqueByOrder(aggregate.edgeKinds, EDGE_KIND_ORDER),
    protocolActions: sortedUniqueByOrder(aggregate.protocolActions, PROTOCOL_ACTION_ORDER),
  };
}

function unionInto<T>(target: T[], source: T[]): void {
  for (const item of source) {
    if (!target.includes(item)) target.push(item);
  }
}

function sortedUniqueByOrder<T extends string>(items: T[], order: readonly T[]): T[] {
  const orderIndex = new Map(order.map((item, index) => [item, index]));
  return [...new Set(items)].sort((a, b) =>
    (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER)
    - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
    || a.localeCompare(b)
  );
}
