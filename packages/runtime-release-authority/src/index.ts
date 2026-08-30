import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  decodeRuntimeReleaseBindingV1,
  decodeRuntimeReleaseSignerPinV1,
  runtimeReleaseBindingSigningBytes,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseResolutionCapabilityV1,
  type RuntimeReleaseResolutionPortV1,
  type RuntimeReleaseSignerPinV1,
  type RuntimeReleaseReadyBindingPortV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  registerRuntimeReleaseAuthority,
  stateForRuntimeReleaseCapability,
} from "./internal/state.ts";
import { issueRuntimeReleaseReadyBindingPort } from "./internal/ready-binding-owner.ts";
import type { RuntimeReleaseAuthorityStateV1 } from "./internal/state.ts";

export {
  buildRuntimeReleaseComposition,
} from "./internal/bootstrap.ts";
export type {
  RuntimeReleaseCheckpointInputV1,
  RuntimeReleaseSchedulerInputV1,
  RuntimeReleaseRevmInputV1,
  RuntimeReleaseReadyInputV1,
  RuntimeReleaseCatalogInputV1,
  RuntimeReleaseCatalogSnapshotV1,
  RuntimeReleaseCatalogServiceV1,
  RuntimeReleaseCompositionInputV1,
  RuntimeReleaseCompositionServicesV1,
  RuntimeReleaseFamilyRuntimeServiceV1,
} from "./internal/bootstrap.ts";
export type {
  RuntimeReleaseObserverStoreBindingV1,
  RuntimeReleaseObserverStoreInputV1,
  RuntimeReleaseObserverStoreServiceV1,
} from "./internal/observer-store-owner.ts";
export {
  openInstalledRuntimeReleasePerformanceDeploymentPortV1,
} from "./internal/performance-deployment-owner.ts";
export type {
  RuntimeReleasePerformanceDeploymentPortV1,
} from "./internal/performance-deployment-owner.ts";
export {
  issueInstalledRuntimeReleasePerformancePolicyPortV1,
} from "./internal/performance-policy-owner.ts";
export type {
  RuntimeReleasePerformancePolicyPortV1,
} from "./internal/performance-policy-owner.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface RuntimeReleaseAuthorityV1 {
  readonly capability: RuntimeReleaseResolutionCapabilityV1;
  readonly resolver: RuntimeReleaseResolutionPortV1;
  readonly readyGeneration: RuntimeReleaseReadyBindingPortV1;
  revoke(): void;
  rotate(
    binding: RuntimeReleaseBindingV1,
  ): void;
}

function verifyBinding(
  bindingValue: RuntimeReleaseBindingV1,
  pinValue: RuntimeReleaseSignerPinV1,
): { readonly binding: RuntimeReleaseBindingV1; readonly deploymentPin: RuntimeReleaseSignerPinV1 } {
  const binding = decodeRuntimeReleaseBindingV1(bindingValue);
  const pin = decodeRuntimeReleaseSignerPinV1(pinValue);
  if (binding.signerKeyId !== pin.signerKeyId) throw new TypeError("runtime release signer pin mismatch");
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]),
    format: "der", type: "spki",
  });
  if (!verifySignature(null, Buffer.from(runtimeReleaseBindingSigningBytes(binding)), publicKey, Buffer.from(binding.signatureHex.slice(2), "hex"))) {
    throw new TypeError("runtime release binding signature invalid");
  }
  return { binding, deploymentPin: pin };
}

/** Verification-only seam for phase admission. It creates no capability and
 * retains no process-local authority. */
export function verifyRuntimeReleaseBindingAuthenticityV1(
  bindingValue: RuntimeReleaseBindingV1,
  deploymentPin: RuntimeReleaseSignerPinV1,
): void {
  verifyBinding(bindingValue, deploymentPin);
}

const resolver: RuntimeReleaseResolutionPortV1 = Object.freeze({
  resolve(capability: RuntimeReleaseResolutionCapabilityV1) {
    const state = stateForRuntimeReleaseCapability(capability);
    return state.binding;
  },
});

/** Candidate-side verification only. This function never signs or derives a pin. */
export function verifyAndIssueRuntimeReleaseAuthorityV1(
  bindingValue: RuntimeReleaseBindingV1,
  deploymentPin: RuntimeReleaseSignerPinV1,
): RuntimeReleaseAuthorityV1 {
  const verified = verifyBinding(bindingValue, deploymentPin);
  const capability = Object.freeze(Object.create(null)) as RuntimeReleaseResolutionCapabilityV1;
  const state: RuntimeReleaseAuthorityStateV1 = {
    binding: verified.binding,
    deploymentPin: verified.deploymentPin,
    active: true,
    version: 0n,
  };
  // The ready-binding port is installed immediately below, before this
  // authority is exposed.  Keep the construction local so callers can never
  // observe a partially initialized authority; the assertion is only needed
  // to bridge the self-referential `readyGeneration` property during setup.
  const authority = {
    capability,
    resolver,
    revoke() {
      state.active = false;
    },
    rotate(nextBinding: RuntimeReleaseBindingV1) {
      if (!state.active) throw new TypeError("runtime release authority revoked");
      state.binding = verifyBinding(nextBinding, state.deploymentPin).binding;
      state.version += 1n;
    },
  } as unknown as RuntimeReleaseAuthorityV1;
  registerRuntimeReleaseAuthority(authority, capability, state);
  (authority as unknown as { readyGeneration: RuntimeReleaseReadyBindingPortV1 }).readyGeneration =
    issueRuntimeReleaseReadyBindingPort(authority);
  return Object.freeze(authority);
}
