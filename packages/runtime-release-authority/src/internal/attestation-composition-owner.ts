import type {
  RuntimeReleaseAttestationCompositionBindingV1,
  RuntimeReleaseAttestationCompositionResolvedV1,
} from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import {
  assertActiveRuntimeReleaseAuthorityState,
} from "./state.ts";
import type { RuntimeReleaseAuthorityStateV1 } from "./state.ts";
import { assertIssuedRuntimeReleaseAttestationProofPort } from "./attestation-proof-consumer.ts";
import type { RuntimeReleaseAttestationProofPortV1 } from "./attestation-proof-owner.ts";

interface AttestationCompositionStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly capability: object;
  readonly proofPortCapability: object;
  readonly version: bigint;
}

const compositionStates = new WeakMap<object, AttestationCompositionStateV1>();

/**
 * Runtime-release-authority is the sole owner of this downstream binding.
 * The proof port is already an Attestation-owned opaque capability; this
 * function stores it behind the runtime authority's active/version fence and
 * never exposes a generic proof issuer.
 */
export function issueRuntimeReleaseAttestationComposition(
  authorityValue: unknown,
  proofPortCapability: unknown,
): RuntimeReleaseAttestationCompositionBindingV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const authorityState = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  assertIssuedRuntimeReleaseAttestationProofPort(proofPortCapability, authority);
  const capability = Object.freeze(Object.create(null)) as object;
  const version = authorityState.version;
  const resolver = Object.freeze({
    resolve(requestedCapability: object): RuntimeReleaseAttestationCompositionResolvedV1 {
      if (requestedCapability !== capability) {
        throw new TypeError("attestation composition capability not issued");
      }
      const current = assertActiveRuntimeReleaseAuthorityState(authority);
      if (current.version !== version) {
        throw new TypeError("attestation composition capability stale after runtime release rotation");
      }
      return Object.freeze({
        provenance: Object.freeze({
          runtimeBinding: current.binding,
          // This field is intentionally hidden from the neutral public
          // contract.  The runtime consumer unwraps it into a guarded port.
          proofPortCapability,
        }),
      }) as unknown as RuntimeReleaseAttestationCompositionResolvedV1;
    },
  });
  const binding = Object.freeze({ capability, resolver });
  compositionStates.set(binding, {
    authority,
    capability,
    proofPortCapability: proofPortCapability as object,
    version,
  });
  return binding;
}

export interface RuntimeReleaseAttestationCompositionResolvedWithProofV1
  extends RuntimeReleaseAttestationCompositionResolvedV1 {
  readonly proofPort: RuntimeReleaseAttestationProofPortV1;
}

export interface IssuedRuntimeReleaseAttestationCompositionV1 {
  readonly binding: RuntimeReleaseAttestationCompositionBindingV1;
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly state: RuntimeReleaseAuthorityStateV1;
}

export function readIssuedRuntimeReleaseAttestationComposition(
  value: unknown,
): IssuedRuntimeReleaseAttestationCompositionV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("attestation composition binding invalid");
  }
  const state = compositionStates.get(value);
  if (!state) throw new TypeError("attestation composition binding not issued");
  const authorityState = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (authorityState.version !== state.version) {
    throw new TypeError("attestation composition binding stale after runtime release rotation");
  }
  // The state is read once more through the exact authority consumer.  This
  // also ensures a forged object carrying the same public fields cannot enter.
  if (state.capability === null || state.proofPortCapability === null) {
    throw new TypeError("attestation composition binding state invalid");
  }
  return { binding: value as RuntimeReleaseAttestationCompositionBindingV1, authority: state.authority, state: authorityState };
}
