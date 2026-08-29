import {
  assertExactKeys,
  assertHash,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeProductionPerformanceProfile,
  encodeHardwareProfileObservationV1,
  encodeProductionPerformanceProfile,
  type HardwareProfileObservationV1,
  type ProductionPerformanceProfileV1,
} from "../../../../specs/performance/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { readRuntimeReleasePerformanceDeploymentPortV1, type RuntimeReleasePerformanceDeploymentPortV1 } from "./performance-deployment-owner.ts";
import { observeRuntimeReleaseHardwareProfileV1 } from "./hardware-profile-observer.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import {
  readRuntimeReleaseQualifiedDiscoverySourcePort,
  type RuntimeReleaseQualifiedDiscoverySourcePortV1,
} from "./discovery-source-authority-owner.ts";

export type RuntimeReleasePerformancePolicyPortV1 = object;

export interface RuntimeReleasePerformancePolicyFactsV1 {
  readonly performanceProfile: ProductionPerformanceProfileV1;
  readonly hardwareProfile: HardwareProfileObservationV1;
  readonly providerRoot: Hash;
  readonly profileArtifactSha256: Hash;
  readonly hardwareArtifactSha256: Hash;
}

interface PolicyStateV1 extends RuntimeReleasePerformancePolicyFactsV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly authorityVersion: bigint;
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
}

const policies = new WeakMap<object, PolicyStateV1>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function issuePolicy(
  authority: RuntimeReleaseAuthorityV1,
  performanceProfile: ProductionPerformanceProfileV1,
  hardwareProfile: HardwareProfileObservationV1,
  providerRoot: Hash,
  profileArtifactSha256: Hash,
  hardwareArtifactSha256: Hash,
): RuntimeReleasePerformancePolicyPortV1 {
  const authorityState = assertActiveRuntimeReleaseAuthorityState(authority);
  const port = Object.freeze(Object.create(null)) as RuntimeReleasePerformancePolicyPortV1;
  policies.set(port, Object.freeze({
    authority,
    authorityVersion: authorityState.version,
    bindingId: authorityState.binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(authorityState.binding),
    performanceProfile,
    hardwareProfile,
    providerRoot,
    profileArtifactSha256,
    hardwareArtifactSha256,
  }));
  return port;
}

/** Final installed mode retains and validates the real packaged deployment basis. */
export function issueInstalledRuntimeReleasePerformancePolicyPortV1(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly deployment: RuntimeReleasePerformanceDeploymentPortV1;
}): RuntimeReleasePerformancePolicyPortV1 {
  assertExactKeys(input, ["authority", "deployment"], "installedRuntimeReleasePerformancePolicy");
  const deployment = readRuntimeReleasePerformanceDeploymentPortV1(input.authority, input.deployment);
  const observedHardware = observeRuntimeReleaseHardwareProfileV1();
  if (!sameBytes(
    encodeHardwareProfileObservationV1(deployment.hardwareProfile),
    encodeHardwareProfileObservationV1(observedHardware),
  )) {
    throw new TypeError("runtime-release current hardware does not match the deployment-qualified hardware profile");
  }
  return issuePolicy(
    input.authority,
    deployment.performanceProfile,
    observedHardware,
    deployment.deploymentBasis.providerRoot,
    deployment.profileArtifactSha256,
    deployment.hardwareArtifactSha256,
  );
}

/**
 * Pre-release mode has no prior deployment basis. The externally authorized
 * static profile is joined to the active authority while hardware is observed
 * by this host and provider identity comes from the qualified source owner.
 */
export function issuePreReleaseRuntimeReleasePerformancePolicyPortV1(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly performanceProfileBytes: Uint8Array;
  readonly qualifiedSource: RuntimeReleaseQualifiedDiscoverySourcePortV1;
}): RuntimeReleasePerformancePolicyPortV1 {
  assertExactKeys(input, ["authority", "performanceProfileBytes", "qualifiedSource"], "preReleaseRuntimePerformancePolicy");
  if (!(input.performanceProfileBytes instanceof Uint8Array) || input.performanceProfileBytes.byteLength === 0) {
    throw new TypeError("pre-release performance profile exact bytes are required");
  }
  const profileBytes = new Uint8Array(input.performanceProfileBytes);
  const performanceProfile = decodeProductionPerformanceProfile(profileBytes);
  if (!sameBytes(profileBytes, encodeProductionPerformanceProfile(performanceProfile))) {
    throw new TypeError("pre-release performance profile is not canonical exact bytes");
  }
  const providerRoot = assertHash(
    readRuntimeReleaseQualifiedDiscoverySourcePort(input.authority, input.qualifiedSource).sourceAuthorityRoot,
    "preReleaseRuntimePerformancePolicy.providerRoot",
  );
  if (/^0x0{64}$/.test(providerRoot)) {
    throw new TypeError("pre-release performance provider root must be a non-zero hash");
  }
  const hardwareProfile = observeRuntimeReleaseHardwareProfileV1();
  const hardwareBytes = encodeHardwareProfileObservationV1(hardwareProfile);
  return issuePolicy(
    input.authority,
    performanceProfile,
    hardwareProfile,
    providerRoot,
    sha256Hex(profileBytes),
    sha256Hex(hardwareBytes),
  );
}

export function readRuntimeReleasePerformancePolicyPortV1(
  authority: RuntimeReleaseAuthorityV1,
  port: RuntimeReleasePerformancePolicyPortV1,
): RuntimeReleasePerformancePolicyFactsV1 {
  const authorityState = assertActiveRuntimeReleaseAuthorityState(authority);
  const state = policies.get(port);
  if (state === undefined
    || state.authority !== authority
    || state.authorityVersion !== authorityState.version
    || state.bindingId !== authorityState.binding.bindingId
    || state.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(authorityState.binding)) {
    throw new TypeError("runtime-release performance policy port is foreign, cloned, or stale");
  }
  return Object.freeze({
    performanceProfile: state.performanceProfile,
    hardwareProfile: state.hardwareProfile,
    providerRoot: state.providerRoot,
    profileArtifactSha256: state.profileArtifactSha256,
    hardwareArtifactSha256: state.hardwareArtifactSha256,
  });
}
