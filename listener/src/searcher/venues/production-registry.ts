import { createRouteAdapterRegistry } from "./route-adapter-registry.js";
import { univ2StandardAdapter } from "./swaps/univ2-standard.js";
import { univ3StandardAdapter } from "./swaps/univ3-standard.js";

export const PRODUCTION_ROUTE_ADAPTERS = createRouteAdapterRegistry({
  swaps: [univ2StandardAdapter, univ3StandardAdapter],
  protocols: [],
});
