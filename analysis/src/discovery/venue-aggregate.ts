import type { EdgeKind, ProtocolAction } from "../../../listener/src/searcher/strategy-taxonomy.js";
import type { VenueCandidate } from "./venue-evidence.js";

export interface AggregatedVenue {
  address: string;
  edgeKinds: EdgeKind[];
  protocolActions: ProtocolAction[];
  txCount: number;
  totalLogCount: number;
}

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

  return [...byAddress.values()].sort(
    (a, b) =>
      b.txCount - a.txCount
      || b.totalLogCount - a.totalLogCount
      || a.address.localeCompare(b.address),
  );
}

function unionInto<T>(target: T[], source: T[]): void {
  for (const item of source) {
    if (!target.includes(item)) target.push(item);
  }
}
