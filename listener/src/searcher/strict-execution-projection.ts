import type { FamilyCapabilityCatalog } from
  "./venues/family-capability-catalog.js";
import type {
  ExecutionRuntimeHop,
  ExecutionRuntimeProjection,
  FundingExecutionResource,
} from "./venues/adapter-family-plugin.js";
import { getAddress } from "ethers";
import type { ResolvedPlanNode } from "../types.js";

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

/** Metadata for a selected root, checked by its actual owned encoder. No offer
 * authority is created here; final source-bound simulation is still mandatory. */
export function strictFundingExecutionResource(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly node: ResolvedPlanNode;
  readonly executor: string;
}): FundingExecutionResource {
  const family = input.catalog.forStrictFamily(input.catalog.ownerOfAction(input.node.adapterId));
  if (family.plugin.manifest.domain !== "funding" || !("funding" in family.plugin) ||
      family.plugin.funding.repayment.executionResource === undefined) {
    throw new Error("selected root has no Funding execution-resource projection");
  }
  const actions = family.plugin.actionAdapters.filter(action => action.id === input.node.adapterId);
  if (actions.length !== 1) throw new Error("selected Funding root has no unique owned encoder");
  const node = Object.freeze({ ...input.node, params: Object.freeze({ ...input.node.params }),
    children: Object.freeze([...input.node.children]) }) as unknown as ResolvedPlanNode;
  actions[0]!.encode(node, getAddress(input.executor), new Uint8Array());
  const projected = family.plugin.funding.repayment.executionResource({ node, executor: input.executor });
  if (!projected || typeof projected !== "object" ||
      typeof projected.fundingId !== "string" || !projected.fundingId ||
      typeof projected.liquidityResourceKey !== "string" || !projected.liquidityResourceKey ||
      typeof projected.amount !== "bigint" || projected.amount <= 0n || projected.amount !== node.amount ||
      getAddress(projected.target) !== getAddress(node.target) ||
      getAddress(projected.asset) !== getAddress(node.tokenIn) || getAddress(node.tokenIn) !== getAddress(node.tokenOut)) {
    throw new Error("Funding resource projection differs from the encoded root");
  }
  return Object.freeze({ fundingId: projected.fundingId, target: getAddress(projected.target).toLowerCase(),
    liquidityHolder: getAddress(projected.liquidityHolder).toLowerCase(), liquidityResourceKey: projected.liquidityResourceKey,
    asset: getAddress(projected.asset).toLowerCase(), amount: projected.amount });
}

/** Before plan selection there is no provider to warm. Every supplied root is
 * projected independently so one selector can warm several chosen providers. */
export function strictFundingPrewarmAddresses(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly selectedRoots?: readonly ResolvedPlanNode[];
  readonly executor?: string;
}): readonly string[] {
  const addresses = new Set<string>();
  for (const node of input.selectedRoots ?? []) {
    if (input.executor === undefined) throw new Error("Funding prewarm requires the selected executor");
    const resource = strictFundingExecutionResource({ catalog: input.catalog, node, executor: input.executor });
    addresses.add(resource.target);
    addresses.add(resource.liquidityHolder);
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
