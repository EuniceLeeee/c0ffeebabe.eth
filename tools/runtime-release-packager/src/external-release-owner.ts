import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AssembledReleaseInvocationSetCapabilityV1 } from "../../../acceptance/gate-core/src/material-provider.ts";
import { readAssembledReleaseAcceptanceResultsV1 } from "../../../acceptance/gate-core/src/internal/assembled-acceptance-owner.ts";
import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  hashSchema,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { VerifyExternalQualificationInputV2 } from "../../../packages/external-qualification-verifier/src/index.ts";
import { decodeAcceptanceCertificateV1 } from "../../../specs/acceptance-certificate/src/index.ts";
import {
  decodeReleaseAcceptanceSetV1,
  decodeSignedReleaseAcceptanceApprovalV1,
  decodeSignedReleaseAuthorityApprovalV3,
  encodeReleaseAcceptanceSetV1,
  encodeSignedReleaseAcceptanceApprovalV1,
  encodeSignedReleaseAuthorityApprovalV3,
  type SignedReleaseAcceptanceApprovalV1,
} from "../../../specs/qualification/src/index.ts";
import type {
  RuntimeReleaseBindingV1,
  RuntimeReleasePackageApprovalPayloadV1,
  RuntimeReleasePackageApprovalV1,
  RuntimeReleaseSignerPinV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  decodeRuntimeReleaseSignerPinV1,
  encodeRuntimeReleasePackageApprovalV1,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleasePackageApprovalSigningBytes,
} from "../../../specs/release-authority/src/index.ts";
import {
  createDeploymentPerformanceWindowBasisV1,
  decodeDeploymentPerformanceWindowBasisV1,
  decodeHardwareProfileObservationV1,
  decodeProductionPerformanceProfile,
  encodeDeploymentPerformanceWindowBasisV1,
  encodeHardwareProfileObservationV1,
  encodeProductionPerformanceProfile,
} from "../../../specs/performance/src/index.ts";
import {
  decodeDeploymentManifestV1,
  encodeDeploymentManifestV1,
} from "../../../apps/searcher-runtime/src/deployment.ts";
import { observeProductionPerformanceDatabaseV1 } from "../../../packages/performance-collector/src/raw-sqlite-observer.ts";
import {
  prepareReleaseAcceptanceV1,
  verifyReleaseRequirementDenominatorV1,
  type PreparedReleaseAcceptanceV1,
} from "./release-acceptance.ts";
import { verifyRuntimeReleaseBindingSignatureV1 } from "./internal/runtime-binding-verifier.ts";
import { observeExactPushedGitV1 } from "./git-release-evidence.ts";
import {
  PACKAGE_INSTALL_PATHS_V1,
  PRODUCTION_RELEASE_LAYOUT_V1,
  PRODUCTION_SYSTEMD_UNIT_V1,
  assertPackageApprovalJoin,
  decodeReleasePackageManifestV1,
  productionProcessCommandSha256V1,
  productionReleaseEnvironmentBytesV1,
  releasePackageApprovalPayload,
  verifyPackageApprovalSignature,
  verifyReleaseArtifactSemanticsV1,
  verifyReleasePackageDirectoryV1,
  type ReleasePackageManifestV1,
} from "./deployment-package.ts";
import { verifyReleaseAcceptanceEvidenceV1 } from "./release-acceptance.ts";
import {
  decodePreReleaseStagingManifestV1,
  hashPreReleaseStagingArtifactSetV1,
  PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1,
  PRE_RELEASE_STAGING_LAYOUT_V1,
} from "./internal/pre-release-staging-schema.ts";
import type {
  PreReleaseStagingArtifactIdentityV1,
  PreReleaseStagingArtifactNameV1,
} from "./pre-release-staging-contract.ts";
import {
  renderProductionDeploymentCompositionV1,
} from "./deployment-composition-artifact.ts";
import type { DeploymentRuntimeInfrastructureRequestV1 } from "../../../packages/runtime-release-authority/src/internal/deployment-runtime-owner.ts";
import {
  readProductionReleaseAcceptanceSigningRequestV1,
  readProductionReleasePreparedAcceptanceV1,
  type ProductionReleaseAcceptancePreparationCapabilityV1,
} from "./production-workflow.ts";

export interface PrepareAssembledReleaseAcceptanceInputV1 {
  readonly invocationSet: AssembledReleaseInvocationSetCapabilityV1;
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
}

/** Sole external-release owner for the post-GateCore acceptance signing
 * request. It can only read the opaque invocation set already evaluated by
 * GateCore and returns bytes for an external signer; it never signs them. */
export function prepareAssembledReleaseAcceptanceV1(
  input: PrepareAssembledReleaseAcceptanceInputV1,
): PreparedReleaseAcceptanceV1 {
  const results = readAssembledReleaseAcceptanceResultsV1(input.invocationSet);
  if (results.some(result => result.verdict !== "pass")) {
    throw new TypeError("assembled GateCore denominator did not pass");
  }
  const runtimeBinding = verifyRuntimeReleaseBindingSignatureV1(
    input.runtimeBinding,
    input.runtimeSignerPin,
  );
  return prepareReleaseAcceptanceV1({
    runtimeBinding,
    externalQualifications: input.externalQualifications,
    acceptanceCertificates: results.map(result => result.certificate),
  });
}

export interface PrepareFrozenProductionArtifactBaseInputV1 {
  readonly repositoryRoot: string;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly stagingArtifacts: readonly PreReleaseStagingArtifactIdentityV1[];
  readonly stagingArtifactBytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>;
  readonly performanceDatabasePath: string;
  readonly performanceDatabaseSha256: Hash;
  readonly preparedAcceptanceCapability: ProductionReleaseAcceptancePreparationCapabilityV1;
  readonly revmWorkerBytes: Uint8Array;
  readonly proofSignerBytes: Uint8Array;
  readonly deploymentInfrastructure: DeploymentRuntimeInfrastructureRequestV1;
}

export type FrozenProductionArtifactBaseV1 = object;

interface FrozenProductionArtifactBaseStateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.frozen-production-artifact-base";
  readonly baseRoot: Hash;
  readonly repositoryRoot: string;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly performanceDatabaseSha256: Hash;
  readonly acceptanceSigningRequestRoot: Hash;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly artifacts: readonly ProductionReleasePackageArtifactBytesV1[];
}

const frozenProductionArtifactBases = new WeakMap<object, FrozenProductionArtifactBaseStateV1>();

function exactStagingArtifactBytes(
  input: PrepareFrozenProductionArtifactBaseInputV1,
): Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>> {
  if (hashPreReleaseStagingArtifactSetV1(input.stagingArtifacts) !== hashSchema.decode(input.stagingArtifactSetRoot)) {
    throw new TypeError("frozen production base staging artifact root mismatch");
  }
  const keys = Reflect.ownKeys(input.stagingArtifactBytes);
  if (keys.length !== PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.length
    || keys.some(key => typeof key !== "string" || !PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.includes(key as never))) {
    throw new TypeError("frozen production base staging bytes denominator mismatch");
  }
  const result = Object.create(null) as Record<PreReleaseStagingArtifactNameV1, Uint8Array>;
  for (let index = 0; index < PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.length; index += 1) {
    const name = PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1[index]!;
    const identity = input.stagingArtifacts[index]!;
    const bytes = input.stagingArtifactBytes[name];
    if (!(bytes instanceof Uint8Array)
      || identity.name !== name
      || identity.contentSha256 !== sha256Hex(bytes)
      || identity.byteLength !== String(bytes.byteLength)) {
      throw new TypeError(`frozen production base staging artifact mismatch: ${name}`);
    }
    result[name] = new Uint8Array(bytes);
  }
  const manifestBytes = result["staging-manifest.json"];
  const expectedManifestRoot = hashDomain("aloha/pre-release-staging-manifest/root/v1", {
    contentSha256: sha256Hex(manifestBytes),
    byteLength: String(manifestBytes.byteLength),
  });
  if (expectedManifestRoot !== hashSchema.decode(input.stagingManifestRoot)) {
    throw new TypeError("frozen production base staging manifest root mismatch");
  }
  const manifest = decodePreReleaseStagingManifestV1(decodeCanonicalJson(manifestBytes));
  if (!Buffer.from(encodeCanonicalBytes(manifest)).equals(Buffer.from(manifestBytes))) {
    throw new TypeError("frozen production base staging manifest is not canonical exact bytes");
  }
  return Object.freeze(result);
}

