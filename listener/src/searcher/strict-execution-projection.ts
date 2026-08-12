import type {
  StrictShadowCatalogViews,
} from "./adapter-family-shadow-catalog-publication.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import { ethers } from "ethers";
import {
  UNIV2_PAIR_INTERFACE,
} from "./venues/swaps/univ2-family/codec.js";
import { UNIV2_ROUTER } from
  "./venues/swaps/univ2-family/victim.js";
import { UNIV2_FAMILY_ID } from
  "./venues/swaps/univ2-family/manifest.js";
import { UNIV3_SWAP_ROUTER } from
  "./venues/swaps/univ3-abi.js";
import { UNIV3_FAMILY_ID } from
  "./venues/swaps/univ3-family/manifest.js";
import { UNIV4_FAMILY_ID } from
  "./venues/swaps/univ4-family/manifest.js";
import { DODO_V2_FAMILY_ID } from
  "./venues/swaps/dodo-v2-family/manifest.js";
import { FLUID_DEX_FAMILY_ID } from
  "./venues/swaps/fluid-dex-family/manifest.js";
import { EIGENPIE_FAMILY_ID } from
  "./venues/protocols/eigenpie-family/manifest.js";
import { GOLDX_FAMILY_ID } from
  "./venues/protocols/goldx-family/manifest.js";
import { PSM_FAMILY_ID } from
  "./venues/protocols/psm-family/manifest.js";

export interface StrictExecutionHop {
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface StrictExecutionAdapterProjection {
  readonly allowanceSpender:
    | string
    | ((hop: StrictExecutionHop) => string | null)
    | null;
  readonly prewarmQuoteCalls: readonly {
    readonly from: string;
    readonly to: string;
    readonly calldata: string;
    readonly gasLimit: number;
  }[];
}

/**
 * Execution-adapter projection layer (Pair A step 3 pilot). Declares the
 * execution-facing facts the live backend needs per strict Family, derived
 * from the same protocol constants the families already use. This is an
 * infrastructure-singleton projection (router/pool constants), NOT an
 * instance allowlist, and it deliberately avoids changing the plugin
 * contract so the definition boundary / sealed parity evidence stays
 * stable. Families without a projection keep the legacy adapter path until
 * their pilot lands.
 */
const strictExecutionAdapters: ReadonlyMap<
  string,
  StrictExecutionAdapterProjection
> = new Map<string, StrictExecutionAdapterProjection>([
  [UNIV2_FAMILY_ID, Object.freeze({
    allowanceSpender: UNIV2_ROUTER,
    prewarmQuoteCalls: Object.freeze([Object.freeze({
      from: ethers.ZeroAddress,
      to: "", // filled from the hop target by the backend
      calldata: UNIV2_PAIR_INTERFACE.encodeFunctionData("getReserves", []),
      gasLimit: 300_000,
    })]),
  })],
  [UNIV3_FAMILY_ID, Object.freeze({
    allowanceSpender: UNIV3_SWAP_ROUTER,
    prewarmQuoteCalls: Object.freeze([]),
  })],
  [UNIV4_FAMILY_ID, Object.freeze({
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([]),
  })],
  [DODO_V2_FAMILY_ID, Object.freeze({
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([]),
  })],
  [FLUID_DEX_FAMILY_ID, Object.freeze({
    allowanceSpender: (hop: StrictExecutionHop) => hop.target,
    prewarmQuoteCalls: Object.freeze([]),
  })],
  [EIGENPIE_FAMILY_ID, Object.freeze({
    allowanceSpender: (hop: StrictExecutionHop) => hop.target,
    prewarmQuoteCalls: Object.freeze([]),
  })],
  [GOLDX_FAMILY_ID, Object.freeze({
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([]),
  })],
  [PSM_FAMILY_ID, Object.freeze({
    allowanceSpender: null,
    prewarmQuoteCalls: Object.freeze([]),
  })],
]);

export function strictExecutionProjectionFor(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly adapterId: string;
}): StrictExecutionAdapterProjection | null {
  let familyId: string;
  try {
    familyId = input.catalog.ownerOfAction(input.adapterId);
  } catch {
    return null;
  }
  return strictExecutionAdapters.get(familyId) ?? null;
}

/**
 * Execution-facing projections from a committed strict publication.
 * Pair A step 1: funding prewarm addresses. The strict funding family
 * plugin already declares repayment execution targets (target /
 * liquidityHolder), so the projection is a direct 1:1 mapping from the
 * committed funding states — no legacy registry read.
 */
export function strictFundingPrewarmAddresses(input: {
  readonly views: StrictShadowCatalogViews;
  readonly catalog: FamilyCapabilityCatalog;
}): readonly string[] {
  const addresses = new Set<string>();
  for (const state of input.views.fundingByPublicationKey.values()) {
    if (state.kind !== "funding") continue;
    const family = input.catalog.forStrictFamily(state.familyId);
    if (!("funding" in family.plugin) || family.plugin.funding === undefined) {
      throw new Error(
        `strict funding publication ${state.familyId} has no funding plugin`,
      );
    }
    addresses.add(family.plugin.funding.repayment.target.toLowerCase());
    addresses.add(
      family.plugin.funding.repayment.liquidityHolder.toLowerCase(),
    );
  }
  return Object.freeze([...addresses].sort());
}

/**
 * Env-gated selection for the live backend: use the committed strict
 * funding projection when available, otherwise the legacy addresses.
 */
export function resolveFundingPrewarmAddresses(input: {
  readonly strictViews: StrictShadowCatalogViews | null;
  readonly catalog: FamilyCapabilityCatalog;
  readonly legacyAddresses: readonly string[];
}): readonly string[] {
  if (input.strictViews !== null) {
    return strictFundingPrewarmAddresses({
      views: input.strictViews,
      catalog: input.catalog,
    });
  }
  return Object.freeze([...new Set(
    input.legacyAddresses.map((address) => address.toLowerCase()),
  )].sort());
}

/**
 * Route prewarm projection: for each hop whose adapter belongs to a strict
 * Family, prewarm the hop target and both tokens. Unknown adapters yield no
 * extra addresses (same default as the legacy optional prewarm). Only
 * meaningful when a committed strict publication is available; the live
 * backend gates this behind the strict-execution env flag.
 */
export function strictRoutePrewarmAddresses(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly hops: readonly {
    readonly adapterId: string;
    readonly target: string;
    readonly tokenIn: string;
    readonly tokenOut: string;
  }[];
}): readonly string[] {
  const addresses = new Set<string>();
  for (const hop of input.hops) {
    try {
      input.catalog.ownerOfAction(hop.adapterId);
    } catch {
      continue;
    }
    addresses.add(hop.target.toLowerCase());
    addresses.add(hop.tokenIn.toLowerCase());
    addresses.add(hop.tokenOut.toLowerCase());
  }
  return Object.freeze([...addresses].sort());
}
