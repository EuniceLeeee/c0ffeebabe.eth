import type {
  StrictShadowCatalogViews,
} from "./adapter-family-shadow-catalog-publication.js";
import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type {
  ExecutionRuntimeHop,
  ExecutionRuntimeProjection,
} from "./venues/adapter-family-plugin.js";

export type StrictExecutionHop = ExecutionRuntimeHop;
export type StrictExecutionAdapterProjection = ExecutionRuntimeProjection;

export function strictExecutionProjectionForHop(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly hop: StrictExecutionHop;
}): StrictExecutionAdapterProjection | null {
  let family;
  try {
    family = input.catalog.forStrictFamily(
      input.catalog.ownerOfAction(input.hop.adapterId),
    );
  } catch {
    return null;
  }
  if (!("execution" in family.plugin)) return null;
  return validateExecutionRuntimeProjection(
    family.plugin.execution.runtimeProjection({
      hop: Object.freeze({ ...input.hop }),
    }),
  );
}

function validateExecutionRuntimeProjection(
  value: ExecutionRuntimeProjection,
): ExecutionRuntimeProjection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("execution runtime projection must be an object");
  }
  if (
    value.allowanceSpender !== null &&
    typeof value.allowanceSpender !== "string"
  ) {
    throw new Error("execution allowance spender must be a string or null");
  }
  if (!Array.isArray(value.prewarmQuoteCalls)) {
    throw new Error("execution prewarm quote calls must be an array");
  }
  for (const call of value.prewarmQuoteCalls) {
    if (
      call === null || typeof call !== "object" ||
      typeof call.from !== "string" || typeof call.to !== "string" ||
      typeof call.calldata !== "string" ||
      !Number.isSafeInteger(call.gasLimit) || call.gasLimit <= 0
    ) {
      throw new Error("execution prewarm quote call is malformed");
    }
  }
  return value;
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
 * Funding prewarm selection (Pair A partial): committed strict funding
 * states are the only source. Without a committed publication the live
 * path has no strict funding data (accepted Phase E risk); the legacy
 * registry fallback has been removed.
 */
export function resolveFundingPrewarmAddresses(input: {
  readonly strictViews: StrictShadowCatalogViews | null;
  readonly catalog: FamilyCapabilityCatalog;
}): readonly string[] {
  if (input.strictViews === null) return Object.freeze([]);
  return strictFundingPrewarmAddresses({
    views: input.strictViews,
    catalog: input.catalog,
  });
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