const COPIED_PRODUCTION_ARTIFACTS = Object.freeze([
  "candidate-proof-verifier-binding.json",
  "catalog-generation.inputs.json",
  "deployment-bundle.mjs",
  "deployment-source.json",
  "executor-state.json",
  "family-catalog.ts",
  "nomination-qualification-deployment-fact.json",
  "performance-profile.json",
  "production-launcher.mjs",
  "release-authority-approval.json",
  "release-intent.json",
  "runtime-composition.ts",
  "runtime-policy.json",
  "runtime-release-binding.json",
  "strategy-catalog.ts",
] as const satisfies readonly PreReleaseStagingArtifactNameV1[]);

function frozenBaseRoot(
  repositoryRoot: string,
  controllerBoundaryEvidenceRoot: Hash,
  stagingArtifactSetRoot: Hash,
  stagingManifestRoot: Hash,
  performanceDatabaseSha256: Hash,
  acceptanceSigningRequestRoot: Hash,
  runtimeSignerPin: RuntimeReleaseSignerPinV1,
  externalQualifications: readonly VerifyExternalQualificationInputV2[],
  artifacts: readonly ProductionReleasePackageArtifactBytesV1[],
): Hash {
  return hashDomain("aloha/frozen-production-artifact-base/v1", {
    repositoryRoot,
    controllerBoundaryEvidenceRoot,
    stagingArtifactSetRoot,
    stagingManifestRoot,
    performanceDatabaseSha256,
    acceptanceSigningRequestRoot,
    runtimeSignerPinSha256: sha256Hex(encodeCanonicalBytes(runtimeSignerPin)),
    externalQualificationsSha256: sha256Hex(encodeCanonicalBytes(externalQualifications)),
    artifacts: artifacts.map(artifact => ({
      name: artifact.name,
      contentSha256: sha256Hex(artifact.bytes),
      byteLength: String(artifact.bytes.byteLength),
    })),
  });
}

/** Mechanically project frozen pre-release facts to every production package
 * role except the externally signed acceptance approval. The result therefore
 * has exactly 25 artifacts; completion adds the 26th role. */
