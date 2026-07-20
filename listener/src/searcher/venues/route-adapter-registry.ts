import { ethers } from "ethers";
import type {
  CompatRouteLegAdapter,
  ProtocolConversionAdapter,
  RouteLegAdapter,
  SwapAdapter,
} from "./route-leg-adapter.js";
import { RouteLegRegistry } from "./route-leg-registry.js";

export interface RouteAdapterRegistry {
  readonly routeLegs: RouteLegRegistry;
  readonly swaps: readonly SwapAdapter[];
  readonly protocols: readonly ProtocolConversionAdapter[];
  readonly compat: readonly CompatRouteLegAdapter[];
}

export function createRouteAdapterRegistry(input: {
  swaps: readonly SwapAdapter[];
  protocols: readonly ProtocolConversionAdapter[];
  compat?: readonly CompatRouteLegAdapter[];
}): RouteAdapterRegistry {
  const compat = input.compat ?? [];
  assertProtocolVenueDeclarations(input.protocols);
  const all: RouteLegAdapter[] = [...input.swaps, ...input.protocols, ...compat];
  return Object.freeze({
    routeLegs: new RouteLegRegistry(all),
    swaps: Object.freeze([...input.swaps]),
    protocols: Object.freeze([...input.protocols]),
    compat: Object.freeze([...compat]),
  });
}

function assertProtocolVenueDeclarations(
  adapters: readonly ProtocolConversionAdapter[],
): void {
  const addresses = new Set<string>();
  const graphOrders = new Set<number>();
  for (const adapter of adapters) {
    if (adapter.discovery && !adapter.requiresProtocolEdgesFlag) {
      throw new Error(
        `route adapter registry: ${adapter.id} discovery must remain behind protocol edge admission`,
      );
    }
    if (
      adapter.discovery?.candidateFromAddress &&
      !adapter.discovery.addressMatcherVersion?.trim()
    ) {
      throw new Error(
        `route adapter registry: ${adapter.id} address discovery requires addressMatcherVersion`,
      );
    }
    const reason = adapter.undeclaredVenueReason?.trim() ?? "";
    if (adapter.declaredVenues.length === 0 ? reason.length === 0 : reason.length !== 0) {
      throw new Error(
        `route adapter registry: ${adapter.id} must declare venues or one undeclared-venue reason`,
      );
    }
    for (const venue of adapter.declaredVenues) {
      if (!adapter.poolAdapters.includes(venue.adapter)) {
        throw new Error(
          `route adapter registry: ${adapter.id} declared foreign pool adapter ${venue.adapter}`,
        );
      }
      if (venue.score !== undefined) {
        throw new Error(`route adapter registry: ${adapter.id} declared a scored static venue`);
      }
      let address: string;
      try {
        address = ethers.getAddress(venue.address).toLowerCase();
      } catch {
        throw new Error(`route adapter registry: ${adapter.id} declared an invalid venue address`);
      }
      if (addresses.has(address)) {
        throw new Error(`route adapter registry: duplicate declared venue ${address}`);
      }
      addresses.add(address);
      if (venue.graphOrder !== undefined) {
        if (!Number.isSafeInteger(venue.graphOrder) || venue.graphOrder < 0) {
          throw new Error(`route adapter registry: ${adapter.id} declared invalid graph order`);
        }
        if (graphOrders.has(venue.graphOrder)) {
          throw new Error(`route adapter registry: duplicate declared graph order ${venue.graphOrder}`);
        }
        graphOrders.add(venue.graphOrder);
      }
    }
  }
}
