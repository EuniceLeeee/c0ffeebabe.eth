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
 * Best-effort prewarm projection from strict Funding definitions. Repayment
 * targets are static Family semantics, so warming them does not require a
 * runtime publication view and does not confer offer/execution authority.
 * Funding offers remain issuer-bound to the current-source strict session.
 */
export function strictFundingPrewarmAddresses(input: {
  readonly catalog: FamilyCapabilityCatalog;
}): readonly string[] {
  const addresses = new Set<string>();
  for (const family of input.catalog.listAll()) {
    if (family.plugin.manifest.domain !== "funding") continue;
    if (!("funding" in family.plugin) || family.plugin.funding === undefined) {
      throw new Error(
        `strict Funding definition ${family.plugin.manifest.familyId} ` +
          "has no funding semantics",
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
 * Route prewarm projection: for each hop whose adapter belongs to a strict
 * Family, prewarm the hop target and both tokens. Unknown adapters yield no
 * extra addresses. This is a static optimization projection; current-source
 * route/exact/execution authority remains in StrictProductionRuntimeSession.
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