export function prepareFrozenProductionArtifactBaseV1(
  input: PrepareFrozenProductionArtifactBaseInputV1,
): FrozenProductionArtifactBaseV1 {
  const preparedAcceptance = readProductionReleasePreparedAcceptanceV1(
    input.preparedAcceptanceCapability,
  );
  const acceptanceSigningRequest = readProductionReleaseAcceptanceSigningRequestV1(
    input.preparedAcceptanceCapability,
  );
  const staging = exactStagingArtifactBytes(input);
  const stagingManifest = decodePreReleaseStagingManifestV1(decodeCanonicalJson(staging["staging-manifest.json"]));
  const runtimeSignerPin = decodeRuntimeReleaseSignerPinV1(decodeCanonicalJson(staging["runtime-release-signer-pin.json"]) as object);
  const binding = verifyRuntimeReleaseBindingSignatureV1(
    decodeRuntimeReleaseBindingV1(staging["runtime-release-binding.json"]),
    runtimeSignerPin,
  );
  const wire = decodeCanonicalJson(staging["qualified-release-runner-input.json"]);
  const wireObject = wire as Readonly<Record<string, unknown>>;
  if (wire === null || typeof wire !== "object" || Array.isArray(wire)
    || !Array.isArray(wireObject.externalQualifications)) {
    throw new TypeError("frozen production base qualified runner denominator is invalid");
  }
  const clonedExternalQualifications = decodeCanonicalJson(
    encodeCanonicalBytes(wireObject.externalQualifications),
  );
  const externalQualifications: readonly VerifyExternalQualificationInputV2[] = Object.freeze(
    clonedExternalQualifications as unknown as VerifyExternalQualificationInputV2[],
  );
  const prepared = prepareReleaseAcceptanceV1({
    runtimeBinding: binding,
    externalQualifications,
    acceptanceCertificates: preparedAcceptance.acceptanceCertificates,
  });
  if (!Buffer.from(encodeCanonicalBytes(prepared.signingInput)).equals(Buffer.from(encodeCanonicalBytes(preparedAcceptance.signingInput)))
    || !Buffer.from(encodeReleaseAcceptanceSetV1(prepared.releaseAcceptanceSet)).equals(Buffer.from(encodeReleaseAcceptanceSetV1(preparedAcceptance.releaseAcceptanceSet)))
    || !Buffer.from(prepared.signingBytes).equals(Buffer.from(preparedAcceptance.signingBytes))) {
    throw new TypeError("frozen production base acceptance preparation mismatch");
  }
  if (binding.bindingId !== stagingManifest.runtimeBindingId
    || binding.candidateReleaseCommit !== stagingManifest.candidateReleaseCommit
    || runtimeReleaseBindingProvenanceHash(binding) !== stagingManifest.releaseProvenanceHash
    || input.controllerBoundaryEvidenceRoot !== stagingManifest.controllerBoundaryEvidenceRoot) {
    throw new TypeError("frozen production base release identity mismatch");
  }
  const revmWorkerBytes = new Uint8Array(input.revmWorkerBytes);
  const proofSignerBytes = new Uint8Array(input.proofSignerBytes);
  if (revmWorkerBytes.byteLength === 0 || proofSignerBytes.byteLength === 0
    || sha256Hex(revmWorkerBytes) !== binding.selectedExecutor.executableFingerprint
    || input.deploymentInfrastructure.revmWorkerExecutableSha256 !== sha256Hex(revmWorkerBytes)
    || input.deploymentInfrastructure.externalProofSigner.executableSha256 !== sha256Hex(proofSignerBytes)) {
    throw new TypeError("frozen production base executable identity mismatch");
  }
  const deploymentCompositionBytes = renderProductionDeploymentCompositionV1(input.deploymentInfrastructure);
  const databasePath = realpathSync(resolve(input.performanceDatabasePath));
  if (databasePath !== resolve(input.performanceDatabasePath)
    || sha256Hex(new Uint8Array(readFileSync(databasePath))) !== input.performanceDatabaseSha256) {
    throw new TypeError("frozen production base performance database identity mismatch");
  }
  const performance = observeProductionPerformanceDatabaseV1(databasePath);
  if (performance.status !== "raw-complete" || performance.release === null
    || performance.profile === null || performance.commitment === null
    || performance.databaseSha256Before !== input.performanceDatabaseSha256
    || performance.databaseSha256After !== input.performanceDatabaseSha256
    || performance.release.bindingId !== binding.bindingId
    || performance.release.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || performance.release.candidateReleaseCommit !== binding.candidateReleaseCommit) {
    throw new TypeError(`frozen production base performance denominator is incomplete: ${performance.reasons.join(",")}`);
  }
  const basisEvents = performance.events.filter(event => event.eventType === "performance-window-basis");
  if (basisEvents.length !== 1) throw new TypeError("frozen production base performance basis event mismatch");
  const hardwareProfile = decodeHardwareProfileObservationV1(
    (basisEvents[0]!.payload as { hardwareProfile?: unknown }).hardwareProfile as object,
  );
  const commitment = performance.commitment;
  if (hardwareProfile.profileRoot !== commitment.hardwareProfileRoot
    || performance.profile.profileHash !== commitment.performanceProfileHash) {
    throw new TypeError("frozen production base performance facts do not join their commitment");
  }
  const performanceBasis = createDeploymentPerformanceWindowBasisV1({
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    candidateReleaseCommit: binding.candidateReleaseCommit,
    performanceProfileHash: performance.profile.profileHash,
    eligibilityRuleHash: commitment.eligibilityRuleHash,
    targetCount: commitment.targetCount,
    providerRoot: commitment.providerRoot,
    hardwareProfileRoot: hardwareProfile.profileRoot,
    commitContextBindingId: commitment.commitContextBindingId,
    commitAppendRecordId: commitment.commitAppendRecordId,
  });
  const releaseEnvironmentBytes = productionReleaseEnvironmentBytesV1(binding.candidateReleaseCommit);
  const unitBytes = new TextEncoder().encode(PRODUCTION_SYSTEMD_UNIT_V1);
  const deploymentBytes = encodeDeploymentManifestV1({
    schemaVersion: 1,
    kind: "aloha.searcher-deployment-manifest",
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    candidateReleaseCommit: binding.candidateReleaseCommit,
    searcherRuntimeArtifactRoot: binding.searcherRuntime.runtimeArtifactRoot,
    searcherRuntimeImplementationClosureDigest: binding.searcherRuntime.implementationClosureDigest,
    searcherRuntimeNodeExecutableSha256: binding.searcherRuntime.nodeExecutableSha256,
    searcherRuntimeEntrypointSha256: sha256Hex(staging["production-launcher.mjs"]),
    searcherRuntimeBundleModulePath: PRODUCTION_RELEASE_LAYOUT_V1.bundleModulePath,
    searcherRuntimeBundleModuleSha256: sha256Hex(staging["deployment-bundle.mjs"]),
    deploymentCompositionModulePath: PRODUCTION_RELEASE_LAYOUT_V1.deploymentCompositionModulePath,
    deploymentCompositionModuleSha256: sha256Hex(deploymentCompositionBytes),
    deploymentSourceConfigPath: PRODUCTION_RELEASE_LAYOUT_V1.deploymentSourceConfigPath,
    deploymentSourceConfigSha256: sha256Hex(staging["deployment-source.json"]),
    deploymentRuntimePolicyPath: PRODUCTION_RELEASE_LAYOUT_V1.deploymentRuntimePolicyPath,
    deploymentRuntimePolicySha256: sha256Hex(staging["runtime-policy.json"]),
    deploymentExecutorStatePath: PRODUCTION_RELEASE_LAYOUT_V1.deploymentExecutorStatePath,
    deploymentExecutorStateSha256: sha256Hex(staging["executor-state.json"]),
    releaseIntentPath: PRODUCTION_RELEASE_LAYOUT_V1.releaseIntentPath,
    releaseIntentSha256: sha256Hex(staging["release-intent.json"]),
    candidateProofVerifierBindingPath: PRODUCTION_RELEASE_LAYOUT_V1.candidateProofVerifierBindingPath,
    candidateProofVerifierBindingSha256: sha256Hex(staging["candidate-proof-verifier-binding.json"]),
    processCommandSha256: productionProcessCommandSha256V1(),
    serviceName: PRODUCTION_RELEASE_LAYOUT_V1.serviceName,
    systemdUnit: PRODUCTION_RELEASE_LAYOUT_V1.systemdUnit,
    systemdUnitPath: PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath,
    systemdUnitSha256: sha256Hex(unitBytes),
    releaseEnvironmentPath: PRODUCTION_RELEASE_LAYOUT_V1.releaseEnvironmentPath,
    releaseEnvironmentSha256: sha256Hex(releaseEnvironmentBytes),
    logPath: PRODUCTION_RELEASE_LAYOUT_V1.logPath,
    dryRun: true,
  });
  const files = new Map<string, Uint8Array>();
  for (const name of COPIED_PRODUCTION_ARTIFACTS) files.set(name, new Uint8Array(staging[name]));
  files.set("acceptance-certificates.json", encodeCanonicalBytes(prepared.acceptanceCertificates));
  files.set("release-acceptance-set.json", encodeReleaseAcceptanceSetV1(prepared.releaseAcceptanceSet));
  files.set("aloha-revm-worker", revmWorkerBytes);
  files.set("aloha-proof-signer", proofSignerBytes);
  files.set("aloha-searcher.service", unitBytes);
  files.set("deployment-composition.mjs", deploymentCompositionBytes);
  files.set("hardware-profile.json", encodeHardwareProfileObservationV1(hardwareProfile));
  files.set("performance-profile.json", encodeProductionPerformanceProfile(performance.profile));
  files.set("performance-window-basis.json", encodeDeploymentPerformanceWindowBasisV1(performanceBasis));
  files.set("searcher-deployment.json", deploymentBytes);
  files.set("searcher-release.env", releaseEnvironmentBytes);
  files.delete("release-acceptance-approval.json");
  const expectedNames = Object.keys(PACKAGE_INSTALL_PATHS_V1).filter(name => name !== "release-acceptance-approval.json").sort();
  const observedNames = [...files.keys()].sort();
  if (observedNames.length !== 25 || observedNames.some((name, index) => name !== expectedNames[index])) {
    throw new TypeError("frozen production artifact base denominator mismatch");
  }
  const artifacts = Object.freeze(observedNames.map(name => Object.freeze({ name, bytes: new Uint8Array(files.get(name)!) })));
  const repositoryRoot = realpathSync(resolve(input.repositoryRoot));
  const controllerBoundaryEvidenceRoot = hashSchema.decode(input.controllerBoundaryEvidenceRoot);
  const stagingArtifactSetRoot = hashSchema.decode(input.stagingArtifactSetRoot);
  const stagingManifestRoot = hashSchema.decode(input.stagingManifestRoot);
  const performanceDatabaseSha256 = hashSchema.decode(input.performanceDatabaseSha256);
  const acceptanceSigningRequestRoot = hashSchema.decode(acceptanceSigningRequest.requestRoot);
  const stateWithoutRoot = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.frozen-production-artifact-base",
    repositoryRoot,
    controllerBoundaryEvidenceRoot,
    stagingArtifactSetRoot,
    stagingManifestRoot,
    performanceDatabaseSha256,
    acceptanceSigningRequestRoot,
    runtimeSignerPin,
    externalQualifications,
    artifacts,
  });
  const baseRoot = frozenBaseRoot(
    repositoryRoot,
    controllerBoundaryEvidenceRoot,
    stagingArtifactSetRoot,
    stagingManifestRoot,
    performanceDatabaseSha256,
    acceptanceSigningRequestRoot,
    runtimeSignerPin,
    externalQualifications,
    artifacts,
  );
  const capability = Object.freeze(Object.create(null));
  frozenProductionArtifactBases.set(capability, Object.freeze({ ...stateWithoutRoot, baseRoot }));
  return capability;
}

function readFrozenProductionArtifactBaseStateV1(
  capability: FrozenProductionArtifactBaseV1,
): FrozenProductionArtifactBaseStateV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("frozen production artifact base capability is invalid");
  }
  const state = frozenProductionArtifactBases.get(capability);
  if (state === undefined) {
    throw new TypeError("frozen production artifact base was not release-owner-issued");
  }
  return state;
}

const FROZEN_PRODUCTION_ARTIFACT_BASE_MANIFEST_V1 = "frozen-production-artifact-base.json";

interface FrozenProductionArtifactBaseManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.frozen-production-artifact-base-manifest";
  readonly baseRoot: Hash;
  readonly repositoryRoot: string;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly performanceDatabaseSha256: Hash;
  readonly acceptanceSigningRequestRoot: Hash;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly artifactCount: "25";
  readonly artifacts: readonly Readonly<{
    readonly name: string;
    readonly contentSha256: Hash;
    readonly byteLength: string;
  }>[];
}

