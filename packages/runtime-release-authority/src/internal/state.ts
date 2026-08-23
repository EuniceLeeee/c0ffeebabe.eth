import type {
  RuntimeReleaseBindingV1,
  RuntimeReleaseSignerPinV1,
} from "../../../../specs/release-authority/src/index.ts";

/**
 * Process-local release state.  The wire binding is only a fact; this state
 * is the authority that makes a downstream capability usable.  Nothing in
 * this module is exported from the package root.
 */
export interface RuntimeReleaseAuthorityStateV1 {
  binding: RuntimeReleaseBindingV1;
  readonly deploymentPin: RuntimeReleaseSignerPinV1;
  active: boolean;
  version: bigint;
}

export const runtimeReleaseAuthorityStates = new WeakMap<object, RuntimeReleaseAuthorityStateV1>();
export const runtimeReleaseCapabilityStates = new WeakMap<object, RuntimeReleaseAuthorityStateV1>();

export function registerRuntimeReleaseAuthority(
  authority: object,
  capability: object,
  state: RuntimeReleaseAuthorityStateV1,
): void {
  runtimeReleaseAuthorityStates.set(authority, state);
  runtimeReleaseCapabilityStates.set(capability, state);
}

export function assertIssuedRuntimeReleaseAuthorityState(value: unknown): RuntimeReleaseAuthorityStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("runtime release authority not issued");
  }
  const state = runtimeReleaseAuthorityStates.get(value);
  if (!state) throw new TypeError("runtime release authority not issued");
  return state;
}

export function assertActiveRuntimeReleaseAuthorityState(
  value: unknown,
): RuntimeReleaseAuthorityStateV1 {
  const state = assertIssuedRuntimeReleaseAuthorityState(value);
  if (!state.active) throw new TypeError("runtime release authority revoked");
  return state;
}

export function stateForRuntimeReleaseCapability(value: unknown): RuntimeReleaseAuthorityStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("runtime release capability invalid");
  }
  const state = runtimeReleaseCapabilityStates.get(value);
  if (!state) throw new TypeError("runtime release capability not issued");
  if (!state.active) throw new TypeError("runtime release capability revoked");
  return state;
}
