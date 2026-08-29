import { readFileSync } from "node:fs";
import {
  assertExactKeys,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeDeploymentPerformanceWindowBasisV1,
  decodeHardwareProfileObservationV1,
  decodeProductionPerformanceProfile,
  encodeDeploymentPerformanceWindowBasisV1,
  encodeHardwareProfileObservationV1,
  encodeProductionPerformanceProfile,
  PERFORMANCE_ELIGIBILITY_RULE_HASH,
  PERFORMANCE_TARGET_COUNT,
  type DeploymentPerformanceWindowBasisV1,
  type HardwareProfileObservationV1,
  type ProductionPerformanceProfileV1,
} from "../../../../specs/performance/src/index.ts";
import {
  runtimeReleaseBindingProvenanceHash,
  runtimeReleaseDiscoverySourceAuthorityRootV1,
} from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";

const BASIS_PATH = "/etc/aloha/performance-window-basis.json";
const PROFILE_PATH = "/etc/aloha/performance-profile.json";
const HARDWARE_PATH = "/etc/aloha/hardware-profile.json";

export type RuntimeReleasePerformanceDeploymentPortV1 = object;

export interface RuntimeReleasePerformanceDeploymentFactsV1 {
  readonly deploymentBasis: DeploymentPerformanceWindowBasisV1;
  readonly performanceProfile: ProductionPerformanceProfileV1;
  readonly hardwareProfile: HardwareProfileObservationV1;
  readonly basisArtifactSha256: Hash;
  readonly profileArtifactSha256: Hash;
  readonly hardwareArtifactSha256: Hash;
}

interface PortStateV1 extends RuntimeReleasePerformanceDeploymentFactsV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly authorityVersion: bigint;
}

const ports = new WeakMap<object, PortStateV1>();

function exactBytes(value: Uint8Array, path: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new TypeError(`${path} exact bytes are required`);
  return new Uint8Array(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

/**
 * Internal deployment owner. Bootstrap never receives these raw bytes; it
 * receives only the opaque port returned after canonical decode and release
 * joins. Kept internal so production callers use the fixed-path loader below.
 */
export function issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly basisBytes: Uint8Array;
  readonly profileBytes: Uint8Array;
  readonly hardwareBytes: Uint8Array;
}): RuntimeReleasePerformanceDeploymentPortV1 {
  assertExactKeys(input, ["authority", "basisBytes", "profileBytes", "hardwareBytes"], "runtimeReleasePerformanceDeployment");
  const authorityState = assertActiveRuntimeReleaseAuthorityState(input.authority);
  const basisBytes = exactBytes(input.basisBytes, "runtimeReleasePerformanceDeployment.basis");
  const profileBytes = exactBytes(input.profileBytes, "runtimeReleasePerformanceDeployment.profile");
  const hardwareBytes = exactBytes(input.hardwareBytes, "runtimeReleasePerformanceDeployment.hardware");
  const deploymentBasis = decodeDeploymentPerformanceWindowBasisV1(basisBytes);
  const performanceProfile = decodeProductionPerformanceProfile(profileBytes);
  const hardwareProfile = decodeHardwareProfileObservationV1(hardwareBytes);
  if (!sameBytes(basisBytes, encodeDeploymentPerformanceWindowBasisV1(deploymentBasis))
    || !sameBytes(profileBytes, encodeProductionPerformanceProfile(performanceProfile))
    || !sameBytes(hardwareBytes, encodeHardwareProfileObservationV1(hardwareProfile))) {
    throw new TypeError("runtime-release performance deployment artifact is not canonical exact bytes");
  }
  const provenance = runtimeReleaseBindingProvenanceHash(authorityState.binding);
  if (deploymentBasis.bindingId !== authorityState.binding.bindingId
    || deploymentBasis.releaseProvenanceHash !== provenance
    || deploymentBasis.candidateReleaseCommit !== authorityState.binding.candidateReleaseCommit
    || deploymentBasis.performanceProfileHash !== performanceProfile.profileHash
    || deploymentBasis.eligibilityRuleHash !== PERFORMANCE_ELIGIBILITY_RULE_HASH
    || deploymentBasis.targetCount !== PERFORMANCE_TARGET_COUNT
    || deploymentBasis.providerRoot !== runtimeReleaseDiscoverySourceAuthorityRootV1(
      authorityState.binding.discoverySourceQualification,
    )
    || deploymentBasis.hardwareProfileRoot !== hardwareProfile.profileRoot) {
    throw new TypeError("runtime-release performance deployment artifacts do not match the signed release");
  }
  const port = Object.freeze(Object.create(null)) as RuntimeReleasePerformanceDeploymentPortV1;
  ports.set(port, {
    authority: input.authority,
    authorityVersion: authorityState.version,
    deploymentBasis,
    performanceProfile,
    hardwareProfile,
    basisArtifactSha256: sha256Hex(basisBytes),
    profileArtifactSha256: sha256Hex(profileBytes),
    hardwareArtifactSha256: sha256Hex(hardwareBytes),
  });
  return port;
}

/** Read the one production deployment layout. No path or fallback is caller-configurable. */
export function openInstalledRuntimeReleasePerformanceDeploymentPortV1(
  authority: RuntimeReleaseAuthorityV1,
): RuntimeReleasePerformanceDeploymentPortV1 {
  return issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1({
    authority,
    basisBytes: new Uint8Array(readFileSync(BASIS_PATH)),
    profileBytes: new Uint8Array(readFileSync(PROFILE_PATH)),
    hardwareBytes: new Uint8Array(readFileSync(HARDWARE_PATH)),
  });
}

export function readRuntimeReleasePerformanceDeploymentPortV1(
  authority: RuntimeReleaseAuthorityV1,
  port: RuntimeReleasePerformanceDeploymentPortV1,
): RuntimeReleasePerformanceDeploymentFactsV1 {
  const authorityState = assertActiveRuntimeReleaseAuthorityState(authority);
  const state = ports.get(port);
  if (state === undefined || state.authority !== authority || state.authorityVersion !== authorityState.version) {
    throw new TypeError("runtime-release performance deployment port is foreign, cloned, or stale");
  }
  return Object.freeze({
    deploymentBasis: state.deploymentBasis,
    performanceProfile: state.performanceProfile,
    hardwareProfile: state.hardwareProfile,
    basisArtifactSha256: state.basisArtifactSha256,
    profileArtifactSha256: state.profileArtifactSha256,
    hardwareArtifactSha256: state.hardwareArtifactSha256,
  });
}