export interface FrozenProductionArtifactBasePublicationV1 {
  readonly baseRoot: Hash;
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifestSha256: Hash;
  readonly artifactCount: "25";
}

function frozenBaseManifest(state: FrozenProductionArtifactBaseStateV1): FrozenProductionArtifactBaseManifestV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.frozen-production-artifact-base-manifest",
    baseRoot: state.baseRoot,
    repositoryRoot: state.repositoryRoot,
    controllerBoundaryEvidenceRoot: state.controllerBoundaryEvidenceRoot,
    stagingArtifactSetRoot: state.stagingArtifactSetRoot,
    stagingManifestRoot: state.stagingManifestRoot,
    performanceDatabaseSha256: state.performanceDatabaseSha256,
    acceptanceSigningRequestRoot: state.acceptanceSigningRequestRoot,
    runtimeSignerPin: state.runtimeSignerPin,
    externalQualifications: state.externalQualifications,
    artifactCount: "25",
    artifacts: Object.freeze(state.artifacts.map(artifact => Object.freeze({
      name: artifact.name,
      contentSha256: sha256Hex(artifact.bytes),
      byteLength: String(artifact.bytes.byteLength),
    }))),
  });
}

function exactFrozenBaseManifest(value: unknown): FrozenProductionArtifactBaseManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("frozen production artifact base manifest must be an object");
  }
  const object = value as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    "acceptanceSigningRequestRoot", "artifactCount", "artifacts", "baseRoot",
    "controllerBoundaryEvidenceRoot", "externalQualifications", "kind",
    "performanceDatabaseSha256", "repositoryRoot", "runtimeSignerPin", "schemaVersion",
    "stagingArtifactSetRoot", "stagingManifestRoot",
  ];
  const keys = Object.keys(object).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || object.schemaVersion !== 1
    || object.kind !== "aloha.frozen-production-artifact-base-manifest"
    || object.artifactCount !== "25"
    || typeof object.repositoryRoot !== "string"
    || !Array.isArray(object.externalQualifications)
    || !Array.isArray(object.artifacts)) {
    throw new TypeError("frozen production artifact base manifest denominator mismatch");
  }
  const runtimeSignerPin = decodeRuntimeReleaseSignerPinV1(object.runtimeSignerPin as object);
  const externalQualifications = Object.freeze(
    object.externalQualifications as unknown as VerifyExternalQualificationInputV2[],
  );
  verifyReleaseRequirementDenominatorV1(externalQualifications);
  const expectedArtifactNames = Object.keys(PACKAGE_INSTALL_PATHS_V1)
    .filter(name => name !== "release-acceptance-approval.json")
    .sort();
  if (object.artifacts.length !== 25) {
    throw new TypeError("frozen production artifact base manifest artifact count mismatch");
  }
  const artifacts = Object.freeze(object.artifacts.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("frozen production artifact base manifest artifact is invalid");
    }
    const artifact = entry as Readonly<Record<string, unknown>>;
    const artifactKeys = Object.keys(artifact).sort();
    if (artifactKeys.length !== 3
      || artifactKeys[0] !== "byteLength"
      || artifactKeys[1] !== "contentSha256"
      || artifactKeys[2] !== "name"
      || artifact.name !== expectedArtifactNames[index]
      || typeof artifact.byteLength !== "string"
      || !/^(?:0|[1-9][0-9]*)$/.test(artifact.byteLength)) {
      throw new TypeError("frozen production artifact base manifest artifact denominator mismatch");
    }
    return Object.freeze({
      name: artifact.name,
      contentSha256: hashSchema.decode(artifact.contentSha256),
      byteLength: artifact.byteLength,
    });
  }));
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.frozen-production-artifact-base-manifest",
    baseRoot: hashSchema.decode(object.baseRoot),
    repositoryRoot: object.repositoryRoot,
    controllerBoundaryEvidenceRoot: hashSchema.decode(object.controllerBoundaryEvidenceRoot),
    stagingArtifactSetRoot: hashSchema.decode(object.stagingArtifactSetRoot),
    stagingManifestRoot: hashSchema.decode(object.stagingManifestRoot),
    performanceDatabaseSha256: hashSchema.decode(object.performanceDatabaseSha256),
    acceptanceSigningRequestRoot: hashSchema.decode(object.acceptanceSigningRequestRoot),
    runtimeSignerPin,
    externalQualifications,
    artifactCount: "25",
    artifacts,
  });
}

function stableFrozenBaseFile(path: string): Uint8Array {
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new TypeError("frozen production artifact base contains a non-canonical file");
  }
  const before = statSync(path, { bigint: true });
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength) || (after.mode & 0o022n) !== 0n) {
    throw new TypeError("frozen production artifact base file changed during read");
  }
  return bytes;
}

function requireFrozenBaseRepositoryV1(): string {
  const root = PRE_RELEASE_STAGING_LAYOUT_V1.productionArtifactBaseRepositoryPath;
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || realpathSync(root) !== root || stat.uid !== 0 || stat.gid !== 0
    || (stat.mode & 0o777) !== 0o700) {
    throw new TypeError("frozen production artifact base repository is not fixed root-owned storage");
  }
  return root;
}

/** Publish the exact 25-role A denominator. This never waits for or reads an
 * external acceptance signature. */
