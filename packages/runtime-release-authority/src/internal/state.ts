import type {
  RuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";

/** Shared lifetime/revocation fence for the exact runtime implementation. */
export interface RuntimeAuthorityStateV1 {
  readonly descriptor: RuntimeAuthorityDescriptorV1;
  active: boolean;
  version: bigint;
}

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
    throw new TypeError("runtime authority not issued");
  }
  const state = runtimeReleaseAuthorityStates.get(value);
  if (!state) throw new TypeError("runtime authority not issued");
  return state;
}

export function assertActiveRuntimeAuthorityState(
  value: unknown,
): RuntimeAuthorityStateV1 {
  const state = assertIssuedRuntimeAuthorityState(value);
  if (!state.active) throw new TypeError("runtime authority revoked");
  return state;
}

export function runtimeAuthorityDescriptorFromState(
  state: RuntimeAuthorityStateV1,
): RuntimeAuthorityDescriptorV1 {
  return state.descriptor;
}

export function stateForRuntimeReleaseCapability(value: unknown): RuntimeAuthorityStateV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("runtime capability invalid");
  }
  const state = runtimeReleaseCapabilityStates.get(value);
  if (!state) throw new TypeError("runtime capability not issued");
  if (!state.active) throw new TypeError("runtime capability revoked");
  return state;
}
