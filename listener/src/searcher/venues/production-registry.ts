import { createRouteAdapterRegistry } from "./route-adapter-registry.js";
import { ADDR } from "../../shared/constants/addresses.js";
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
import {
  assertIdentityResolverCoverage,
  balancerV3IdentityResolver,
  curveIdentityResolver,
  factoryIdentityResolver,
  IdentityResolverRegistry,
  type IdentityResolverDescriptor,
} from "./identity.js";

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

const PRODUCTION_IDENTITY_POLICIES: readonly IdentityResolverDescriptor[] = [
  { poolAdapter: "univ2", policy: "onchain-resolver", resolve: factoryIdentityResolver },
  { poolAdapter: "univ3", policy: "onchain-resolver", resolve: factoryIdentityResolver },
  { poolAdapter: "curve", policy: "onchain-resolver", resolve: curveIdentityResolver },
  { poolAdapter: "curve-nr", policy: "onchain-resolver", resolve: curveIdentityResolver },
  { poolAdapter: "curve-underlying", policy: "onchain-resolver", resolve: curveIdentityResolver },
  {
    poolAdapter: "balancer-v3",
    policy: "onchain-resolver",
    resolve: balancerV3IdentityResolver,
  },
  {
    poolAdapter: "univ4",
    policy: "trusted-singleton-seed",
    canonicalAddress: ADDR.UNISWAP_V4_POOL_MANAGER,
    canonicalVenueId: "univ4",
    canonicalIdentitySource: "v4-manager",
  },
  { poolAdapter: "erc4626", policy: "trusted-singleton-seed" },
  { poolAdapter: "goldx", policy: "trusted-singleton-seed" },
  { poolAdapter: "metronome-synth", policy: "trusted-singleton-seed" },
  { poolAdapter: "metronome-hgusdc", policy: "trusted-singleton-seed" },
  { poolAdapter: "psm", policy: "trusted-singleton-seed" },
  { poolAdapter: "rocksolid", policy: "trusted-singleton-seed" },
  { poolAdapter: "wsteth", policy: "trusted-singleton-seed" },
  { poolAdapter: "fluid-vault", policy: "trusted-singleton-seed" },
  {
    poolAdapter: "fluid-dex",
    policy: "trusted-singleton-seed",
    legacyReason: "legacy Fluid DEX route; RouteAdapter migration is fixture-blocked",
  },
];

/**
 * Identity admission stays independent from execution, while startup-time
 * conformance makes a newly registered route pool impossible to omit silently.
 */
export const PRODUCTION_IDENTITY_RESOLVERS = new IdentityResolverRegistry(
  PRODUCTION_IDENTITY_POLICIES,
);

assertIdentityResolverCoverage(
  PRODUCTION_ROUTE_ADAPTERS.routeLegs.list(),
  PRODUCTION_IDENTITY_RESOLVERS,
);