export function materializeFrozenProductionArtifactBaseV1(
  capability: FrozenProductionArtifactBaseV1,
): FrozenProductionArtifactBasePublicationV1 {
  if (arguments.length !== 1) throw new TypeError("frozen production artifact base publication accepts one capability");
  const state = readFrozenProductionArtifactBaseStateV1(capability);
  const root = requireFrozenBaseRepositoryV1();
  const finalDirectory = join(root, state.baseRoot.slice(2));
  if (existsSync(finalDirectory)) throw new TypeError("frozen production artifact base was already published");
  const stageDirectory = `${finalDirectory}.tmp-${process.pid}`;
  if (existsSync(stageDirectory)) throw new TypeError("frozen production artifact base staging directory already exists");
  mkdirSync(stageDirectory, { mode: 0o700 });
  let published = false;
  try {
    for (const artifact of state.artifacts) {
      writeFileSync(join(stageDirectory, artifact.name), artifact.bytes, { flag: "wx", mode: 0o444 });
    }
    const manifestBytes = encodeCanonicalBytes(frozenBaseManifest(state));
    const manifestPath = join(stageDirectory, FROZEN_PRODUCTION_ARTIFACT_BASE_MANIFEST_V1);
    writeFileSync(manifestPath, manifestBytes, { flag: "wx", mode: 0o444 });
    for (const name of readdirSync(stageDirectory)) fsyncPath(join(stageDirectory, name));
    fsyncPath(stageDirectory);
    renameSync(stageDirectory, finalDirectory);
    published = true;
    fsyncPath(root);
    const reopened = reopenFrozenProductionArtifactBaseV1(finalDirectory);
    const reopenedState = readFrozenProductionArtifactBaseStateV1(reopened);
    if (reopenedState.baseRoot !== state.baseRoot) {
      throw new TypeError("published frozen production artifact base did not reopen exactly");
    }
    return Object.freeze({
      baseRoot: state.baseRoot,
      directory: finalDirectory,
      manifestPath: join(finalDirectory, FROZEN_PRODUCTION_ARTIFACT_BASE_MANIFEST_V1),
      manifestSha256: sha256Hex(manifestBytes),
      artifactCount: "25",
    });
  } catch (error) {
    if (existsSync(stageDirectory)) rmSync(stageDirectory, { recursive: true, force: true });
    if (published && existsSync(finalDirectory)) rmSync(finalDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Reissue only from the fixed content-addressed A directory after exact-byte
 * and exact-denominator verification. */
export function reopenFrozenProductionArtifactBaseV1(
  directoryValue: string,
): FrozenProductionArtifactBaseV1 {
  const root = requireFrozenBaseRepositoryV1();
  const directory = realpathSync(resolve(directoryValue));
  if (resolve(directoryValue) !== directory || dirname(directory) !== root
    || !lstatSync(directory).isDirectory()) {
    throw new TypeError("frozen production artifact base is not a direct fixed repository member");
  }
  const manifestPath = join(directory, FROZEN_PRODUCTION_ARTIFACT_BASE_MANIFEST_V1);
  const manifestBytes = stableFrozenBaseFile(manifestPath);
  const manifest = exactFrozenBaseManifest(decodeCanonicalJson(manifestBytes));
  if (!Buffer.from(manifestBytes).equals(Buffer.from(encodeCanonicalBytes(manifest)))) {
    throw new TypeError("frozen production artifact base manifest is not canonical exact bytes");
  }
  if (directory !== join(root, manifest.baseRoot.slice(2))) {
    throw new TypeError("frozen production artifact base directory is not content addressed");
  }
  const expectedNames = [...manifest.artifacts.map(artifact => artifact.name), FROZEN_PRODUCTION_ARTIFACT_BASE_MANIFEST_V1].sort();
  const observedNames = readdirSync(directory).sort();
  if (observedNames.length !== expectedNames.length
    || observedNames.some((name, index) => name !== expectedNames[index])) {
    throw new TypeError("frozen production artifact base directory denominator mismatch");
  }
  const artifacts = Object.freeze(manifest.artifacts.map(identity => {
    const bytes = stableFrozenBaseFile(join(directory, identity.name));
    if (sha256Hex(bytes) !== identity.contentSha256 || String(bytes.byteLength) !== identity.byteLength) {
      throw new TypeError(`frozen production artifact base artifact mismatch: ${identity.name}`);
    }
    return Object.freeze({ name: identity.name, bytes });
  }));
  const expectedRoot = frozenBaseRoot(
    manifest.repositoryRoot,
    manifest.controllerBoundaryEvidenceRoot,
    manifest.stagingArtifactSetRoot,
    manifest.stagingManifestRoot,
    manifest.performanceDatabaseSha256,
    manifest.acceptanceSigningRequestRoot,
    manifest.runtimeSignerPin,
    manifest.externalQualifications,
    artifacts,
  );
  if (expectedRoot !== manifest.baseRoot) {
    throw new TypeError("frozen production artifact base root mismatch");
  }
  const capability = Object.freeze(Object.create(null));
  frozenProductionArtifactBases.set(capability, Object.freeze({
    schemaVersion: 1,
    kind: "aloha.frozen-production-artifact-base",
    baseRoot: manifest.baseRoot,
    repositoryRoot: manifest.repositoryRoot,
    controllerBoundaryEvidenceRoot: manifest.controllerBoundaryEvidenceRoot,
    stagingArtifactSetRoot: manifest.stagingArtifactSetRoot,
    stagingManifestRoot: manifest.stagingManifestRoot,
    performanceDatabaseSha256: manifest.performanceDatabaseSha256,
    acceptanceSigningRequestRoot: manifest.acceptanceSigningRequestRoot,
    runtimeSignerPin: manifest.runtimeSignerPin,
    externalQualifications: manifest.externalQualifications,
    artifacts,
  }));
  return capability;
}

export function completeFrozenProductionArtifactBaseV1(
  base: FrozenProductionArtifactBaseV1,
  approval: SignedReleaseAcceptanceApprovalV1,
): PreparedProductionReleasePackageCapabilityV1 {
  const state = readFrozenProductionArtifactBaseStateV1(base);
  if (state.artifacts.length !== 25
    || state.baseRoot !== frozenBaseRoot(
      state.repositoryRoot,
      state.controllerBoundaryEvidenceRoot,
      state.stagingArtifactSetRoot,
      state.stagingManifestRoot,
      state.performanceDatabaseSha256,
      state.acceptanceSigningRequestRoot,
      state.runtimeSignerPin,
      state.externalQualifications,
      state.artifacts,
    )) {
    throw new TypeError("frozen production artifact base identity mismatch");
  }
  const artifacts = [...state.artifacts.map(artifact => Object.freeze({ name: artifact.name, bytes: new Uint8Array(artifact.bytes) })), Object.freeze({
    name: "release-acceptance-approval.json",
    bytes: encodeSignedReleaseAcceptanceApprovalV1(approval),
  })].sort((left, right) => left.name.localeCompare(right.name));
  if (artifacts.length !== 26) throw new TypeError("completed production artifact denominator mismatch");
  const prepared = prepareProductionReleasePackageV1({
    repositoryRoot: state.repositoryRoot,
    controllerBoundaryEvidenceRoot: state.controllerBoundaryEvidenceRoot,
    runtimeSignerPin: state.runtimeSignerPin,
    externalQualifications: state.externalQualifications,
    artifacts,
  });
  preparedPackageArtifactBaseRoots.set(prepared, state.baseRoot);
  return prepared;
}

export interface ProductionReleasePackageArtifactBytesV1 {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface PrepareProductionReleasePackageInputV1 {
  readonly repositoryRoot: string;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly artifacts: readonly ProductionReleasePackageArtifactBytesV1[];
}

export interface ProductionReleasePackageSigningRequestV1 {
  readonly packageRoot: Hash;
  readonly signerKeyId: Hash;
  readonly payload: RuntimeReleasePackageApprovalPayloadV1;
  readonly signingBytes: Uint8Array;
}

export type PreparedProductionReleasePackageCapabilityV1 = object;

interface PreparedProductionReleasePackageStateV1 {
  readonly manifest: ReleasePackageManifestV1;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
  readonly files: readonly ProductionReleasePackageArtifactBytesV1[];
  readonly signingRequest: ProductionReleasePackageSigningRequestV1;
}

const preparedPackages = new WeakMap<object, PreparedProductionReleasePackageStateV1>();
const preparedPackageArtifactBaseRoots = new WeakMap<object, Hash>();

function exactArtifactBytes(
  values: readonly ProductionReleasePackageArtifactBytesV1[],
): readonly ProductionReleasePackageArtifactBytesV1[] {
  const expectedNames = Object.keys(PACKAGE_INSTALL_PATHS_V1).sort();
  if (values.length !== expectedNames.length) throw new TypeError("production release artifact denominator mismatch");
  return Object.freeze(values.map((value, index) => {
    if (value.name !== expectedNames[index]) throw new TypeError("production release artifacts must be exact, sorted, and unique");
    if (!(value.bytes instanceof Uint8Array)) throw new TypeError(`production release artifact bytes invalid: ${value.name}`);
    return Object.freeze({ name: value.name, bytes: new Uint8Array(value.bytes) });
  }));
}

/** Consume externally signed release acceptance and assemble the exact
 * package plus external package-approval signing bytes. */
export function prepareProductionReleasePackageV1(
  input: PrepareProductionReleasePackageInputV1,
): PreparedProductionReleasePackageCapabilityV1 {
  const git = observeExactPushedGitV1(input.repositoryRoot);
  const runtimeSignerPin = decodeRuntimeReleaseSignerPinV1(input.runtimeSignerPin);
  const files = exactArtifactBytes(input.artifacts);
  const byName = new Map(files.map(file => [file.name, file.bytes] as const));
  const load = (name: string): Uint8Array => {
    const bytes = byName.get(name);
    if (bytes === undefined) throw new TypeError(`production release artifact missing: ${name}`);
    return bytes;
  };
  const runtimeBinding = verifyRuntimeReleaseBindingSignatureV1(
    decodeRuntimeReleaseBindingV1(load("runtime-release-binding.json")),
    runtimeSignerPin,
  );
  const certificateValues = decodeCanonicalJson(load("acceptance-certificates.json"));
  if (!Array.isArray(certificateValues)) throw new TypeError("acceptance certificate artifact must be an array");
  const acceptance = verifyReleaseAcceptanceEvidenceV1({
    runtimeBinding,
    externalQualifications: input.externalQualifications,
    acceptanceCertificates: certificateValues.map(value => decodeAcceptanceCertificateV1(value as object)),
    releaseAcceptanceSet: decodeReleaseAcceptanceSetV1(load("release-acceptance-set.json")),
    releaseAcceptanceApproval: decodeSignedReleaseAcceptanceApprovalV1(load("release-acceptance-approval.json")),
  });
  const packagedReleaseApproval = decodeSignedReleaseAuthorityApprovalV3(load("release-authority-approval.json"));
  if (!Buffer.from(encodeSignedReleaseAuthorityApprovalV3(packagedReleaseApproval)).equals(
    Buffer.from(encodeSignedReleaseAuthorityApprovalV3(acceptance.releaseAuthorityApproval)),
  )) throw new TypeError("packaged release authority approval does not equal the externally verified denominator");
  const deployment = decodeDeploymentManifestV1(decodeCanonicalJson(load("searcher-deployment.json")));
  const profile = decodeProductionPerformanceProfile(load("performance-profile.json"));
  const hardware = decodeHardwareProfileObservationV1(load("hardware-profile.json"));
  const basis = decodeDeploymentPerformanceWindowBasisV1(load("performance-window-basis.json"));
  const artifacts = Object.freeze(files.map(file => Object.freeze({
    name: file.name,
    installPath: PACKAGE_INSTALL_PATHS_V1[file.name]!,
    sha256: sha256Hex(file.bytes),
    byteLength: String(file.bytes.byteLength),
  })));
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-package" as const,
    git,
    bindingId: runtimeBinding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(runtimeBinding),
    runtimeSignerPinSha256: sha256Hex(encodeCanonicalBytes(runtimeSignerPin)),
    releaseAcceptanceApprovalId: acceptance.releaseAcceptanceApproval.approvalId,
    releaseAcceptanceApprovalPayloadHash: acceptance.releaseAcceptanceApproval.payloadHash,
    releaseAcceptanceRequirementSetRoot: acceptance.releaseAcceptanceSet.releaseAcceptanceRequirementSetRoot,
    releaseAcceptanceSetRoot: acceptance.releaseAcceptanceSet.root,
    controllerBoundaryEvidenceRoot: hashSchema.decode(input.controllerBoundaryEvidenceRoot),
    deploymentManifestHash: deployment.manifestHash,
    performance: Object.freeze({
      profileArtifactSha256: sha256Hex(load("performance-profile.json")),
      profileHash: profile.profileHash,
      basisArtifactSha256: sha256Hex(load("performance-window-basis.json")),
      basisId: basis.basisId,
      providerRoot: basis.providerRoot,
      hardwareProfileRoot: hardware.profileRoot,
      hardwareProfileArtifactSha256: sha256Hex(load("hardware-profile.json")),
      eligibilityRuleHash: basis.eligibilityRuleHash,
      commitContextBindingId: basis.commitContextBindingId,
      commitAppendRecordId: basis.commitAppendRecordId,
    }),
    artifacts,
    dryRun: true as const,
  });
  const packageRoot = hashDomain("aloha/runtime-release-package/v1", payload);
  const manifest = decodeReleasePackageManifestV1({ ...payload, packageRoot });
  verifyReleaseArtifactSemanticsV1(manifest, runtimeSignerPin, load);
  const approvalPayload = releasePackageApprovalPayload(manifest);
  const signingRequest = Object.freeze({
    packageRoot: manifest.packageRoot,
    signerKeyId: runtimeSignerPin.signerKeyId,
    payload: approvalPayload,
    signingBytes: runtimeReleasePackageApprovalSigningBytes(approvalPayload, runtimeSignerPin.signerKeyId),
  });
  const capability = Object.freeze(Object.create(null));
  preparedPackages.set(capability, Object.freeze({ manifest, runtimeSignerPin, files, signingRequest }));
  return capability;
}

function readPreparedProductionReleasePackageStateV1(
  capability: PreparedProductionReleasePackageCapabilityV1,
): PreparedProductionReleasePackageStateV1 {
  if (capability === null || typeof capability !== "object") throw new TypeError("prepared production release package capability is invalid");
  const state = preparedPackages.get(capability);
  if (state === undefined) throw new TypeError("prepared production release package capability was not release-owner-issued");
  return state;
}

export function readProductionReleasePackageSigningRequestV1(
  capability: PreparedProductionReleasePackageCapabilityV1,
): ProductionReleasePackageSigningRequestV1 {
  const request = readPreparedProductionReleasePackageStateV1(capability).signingRequest;
  return Object.freeze({ ...request, signingBytes: new Uint8Array(request.signingBytes) });
}

const PREPARED_RELEASE_PACKAGE_METADATA_NAME_V1 = "prepared-release-package.json";
const PACKAGE_APPROVAL_SIGNING_REQUEST_NAME_V1 = "runtime-release-package-approval-signing-request.json";

export interface PreparedProductionReleasePackagePublicationV1 {
  readonly packageRoot: Hash;
  readonly directory: string;
  readonly releaseManifestPath: string;
  readonly releaseManifestSha256: Hash;
  readonly signingRequestPath: string;
  readonly signingRequestRoot: Hash;
  readonly signingRequestSha256: Hash;
  readonly artifactCount: "26";
}

function packageApprovalSigningRequestWire(
  request: ProductionReleasePackageSigningRequestV1,
): Readonly<{
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-release-package-approval-signing-request";
  readonly packageRoot: Hash;
  readonly signerKeyId: Hash;
  readonly approvalPayload: RuntimeReleasePackageApprovalPayloadV1;
  readonly signingBytesHex: string;
  readonly requestRoot: Hash;
}> {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-package-approval-signing-request" as const,
    packageRoot: request.packageRoot,
    signerKeyId: request.signerKeyId,
    approvalPayload: request.payload,
    signingBytesHex: `0x${Buffer.from(request.signingBytes).toString("hex")}`,
  });
  return Object.freeze({
    ...payload,
    requestRoot: hashDomain("aloha/runtime-release-package-approval-signing-request/v1", payload),
  });
}

