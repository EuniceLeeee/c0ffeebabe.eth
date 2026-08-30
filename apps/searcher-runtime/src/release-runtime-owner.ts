import { createPublicKey, verify as verifySignature } from "node:crypto";
import { dirname, join } from "node:path";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  nonEmptyStringSchema,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../../packages/attestation/src/internal/composition.ts";
import type {
  AttestationCompositionBindingV1,
  InstanceDecisionV1,
  InstanceLifecycleSingleFlightPort,
  RejectionTransportExecutorV1,
} from "../../../packages/attestation/src/index.ts";
import type { StartupRuntimeV1 } from "../../../packages/startup-runtime/src/index.ts";
import { createSqliteDurableStore } from "../../../packages/durable-store/src/index.ts";
import {
  decodeReleaseQualifiedCapabilitySetV1,
} from "../../../specs/capability-index/src/index.ts";
import {
  decodeRuntimeReleasePackageApprovalV1,
  decodeNominationQualificationDeploymentFactV1,
  decodeRuntimeReleaseQualifiedCapabilityProjectionV1,
  decodeRuntimeReleaseBindingV1,
  decodeRuntimeReleaseSignerPinV1,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleasePackageApprovalSigningBytes,
  nominationQualificationDeploymentFactSigningBytes,
  type NominationQualificationDeploymentFactV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  openVerifiedRuntimeReleaseOwnerPortV1,
  verifyExternalRuntimeReleaseBindingV1,
  type VerifiedRuntimeReleaseOwnerPortV1,
} from "../../../packages/runtime-release-authority/src/production-runtime-owner.ts";
import {
  encodeEconomicSafetyObjectiveTemplatesV1,
} from "../../../packages/economics-safety/src/index.ts";
import {
  createRethSearcherRuntimeSourceV1,
} from "./internal/reth-source.ts";
import {
  issueSearcherRuntimeApplicationOwnerV1,
} from "./internal/application-owner.ts";
import {
  assertInstalledProductionRuntimeEnvironmentV1,
} from "./internal/production-runtime-environment.ts";
import {
  issueSearcherProductionEvidenceOwnerV1,
} from "./production-evidence.ts";
import {
  closeProductionRuntimeAcceptanceEvidenceV1,
  installProductionRuntimeSigtermEvidenceV1,
  issueProductionRuntimeAcceptanceEvidenceOwnerV1,
  recordProductionRuntimeProcessReadyV1,
  type ProductionRuntimeAcceptanceEvidenceOwnerV1,
} from "./native-runtime-lifecycle-evidence.ts";
import {
  assertDeploymentRuntimeBundleV1,
  assertDeploymentBundleIdentityV1,
  assertRuntimeAnchorsV1,
  decodeDeploymentManifestV1,
  loadVerifiedDeploymentCompositionSnapshotV1,
  runtimeAnchorReceiptV1,
  systemRuntimeAnchorObserverV1,
  type DeploymentManifestV1,
  type DeploymentRuntimeBundleV1,
  type DryRunServiceHandleV1,
  type RuntimeAnchorObservationV1,
  type RuntimeAnchorReceiptV1,
} from "./deployment.ts";
import { startReleaseSearcherStartup } from "./index.ts";
import type { SearcherRuntimeApplicationV1 } from "./internal/application-owner.ts";
import {
  assertDeploymentSourceJoinsReleaseV1,
  decodeDeploymentSourceConfigBytesV1,
  type DeploymentSourceConfigV1,
} from "./deployment-source.ts";
import {
  assertDeploymentRuntimeArtifactsJoinReleaseV1,
  decodeDeploymentExecutorStateDescriptorBytesV1,
  decodeDeploymentRuntimePolicyBytesV1,
} from "./deployment-runtime-policy.ts";

const BINDING_PATH = "/etc/aloha/runtime-release-binding.json";
const DEPLOYMENT_MANIFEST_PATH = "/etc/aloha/searcher-deployment.json";
const DEPLOYMENT_BUNDLE_PATH = "/etc/aloha/deployment-bundle.mjs";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PACKAGE_DOMAIN = "aloha/runtime-release-package/v1";
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
export const SIX_STEP_EVIDENCE_DIRECTORY_NAME = "six-step-evidence";
const runtimeAcceptanceOwners = new WeakMap<object, ProductionRuntimeAcceptanceEvidenceOwnerV1>();

const PACKAGE_ARTIFACT_PATHS = Object.freeze({
  "acceptance-certificates.json": "/etc/aloha/acceptance-certificates.json",
  "aloha-proof-signer": "/opt/aloha/bin/aloha-proof-signer",
  "aloha-revm-worker": "/opt/aloha/bin/aloha-revm-worker",
  "aloha-searcher.service": "/etc/systemd/system/aloha-searcher.service",
  "catalog-generation.inputs.json": "/etc/aloha/runtime-facts/catalog-generation.inputs.json",
  "candidate-proof-verifier-binding.json": "/etc/aloha/candidate-proof-verifier-binding.json",
  "deployment-bundle.mjs": DEPLOYMENT_BUNDLE_PATH,
  "deployment-composition.mjs": "/etc/aloha/deployment-composition.mjs",
  "deployment-source.json": "/etc/aloha/deployment-source.json",
  "executor-state.json": "/etc/aloha/executor-state.json",
  "family-catalog.ts": "/etc/aloha/runtime-facts/family-catalog.ts",
  "hardware-profile.json": "/etc/aloha/hardware-profile.json",
  "nomination-qualification-deployment-fact.json": "/etc/aloha/nomination-qualification-deployment-fact.json",
  "performance-profile.json": "/etc/aloha/performance-profile.json",
  "performance-window-basis.json": "/etc/aloha/performance-window-basis.json",
  "production-launcher.mjs": "/etc/aloha/production-launcher.mjs",
  "release-acceptance-approval.json": "/etc/aloha/release-acceptance-approval.json",
  "release-acceptance-set.json": "/etc/aloha/release-acceptance-set.json",
  "release-authority-approval.json": "/etc/aloha/release-authority-approval.json",
  "release-intent.json": "/etc/aloha/release-intent.json",
  "runtime-policy.json": "/etc/aloha/runtime-policy.json",
  "runtime-composition.ts": "/etc/aloha/runtime-facts/runtime-composition.ts",
  "runtime-release-binding.json": BINDING_PATH,
  "searcher-deployment.json": DEPLOYMENT_MANIFEST_PATH,
  "searcher-release.env": "/etc/aloha/searcher-release.env",
  "strategy-catalog.ts": "/etc/aloha/runtime-facts/strategy-catalog.ts",
});

