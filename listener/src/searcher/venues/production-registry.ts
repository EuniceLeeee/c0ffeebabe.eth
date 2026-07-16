import { createRouteAdapterRegistry } from "./route-adapter-registry.js";
import { balancerV3Adapter } from "./swaps/balancer-v3.js";
import { curvePlainAdapter } from "./swaps/curve-plain.js";
import { curveUnderlyingAdapter } from "./swaps/curve-underlying.js";
import { univ2StandardAdapter } from "./swaps/univ2-standard.js";
import { univ3StandardAdapter } from "./swaps/univ3-standard.js";

export const PRODUCTION_ROUTE_ADAPTERS = createRouteAdapterRegistry({
  swaps: [
    univ2StandardAdapter,
    univ3StandardAdapter,
    curvePlainAdapter,
    curveUnderlyingAdapter,
    balancerV3Adapter,
  ],
  protocols: [],
});