function preparedReleasePackageMetadata(
  state: PreparedProductionReleasePackageStateV1,
  artifactBaseRoot: Hash,
  releaseManifestBytes: Uint8Array,
  signingRequestBytes: Uint8Array,
  signingRequestRoot: Hash,
): Readonly<{
  readonly schemaVersion: 1;
  readonly kind: "aloha.prepared-production-release-package";
  readonly packageRoot: Hash;
  readonly artifactBaseRoot: Hash;
  readonly artifactCount: "26";
  readonly releaseManifestSha256: Hash;
  readonly signingRequestRoot: Hash;
  readonly signingRequestSha256: Hash;
  readonly runtimeSignerPin: RuntimeReleaseSignerPinV1;
}> {
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.prepared-production-release-package",
    packageRoot: state.manifest.packageRoot,
    artifactBaseRoot,
    artifactCount: "26",
    releaseManifestSha256: sha256Hex(releaseManifestBytes),
    signingRequestRoot,
    signingRequestSha256: sha256Hex(signingRequestBytes),
    runtimeSignerPin: state.runtimeSignerPin,
  });
}

function stablePreparedPackageFile(path: string): Uint8Array {
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new TypeError("prepared release package contains a non-canonical file");
  }
  const before = statSync(path, { bigint: true });
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength) || (after.mode & 0o022n) !== 0n) {
    throw new TypeError("prepared release package file changed during read");
  }
  return bytes;
}

