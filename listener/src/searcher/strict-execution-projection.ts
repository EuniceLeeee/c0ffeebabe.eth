import type {
  StrictShadowCatalogViews,
} from "./adapter-family-shadow-catalog-publication.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";

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