const PRE_RELEASE_ENTRYPOINT_PATH = "/var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs";
const PRE_RELEASE_ARTIFACT_PATHS = Object.freeze({
  "aloha-searcher-pre-release.service": "/run/systemd/system/aloha-searcher-pre-release.service",
  "candidate-proof-verifier-binding.json": "/var/lib/aloha/pre-release/artifacts/candidate-proof-verifier-binding.json",
  "catalog-generation.inputs.json": "/var/lib/aloha/pre-release/artifacts/runtime-facts/catalog-generation.inputs.json",
  "deployment-bundle.mjs": "/var/lib/aloha/pre-release/artifacts/deployment-bundle.mjs",
  "deployment-composition.mjs": "/var/lib/aloha/pre-release/artifacts/deployment-composition.mjs",
  "deployment-source.json": "/var/lib/aloha/pre-release/artifacts/deployment-source.json",
  "executor-state.json": "/var/lib/aloha/pre-release/artifacts/executor-state.json",
  "family-catalog.ts": "/var/lib/aloha/pre-release/artifacts/runtime-facts/family-catalog.ts",
  "nomination-qualification-deployment-fact.json": "/var/lib/aloha/pre-release/artifacts/nomination-qualification-deployment-fact.json",
  "performance-profile.json": "/var/lib/aloha/pre-release/artifacts/performance-profile.json",
  "qualified-release-runner-input.json": "/var/lib/aloha/pre-release/artifacts/qualified-release-runner-input.json",
  "release-authority-approval.json": "/var/lib/aloha/pre-release/artifacts/release-authority-approval.json",
  "release-intent.json": "/var/lib/aloha/pre-release/artifacts/release-intent.json",
  "runtime-policy.json": "/var/lib/aloha/pre-release/artifacts/runtime-policy.json",
  "runtime-boundary-projection.json": "/var/lib/aloha/pre-release/artifacts/runtime-boundary-projection.json",
  "runtime-composition.ts": "/var/lib/aloha/pre-release/artifacts/runtime-facts/runtime-composition.ts",
  "runtime-release-binding.json": "/var/lib/aloha/pre-release/artifacts/runtime-release-binding.json",
  "runtime-release-signer-pin.json": "/var/lib/aloha/pre-release/artifacts/runtime-release-signer-pin.json",
  "searcher-pre-release.env": "/var/lib/aloha/pre-release/artifacts/searcher-pre-release.env",
  "staging-manifest.json": "/var/lib/aloha/pre-release/artifacts/staging-manifest.json",
  "strategy-catalog.ts": "/var/lib/aloha/pre-release/artifacts/runtime-facts/strategy-catalog.ts",
  "pre-release-owner.mjs": PRE_RELEASE_ENTRYPOINT_PATH,
  "production-launcher.mjs": "/var/lib/aloha/pre-release/artifacts/production-launcher.mjs",
});

interface ProductionSnapshotFileV1 {
  readonly bytes: Uint8Array;
  readonly sha256: Hash;
  readonly byteLength: string;
  readonly fence: Readonly<{
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  }>;
}

interface InstalledProductionStartupStateV1 {
  readonly phase: "installed-production";
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly manifestBytes: Uint8Array;
  readonly pinBytes: Uint8Array;
  readonly approvalBytes: Uint8Array;
  readonly artifacts: Readonly<Record<string, ProductionSnapshotFileV1>>;
  /** Read-only provenance verified from external signed package bytes. */
  readonly nominationQualificationDeploymentFact: NominationQualificationDeploymentFactV1;
}

interface PreReleaseStartupStateV1 {
  readonly phase: "pre-release";
  readonly authorization: Readonly<Record<string, unknown>>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly artifacts: Readonly<Record<string, ProductionSnapshotFileV1>>;
}

type ReleaseRuntimeStartupStateV1 = InstalledProductionStartupStateV1 | PreReleaseStartupStateV1;

export interface ProductionStartupCapabilityV1 {
  readonly __opaqueProductionStartupCapabilityV1: never;
}

const productionStartupStates = new WeakMap<object, ReleaseRuntimeStartupStateV1>();
const consumedProductionStartupCapabilities = new WeakSet<object>();

function exactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some(key => typeof key !== "string") || actual.length !== expected.length
    || expected.some(key => !actual.includes(key))) {
    throw new TypeError(`${label} has non-exact fields`);
  }
}

function canonicalDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal`);
  }
  return value;
}

function copySnapshotFile(value: unknown, label: string): ProductionSnapshotFileV1 {
  exactKeys(value, ["bytes", "sha256", "byteLength", "fence"], label);
  if (!(value.bytes instanceof Uint8Array)) throw new TypeError(`${label}.bytes must be Uint8Array`);
  const bytes = new Uint8Array(value.bytes);
  const digest = hashSchema.decode(value.sha256, `${label}.sha256`);
  const byteLength = canonicalDecimal(value.byteLength, `${label}.byteLength`);
  exactKeys(value.fence, ["dev", "ino", "size", "mtimeNs", "ctimeNs"], `${label}.fence`);
  const fence = Object.freeze({
    dev: canonicalDecimal(value.fence.dev, `${label}.fence.dev`),
    ino: canonicalDecimal(value.fence.ino, `${label}.fence.ino`),
    size: canonicalDecimal(value.fence.size, `${label}.fence.size`),
    mtimeNs: canonicalDecimal(value.fence.mtimeNs, `${label}.fence.mtimeNs`),
    ctimeNs: canonicalDecimal(value.fence.ctimeNs, `${label}.fence.ctimeNs`),
  });
  if (digest !== sha256Hex(bytes) || byteLength !== String(bytes.byteLength)) {
    throw new TypeError(`${label} bytes do not match their snapshot identity`);
  }
  return Object.freeze({ bytes, sha256: digest, byteLength, fence });
}

function copySnapshotMap(
  value: unknown,
  paths: Readonly<Record<string, string>>,
  label: string,
): Readonly<Record<string, ProductionSnapshotFileV1>> {
  exactKeys(value, Object.keys(paths), label);
  return Object.freeze(Object.fromEntries(Object.keys(paths).map(name => [
    name,
    copySnapshotFile(value[name], `${label}.${name}`),
  ])));
}

function canonicalObjectFromSnapshot(value: unknown, bytes: Uint8Array, label: string): Readonly<Record<string, unknown>> {
  const decoded = decodeCanonicalJson(bytes);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError(`${label} must be an object`);
  }
  exactKeys(value, Object.keys(decoded), `${label} snapshot`);
  if (!Buffer.from(encodeCanonicalBytes(value)).equals(Buffer.from(bytes))) {
    throw new TypeError(`${label} snapshot value does not equal its exact bytes`);
  }
  return decoded as Readonly<Record<string, unknown>>;
}

export function decodeReleasePackageManifestForRuntimeOwnerV1(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  const value = decodeCanonicalJson(bytes);
  exactKeys(value, [
    "schemaVersion", "kind", "packageRoot", "git", "bindingId", "releaseProvenanceHash",
    "runtimeSignerPinSha256", "releaseAcceptanceApprovalId", "releaseAcceptanceApprovalPayloadHash",
    "releaseAcceptanceRequirementSetRoot", "releaseAcceptanceSetRoot", "controllerBoundaryEvidenceRoot",
    "deploymentManifestHash",
    "performance", "artifacts", "dryRun",
  ], "release package manifest");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.runtime-release-package" || value.dryRun !== true) {
    throw new TypeError("release package manifest role is invalid");
  }
  hashSchema.decode(value.packageRoot, "release package manifest.packageRoot");
  hashSchema.decode(value.bindingId, "release package manifest.bindingId");
  hashSchema.decode(value.releaseProvenanceHash, "release package manifest.releaseProvenanceHash");
  hashSchema.decode(value.runtimeSignerPinSha256, "release package manifest.runtimeSignerPinSha256");
  hashSchema.decode(value.releaseAcceptanceApprovalId, "release package manifest.releaseAcceptanceApprovalId");
  hashSchema.decode(value.releaseAcceptanceApprovalPayloadHash, "release package manifest.releaseAcceptanceApprovalPayloadHash");
  hashSchema.decode(value.releaseAcceptanceRequirementSetRoot, "release package manifest.releaseAcceptanceRequirementSetRoot");
  hashSchema.decode(value.releaseAcceptanceSetRoot, "release package manifest.releaseAcceptanceSetRoot");
  if (hashSchema.decode(
    value.controllerBoundaryEvidenceRoot,
    "release package manifest.controllerBoundaryEvidenceRoot",
  ) === ZERO_HASH) {
    throw new TypeError("release package manifest.controllerBoundaryEvidenceRoot must be non-zero");
  }
  hashSchema.decode(value.deploymentManifestHash, "release package manifest.deploymentManifestHash");
  exactKeys(value.git, ["branch", "upstreamRef", "commit"], "release package manifest.git");
  nonEmptyStringSchema.decode(value.git.branch, "release package manifest.git.branch");
  nonEmptyStringSchema.decode(value.git.upstreamRef, "release package manifest.git.upstreamRef");
  gitSha40Schema.decode(value.git.commit, "release package manifest.git.commit");
  exactKeys(value.performance, [
    "profileArtifactSha256", "profileHash", "basisArtifactSha256", "basisId", "providerRoot",
    "hardwareProfileRoot", "hardwareProfileArtifactSha256", "eligibilityRuleHash",
    "commitContextBindingId", "commitAppendRecordId",
  ], "release package manifest.performance");
  for (const field of Object.keys(value.performance)) {
    hashSchema.decode(value.performance[field], `release package manifest.performance.${field}`);
  }
  if (!Array.isArray(value.artifacts)) throw new TypeError("release package manifest.artifacts must be an array");
  const expectedNames = Object.keys(PACKAGE_ARTIFACT_PATHS).sort();
  if (value.artifacts.length !== expectedNames.length) throw new TypeError("release package artifact denominator mismatch");
  for (let index = 0; index < expectedNames.length; index += 1) {
    const artifact = value.artifacts[index];
    exactKeys(artifact, ["name", "installPath", "sha256", "byteLength"], `release package artifact ${index}`);
    const expectedName = expectedNames[index]!;
    if (artifact.name !== expectedName
      || artifact.installPath !== (PACKAGE_ARTIFACT_PATHS as Readonly<Record<string, string>>)[expectedName]) {
      throw new TypeError("release package artifact role mismatch");
    }
    hashSchema.decode(artifact.sha256, `release package artifact ${expectedName}.sha256`);
    canonicalDecimal(artifact.byteLength, `release package artifact ${expectedName}.byteLength`);
  }
  const { packageRoot: _ignored, ...payload } = value;
  if (value.packageRoot !== hashDomain(PACKAGE_DOMAIN, payload)) {
    throw new TypeError("release package manifest identity mismatch");
  }
  return value;
}

export function assertRuntimeReleasePackageApprovalJoinV1(
  manifest: Readonly<Record<string, unknown>>,
  approval: Readonly<Record<string, unknown>>,
): void {
  const joins: Readonly<Record<string, unknown>> = {
    packageRoot: manifest.packageRoot,
    bindingId: manifest.bindingId,
    releaseProvenanceHash: manifest.releaseProvenanceHash,
    releaseAcceptanceApprovalId: manifest.releaseAcceptanceApprovalId,
    releaseAcceptanceApprovalPayloadHash: manifest.releaseAcceptanceApprovalPayloadHash,
    releaseAcceptanceRequirementSetRoot: manifest.releaseAcceptanceRequirementSetRoot,
    releaseAcceptanceSetRoot: manifest.releaseAcceptanceSetRoot,
    controllerBoundaryEvidenceRoot: manifest.controllerBoundaryEvidenceRoot,
    candidateReleaseCommit: (manifest.git as Record<string, unknown>).commit,
    performanceBasisId: (manifest.performance as Record<string, unknown>).basisId,
    performanceProfileHash: (manifest.performance as Record<string, unknown>).profileHash,
    hardwareProfileRoot: (manifest.performance as Record<string, unknown>).hardwareProfileRoot,
    providerRoot: (manifest.performance as Record<string, unknown>).providerRoot,
  };
  for (const [field, expected] of Object.entries(joins)) {
    if (approval[field] !== expected) {
      throw new TypeError(`runtime release package approval mismatch: ${field}`);
    }
  }
}

function verifyPackageApproval(
  manifest: Readonly<Record<string, unknown>>,
  pinBytes: Uint8Array,
  approvalBytes: Uint8Array,
): void {
  const pin = decodeRuntimeReleaseSignerPinV1(decodeCanonicalJson(pinBytes) as object);
  const approval = decodeRuntimeReleasePackageApprovalV1(decodeCanonicalJson(approvalBytes) as object);
  if (sha256Hex(pinBytes) !== manifest.runtimeSignerPinSha256 || approval.signerKeyId !== pin.signerKeyId) {
    throw new TypeError("runtime release package signer pin mismatch");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(
    null,
    Buffer.from(runtimeReleasePackageApprovalSigningBytes(approval)),
    publicKey,
    Buffer.from(approval.signatureHex.slice(2), "hex"),
  )) throw new TypeError("runtime release package approval signature invalid");
  assertRuntimeReleasePackageApprovalJoinV1(
    manifest,
    approval as unknown as Readonly<Record<string, unknown>>,
  );
}

function verifyInstalledNominationQualificationDeploymentFact(
  bytes: Uint8Array,
  pinBytes: Uint8Array,
  bindingBytes: Uint8Array,
): NominationQualificationDeploymentFactV1 {
  const fact = decodeNominationQualificationDeploymentFactV1(bytes);
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(fact)))) {
    throw new TypeError("nomination qualification deployment fact is not canonical exact bytes");
  }
  const pin = decodeRuntimeReleaseSignerPinV1(decodeCanonicalJson(pinBytes) as object);
  if (fact.signerKeyId !== pin.signerKeyId) {
    throw new TypeError("nomination qualification deployment fact signer pin mismatch");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(
    null,
    Buffer.from(nominationQualificationDeploymentFactSigningBytes(fact)),
    publicKey,
    Buffer.from(fact.signatureHex.slice(2), "hex"),
  )) throw new TypeError("nomination qualification deployment fact signature invalid");
  const binding = decodeRuntimeReleaseBindingV1(bindingBytes);
  if (fact.runtimeBindingId !== binding.bindingId
    || fact.runtimeBindingPayloadHash !== binding.payloadHash
    || fact.candidateReleaseCommit !== binding.candidateReleaseCommit
    || fact.catalogProposedCapabilitySetRoot !== binding.qualifiedCapabilityRefsRoot
    || fact.nominationProgramSetRoot !== binding.nominationProgramSetRoot
    || fact.nominationQualificationSetRoot !== binding.nominationQualificationSetRoot) {
    throw new TypeError("nomination qualification deployment fact does not exact-join installed runtime binding");
  }
  return fact;
}

/**
 * Convert the builtins-only preverification snapshot into a process-local,
 * non-cloneable capability.  Raw package facts never authorize startup.
 */
export function issueProductionStartupCapabilityV1(input: unknown): ProductionStartupCapabilityV1 {
  exactKeys(input, ["manifest", "manifestBytes", "pin", "pinBytes", "approval", "approvalBytes", "artifacts"], "production startup snapshot");
  if (!(input.manifestBytes instanceof Uint8Array) || !(input.pinBytes instanceof Uint8Array)
    || !(input.approvalBytes instanceof Uint8Array)) {
    throw new TypeError("production startup snapshot raw bytes are required");
  }
  const manifestBytes = new Uint8Array(input.manifestBytes);
  const pinBytes = new Uint8Array(input.pinBytes);
  const approvalBytes = new Uint8Array(input.approvalBytes);
  const manifest = decodeReleasePackageManifestForRuntimeOwnerV1(manifestBytes);
  canonicalObjectFromSnapshot(input.manifest, manifestBytes, "release package manifest");
  canonicalObjectFromSnapshot(input.pin, pinBytes, "runtime release signer pin");
  canonicalObjectFromSnapshot(input.approval, approvalBytes, "runtime release package approval");
  const artifacts = copySnapshotMap(input.artifacts, PACKAGE_ARTIFACT_PATHS, "release artifacts");
  const manifestArtifacts = manifest.artifacts as readonly Record<string, unknown>[];
  for (const artifact of manifestArtifacts) {
    const snapshot = artifacts[artifact.name as string];
    if (snapshot === undefined || snapshot.sha256 !== artifact.sha256 || snapshot.byteLength !== artifact.byteLength) {
      throw new TypeError(`release artifact does not join package manifest: ${String(artifact.name)}`);
    }
  }
  verifyPackageApproval(manifest, pinBytes, approvalBytes);
  const deploymentManifest = decodeDeploymentManifestV1(artifacts["searcher-deployment.json"]!.bytes);
  const nominationQualificationDeploymentFact = verifyInstalledNominationQualificationDeploymentFact(
    artifacts["nomination-qualification-deployment-fact.json"]!.bytes,
    pinBytes,
    artifacts["runtime-release-binding.json"]!.bytes,
  );
  if (deploymentManifest.manifestHash !== manifest.deploymentManifestHash
    || deploymentManifest.searcherRuntimeBundleModulePath !== DEPLOYMENT_BUNDLE_PATH
    || artifacts["deployment-bundle.mjs"]!.sha256 !== deploymentManifest.searcherRuntimeBundleModuleSha256) {
    throw new TypeError("deployment manifest does not join the package-owned production entry");
  }
  const state: InstalledProductionStartupStateV1 = Object.freeze({
    phase: "installed-production",
    manifest,
    manifestBytes,
    pinBytes,
    approvalBytes,
    artifacts,
    nominationQualificationDeploymentFact,
  });
  const capability = Object.freeze(Object.create(null)) as ProductionStartupCapabilityV1;
  productionStartupStates.set(capability as object, state);
  return capability;
}

/** Issue the same private runtime brand for the independently preverified
 * pre-release phase. The runtime rechecks fixed process identity, exact
 * staged bytes, and the signed release binding without importing packager or
 * acceptance authority. */
export function issuePreReleaseRuntimeStartupCapabilityV1(input: unknown): ProductionStartupCapabilityV1 {
  if (process.env.SEARCHER_DRY_RUN !== "1" || process.argv[1] !== PRE_RELEASE_ENTRYPOINT_PATH) {
    throw new TypeError("pre-release runtime phase identity mismatch");
  }
  exactKeys(input, ["snapshots", "authorizationSnapshot"], "pre-release runtime snapshot");
  const artifacts = copySnapshotMap(input.snapshots, PRE_RELEASE_ARTIFACT_PATHS, "pre-release runtime artifacts");
  const authorizationFile = copySnapshotFile(input.authorizationSnapshot, "pre-release authorization");
  const authorizationValue = decodeCanonicalJson(authorizationFile.bytes);
  if (authorizationValue === null || typeof authorizationValue !== "object" || Array.isArray(authorizationValue)) {
    throw new TypeError("pre-release authorization must be a canonical object");
  }
  const authorization = authorizationValue as Readonly<Record<string, unknown>>;
  const manifestValue = decodeCanonicalJson(artifacts["staging-manifest.json"]!.bytes);
  if (manifestValue === null || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
    throw new TypeError("pre-release staging manifest must be a canonical object");
  }
  const manifest = manifestValue as Readonly<Record<string, unknown>>;
  if (authorization.kind !== "aloha.pre-release-launch-authorization"
    || authorization.phase !== "pre-release" || authorization.dryRun !== true
    || manifest.kind !== "aloha.pre-release-staging-manifest"
    || manifest.phase !== "pre-release" || manifest.dryRun !== true) {
    throw new TypeError("pre-release runtime signed phase role mismatch");
  }
  const binding = decodeRuntimeReleaseBindingV1(artifacts["runtime-release-binding.json"]!.bytes);
  const pin = decodeRuntimeReleaseSignerPinV1(
    decodeCanonicalJson(artifacts["runtime-release-signer-pin.json"]!.bytes) as object,
  );
  verifyExternalRuntimeReleaseBindingV1(binding, pin);
  const provenance = runtimeReleaseBindingProvenanceHash(binding);
  if (authorization.candidateReleaseCommit !== binding.candidateReleaseCommit
    || authorization.runtimeBindingId !== binding.bindingId
    || authorization.releaseProvenanceHash !== provenance
    || manifest.candidateReleaseCommit !== binding.candidateReleaseCommit
    || manifest.runtimeBindingId !== binding.bindingId
    || manifest.releaseProvenanceHash !== provenance
    || manifest.bundlePath !== PRE_RELEASE_ARTIFACT_PATHS["deployment-bundle.mjs"]
    || manifest.deploymentBundleSha256 !== artifacts["deployment-bundle.mjs"]!.sha256
    || manifest.deploymentCompositionPath !== PRE_RELEASE_ARTIFACT_PATHS["deployment-composition.mjs"]
    || manifest.deploymentCompositionSha256 !== artifacts["deployment-composition.mjs"]!.sha256
    || manifest.deploymentSourcePath !== PRE_RELEASE_ARTIFACT_PATHS["deployment-source.json"]
    || manifest.deploymentSourceSha256 !== artifacts["deployment-source.json"]!.sha256
    || manifest.runtimePolicyPath !== PRE_RELEASE_ARTIFACT_PATHS["runtime-policy.json"]
    || manifest.runtimePolicySha256 !== artifacts["runtime-policy.json"]!.sha256
    || manifest.executorStatePath !== PRE_RELEASE_ARTIFACT_PATHS["executor-state.json"]
    || manifest.executorStateSha256 !== artifacts["executor-state.json"]!.sha256
    || manifest.performanceProfilePath !== PRE_RELEASE_ARTIFACT_PATHS["performance-profile.json"]
    || manifest.performanceProfileSha256 !== artifacts["performance-profile.json"]!.sha256
    || manifest.runtimeBindingPath !== PRE_RELEASE_ARTIFACT_PATHS["runtime-release-binding.json"]
    || manifest.runtimeBindingSha256 !== artifacts["runtime-release-binding.json"]!.sha256
    || manifest.nominationQualificationDeploymentFactPath !== PRE_RELEASE_ARTIFACT_PATHS["nomination-qualification-deployment-fact.json"]
    || manifest.nominationQualificationDeploymentFactSha256 !== artifacts["nomination-qualification-deployment-fact.json"]!.sha256
    || manifest.runtimeSignerPinPath !== PRE_RELEASE_ARTIFACT_PATHS["runtime-release-signer-pin.json"]
    || manifest.runtimeSignerPinSha256 !== artifacts["runtime-release-signer-pin.json"]!.sha256) {
    throw new TypeError("pre-release runtime artifacts do not exact-join the signed phase");
  }
  verifyInstalledNominationQualificationDeploymentFact(
    artifacts["nomination-qualification-deployment-fact.json"]!.bytes,
    artifacts["runtime-release-signer-pin.json"]!.bytes,
    artifacts["runtime-release-binding.json"]!.bytes,
  );
  const now = BigInt(Date.now()) * 1_000_000n;
  if (typeof authorization.issuedAtUnixNs !== "string" || typeof authorization.expiresAtUnixNs !== "string"
    || now < BigInt(authorization.issuedAtUnixNs) || now >= BigInt(authorization.expiresAtUnixNs)) {
    throw new TypeError("pre-release runtime authorization is not currently valid");
  }
  const source = assertDeploymentSourceJoinsReleaseV1(
    decodeDeploymentSourceConfigBytesV1(artifacts["deployment-source.json"]!.bytes),
    binding,
  );
  const runtimePolicy = decodeDeploymentRuntimePolicyBytesV1(artifacts["runtime-policy.json"]!.bytes);
  const executorState = decodeDeploymentExecutorStateDescriptorBytesV1(artifacts["executor-state.json"]!.bytes);
  assertDeploymentRuntimeArtifactsJoinReleaseV1(runtimePolicy, executorState, binding);
  if (runtimePolicy.economicSafety.profitAsset.identity.chainId !== source.chainId) {
    throw new TypeError("deployment economic profit asset does not join the qualified source chain");
  }
  const state: PreReleaseStartupStateV1 = Object.freeze({
    phase: "pre-release",
    authorization,
    manifest,
    artifacts,
  });
  const capability = Object.freeze(Object.create(null)) as ProductionStartupCapabilityV1;
  productionStartupStates.set(capability as object, state);
  return capability;
}

function consumeProductionStartupCapability(capability: ProductionStartupCapabilityV1): ReleaseRuntimeStartupStateV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("production startup capability is required");
  }
  const state = productionStartupStates.get(capability as object);
  if (state === undefined || consumedProductionStartupCapabilities.has(capability as object)) {
    throw new TypeError("production startup capability was not issued or was already consumed");
  }
  consumedProductionStartupCapabilities.add(capability as object);
  return state;
}

class SingleFlightInstanceLifecycleV1 implements InstanceLifecycleSingleFlightPort {
  readonly #pending = new Map<Hash, Promise<InstanceDecisionV1>>();

  getOrBuild(key: Hash, build: () => Promise<InstanceDecisionV1>): Promise<InstanceDecisionV1> {
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;
    const pending = Promise.resolve().then(build).finally(() => {
      if (this.#pending.get(key) === pending) this.#pending.delete(key);
    });
    this.#pending.set(key, pending);
    return pending;
  }
}

function qualifiedCapabilityProjection(
  binding: ReturnType<typeof decodeRuntimeReleaseBindingV1>,
  bytes: Uint8Array,
): unknown {
  const decoded = decodeCanonicalJson(bytes);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("generated catalog input is invalid");
  }
  const set = decodeReleaseQualifiedCapabilitySetV1(
    (decoded as { readonly proposedCapabilitySet?: unknown }).proposedCapabilitySet,
  );
  return decodeRuntimeReleaseQualifiedCapabilityProjectionV1({
    schemaVersion: 1,
    kind: "aloha.runtime-release-qualified-capability-projection",
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    qualifiedCapabilityRefsRoot: set.root,
    refs: set.refs,
  });
}

interface VerifiedRuntimeCoreInputV1 {
  readonly binding: ReturnType<typeof decodeRuntimeReleaseBindingV1>;
  readonly owner: VerifiedRuntimeReleaseOwnerPortV1;
  readonly source: DeploymentSourceConfigV1;
  readonly artifacts: Readonly<Record<string, ProductionSnapshotFileV1>>;
  readonly deploymentCompositionSha256: Hash;
  readonly runtimeAnchor: RuntimeAnchorReceiptV1;
  /** Owner-derived from the independently observed physical process anchor. */
  readonly processEpoch: Hash;
  readonly performance:
    | Readonly<{ readonly phase: "installed-production" }>
    | Readonly<{ readonly phase: "pre-release"; readonly profileBytes: Uint8Array }>;
}

/** One runtime composition core for installed production and pre-release.
 * Phase owners must already have verified signatures, paths, storage
 * projection, anchors, and the composition digest before entering here. */
async function buildVerifiedRuntimeCoreV1(input: VerifiedRuntimeCoreInputV1) {
  const { binding, owner, source, artifacts } = input;
  const runtimePolicy = decodeDeploymentRuntimePolicyBytesV1(artifacts["runtime-policy.json"]!.bytes);
  const executorState = decodeDeploymentExecutorStateDescriptorBytesV1(artifacts["executor-state.json"]!.bytes);
  assertDeploymentRuntimeArtifactsJoinReleaseV1(runtimePolicy, executorState, binding);
  if (runtimePolicy.economicSafety.profitAsset.identity.chainId !== source.chainId) {
    throw new TypeError("deployment economic profit asset does not join the qualified source chain");
  }
  const objectiveRef = hashDomain("aloha/search-objective/v1", runtimePolicy.objective);
  const economicSafetyObjectiveTemplatesBytes = encodeEconomicSafetyObjectiveTemplatesV1([{
    objectiveRef,
    profitAsset: runtimePolicy.economicSafety.profitAsset,
    profitAccount: runtimePolicy.economicSafety.profitAccount,
    minNetGain: runtimePolicy.objective.minNetGain,
    maxGas: runtimePolicy.objective.maxGas,
    maxValueAtRisk: runtimePolicy.objective.maxValueAtRisk,
    priorityFeePerGas: runtimePolicy.economicSafety.priorityFeePerGas,
    bidCostNative: runtimePolicy.economicSafety.bidCostNative,
    valuationOwnerRef: runtimePolicy.economicSafety.valuationOwnerRef,
  }]);
  const infrastructureRequest = await loadVerifiedDeploymentCompositionSnapshotV1(
    input.deploymentCompositionSha256,
    artifacts["deployment-composition.mjs"]!.bytes,
  );
  const infrastructure = owner.bindInfrastructure({
    request: infrastructureRequest,
    endpoint: source.endpoint,
    timeoutMs: source.timeoutMs,
  });
  const runtimeSource = createRethSearcherRuntimeSourceV1({
    canonical: {
      profile: source.profile,
      endpoint: source.endpoint,
      chainId: source.chainId,
      journalPath: source.canonicalJournalPath,
      timeoutMs: source.timeoutMs,
      headPollIntervalMs: source.headPollIntervalMs,
    },
    ingress: {
      profile: source.profile,
      endpoint: source.endpoint,
      pending: runtimePolicy.pending,
      timeoutMs: source.timeoutMs,
      blockscan: {
        objective: {
          objectiveRef,
          payload: runtimePolicy.objective,
        },
        callerId: runtimePolicy.callerId,
        deadlineMs: runtimePolicy.deadlineMs,
        admission: runtimePolicy.admission,
      },
    },
  });
  const durable = createSqliteDurableStore(source.checkpointDatabasePath);
  const lifecycle = new SingleFlightInstanceLifecycleV1();
  const rejectionExecutor: RejectionTransportExecutorV1 = Object.freeze({
    async execute(): Promise<never> {
      throw new TypeError("attestation rejection transport is unavailable");
    },
  });
  const services = owner.compose({
    infrastructure,
    catalog: { qualifiedCapabilityProjection: qualifiedCapabilityProjection(binding, artifacts["catalog-generation.inputs.json"]!.bytes) },
    attestation: {
      build(composition: AttestationCompositionBindingV1) {
        const frameworkRuntime = createFrameworkFailureRuntime(composition, { classify() { return null; } });
        const rejectionIssuer = createRejectionExecutorAuthorityIssuer(composition);
        return {
          frameworkRuntime,
          rejectionRuntime: createRejectionFactRuntime(rejectionIssuer.issue(rejectionExecutor)),
          instanceLifecycle: lifecycle,
        };
      },
    },
    checkpoint: { durable, canonical: runtimeSource.canonical },
    ready: {
      policy: {
        observationWindowBlocks: "50",
        targetRefreshAgeBlocks: "20",
        maxServingAgeBlocks: "50",
        minPromotionMarginBlocks: "2",
        maxInProgressRuns: "1",
      },
      monotonicNow: () => process.hrtime.bigint().toString(),
    },
    qualifiedDiscoverySource: {
      profile: source.profile,
      endpoint: source.endpoint,
      chainId: source.chainId,
      providerIdentity: source.providerIdentity,
      backendEpoch: source.backendEpoch,
    },
    performance: input.performance,
    finalSimulation: {
      endpoint: source.endpoint,
      timeoutMs: source.timeoutMs,
      executorAddress: executorState.executorAddress,
      callerAddress: executorState.callerAddress,
      qualifiedExecutorCodeHash: executorState.qualifiedExecutorCodeHash,
      executorConfig: executorState.executorConfig,
      accounts: executorState.accounts,
    },
    economicSafetyObjectiveTemplatesBytes,
    sixStep: {
      process: {
        systemId: `${input.runtimeAnchor.serviceName}/${input.runtimeAnchor.systemdUnit}`,
        commitSha: input.runtimeAnchor.candidateReleaseCommit,
        executableHash: input.runtimeAnchor.entrypointSha256,
        deploymentManifestHash: input.runtimeAnchor.manifestHash,
        serviceIdentityHash: hashDomain("aloha/production-six-step-service-identity/v1", {
          bindingId: input.runtimeAnchor.bindingId,
          serviceName: input.runtimeAnchor.serviceName,
          systemdUnit: input.runtimeAnchor.systemdUnit,
          invocationId: input.runtimeAnchor.invocationId,
        }),
        pid: input.runtimeAnchor.pid,
        processStartTicks: input.runtimeAnchor.processStartTicks,
        bootIdHash: hashDomain("aloha/searcher-runtime-boot-id/v1", input.runtimeAnchor.bootId),
      },
      emitterCodeHash: input.runtimeAnchor.implementationClosureDigest,
      observerContentDirectory: source.observerContentDirectory,
      evidenceDirectory: join(dirname(source.observerContentDirectory), SIX_STEP_EVIDENCE_DIRECTORY_NAME),
    },
    startup: { processEpoch: input.processEpoch },
  });
  return Object.freeze({
    services,
    runtimeSource,
    runtimePolicy,
  });
}

/**
 * Exact production bundle entry referenced by the package-owned deployment
 * module. It accepts only already-observed host facts; every executable port
 * is created here or recovered from the package-approved opaque composition.
 */
async function loadInstalledProductionDeploymentBundleV1(input: Readonly<{
  readonly capability: ProductionStartupCapabilityV1;
  readonly manifest: DeploymentManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly anchors: RuntimeAnchorObservationV1;
}>): Promise<DeploymentRuntimeBundleV1> {
  const state = productionStartupStates.get(input.capability as object);
  if (state === undefined || !consumedProductionStartupCapabilities.has(input.capability as object)) {
    throw new TypeError("production startup capability was not issued for this process");
  }
  if (state.phase !== "installed-production") {
    throw new TypeError("installed production loader received a pre-release capability");
  }
  const manifest = decodeDeploymentManifestV1(input.manifest);
  if (sha256Hex(input.manifestBytes) !== sha256Hex(encodeCanonicalBytes(manifest))) {
    throw new TypeError("installed deployment manifest bytes are not canonical exact bytes");
  }
  const binding = decodeRuntimeReleaseBindingV1(state.artifacts["runtime-release-binding.json"]!.bytes);
  const signerPin = decodeRuntimeReleaseSignerPinV1(decodeCanonicalJson(state.pinBytes) as object);
  const owner = openVerifiedRuntimeReleaseOwnerPortV1(binding, signerPin);
  const provenance = runtimeReleaseBindingProvenanceHash(binding);
  if (manifest.bindingId !== binding.bindingId
    || manifest.releaseProvenanceHash !== provenance
    || manifest.candidateReleaseCommit !== binding.candidateReleaseCommit) {
    throw new TypeError("installed deployment manifest does not join the signed release");
  }

  const runtimeAnchor = runtimeAnchorReceiptV1(manifest, input.anchors, input.manifestBytes);
  const source = assertDeploymentSourceJoinsReleaseV1(
    decodeDeploymentSourceConfigBytesV1(state.artifacts["deployment-source.json"]!.bytes),
    binding,
  );
  const core = await buildVerifiedRuntimeCoreV1({
    binding,
    owner,
    source,
    artifacts: state.artifacts,
    deploymentCompositionSha256: manifest.deploymentCompositionModuleSha256,
    runtimeAnchor,
    processEpoch: hashDomain("aloha/searcher-runtime-process-epoch/v1", {
      bindingId: runtimeAnchor.bindingId,
      releaseProvenanceHash: runtimeAnchor.releaseProvenanceHash,
      bootId: runtimeAnchor.bootId,
      invocationId: runtimeAnchor.invocationId,
      pid: runtimeAnchor.pid,
      processStartTicks: runtimeAnchor.processStartTicks,
    }),
    performance: Object.freeze({ phase: "installed-production" as const }),
  });
  const {
    services,
    runtimeSource,
    runtimePolicy,
  } = core;
  const evidence = issueSearcherProductionEvidenceOwnerV1({
    databasePath: source.productionEvidenceDatabasePath,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    runtimeAnchor,
    economicSafety: services.economicSafety,
    strategyRuntime: services.strategyRuntime,
  });
  const runtimeAcceptance = issueProductionRuntimeAcceptanceEvidenceOwnerV1({
    databasePath: source.productionEvidenceDatabasePath,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    runtimeAnchor,
    checkpoint: services.checkpoint,
    strategy: services.strategyRuntime.readMetadata(),
    phaseManifest: Object.freeze({ kind: "production", bytes: input.manifestBytes }),
    releaseIntentBytes: state.artifacts["release-intent.json"]!.bytes,
    systemdUnitBytes: state.artifacts["aloha-searcher.service"]!.bytes,
    releaseEnvironmentBytes: state.artifacts["searcher-release.env"]!.bytes,
    logPath: manifest.logPath,
  });
  const terminalObservations = owner.bindTerminalObservations({
    observerStore: services.observerStore,
    observerContentDirectory: source.observerContentDirectory,
    terminalLocatorDirectory: source.terminalLocatorDirectory,
    releaseIntentCanonicalBytes: state.artifacts["release-intent.json"]!.bytes,
    familyCatalogSourceBytes: state.artifacts["family-catalog.ts"]!.bytes,
    runtimeCompositionSourceBytes: state.artifacts["runtime-composition.ts"]!.bytes,
    strategyCatalogSourceBytes: state.artifacts["strategy-catalog.ts"]!.bytes,
    candidateProofVerifierBindingBytes: state.artifacts["candidate-proof-verifier-binding.json"]!.bytes,
  });
  const application = issueSearcherRuntimeApplicationOwnerV1({
    strategyRuntime: services.strategyRuntime,
    performanceRuntime: services.performance,
    fullGraphCoarseSweep: services.fullGraphCoarseSweep,
    fullFamilyTerminalBinding: services.fullFamilyTerminalBinding,
    sixStepTerminalBinding: services.sixStepTerminalBinding,
    ...terminalObservations,
    economicSafety: services.economicSafety,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    source: runtimeSource,
    coreInput: {
      amountSeed: runtimePolicy.amountSeed,
      execution: Object.freeze({
        transactionOrigin: runtimePolicy.callerId,
        executorAddress: runtimePolicy.amountSeed.recipient,
      }),
    },
    finalSimulationFactory: services.finalSimulationFactory,
    evidence,
  });
  const bundle = Object.freeze({
    startupOwner: services.startup,
    application,
    release: Object.freeze({ binding, manifestHash: manifest.manifestHash }),
  });
  assertDeploymentBundleIdentityV1(manifest, bundle.startupOwner, bundle.release);
  runtimeAcceptanceOwners.set(bundle, runtimeAcceptance);
  return bundle;
}

/**
 * Start an installed bundle only after the package-owned bootstrap has
 * verified every persisted byte and joined it to the process-local owners.
 * This join is deliberately private to the installed production entrypoint:
 * no shared registrar or caller-supplied start capability exists.
 */
async function startInstalledVerifiedDeploymentRuntimeBundleV1(input: Readonly<{
  readonly manifest: DeploymentManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly manifestPath: string;
  readonly anchors: RuntimeAnchorObservationV1;
  readonly bundle: DeploymentRuntimeBundleV1;
  readonly signal?: AbortSignal;
}>): Promise<DryRunServiceHandleV1> {
  const manifest = decodeDeploymentManifestV1(input.manifest);
  const manifestBytes = new Uint8Array(input.manifestBytes);
  const anchors = input.anchors;
  const bundle = input.bundle;
  assertDeploymentRuntimeBundleV1(bundle);
  assertDeploymentBundleIdentityV1(manifest, bundle.startupOwner, bundle.release);
  assertRuntimeAnchorsV1(manifest, anchors, input.manifestPath, manifestBytes);

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();

  let startup: StartupRuntimeV1;
  try {
    startup = await startReleaseSearcherStartup(bundle.startupOwner, controller.signal);
  } catch (error) {
    input.signal?.removeEventListener("abort", abort);
    throw error;
  }

  let application: SearcherRuntimeApplicationV1;
  try {
    application = bundle.application.open(startup);
  } catch (error) {
    await startup.close();
    input.signal?.removeEventListener("abort", abort);
    throw error;
  }

  const applicationRun = application.run(controller.signal);
  const done = applicationRun.finally(async () => {
    await application.stop();
    input.signal?.removeEventListener("abort", abort);
  });
  return Object.freeze({
    anchors,
    startup,
    application,
    done,
    async stop() {
      controller.abort();
      await done;
    },
  });
}

async function attachNativeRuntimeLifecycleEvidenceV1(
  service: DryRunServiceHandleV1,
  owner: ProductionRuntimeAcceptanceEvidenceOwnerV1,
): Promise<DryRunServiceHandleV1> {
  try {
    await recordProductionRuntimeProcessReadyV1(owner, service.startup);
  } catch (error) {
    await service.stop();
    closeProductionRuntimeAcceptanceEvidenceV1(owner);
    throw error;
  }
  const sigterm = installProductionRuntimeSigtermEvidenceV1({ owner, stop: () => service.stop() });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    sigterm.uninstall();
    closeProductionRuntimeAcceptanceEvidenceV1(owner);
  };
  const joinSignal = async (): Promise<void> => {
    const task = sigterm.task();
    if (task !== null) await task;
  };
  const done = service.done.then(async () => {
    await joinSignal();
    close();
  }, async error => {
    try {
      await joinSignal();
    } finally {
      close();
    }
    throw error;
  });
  return Object.freeze({
    anchors: service.anchors,
    startup: service.startup,
    application: service.application,
    done,
    async stop() {
      await service.stop();
      await joinSignal();
      close();
    },
  });
}

/** Start only from the process-local capability issued after package preverification. */
export async function startInstalledProductionServiceV1(
  capability: ProductionStartupCapabilityV1,
): Promise<DryRunServiceHandleV1> {
  const state = consumeProductionStartupCapability(capability);
  if (state.phase !== "installed-production") {
    throw new TypeError("installed production start requires an installed capability");
  }
  if (process.env.SEARCHER_DRY_RUN !== "1") {
    throw new TypeError("runtime dry-run guard requires SEARCHER_DRY_RUN=1");
  }
  assertInstalledProductionRuntimeEnvironmentV1();
  const manifestBytes = new Uint8Array(state.artifacts["searcher-deployment.json"]!.bytes);
  const manifest = decodeDeploymentManifestV1(manifestBytes);
  const anchors = await systemRuntimeAnchorObserverV1.observe({
    manifestPath: DEPLOYMENT_MANIFEST_PATH,
    manifestBytes,
    logPath: manifest.logPath,
    bundleModulePath: DEPLOYMENT_BUNDLE_PATH,
    systemdUnitPath: manifest.systemdUnitPath,
    releaseEnvironmentPath: manifest.releaseEnvironmentPath,
  });
  assertRuntimeAnchorsV1(manifest, anchors, DEPLOYMENT_MANIFEST_PATH, manifestBytes);
  const bundle = await loadInstalledProductionDeploymentBundleV1({
    capability,
    manifest,
    manifestBytes,
    anchors,
  });
  const service = await startInstalledVerifiedDeploymentRuntimeBundleV1({
    manifest,
    manifestBytes,
    manifestPath: DEPLOYMENT_MANIFEST_PATH,
    anchors,
    bundle,
  });
  const runtimeAcceptance = runtimeAcceptanceOwners.get(bundle);
  if (runtimeAcceptance === undefined) {
    await service.stop();
    throw new TypeError("installed production runtime lifecycle owner is unavailable");
  }
  return attachNativeRuntimeLifecycleEvidenceV1(service, runtimeAcceptance);
}

async function startPreReleaseRuntimeServiceV1(
  capability: ProductionStartupCapabilityV1,
): Promise<DryRunServiceHandleV1> {
  const state = consumeProductionStartupCapability(capability);
  if (state.phase !== "pre-release") {
    throw new TypeError("pre-release start requires a pre-release capability");
  }
  if (process.env.SEARCHER_DRY_RUN !== "1" || process.argv[1] !== PRE_RELEASE_ENTRYPOINT_PATH) {
    throw new TypeError("pre-release runtime start phase identity mismatch");
  }
  const { authorization, manifest, artifacts } = state;
  const requiredFixedPaths = Object.freeze({
    manifestPath: PRE_RELEASE_ARTIFACT_PATHS["staging-manifest.json"],
    canonicalJournalPath: "/var/lib/aloha/pre-release/runtime/canonical-journal.sqlite",
    checkpointDatabasePath: "/var/lib/aloha/pre-release/runtime/checkpoint.sqlite",
    processEvidenceDatabasePath: "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite",
    observerContentDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/content",
    terminalLocatorDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/terminal-locators",
    logPath: "/var/log/aloha/pre-release.log",
    serviceName: "aloha-searcher-pre-release",
    systemdUnit: "aloha-searcher-pre-release.service",
    systemdUnitPath: PRE_RELEASE_ARTIFACT_PATHS["aloha-searcher-pre-release.service"],
    releaseEnvironmentPath: PRE_RELEASE_ARTIFACT_PATHS["searcher-pre-release.env"],
  });
  for (const [field, expected] of Object.entries(requiredFixedPaths)) {
    if (authorization[field] !== expected || manifest[field] !== undefined && manifest[field] !== expected) {
      throw new TypeError(`pre-release runtime fixed ${field} mismatch`);
    }
  }
  const binding = decodeRuntimeReleaseBindingV1(artifacts["runtime-release-binding.json"]!.bytes);
  const signerPin = decodeRuntimeReleaseSignerPinV1(
    decodeCanonicalJson(artifacts["runtime-release-signer-pin.json"]!.bytes) as object,
  );
  const owner = openVerifiedRuntimeReleaseOwnerPortV1(binding, signerPin);
  const sourceSigned = assertDeploymentSourceJoinsReleaseV1(
    decodeDeploymentSourceConfigBytesV1(artifacts["deployment-source.json"]!.bytes),
    binding,
  );
  const source: DeploymentSourceConfigV1 = Object.freeze({
    ...sourceSigned,
    canonicalJournalPath: requiredFixedPaths.canonicalJournalPath,
    checkpointDatabasePath: requiredFixedPaths.checkpointDatabasePath,
    productionEvidenceDatabasePath: requiredFixedPaths.processEvidenceDatabasePath,
    observerContentDirectory: requiredFixedPaths.observerContentDirectory,
    terminalLocatorDirectory: requiredFixedPaths.terminalLocatorDirectory,
  });
  const manifestBytes = artifacts["staging-manifest.json"]!.bytes;
  const anchors = await systemRuntimeAnchorObserverV1.observe({
    manifestPath: requiredFixedPaths.manifestPath,
    manifestBytes,
    logPath: requiredFixedPaths.logPath,
    bundleModulePath: PRE_RELEASE_ARTIFACT_PATHS["deployment-bundle.mjs"],
    systemdUnitPath: requiredFixedPaths.systemdUnitPath,
    releaseEnvironmentPath: requiredFixedPaths.releaseEnvironmentPath,
  });
  const processCommandSha256 = sha256Hex(Buffer.from([
    "/usr/bin/node",
    PRE_RELEASE_ENTRYPOINT_PATH,
    "",
  ].join("\0")));
  if (anchors.candidateReleaseCommit !== binding.candidateReleaseCommit
    || anchors.entrypointSha256 !== artifacts["pre-release-owner.mjs"]!.sha256
    || anchors.nodeExecutableSha256 !== binding.searcherRuntime.nodeExecutableSha256
    || anchors.bundleModulePath !== PRE_RELEASE_ARTIFACT_PATHS["deployment-bundle.mjs"]
    || anchors.bundleModuleSha256 !== artifacts["deployment-bundle.mjs"]!.sha256
    || anchors.processCommandSha256 !== processCommandSha256
    || anchors.manifestArtifactSha256 !== artifacts["staging-manifest.json"]!.sha256
    || anchors.serviceName !== requiredFixedPaths.serviceName
    || anchors.systemdUnit !== requiredFixedPaths.systemdUnit
    || anchors.systemdUnitPath !== requiredFixedPaths.systemdUnitPath
    || anchors.systemdUnitSha256 !== artifacts["aloha-searcher-pre-release.service"]!.sha256
    || anchors.releaseEnvironmentPath !== requiredFixedPaths.releaseEnvironmentPath
    || anchors.releaseEnvironmentSha256 !== artifacts["searcher-pre-release.env"]!.sha256
    || anchors.dryRun !== true) {
    throw new TypeError("pre-release runtime physical anchors do not join the signed phase");
  }
  const runtimeAnchor: RuntimeAnchorReceiptV1 = Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1",
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    manifestHash: hashSchema.decode(authorization.stagingManifestRoot, "pre-release staging manifest root"),
    manifestArtifactSha256: anchors.manifestArtifactSha256,
    runtimeArtifactRoot: binding.searcherRuntime.runtimeArtifactRoot,
    implementationClosureDigest: binding.searcherRuntime.implementationClosureDigest,
    candidateReleaseCommit: anchors.candidateReleaseCommit,
    entrypointSha256: anchors.entrypointSha256,
    nodeExecutableSha256: anchors.nodeExecutableSha256,
    bundleModulePath: anchors.bundleModulePath,
    bundleModuleSha256: anchors.bundleModuleSha256,
    serviceName: anchors.serviceName,
    systemdUnit: anchors.systemdUnit,
    bootId: anchors.bootId,
    invocationId: anchors.invocationId,
    logDevice: anchors.logDevice,
    logInode: anchors.logInode,
    pid: anchors.pid,
    processStartTicks: anchors.processStartTicks,
    dryRun: true,
  });
  const core = await buildVerifiedRuntimeCoreV1({
    binding,
    owner,
    source,
    artifacts,
    deploymentCompositionSha256: hashSchema.decode(
      manifest.deploymentCompositionSha256,
      "pre-release deployment composition sha256",
    ),
    runtimeAnchor,
    processEpoch: hashDomain("aloha/searcher-runtime-process-epoch/v1", {
      bindingId: runtimeAnchor.bindingId,
      releaseProvenanceHash: runtimeAnchor.releaseProvenanceHash,
      bootId: runtimeAnchor.bootId,
      invocationId: runtimeAnchor.invocationId,
      pid: runtimeAnchor.pid,
      processStartTicks: runtimeAnchor.processStartTicks,
    }),
    performance: Object.freeze({
      phase: "pre-release" as const,
      profileBytes: artifacts["performance-profile.json"]!.bytes,
    }),
  });
  const release = Object.freeze({
    bindingId: core.services.release.bindingId,
    releaseProvenanceHash: core.services.release.releaseProvenanceHash,
    candidateReleaseCommit: core.services.release.candidateReleaseCommit,
  });
  const evidence = issueSearcherProductionEvidenceOwnerV1({
    databasePath: source.productionEvidenceDatabasePath,
    release,
    runtimeAnchor,
    economicSafety: core.services.economicSafety,
    strategyRuntime: core.services.strategyRuntime,
  });
  const runtimeAcceptance = issueProductionRuntimeAcceptanceEvidenceOwnerV1({
    databasePath: source.productionEvidenceDatabasePath,
    release,
    runtimeAnchor,
    checkpoint: core.services.checkpoint,
    strategy: core.services.strategyRuntime.readMetadata(),
    phaseManifest: Object.freeze({
      kind: "pre-release",
      bytes: artifacts["staging-manifest.json"]!.bytes,
      semanticRoot: hashSchema.decode(authorization.stagingManifestRoot, "pre-release staging manifest root"),
    }),
    releaseIntentBytes: artifacts["release-intent.json"]!.bytes,
    systemdUnitBytes: artifacts["aloha-searcher-pre-release.service"]!.bytes,
    releaseEnvironmentBytes: artifacts["searcher-pre-release.env"]!.bytes,
    logPath: requiredFixedPaths.logPath,
  });
  const terminalObservations = owner.bindTerminalObservations({
    observerStore: core.services.observerStore,
    observerContentDirectory: source.observerContentDirectory,
    terminalLocatorDirectory: source.terminalLocatorDirectory,
    releaseIntentCanonicalBytes: artifacts["release-intent.json"]!.bytes,
    familyCatalogSourceBytes: artifacts["family-catalog.ts"]!.bytes,
    runtimeCompositionSourceBytes: artifacts["runtime-composition.ts"]!.bytes,
    strategyCatalogSourceBytes: artifacts["strategy-catalog.ts"]!.bytes,
    candidateProofVerifierBindingBytes: artifacts["candidate-proof-verifier-binding.json"]!.bytes,
  });
  const applicationOwner = issueSearcherRuntimeApplicationOwnerV1({
    strategyRuntime: core.services.strategyRuntime,
    performanceRuntime: core.services.performance,
    fullGraphCoarseSweep: core.services.fullGraphCoarseSweep,
    fullFamilyTerminalBinding: core.services.fullFamilyTerminalBinding,
    sixStepTerminalBinding: core.services.sixStepTerminalBinding,
    ...terminalObservations,
    economicSafety: core.services.economicSafety,
    release,
    source: core.runtimeSource,
    coreInput: {
      amountSeed: core.runtimePolicy.amountSeed,
      execution: Object.freeze({
        transactionOrigin: core.runtimePolicy.callerId,
        executorAddress: core.runtimePolicy.amountSeed.recipient,
      }),
    },
    finalSimulationFactory: core.services.finalSimulationFactory,
    evidence,
  });
  const controller = new AbortController();
  const startup = await startReleaseSearcherStartup(core.services.startup, controller.signal);
  let application: SearcherRuntimeApplicationV1;
  try {
    application = applicationOwner.open(startup);
  } catch (error) {
    await startup.close();
    evidence.close();
    throw error;
  }
  const run = application.run(controller.signal);
  const done = run.finally(() => application.stop());
  const service: DryRunServiceHandleV1 = Object.freeze({
    anchors,
    startup,
    application,
    done,
    async stop() {
      controller.abort();
      await done;
    },
  });
  return attachNativeRuntimeLifecycleEvidenceV1(service, runtimeAcceptance);
}

/** Consume either fixed phase through the same private brand registry. */
export function startReleaseRuntimeSessionOwnerV1(
  capability: ProductionStartupCapabilityV1,
): Promise<DryRunServiceHandleV1> {
  const state = capability !== null && typeof capability === "object"
    ? productionStartupStates.get(capability as object)
    : undefined;
  if (state === undefined) throw new TypeError("release runtime startup capability was not issued");
  return state.phase === "installed-production"
    ? startInstalledProductionServiceV1(capability)
    : startPreReleaseRuntimeServiceV1(capability);
}