/** Persist the exact B=26 denominator and its external package-approval
 * signing request. This is not an approved or installable package yet. */
export function materializePreparedProductionReleasePackageV1(
  capability: PreparedProductionReleasePackageCapabilityV1,
  preparedRepositoryRootValue: string,
): PreparedProductionReleasePackagePublicationV1 {
  if (arguments.length !== 2) throw new TypeError("prepared release package publication accepts capability and repository");
  const state = readPreparedProductionReleasePackageStateV1(capability);
  const artifactBaseRoot = preparedPackageArtifactBaseRoots.get(capability);
  if (artifactBaseRoot === undefined) {
    throw new TypeError("prepared release package was not derived from a frozen production artifact base");
  }
  const requestedRoot = resolve(preparedRepositoryRootValue);
  const preparedRepositoryRoot = realpathSync(requestedRoot);
  if (preparedRepositoryRoot !== requestedRoot || !lstatSync(preparedRepositoryRoot).isDirectory()) {
    throw new TypeError("prepared release package repository must be a canonical directory");
  }
  const finalDirectory = join(preparedRepositoryRoot, state.manifest.packageRoot.slice(2));
  if (existsSync(finalDirectory)) throw new TypeError("prepared release package already exists");
  const stageDirectory = join(preparedRepositoryRoot, `.stage-${state.manifest.packageRoot.slice(2)}-${process.pid}`);
  if (existsSync(stageDirectory)) throw new TypeError("prepared release package staging directory already exists");
  mkdirSync(stageDirectory, { mode: 0o700 });
  let published = false;
  try {
    for (const file of state.files) {
      const path = join(stageDirectory, file.name);
      writeFileSync(path, file.bytes, { flag: "wx", mode: 0o444 });
      fsyncPath(path);
    }
    const releaseManifestBytes = encodeCanonicalBytes(state.manifest);
    const releaseManifestPath = join(stageDirectory, "release-package.json");
    writeFileSync(releaseManifestPath, releaseManifestBytes, { flag: "wx", mode: 0o444 });
    fsyncPath(releaseManifestPath);
    const signingRequest = packageApprovalSigningRequestWire(state.signingRequest);
    const signingRequestBytes = encodeCanonicalBytes(signingRequest);
    const signingRequestPath = join(stageDirectory, PACKAGE_APPROVAL_SIGNING_REQUEST_NAME_V1);
    writeFileSync(signingRequestPath, signingRequestBytes, { flag: "wx", mode: 0o444 });
    fsyncPath(signingRequestPath);
    const metadataBytes = encodeCanonicalBytes(preparedReleasePackageMetadata(
      state,
      artifactBaseRoot,
      releaseManifestBytes,
      signingRequestBytes,
      signingRequest.requestRoot,
    ));
    const metadataPath = join(stageDirectory, PREPARED_RELEASE_PACKAGE_METADATA_NAME_V1);
    writeFileSync(metadataPath, metadataBytes, { flag: "wx", mode: 0o444 });
    fsyncPath(metadataPath);
    fsyncPath(stageDirectory);
    renameSync(stageDirectory, finalDirectory);
    published = true;
    fsyncPath(preparedRepositoryRoot);
    const reopened = reopenPreparedProductionReleasePackageV1(finalDirectory, preparedRepositoryRoot);
    if (readPreparedProductionReleasePackageStateV1(reopened).manifest.packageRoot !== state.manifest.packageRoot) {
      throw new TypeError("published prepared release package did not reopen exactly");
    }
    return Object.freeze({
      packageRoot: state.manifest.packageRoot,
      directory: finalDirectory,
      releaseManifestPath: join(finalDirectory, "release-package.json"),
      releaseManifestSha256: sha256Hex(releaseManifestBytes),
      signingRequestPath: join(finalDirectory, PACKAGE_APPROVAL_SIGNING_REQUEST_NAME_V1),
      signingRequestRoot: signingRequest.requestRoot,
      signingRequestSha256: sha256Hex(signingRequestBytes),
      artifactCount: "26",
    });
  } catch (error) {
    if (existsSync(stageDirectory)) rmSync(stageDirectory, { recursive: true, force: true });
    if (published && existsSync(finalDirectory)) rmSync(finalDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Reissue the prepared-package capability only from one exact direct child of
 * its fixed workflow repository. */
export function reopenPreparedProductionReleasePackageV1(
  directoryValue: string,
  preparedRepositoryRootValue: string,
): PreparedProductionReleasePackageCapabilityV1 {
  if (arguments.length !== 2) throw new TypeError("prepared release package reopen accepts directory and repository");
  const root = realpathSync(resolve(preparedRepositoryRootValue));
  const directory = realpathSync(resolve(directoryValue));
  if (root !== resolve(preparedRepositoryRootValue) || !lstatSync(root).isDirectory()
    || directory !== resolve(directoryValue) || dirname(directory) !== root || !lstatSync(directory).isDirectory()) {
    throw new TypeError("prepared release package is not a direct canonical repository member");
  }
  const metadataBytes = stablePreparedPackageFile(join(directory, PREPARED_RELEASE_PACKAGE_METADATA_NAME_V1));
  const metadataValue = decodeCanonicalJson(metadataBytes);
  if (metadataValue === null || typeof metadataValue !== "object" || Array.isArray(metadataValue)) {
    throw new TypeError("prepared release package metadata is invalid");
  }
  const metadata = metadataValue as Readonly<Record<string, unknown>>;
  const metadataKeys = Object.keys(metadata).sort();
  const expectedMetadataKeys = [
    "artifactBaseRoot", "artifactCount", "kind", "packageRoot", "releaseManifestSha256", "runtimeSignerPin",
    "schemaVersion", "signingRequestRoot", "signingRequestSha256",
  ];
  if (metadataKeys.length !== expectedMetadataKeys.length
    || metadataKeys.some((key, index) => key !== expectedMetadataKeys[index])
    || metadata.schemaVersion !== 1
    || metadata.kind !== "aloha.prepared-production-release-package"
    || metadata.artifactCount !== "26") {
    throw new TypeError("prepared release package metadata denominator mismatch");
  }
  const packageRoot = hashSchema.decode(metadata.packageRoot);
  const artifactBaseRoot = hashSchema.decode(metadata.artifactBaseRoot);
  if (directory !== join(root, packageRoot.slice(2))) {
    throw new TypeError("prepared release package directory is not content addressed");
  }
  const releaseManifestBytes = stablePreparedPackageFile(join(directory, "release-package.json"));
  const manifest = decodeReleasePackageManifestV1(decodeCanonicalJson(releaseManifestBytes));
  const runtimeSignerPin = decodeRuntimeReleaseSignerPinV1(metadata.runtimeSignerPin as object);
  if (manifest.packageRoot !== packageRoot
    || sha256Hex(releaseManifestBytes) !== hashSchema.decode(metadata.releaseManifestSha256)
    || !Buffer.from(releaseManifestBytes).equals(Buffer.from(encodeCanonicalBytes(manifest)))) {
    throw new TypeError("prepared release package manifest mismatch");
  }
  const expectedArtifactNames = Object.keys(PACKAGE_INSTALL_PATHS_V1).sort();
  if (manifest.artifacts.length !== 26
    || manifest.artifacts.some((artifact, index) => artifact.name !== expectedArtifactNames[index])) {
    throw new TypeError("prepared release package artifact denominator mismatch");
  }
  const files = Object.freeze(manifest.artifacts.map(artifact => {
    const bytes = stablePreparedPackageFile(join(directory, artifact.name));
    if (sha256Hex(bytes) !== artifact.sha256 || String(bytes.byteLength) !== artifact.byteLength
      || artifact.installPath !== PACKAGE_INSTALL_PATHS_V1[artifact.name]) {
      throw new TypeError(`prepared release package artifact mismatch: ${artifact.name}`);
    }
    return Object.freeze({ name: artifact.name, bytes });
  }));
  const expectedNames = [
    ...expectedArtifactNames,
    "release-package.json",
    PREPARED_RELEASE_PACKAGE_METADATA_NAME_V1,
    PACKAGE_APPROVAL_SIGNING_REQUEST_NAME_V1,
  ].sort();
  const observedNames = readdirSync(directory).sort();
  if (observedNames.length !== expectedNames.length
    || observedNames.some((name, index) => name !== expectedNames[index])) {
    throw new TypeError("prepared release package directory denominator mismatch");
  }
  const byName = new Map(files.map(file => [file.name, file.bytes] as const));
  verifyReleaseArtifactSemanticsV1(manifest, runtimeSignerPin, name => {
    const bytes = byName.get(name);
    if (bytes === undefined) throw new TypeError(`prepared release package artifact missing: ${name}`);
    return bytes;
  });
  const approvalPayload = releasePackageApprovalPayload(manifest);
  const signingRequest: ProductionReleasePackageSigningRequestV1 = Object.freeze({
    packageRoot: manifest.packageRoot,
    signerKeyId: runtimeSignerPin.signerKeyId,
    payload: approvalPayload,
    signingBytes: runtimeReleasePackageApprovalSigningBytes(approvalPayload, runtimeSignerPin.signerKeyId),
  });
  const expectedSigningRequest = packageApprovalSigningRequestWire(signingRequest);
  const signingRequestBytes = stablePreparedPackageFile(join(directory, PACKAGE_APPROVAL_SIGNING_REQUEST_NAME_V1));
  if (sha256Hex(signingRequestBytes) !== hashSchema.decode(metadata.signingRequestSha256)
    || expectedSigningRequest.requestRoot !== hashSchema.decode(metadata.signingRequestRoot)
    || !Buffer.from(signingRequestBytes).equals(Buffer.from(encodeCanonicalBytes(expectedSigningRequest)))) {
    throw new TypeError("prepared release package signing request mismatch");
  }
  const expectedMetadata = preparedReleasePackageMetadata(
    Object.freeze({ manifest, runtimeSignerPin, files, signingRequest }),
    artifactBaseRoot,
    releaseManifestBytes,
    signingRequestBytes,
    expectedSigningRequest.requestRoot,
  );
  if (!Buffer.from(metadataBytes).equals(Buffer.from(encodeCanonicalBytes(expectedMetadata)))) {
    throw new TypeError("prepared release package metadata is not canonical exact bytes");
  }
  const artifactBase = reopenFrozenProductionArtifactBaseV1(join(
    PRE_RELEASE_STAGING_LAYOUT_V1.productionArtifactBaseRepositoryPath,
    artifactBaseRoot.slice(2),
  ));
  const acceptanceApprovalBytes = byName.get("release-acceptance-approval.json");
  if (acceptanceApprovalBytes === undefined) {
    throw new TypeError("prepared release package lacks its signed acceptance approval");
  }
  const rederived = completeFrozenProductionArtifactBaseV1(
    artifactBase,
    decodeSignedReleaseAcceptanceApprovalV1(acceptanceApprovalBytes),
  );
  const rederivedState = readPreparedProductionReleasePackageStateV1(rederived);
  const sameFiles = rederivedState.files.length === files.length
    && rederivedState.files.every((file, index) => file.name === files[index]!.name
      && Buffer.from(file.bytes).equals(Buffer.from(files[index]!.bytes)));
  if (rederivedState.manifest.packageRoot !== manifest.packageRoot
    || !Buffer.from(encodeCanonicalBytes(rederivedState.manifest)).equals(Buffer.from(releaseManifestBytes))
    || !Buffer.from(encodeCanonicalBytes(rederivedState.runtimeSignerPin)).equals(Buffer.from(encodeCanonicalBytes(runtimeSignerPin)))
    || !Buffer.from(encodeCanonicalBytes(packageApprovalSigningRequestWire(rederivedState.signingRequest))).equals(Buffer.from(signingRequestBytes))
    || !sameFiles) {
    throw new TypeError("prepared release package is not the exact A plus externally signed acceptance approval");
  }
  return rederived;
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Atomically publish one externally approved content-addressed package. It
 * does not install production paths or start a service. */
export function materializeApprovedProductionReleasePackageV1(
  capability: PreparedProductionReleasePackageCapabilityV1,
  approvalValue: RuntimeReleasePackageApprovalV1,
  packageRepositoryRootValue: string,
): string {
  const state = readPreparedProductionReleasePackageStateV1(capability);
  const approval = verifyPackageApprovalSignature(approvalValue, state.runtimeSignerPin);
  assertPackageApprovalJoin(state.manifest, approval);
  const requestedRoot = resolve(packageRepositoryRootValue);
  const packageRepositoryRoot = realpathSync(requestedRoot);
  if (packageRepositoryRoot !== requestedRoot || !lstatSync(packageRepositoryRoot).isDirectory()) {
    throw new TypeError("release package repository must be a canonical directory");
  }
  const finalDirectory = join(packageRepositoryRoot, state.manifest.packageRoot.slice(2));
  if (existsSync(finalDirectory)) throw new TypeError("release package already exists");
  const stageDirectory = join(packageRepositoryRoot, `.stage-${state.manifest.packageRoot.slice(2)}-${process.pid}`);
  if (existsSync(stageDirectory)) throw new TypeError("release package staging directory already exists");
  mkdirSync(stageDirectory, { mode: 0o700 });
  let published = false;
  try {
    for (const file of state.files) {
      const path = join(stageDirectory, file.name);
      writeFileSync(path, file.bytes, { flag: "wx", mode: 0o444 });
      fsyncPath(path);
    }
    const manifestPath = join(stageDirectory, "release-package.json");
    writeFileSync(manifestPath, encodeCanonicalBytes(state.manifest), { flag: "wx", mode: 0o444 });
    fsyncPath(manifestPath);
    const approvalPath = join(stageDirectory, "runtime-release-package-approval.json");
    writeFileSync(approvalPath, encodeRuntimeReleasePackageApprovalV1(approval), { flag: "wx", mode: 0o444 });
    fsyncPath(approvalPath);
    fsyncPath(stageDirectory);
    const expectedNames = [...state.files.map(file => file.name), "release-package.json", "runtime-release-package-approval.json"].sort();
    const observedNames = readdirSync(stageDirectory).sort();
    if (observedNames.length !== expectedNames.length
      || observedNames.some((name, index) => name !== expectedNames[index])) {
      throw new TypeError("staged release package file set mismatch");
    }
    for (const artifact of state.manifest.artifacts) {
      const path = join(stageDirectory, artifact.name);
      const bytes = new Uint8Array(readFileSync(path));
      if (realpathSync(path) !== path || !lstatSync(path).isFile()
        || sha256Hex(bytes) !== artifact.sha256 || String(bytes.byteLength) !== artifact.byteLength) {
        throw new TypeError(`staged release package artifact mismatch: ${artifact.name}`);
      }
    }
    verifyReleaseArtifactSemanticsV1(
      state.manifest,
      state.runtimeSignerPin,
      name => new Uint8Array(readFileSync(join(stageDirectory, name))),
    );
    renameSync(stageDirectory, finalDirectory);
    published = true;
    fsyncPath(packageRepositoryRoot);
    verifyReleasePackageDirectoryV1(finalDirectory, state.runtimeSignerPin, approval);
    return finalDirectory;
  } catch (error) {
    if (existsSync(stageDirectory)) rmSync(stageDirectory, { recursive: true, force: true });
    if (published && existsSync(finalDirectory)) rmSync(finalDirectory, { recursive: true, force: true });
    throw error;
  }
}
