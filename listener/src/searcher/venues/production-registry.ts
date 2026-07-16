import { createRouteAdapterRegistry } from "./route-adapter-registry.js";
import { fluidCreditCompatAdapter } from "./compat/fluid-credit.js";
import { erc4626Adapter } from "./protocols/erc4626.js";
import { goldxAdapter } from "./protocols/goldx.js";
import { metronomeHgusdcAdapter, metronomeSynthAdapter } from "./protocols/metronome.js";
import { psmAdapter } from "./protocols/psm.js";
import { rocksolidAdapter } from "./protocols/rocksolid.js";
import { wstethAdapter } from "./protocols/wsteth.js";
import { balancerV3Adapter } from "./swaps/balancer-v3.js";
import { curvePlainAdapter } from "./swaps/curve-plain.js";
import { curveUnderlyingAdapter } from "./swaps/curve-underlying.js";
import { univ2StandardAdapter } from "./swaps/univ2-standard.js";
import { univ3StandardAdapter } from "./swaps/univ3-standard.js";
import { univ4Adapter } from "./swaps/univ4.js";

export interface LegacyRouteEdgeDescriptor {
  readonly edgeAdapterId: string;
  readonly slotKind: "swap" | "protocol";
  readonly reason: string;
}

/**
 * Production route edges that still use the legacy token-graph/quoter/plan-builder
 * switches. Keep each exception explicit until it has a pinned venue fixture and
 * can move into PRODUCTION_ROUTE_ADAPTERS without weakening equivalence gates.
 */
export const LEGACY_PRODUCTION_ROUTE_EDGES: readonly LegacyRouteEdgeDescriptor[] = Object.freeze([
  Object.freeze({
    edgeAdapterId: "fluid-dex-swap",
    slotKind: "swap",
    reason: "legacy Fluid DEX route; RouteAdapter migration is fixture-blocked",
  }),
]);

export const PRODUCTION_ROUTE_ADAPTERS = createRouteAdapterRegistry({
  swaps: [
    univ2StandardAdapter,
    univ3StandardAdapter,
    curvePlainAdapter,
    curveUnderlyingAdapter,
    balancerV3Adapter,
    univ4Adapter,
  ],
  protocols: [
    erc4626Adapter,
    goldxAdapter,
    metronomeSynthAdapter,
    metronomeHgusdcAdapter,
    psmAdapter,
    rocksolidAdapter,
    wstethAdapter,
  ],
  compat: [fluidCreditCompatAdapter],
});
