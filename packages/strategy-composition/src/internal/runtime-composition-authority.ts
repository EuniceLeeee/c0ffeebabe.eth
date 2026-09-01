import type { Hash } from "../../../canonical-codec/src/index.ts";
import type { StrategyPlanningProblemIssuerV1 } from "../../../strategy-sdk/src/index.ts";
import type { GeneratedStrategyRuntimeDescriptorV1 } from "../index.ts";
import type { RuntimeAuthorityProjectionV1 } from "../../../runtime-authority/src/index.ts";

declare const generatedStrategyRuntimeCompositionCapabilityBrand: unique symbol;

/**
 * Process-local hand-off from the generated factory.  The descriptor and
 * callable issuers never cross the public Strategy-composition boundary.
 */
export interface GeneratedStrategyRuntimeCompositionCapabilityV1 {
  readonly [generatedStrategyRuntimeCompositionCapabilityBrand]: never;
}

export interface GeneratedStrategyRuntimeCompositionAuthorityStateV1 {
  readonly descriptor: GeneratedStrategyRuntimeDescriptorV1;
  readonly issuers: readonly StrategyPlanningProblemIssuerV1[];
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly runtimeMembershipHash: Hash;
  readonly assertCurrent: () => void;
}

const issued = new WeakMap<object, GeneratedStrategyRuntimeCompositionAuthorityStateV1>();

/** Internal generated-factory owner only; this module is not a package export. */
export function issueGeneratedStrategyRuntimeCompositionCapability(
  state: GeneratedStrategyRuntimeCompositionAuthorityStateV1,
): GeneratedStrategyRuntimeCompositionCapabilityV1 {
  state.assertCurrent();
  const capability = Object.freeze(Object.create(null)) as GeneratedStrategyRuntimeCompositionCapabilityV1;
  issued.set(capability, Object.freeze({
    descriptor: state.descriptor,
    issuers: Object.freeze([...state.issuers]),
    runtimeAuthority: state.runtimeAuthority,
    runtimeMembershipHash: state.runtimeMembershipHash,
    assertCurrent: state.assertCurrent,
  }));
  return capability;
}

export function readGeneratedStrategyRuntimeCompositionCapability(
  value: unknown,
): GeneratedStrategyRuntimeCompositionAuthorityStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Strategy runtime production authority is unavailable");
  }
  const state = issued.get(value);
  if (state === undefined) throw new TypeError("Strategy runtime production authority is unavailable");
  state.assertCurrent();
  return state;
}
