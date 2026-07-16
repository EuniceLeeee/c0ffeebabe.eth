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
  const all: RouteLegAdapter[] = [...input.swaps, ...input.protocols, ...compat];
  return Object.freeze({
    routeLegs: new RouteLegRegistry(all),
    swaps: Object.freeze([...input.swaps]),
    protocols: Object.freeze([...input.protocols]),
    compat: Object.freeze([...compat]),
  });
}
