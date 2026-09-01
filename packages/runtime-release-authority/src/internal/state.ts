import type {
  RuntimeReleaseBindingV1,
  RuntimeReleaseSignerPinV1,
} from "../../../../specs/release-authority/src/index.ts";
import type {
  RuntimeAuthorityDescriptorV1,
  SignedReleaseRuntimeAuthorityDescriptorV1,
  UnsignedDryRunRuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";

/**
 * Process-local release state.  The wire binding is only a fact; this state
 * is the authority that makes a downstream capability usable.  Nothing in
 * this module is exported from the package root.
 */
export interface RuntimeReleaseAuthorityStateV1 {
  readonly authorityClass: "signed-release";
  readonly descriptor: SignedReleaseRuntimeAuthorityDescriptorV1;
  binding: RuntimeReleaseBindingV1;
  readonly deploymentPin: RuntimeReleaseSignerPinV1;
  active: boolean;
  version: bigint;
}

/**
 * A zero-signature dry-run has process-local authority to run the exact
 * observed implementation, but carries no release approval, signer, key, or
 * qualification claim.  Domain owners add only their exact observed inputs;
 * this state is the shared lifetime/revocation fence.
 */
export interface UnsignedDryRunRuntimeAuthorityStateV1 {
  readonly authorityClass: "unsigned-dry-run";
  readonly descriptor: UnsignedDryRunRuntimeAuthorityDescriptorV1;
  active: boolean;
  version: bigint;
}

export type RuntimeAuthorityStateV1 =
  | RuntimeReleaseAuthorityStateV1
  | UnsignedDryRunRuntimeAuthorityStateV1;

export const runtimeReleaseAuthorityStates = new WeakMap<object, RuntimeAuthorityStateV1>();
export const runtimeReleaseCapabilityStates = new WeakMap<object, RuntimeAuthorityStateV1>();

export function registerRuntimeReleaseAuthority(
  authority: object,
  capability: object,
  state: RuntimeAuthorityStateV1,
): void {
  runtimeReleaseAuthorityStates.set(authority, state);
  runtimeReleaseCapabilityStates.set(capability, state);
}

export function assertIssuedRuntimeAuthorityState(value: unknown): RuntimeAuthorityStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("runtime release authority not issued");
  }
  const state = runtimeReleaseAuthorityStates.get(value);
  if (!state) throw new TypeError("runtime release authority not issued");
  return state;
}

export function assertActiveRuntimeAuthorityState(
  value: unknown,
): RuntimeAuthorityStateV1 {
  const state = assertIssuedRuntimeAuthorityState(value);
  if (!state.active) throw new TypeError("runtime authority revoked");
  return state;
}

export function assertIssuedRuntimeReleaseAuthorityState(value: unknown): RuntimeReleaseAuthorityStateV1 {
  const state = assertIssuedRuntimeAuthorityState(value);
  if (state.authorityClass !== "signed-release") {
    throw new TypeError("runtime authority is not a signed release");
  }
  return state;
}

export function assertActiveRuntimeReleaseAuthorityState(value: unknown): RuntimeReleaseAuthorityStateV1 {
  const state = assertActiveRuntimeAuthorityState(value);
  if (state.authorityClass !== "signed-release") {
    throw new TypeError("runtime authority is not a signed release");
  }
  return state;
}

export function runtimeAuthorityDescriptorFromState(
  state: RuntimeAuthorityStateV1,
): RuntimeAuthorityDescriptorV1 {
  return state.descriptor;
}

export function stateForRuntimeReleaseCapability(value: unknown): RuntimeAuthorityStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("runtime release capability invalid");
  }
  const state = runtimeReleaseCapabilityStates.get(value);
  if (!state) throw new TypeError("runtime release capability not issued");
  if (!state.active) throw new TypeError("runtime release capability revoked");
  return state;
}
