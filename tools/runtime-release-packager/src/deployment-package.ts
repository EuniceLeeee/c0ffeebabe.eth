import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  nonEmptyStringSchema,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeAcceptanceCertificateV1,
} from "../../../specs/acceptance-certificate/src/index.ts";
import {
  decodeReleaseAcceptanceSetV1,
  decodeSignedReleaseAcceptanceApprovalV1,
  decodeSignedReleaseAuthorityApprovalV3,
  encodeReleaseAcceptanceSetV1,
  encodeSignedReleaseAcceptanceApprovalV1,
  encodeSignedReleaseAuthorityApprovalV3,
} from "../../../specs/qualification/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  decodeNominationQualificationDeploymentFactV1,
  decodeRuntimeReleasePackageApprovalV1,
  decodeRuntimeReleaseSignerPinV1,
  encodeRuntimeReleaseBindingV1,
  encodeRuntimeReleasePackageApprovalV1,
  nominationQualificationDeploymentFactSigningBytes,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleasePackageApprovalSigningBytes,
  runtimeReleaseDiscoverySourceAuthorityRootV1,
  type RuntimeReleaseBindingV1,
  type NominationQualificationDeploymentFactV1,
  type RuntimeReleasePackageApprovalPayloadV1,
  type RuntimeReleasePackageApprovalV1,
  type RuntimeReleaseSignerPinV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  decodeDeploymentPerformanceWindowBasisV1,
  decodeHardwareProfileObservationV1,
  decodeProductionPerformanceProfile,
  encodeDeploymentPerformanceWindowBasisV1,
  encodeHardwareProfileObservationV1,
  encodeProductionPerformanceProfile,
  PERFORMANCE_ELIGIBILITY_RULE_HASH,
  PERFORMANCE_TARGET_COUNT,
} from "../../../specs/performance/src/index.ts";
import { decodeDeploymentManifestV1 } from "../../../apps/searcher-runtime/src/deployment.ts";
import {
  assertDeploymentSourceJoinsReleaseV1,
  decodeDeploymentSourceConfigBytesV1,
} from "../../../apps/searcher-runtime/src/deployment-source.ts";
import {
  assertDeploymentRuntimeArtifactsJoinReleaseV1,
  decodeDeploymentExecutorStateDescriptorBytesV1,
  decodeDeploymentRuntimePolicyBytesV1,
} from "../../../apps/searcher-runtime/src/deployment-runtime-policy.ts";
import { decodeReleaseIntent } from "../../../specs/release-intent/src/index.ts";
import {
  decodeFullFamilyCandidateProofVerifierBinding,
  encodeFullFamilyCandidateProofVerifierBinding,
} from "../../../specs/full-family-facts/src/index.ts";
import {
  createReleaseFamilyRuntimeComposition,
} from "../../../generated/runtime-composition/index.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
} from "../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import { verifyRuntimeReleaseBindingSignatureV1 } from "./internal/runtime-binding-verifier.ts";
import type { GitReleaseEvidenceV1 } from "./git-release-evidence.ts";
import { decodeProductionDeploymentCompositionV1 } from "./deployment-composition-artifact.ts";

export { verifyRuntimeReleaseBindingSignatureV1 } from "./internal/runtime-binding-verifier.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PACKAGE_DOMAIN = "aloha/runtime-release-package/v1";
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const RELEASE_PACKAGE_APPROVAL_SIDECAR_NAME_V1 = "runtime-release-package-approval.json";

export const PRODUCTION_RELEASE_LAYOUT_V1 = deepFreeze({
  nodeExecutablePath: "/usr/bin/node",
  entrypointPath: "/etc/aloha/production-launcher.mjs",
  bundleModulePath: "/etc/aloha/deployment-bundle.mjs",
  catalogGenerationInputPath: "/etc/aloha/runtime-facts/catalog-generation.inputs.json",
  familyCatalogSourcePath: "/etc/aloha/runtime-facts/family-catalog.ts",
  runtimeCompositionSourcePath: "/etc/aloha/runtime-facts/runtime-composition.ts",
  strategyCatalogSourcePath: "/etc/aloha/runtime-facts/strategy-catalog.ts",
  deploymentCompositionModulePath: "/etc/aloha/deployment-composition.mjs",
  deploymentSourceConfigPath: "/etc/aloha/deployment-source.json",
  deploymentRuntimePolicyPath: "/etc/aloha/runtime-policy.json",
  deploymentExecutorStatePath: "/etc/aloha/executor-state.json",
  releaseIntentPath: "/etc/aloha/release-intent.json",
  candidateProofVerifierBindingPath: "/etc/aloha/candidate-proof-verifier-binding.json",
  acceptanceCertificatesPath: "/etc/aloha/acceptance-certificates.json",
  releaseAuthorityApprovalPath: "/etc/aloha/release-authority-approval.json",
  releaseAcceptanceSetPath: "/etc/aloha/release-acceptance-set.json",
  releaseAcceptanceApprovalPath: "/etc/aloha/release-acceptance-approval.json",
  runtimeBindingPath: "/etc/aloha/runtime-release-binding.json",
  nominationQualificationDeploymentFactPath: "/etc/aloha/nomination-qualification-deployment-fact.json",
  deploymentManifestPath: "/etc/aloha/searcher-deployment.json",
  packageManifestPath: "/etc/aloha/release-package.json",
  releaseEnvironmentPath: "/etc/aloha/searcher-release.env",
  performanceProfilePath: "/etc/aloha/performance-profile.json",
  hardwareProfilePath: "/etc/aloha/hardware-profile.json",
  performanceBasisPath: "/etc/aloha/performance-window-basis.json",
  revmWorkerExecutablePath: "/opt/aloha/bin/aloha-revm-worker",
  proofSignerExecutablePath: "/opt/aloha/bin/aloha-proof-signer",
  runtimeSignerPinPath: "/etc/aloha/trust/runtime-release-signer-pin.json",
  packageApprovalPath: "/etc/aloha/trust/runtime-release-package-approval.json",
  systemdUnitPath: "/etc/systemd/system/aloha-searcher.service",
  serviceName: "aloha-searcher",
  systemdUnit: "aloha-searcher.service",
  logPath: "/var/log/aloha/searcher.log",
});
export const PRODUCTION_RELEASE_REPOSITORY_ROOT_V1 = "/opt/aloha";

export const PACKAGE_INSTALL_PATHS_V1: Readonly<Record<string, string>> = Object.freeze({
  "acceptance-certificates.json": PRODUCTION_RELEASE_LAYOUT_V1.acceptanceCertificatesPath,
  "aloha-searcher.service": PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath,
  "catalog-generation.inputs.json": PRODUCTION_RELEASE_LAYOUT_V1.catalogGenerationInputPath,
  "deployment-bundle.mjs": PRODUCTION_RELEASE_LAYOUT_V1.bundleModulePath,
  "deployment-composition.mjs": PRODUCTION_RELEASE_LAYOUT_V1.deploymentCompositionModulePath,
  "deployment-source.json": PRODUCTION_RELEASE_LAYOUT_V1.deploymentSourceConfigPath,
  "runtime-policy.json": PRODUCTION_RELEASE_LAYOUT_V1.deploymentRuntimePolicyPath,
  "executor-state.json": PRODUCTION_RELEASE_LAYOUT_V1.deploymentExecutorStatePath,
  "family-catalog.ts": PRODUCTION_RELEASE_LAYOUT_V1.familyCatalogSourcePath,
  "release-intent.json": PRODUCTION_RELEASE_LAYOUT_V1.releaseIntentPath,
  "candidate-proof-verifier-binding.json": PRODUCTION_RELEASE_LAYOUT_V1.candidateProofVerifierBindingPath,
  "hardware-profile.json": PRODUCTION_RELEASE_LAYOUT_V1.hardwareProfilePath,
  "performance-profile.json": PRODUCTION_RELEASE_LAYOUT_V1.performanceProfilePath,
  "performance-window-basis.json": PRODUCTION_RELEASE_LAYOUT_V1.performanceBasisPath,
  "production-launcher.mjs": PRODUCTION_RELEASE_LAYOUT_V1.entrypointPath,
  "aloha-revm-worker": PRODUCTION_RELEASE_LAYOUT_V1.revmWorkerExecutablePath,
  "aloha-proof-signer": PRODUCTION_RELEASE_LAYOUT_V1.proofSignerExecutablePath,
  "runtime-release-binding.json": PRODUCTION_RELEASE_LAYOUT_V1.runtimeBindingPath,
  "nomination-qualification-deployment-fact.json": PRODUCTION_RELEASE_LAYOUT_V1.nominationQualificationDeploymentFactPath,
  "release-authority-approval.json": PRODUCTION_RELEASE_LAYOUT_V1.releaseAuthorityApprovalPath,
  "release-acceptance-set.json": PRODUCTION_RELEASE_LAYOUT_V1.releaseAcceptanceSetPath,
  "release-acceptance-approval.json": PRODUCTION_RELEASE_LAYOUT_V1.releaseAcceptanceApprovalPath,
  "runtime-composition.ts": PRODUCTION_RELEASE_LAYOUT_V1.runtimeCompositionSourcePath,
  "searcher-deployment.json": PRODUCTION_RELEASE_LAYOUT_V1.deploymentManifestPath,
  "searcher-release.env": PRODUCTION_RELEASE_LAYOUT_V1.releaseEnvironmentPath,
  "strategy-catalog.ts": PRODUCTION_RELEASE_LAYOUT_V1.strategyCatalogSourcePath,
});

export const PRODUCTION_SYSTEMD_UNIT_V1 = `[Unit]
Description=Aloha strict dry-run searcher
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=aloha
WorkingDirectory=/
Environment=SEARCHER_DRY_RUN=1
EnvironmentFile=/etc/aloha/searcher-release.env
UnsetEnvironment=BASH_ENV ENV DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_CONFIG_SYSTEM GIT_DIR GIT_EXEC_PATH GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS GIT_OBJECT_DIRECTORY GIT_OPTIONAL_LOCKS GIT_REPLACE_REF_BASE GIT_WORK_TREE LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_LIBRARY_PATH LD_PRELOAD LD_PROFILE NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH OPENSSL_CONF OPENSSL_ENGINES OPENSSL_MODULES OWNER_PRIVATE_KEY PRIVATE_KEY SSL_CERT_DIR SSL_CERT_FILE
ExecStart=/usr/bin/node /etc/aloha/production-launcher.mjs
Restart=no
RuntimeMaxSec=1800s
KillSignal=SIGTERM
TimeoutStopSec=30s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/aloha /var/log/aloha
StandardOutput=append:/var/log/aloha/searcher.log
StandardError=append:/var/log/aloha/searcher.log

[Install]
WantedBy=multi-user.target
`;

const PRODUCTION_PROCESS_COMMAND_BYTES_V1 = Buffer.from([
  PRODUCTION_RELEASE_LAYOUT_V1.nodeExecutablePath,
  PRODUCTION_RELEASE_LAYOUT_V1.entrypointPath,
  "",
].join("\0"));

export interface ReleasePackageArtifactV1 {
  readonly name: string;
  readonly installPath: string;
  readonly sha256: Hash;
  readonly byteLength: string;
}

export interface ReleasePackageManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-release-package";
  readonly packageRoot: Hash;
  readonly git: GitReleaseEvidenceV1;
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly runtimeSignerPinSha256: Hash;
  readonly releaseAcceptanceApprovalId: Hash;
  readonly releaseAcceptanceApprovalPayloadHash: Hash;
  readonly releaseAcceptanceRequirementSetRoot: Hash;
  readonly releaseAcceptanceSetRoot: Hash;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly deploymentManifestHash: Hash;
  readonly performance: {
    readonly profileArtifactSha256: Hash;
    readonly profileHash: Hash;
    readonly basisArtifactSha256: Hash;
    readonly basisId: Hash;
    readonly providerRoot: Hash;
    readonly hardwareProfileRoot: Hash;
    readonly hardwareProfileArtifactSha256: Hash;
    readonly eligibilityRuleHash: Hash;
    readonly commitContextBindingId: Hash;
    readonly commitAppendRecordId: Hash;
  };
  readonly artifacts: readonly ReleasePackageArtifactV1[];
  readonly dryRun: true;
}

interface ReleasePackagePayloadV1 extends Omit<ReleasePackageManifestV1, "packageRoot"> {}

function regularCanonicalPath(path: string, label: string): string {
  const absolute = resolve(path);
  if (absolute !== path) throw new TypeError(`${label} path is not canonical absolute`);
  const real = realpathSync(path);
  if (real !== path) throw new TypeError(`${label} path must not be a symlink`);
  if (!lstatSync(path).isFile()) throw new TypeError(`${label} is not a regular file`);
  return path;
}

export function verifyPackageApprovalSignature(
  approvalValue: RuntimeReleasePackageApprovalV1,
  pinValue: RuntimeReleaseSignerPinV1,
): RuntimeReleasePackageApprovalV1 {
  const approval = decodeRuntimeReleasePackageApprovalV1(approvalValue);
  const pin = decodeRuntimeReleaseSignerPinV1(pinValue);
  if (approval.signerKeyId !== pin.signerKeyId) {
    throw new TypeError("runtime release package approval signer pin mismatch");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]),
    format: "der",
    type: "spki",
  });
  const valid = verifySignature(
    null,
    Buffer.from(runtimeReleasePackageApprovalSigningBytes(approval)),
    publicKey,
    Buffer.from(approval.signatureHex.slice(2), "hex"),
  );
  if (!valid) throw new TypeError("runtime release package approval signature invalid");
  return approval;
}

function verifyNominationQualificationDeploymentFactSignature(
  value: NominationQualificationDeploymentFactV1,
  pinValue: RuntimeReleaseSignerPinV1,
): NominationQualificationDeploymentFactV1 {
  const fact = decodeNominationQualificationDeploymentFactV1(value);
  const pin = decodeRuntimeReleaseSignerPinV1(pinValue);
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
  return fact;
}

function assertNominationQualificationDeploymentFactJoinsBinding(
  fact: NominationQualificationDeploymentFactV1,
  binding: RuntimeReleaseBindingV1,
): void {
  if (fact.runtimeBindingId !== binding.bindingId
    || fact.runtimeBindingPayloadHash !== binding.payloadHash
    || fact.candidateReleaseCommit !== binding.candidateReleaseCommit
    || fact.catalogProposedCapabilitySetRoot !== binding.qualifiedCapabilityRefsRoot
    || fact.nominationProgramSetRoot !== binding.nominationProgramSetRoot
    || fact.nominationQualificationSetRoot !== binding.nominationQualificationSetRoot) {
    throw new TypeError("nomination qualification deployment fact does not exact-join runtime binding");
  }
}

function packageRoot(payload: ReleasePackagePayloadV1): Hash {
  return hashDomain(PACKAGE_DOMAIN, payload);
}

function releaseEnvironment(commit: string): Uint8Array {
  return Buffer.from([
    `SEARCHER_RUNTIME_COMMIT=${commit}`,
    `SEARCHER_RUNTIME_SERVICE_NAME=${PRODUCTION_RELEASE_LAYOUT_V1.serviceName}`,
    `SEARCHER_RUNTIME_MANIFEST_PATH=${PRODUCTION_RELEASE_LAYOUT_V1.deploymentManifestPath}`,
    `SEARCHER_RUNTIME_BUNDLE_MODULE=${PRODUCTION_RELEASE_LAYOUT_V1.bundleModulePath}`,
    `SEARCHER_RELEASE_PACKAGE_MANIFEST=${PRODUCTION_RELEASE_LAYOUT_V1.packageManifestPath}`,
    `SEARCHER_RELEASE_PACKAGE_APPROVAL=${PRODUCTION_RELEASE_LAYOUT_V1.packageApprovalPath}`,
    `SEARCHER_PERFORMANCE_PROFILE_PATH=${PRODUCTION_RELEASE_LAYOUT_V1.performanceProfilePath}`,
    `SEARCHER_HARDWARE_PROFILE_PATH=${PRODUCTION_RELEASE_LAYOUT_V1.hardwareProfilePath}`,
    `SEARCHER_PERFORMANCE_BASIS_PATH=${PRODUCTION_RELEASE_LAYOUT_V1.performanceBasisPath}`,
    "SEARCHER_DRY_RUN=1",
    "",
  ].join("\n"));
}

export function productionReleaseEnvironmentBytesV1(commit: string): Uint8Array {
  return new Uint8Array(releaseEnvironment(gitSha40Schema.decode(commit)));
}

export function productionProcessCommandSha256V1(): Hash {
  return sha256Hex(PRODUCTION_PROCESS_COMMAND_BYTES_V1);
}

function assertCanonicalBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new TypeError(`${label} artifact is not canonical exact bytes`);
}

export function releasePackageApprovalPayload(
  manifest: ReleasePackageManifestV1,
): RuntimeReleasePackageApprovalPayloadV1 {
  return deepFreeze({
    schemaVersion: 1,
    kind: "aloha.runtime-release-package-approval",
    packageRoot: manifest.packageRoot,
    bindingId: manifest.bindingId,
    releaseProvenanceHash: manifest.releaseProvenanceHash,
    releaseAcceptanceApprovalId: manifest.releaseAcceptanceApprovalId,
    releaseAcceptanceApprovalPayloadHash: manifest.releaseAcceptanceApprovalPayloadHash,
    releaseAcceptanceRequirementSetRoot: manifest.releaseAcceptanceRequirementSetRoot,
    releaseAcceptanceSetRoot: manifest.releaseAcceptanceSetRoot,
    controllerBoundaryEvidenceRoot: manifest.controllerBoundaryEvidenceRoot,
    candidateReleaseCommit: manifest.git.commit,
    performanceBasisId: manifest.performance.basisId,
    performanceProfileHash: manifest.performance.profileHash,
    hardwareProfileRoot: manifest.performance.hardwareProfileRoot,
    providerRoot: manifest.performance.providerRoot,
  });
}

export function assertPackageApprovalJoin(
  manifest: ReleasePackageManifestV1,
  approval: RuntimeReleasePackageApprovalV1,
): void {
  const expected = releasePackageApprovalPayload(manifest);
  for (const key of Object.keys(expected) as readonly (keyof RuntimeReleasePackageApprovalPayloadV1)[]) {
    if (approval[key] !== expected[key]) {
      throw new TypeError(`runtime release package approval mismatch: ${key}`);
    }
  }
}

function decodeArtifact(value: unknown, path: string): ReleasePackageArtifactV1 {
  const decoded = decodeExactObject(value, {
    name: (item, itemPath) => nonEmptyStringSchema.decode(item, itemPath),
    installPath: (item, itemPath) => nonEmptyStringSchema.decode(item, itemPath),
    sha256: (item, itemPath) => hashSchema.decode(item, itemPath),
    byteLength: (item, itemPath) => nonEmptyStringSchema.decode(item, itemPath),
  }, path);
  if (basename(decoded.name) !== decoded.name || decoded.name === "release-package.json") throw new TypeError(`invalid package artifact name at ${path}`);
  if (!decoded.installPath.startsWith("/")) throw new TypeError(`package install path is not absolute at ${path}`);
  if (!/^(0|[1-9][0-9]*)$/.test(decoded.byteLength)) throw new TypeError(`invalid byte length at ${path}`);
  return decoded;
}

function decodeArtifacts(value: unknown, path: string): readonly ReleasePackageArtifactV1[] {
  if (!Array.isArray(value)) throw new TypeError(`expected artifact array at ${path}`);
  const decoded = value.map((entry, index) => decodeArtifact(entry, `${path}[${index}]`));
  for (let index = 1; index < decoded.length; index += 1) {
    if (decoded[index - 1]!.name >= decoded[index]!.name) throw new TypeError("package artifacts must be strictly sorted and unique");
  }
  return Object.freeze(decoded);
}

export function decodeReleasePackageManifestV1(value: unknown): ReleasePackageManifestV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, path) => { if (item !== 1) throw new TypeError(`unsupported release package schema at ${path}`); return 1 as const; },
    kind: (item, path) => { if (item !== "aloha.runtime-release-package") throw new TypeError(`invalid release package kind at ${path}`); return "aloha.runtime-release-package" as const; },
    packageRoot: (item, path) => hashSchema.decode(item, path),
    git: (item, path) => decodeExactObject(item, {
      branch: (entry, entryPath) => nonEmptyStringSchema.decode(entry, entryPath),
      upstreamRef: (entry, entryPath) => nonEmptyStringSchema.decode(entry, entryPath),
      commit: (entry, entryPath) => gitSha40Schema.decode(entry, entryPath),
    }, path),
    bindingId: (item, path) => hashSchema.decode(item, path),
    releaseProvenanceHash: (item, path) => hashSchema.decode(item, path),
    runtimeSignerPinSha256: (item, path) => hashSchema.decode(item, path),
    releaseAcceptanceApprovalId: (item, path) => hashSchema.decode(item, path),
    releaseAcceptanceApprovalPayloadHash: (item, path) => hashSchema.decode(item, path),
    releaseAcceptanceRequirementSetRoot: (item, path) => hashSchema.decode(item, path),
    releaseAcceptanceSetRoot: (item, path) => hashSchema.decode(item, path),
    controllerBoundaryEvidenceRoot: (item, path) => hashSchema.decode(item, path),
    deploymentManifestHash: (item, path) => hashSchema.decode(item, path),
    performance: (item, path) => decodeExactObject(item, {
      profileArtifactSha256: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      profileHash: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      basisArtifactSha256: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      basisId: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      providerRoot: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      hardwareProfileRoot: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      hardwareProfileArtifactSha256: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      eligibilityRuleHash: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      commitContextBindingId: (entry, entryPath) => hashSchema.decode(entry, entryPath),
      commitAppendRecordId: (entry, entryPath) => hashSchema.decode(entry, entryPath),
    }, path),
    artifacts: decodeArtifacts,
    dryRun: (item, path) => { if (item !== true) throw new TypeError(`release package must be dry-run at ${path}`); return true as const; },
  });
  if (decoded.controllerBoundaryEvidenceRoot === ZERO_HASH) {
    throw new TypeError("release package controller boundary evidence root must be non-zero");
  }
  const { packageRoot: _ignored, ...payload } = decoded;
  if (decoded.packageRoot !== packageRoot(payload)) throw new TypeError("release package root mismatch");
  return deepFreeze(decoded);
}

/** Verify the package's exact file set and every raw artifact byte commitment. */
function verifyReleasePackageDirectoryContentsV1(
  directoryValue: string,
  signerPinValue: RuntimeReleaseSignerPinV1,
  requireApprovalSidecar = false,
): ReleasePackageManifestV1 {
  const requestedDirectory = resolve(directoryValue);
  const directory = realpathSync(requestedDirectory);
  if (directory !== requestedDirectory) throw new TypeError("release package directory must not be a symlink");
  if (!lstatSync(directory).isDirectory()) throw new TypeError("release package is not a directory");
  const names = readdirSync(directory).sort();
  const manifestName = "release-package.json";
  if (!names.includes(manifestName)) throw new TypeError("release package manifest is missing");
  const manifestBytes = new Uint8Array(readFileSync(join(directory, manifestName)));
  const manifest = decodeReleasePackageManifestV1(decodeCanonicalJson(manifestBytes));
  assertCanonicalBytes(manifestBytes, encodeCanonicalBytes(manifest), "release package manifest");
  const expectedNames = [
    ...manifest.artifacts.map(value => value.name),
    manifestName,
    ...(requireApprovalSidecar ? [RELEASE_PACKAGE_APPROVAL_SIDECAR_NAME_V1] : []),
  ].sort();
  if (names.length !== expectedNames.length || names.some((value, index) => value !== expectedNames[index])) {
    throw new TypeError("release package file set mismatch");
  }
  for (const artifact of manifest.artifacts) {
    const path = join(directory, artifact.name);
    if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new TypeError(`release package artifact is not a regular non-symlink file: ${artifact.name}`);
    const bytes = new Uint8Array(readFileSync(path));
    if (sha256Hex(bytes) !== artifact.sha256 || bytes.byteLength.toString() !== artifact.byteLength) {
      throw new TypeError(`release package artifact mismatch: ${artifact.name}`);
    }
  }
  if (basename(directory) !== manifest.packageRoot.slice(2)) throw new TypeError("release package directory is not content-addressed");
  verifyReleaseArtifactSemanticsV1(
    manifest,
    signerPinValue,
    name => new Uint8Array(readFileSync(join(directory, name))),
  );
  return manifest;
}

/** Verify package bytes plus the exact approved sidecar durably bound before
 * the ready marker. The supplied projection must equal those physical bytes. */
export function verifyReleasePackageDirectoryV1(
  directoryValue: string,
  signerPinValue: RuntimeReleaseSignerPinV1,
  approvalValue: RuntimeReleasePackageApprovalV1,
): ReleasePackageManifestV1 {
  const directory = realpathSync(resolve(directoryValue));
  const manifest = verifyReleasePackageDirectoryContentsV1(directory, signerPinValue, true);
  const sidecarPath = join(directory, RELEASE_PACKAGE_APPROVAL_SIDECAR_NAME_V1);
  if (realpathSync(sidecarPath) !== sidecarPath || !lstatSync(sidecarPath).isFile()) {
    throw new TypeError("release package approval sidecar is not a regular physical file");
  }
  const sidecarBytes = new Uint8Array(readFileSync(sidecarPath));
  const sidecarApproval = verifyPackageApprovalSignature(
    decodeRuntimeReleasePackageApprovalV1(sidecarBytes),
    signerPinValue,
  );
  assertCanonicalBytes(
    sidecarBytes,
    encodeRuntimeReleasePackageApprovalV1(sidecarApproval),
    "release package approval sidecar",
  );
  const approval = verifyPackageApprovalSignature(approvalValue, signerPinValue);
  if (!Buffer.from(encodeRuntimeReleasePackageApprovalV1(approval)).equals(
    Buffer.from(encodeRuntimeReleasePackageApprovalV1(sidecarApproval)),
  )) throw new TypeError("runtime release package approval does not equal its durable sidecar");
  assertPackageApprovalJoin(manifest, approval);
  return manifest;
}

export function verifyReleaseArtifactSemanticsV1(
  manifest: ReleasePackageManifestV1,
  signerPinValue: RuntimeReleaseSignerPinV1,
  load: (name: string) => Uint8Array,
): void {
  const signerPin = decodeRuntimeReleaseSignerPinV1(signerPinValue);
  if (sha256Hex(encodeCanonicalBytes(signerPin)) !== manifest.runtimeSignerPinSha256) throw new TypeError("runtime release signer trust pin mismatch");
  const certificateBytes = load("acceptance-certificates.json");
  const releaseAuthorityApprovalBytes = load("release-authority-approval.json");
  const releaseAcceptanceSetBytes = load("release-acceptance-set.json");
  const releaseAcceptanceApprovalBytes = load("release-acceptance-approval.json");
  const bindingBytes = load("runtime-release-binding.json");
  const nominationQualificationDeploymentFactBytes = load("nomination-qualification-deployment-fact.json");
  const deploymentBytes = load("searcher-deployment.json");
  const profileBytes = load("performance-profile.json");
  const hardwareProfileBytes = load("hardware-profile.json");
  const performanceBasisBytes = load("performance-window-basis.json");
  const bundleBytes = load("deployment-bundle.mjs");
  const launcherBytes = load("production-launcher.mjs");
  const revmWorkerBytes = load("aloha-revm-worker");
  const proofSignerBytes = load("aloha-proof-signer");
  const deploymentCompositionModuleBytes = load("deployment-composition.mjs");
  const deploymentSourceConfigBytes = load("deployment-source.json");
  const deploymentRuntimePolicyBytes = load("runtime-policy.json");
  const deploymentExecutorStateBytes = load("executor-state.json");
  const releaseIntentBytes = load("release-intent.json");
  const candidateProofVerifierBindingBytes = load("candidate-proof-verifier-binding.json");
  const unitBytes = load("aloha-searcher.service");
  const environmentBytes = load("searcher-release.env");
  const expectedArtifactNames = Object.keys(PACKAGE_INSTALL_PATHS_V1).sort();
  if (manifest.artifacts.length !== expectedArtifactNames.length
    || manifest.artifacts.some((artifact, index) => artifact.name !== expectedArtifactNames[index]
      || artifact.installPath !== PACKAGE_INSTALL_PATHS_V1[artifact.name])) {
    throw new TypeError("release package artifact role set mismatch");
  }
  assertCanonicalBytes(unitBytes, Buffer.from(PRODUCTION_SYSTEMD_UNIT_V1), "systemd unit");
  assertCanonicalBytes(environmentBytes, releaseEnvironment(manifest.git.commit), "release environment");
  const certificateValues = decodeCanonicalJson(certificateBytes);
  if (!Array.isArray(certificateValues)) throw new TypeError("acceptance certificate artifact must be an array");
  const certificates = certificateValues.map(value => decodeAcceptanceCertificateV1(value as object));
  const releaseAuthorityApproval = decodeSignedReleaseAuthorityApprovalV3(releaseAuthorityApprovalBytes);
  const releaseAcceptanceSet = decodeReleaseAcceptanceSetV1(releaseAcceptanceSetBytes);
  const releaseAcceptanceApproval = decodeSignedReleaseAcceptanceApprovalV1(releaseAcceptanceApprovalBytes);
  const binding = verifyRuntimeReleaseBindingSignatureV1(decodeRuntimeReleaseBindingV1(bindingBytes), signerPin);
  const deploymentComposition = decodeProductionDeploymentCompositionV1(deploymentCompositionModuleBytes);
  if (deploymentComposition.revmWorkerExecutablePath !== PRODUCTION_RELEASE_LAYOUT_V1.revmWorkerExecutablePath
    || deploymentComposition.revmWorkerExecutableSha256 !== sha256Hex(revmWorkerBytes)
    || deploymentComposition.externalProofSigner.executablePath !== PRODUCTION_RELEASE_LAYOUT_V1.proofSignerExecutablePath
    || deploymentComposition.externalProofSigner.executableSha256 !== sha256Hex(proofSignerBytes)) {
    throw new TypeError("deployment composition executable artifacts do not exact-join the package");
  }
  const nominationQualificationDeploymentFact = verifyNominationQualificationDeploymentFactSignature(
    decodeNominationQualificationDeploymentFactV1(nominationQualificationDeploymentFactBytes),
    signerPin,
  );
  assertNominationQualificationDeploymentFactJoinsBinding(nominationQualificationDeploymentFact, binding);
  assertDeploymentSourceJoinsReleaseV1(
    decodeDeploymentSourceConfigBytesV1(deploymentSourceConfigBytes),
    binding,
  );
  assertDeploymentRuntimeArtifactsJoinReleaseV1(
    decodeDeploymentRuntimePolicyBytesV1(deploymentRuntimePolicyBytes),
    decodeDeploymentExecutorStateDescriptorBytesV1(deploymentExecutorStateBytes),
    binding,
  );
  const releaseIntent = decodeReleaseIntent(decodeCanonicalJson(releaseIntentBytes));
  assertCanonicalBytes(releaseIntentBytes, encodeCanonicalBytes(releaseIntent), "release intent");
  if (releaseIntent.releaseIntentRoot !== readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition).releaseIntentRoot) {
    throw new TypeError("release intent does not join the generated runtime composition");
  }
  const candidateProofVerifierBinding = decodeFullFamilyCandidateProofVerifierBinding(candidateProofVerifierBindingBytes);
  assertCanonicalBytes(candidateProofVerifierBindingBytes, encodeFullFamilyCandidateProofVerifierBinding(candidateProofVerifierBinding), "candidate proof verifier binding");
  if (candidateProofVerifierBinding.runtimeBindingId !== binding.bindingId
    || candidateProofVerifierBinding.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || candidateProofVerifierBinding.releaseAuthorityRoot !== binding.releaseAuthorityRoot
    || candidateProofVerifierBinding.candidateReleaseCommit !== binding.candidateReleaseCommit
    || candidateProofVerifierBinding.proofKeyId !== binding.candidatePartitionProofIssuerKeyId) {
    throw new TypeError("candidate proof verifier binding does not join the signed release");
  }
  const deployment = decodeDeploymentManifestV1(decodeCanonicalJson(deploymentBytes));
  const profile = decodeProductionPerformanceProfile(profileBytes);
  const hardwareProfile = decodeHardwareProfileObservationV1(hardwareProfileBytes);
  const performanceBasis = decodeDeploymentPerformanceWindowBasisV1(performanceBasisBytes);
  assertCanonicalBytes(certificateBytes, encodeCanonicalBytes(certificates), "acceptance certificates");
  assertCanonicalBytes(releaseAuthorityApprovalBytes, encodeSignedReleaseAuthorityApprovalV3(releaseAuthorityApproval), "release authority approval");
  assertCanonicalBytes(releaseAcceptanceSetBytes, encodeReleaseAcceptanceSetV1(releaseAcceptanceSet), "release acceptance set");
  assertCanonicalBytes(releaseAcceptanceApprovalBytes, encodeSignedReleaseAcceptanceApprovalV1(releaseAcceptanceApproval), "release acceptance approval");
  assertCanonicalBytes(bindingBytes, encodeRuntimeReleaseBindingV1(binding), "runtime release binding");
  assertCanonicalBytes(
    nominationQualificationDeploymentFactBytes,
    encodeCanonicalBytes(nominationQualificationDeploymentFact),
    "nomination qualification deployment fact",
  );
  assertCanonicalBytes(deploymentBytes, encodeCanonicalBytes(deployment), "deployment manifest");
  assertCanonicalBytes(profileBytes, encodeProductionPerformanceProfile(profile), "performance profile");
  assertCanonicalBytes(hardwareProfileBytes, encodeHardwareProfileObservationV1(hardwareProfile), "hardware profile");
  assertCanonicalBytes(performanceBasisBytes, encodeDeploymentPerformanceWindowBasisV1(performanceBasis), "performance basis");
  if (manifest.bindingId !== binding.bindingId
    || manifest.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || manifest.releaseAcceptanceApprovalId !== releaseAcceptanceApproval.approvalId
    || manifest.releaseAcceptanceApprovalPayloadHash !== releaseAcceptanceApproval.payloadHash
    || manifest.releaseAcceptanceRequirementSetRoot !== releaseAcceptanceSet.releaseAcceptanceRequirementSetRoot
    || manifest.releaseAcceptanceSetRoot !== releaseAcceptanceSet.root
    || releaseAcceptanceApproval.runtimeReleaseBindingId !== binding.bindingId
    || releaseAcceptanceApproval.releaseAuthorityApprovalId !== releaseAuthorityApproval.approvalId
    || releaseAcceptanceApproval.releaseAuthorityApprovalPayloadHash !== releaseAuthorityApproval.payloadHash
    || releaseAcceptanceApproval.releaseAcceptanceRequirementSetRoot !== releaseAuthorityApproval.releaseAcceptanceRequirementSetRoot
    || releaseAcceptanceApproval.releaseAcceptanceSetRoot !== releaseAcceptanceSet.root
    || binding.releaseAuthorityApprovalId !== releaseAuthorityApproval.approvalId
    || binding.releaseAuthorityApprovalPayloadHash !== releaseAuthorityApproval.payloadHash
    || binding.releaseAcceptanceRequirementSetRoot !== releaseAuthorityApproval.releaseAcceptanceRequirementSetRoot
    || certificates.length !== releaseAcceptanceSet.entries.length
    || manifest.git.commit !== binding.candidateReleaseCommit
    || manifest.deploymentManifestHash !== deployment.manifestHash
    || deployment.bindingId !== binding.bindingId
    || deployment.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || deployment.candidateReleaseCommit !== binding.candidateReleaseCommit
    || deployment.searcherRuntimeBundleModuleSha256 !== binding.searcherRuntime.bundleModuleSha256
    || deployment.deploymentCompositionModulePath !== PRODUCTION_RELEASE_LAYOUT_V1.deploymentCompositionModulePath
    || deployment.deploymentCompositionModuleSha256 !== sha256Hex(deploymentCompositionModuleBytes)
    || deployment.deploymentSourceConfigPath !== PRODUCTION_RELEASE_LAYOUT_V1.deploymentSourceConfigPath
    || deployment.deploymentSourceConfigSha256 !== sha256Hex(deploymentSourceConfigBytes)
    || deployment.deploymentRuntimePolicyPath !== PRODUCTION_RELEASE_LAYOUT_V1.deploymentRuntimePolicyPath
    || deployment.deploymentRuntimePolicySha256 !== sha256Hex(deploymentRuntimePolicyBytes)
    || deployment.deploymentExecutorStatePath !== PRODUCTION_RELEASE_LAYOUT_V1.deploymentExecutorStatePath
    || deployment.deploymentExecutorStateSha256 !== sha256Hex(deploymentExecutorStateBytes)
    || deployment.releaseIntentPath !== PRODUCTION_RELEASE_LAYOUT_V1.releaseIntentPath
    || deployment.releaseIntentSha256 !== sha256Hex(releaseIntentBytes)
    || deployment.candidateProofVerifierBindingPath !== PRODUCTION_RELEASE_LAYOUT_V1.candidateProofVerifierBindingPath
    || deployment.candidateProofVerifierBindingSha256 !== sha256Hex(candidateProofVerifierBindingBytes)
    || deployment.searcherRuntimeNodeExecutableSha256 !== binding.searcherRuntime.nodeExecutableSha256
    || deployment.searcherRuntimeEntrypointSha256 !== binding.searcherRuntime.entrypointSha256
    || deployment.processCommandSha256 !== sha256Hex(PRODUCTION_PROCESS_COMMAND_BYTES_V1)
    || deployment.systemdUnitPath !== PRODUCTION_RELEASE_LAYOUT_V1.systemdUnitPath
    || deployment.systemdUnitSha256 !== sha256Hex(unitBytes)
    || deployment.releaseEnvironmentPath !== PRODUCTION_RELEASE_LAYOUT_V1.releaseEnvironmentPath
    || deployment.releaseEnvironmentSha256 !== sha256Hex(environmentBytes)) {
    throw new TypeError("release package semantic identity mismatch");
  }
  if (sha256Hex(bundleBytes) !== binding.searcherRuntime.bundleModuleSha256
    || sha256Hex(launcherBytes) !== binding.searcherRuntime.entrypointSha256
    || sha256Hex(revmWorkerBytes) !== binding.selectedExecutor.executableFingerprint
    || proofSignerBytes.byteLength === 0
    || binding.searcherRuntime.bundleModulePath !== PRODUCTION_RELEASE_LAYOUT_V1.bundleModulePath
    || deployment.searcherRuntimeBundleModulePath !== PRODUCTION_RELEASE_LAYOUT_V1.bundleModulePath
    || deployment.serviceName !== PRODUCTION_RELEASE_LAYOUT_V1.serviceName
    || deployment.systemdUnit !== PRODUCTION_RELEASE_LAYOUT_V1.systemdUnit
    || deployment.logPath !== PRODUCTION_RELEASE_LAYOUT_V1.logPath
    || deployment.dryRun !== true) {
    throw new TypeError("release package deployment role mismatch");
  }
  if (manifest.performance.profileArtifactSha256 !== sha256Hex(profileBytes)
    || manifest.performance.profileHash !== profile.profileHash
    || manifest.performance.basisArtifactSha256 !== sha256Hex(performanceBasisBytes)
    || manifest.performance.basisId !== performanceBasis.basisId
    || manifest.performance.providerRoot !== performanceBasis.providerRoot
    || manifest.performance.hardwareProfileRoot !== performanceBasis.hardwareProfileRoot
    || manifest.performance.hardwareProfileArtifactSha256 !== sha256Hex(hardwareProfileBytes)
    || manifest.performance.eligibilityRuleHash !== performanceBasis.eligibilityRuleHash
    || manifest.performance.commitContextBindingId !== performanceBasis.commitContextBindingId
    || manifest.performance.commitAppendRecordId !== performanceBasis.commitAppendRecordId
    || performanceBasis.performanceProfileHash !== profile.profileHash
    || performanceBasis.bindingId !== binding.bindingId
    || performanceBasis.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || performanceBasis.candidateReleaseCommit !== binding.candidateReleaseCommit
    || performanceBasis.targetCount !== PERFORMANCE_TARGET_COUNT
    || performanceBasis.eligibilityRuleHash !== PERFORMANCE_ELIGIBILITY_RULE_HASH
    || performanceBasis.providerRoot !== runtimeReleaseDiscoverySourceAuthorityRootV1(
      binding.discoverySourceQualification,
    )
    || performanceBasis.hardwareProfileRoot !== hardwareProfile.profileRoot) {
    throw new TypeError("release package performance identity mismatch");
  }
}

export interface VerifyInstalledReleaseInputV1 {
  readonly packageManifestPath: string;
  readonly nodeExecutablePath: string;
  readonly entrypointPath: string;
  readonly signerPinPath: string;
  readonly packageApprovalPath: string;
}

/** Re-check the signed, content-addressed installed package before every start/restart. */
export function verifyInstalledReleaseV1(input: VerifyInstalledReleaseInputV1): ReleasePackageManifestV1 {
  const manifestPath = regularCanonicalPath(input.packageManifestPath, "installed package manifest");
  const manifestBytes = new Uint8Array(readFileSync(manifestPath));
  const manifest = decodeReleasePackageManifestV1(decodeCanonicalJson(manifestBytes));
  assertCanonicalBytes(manifestBytes, encodeCanonicalBytes(manifest), "installed package manifest");
  for (const artifact of manifest.artifacts) {
    const path = regularCanonicalPath(artifact.installPath, `installed ${artifact.name}`);
    const bytes = new Uint8Array(readFileSync(path));
    if (sha256Hex(bytes) !== artifact.sha256 || bytes.byteLength.toString() !== artifact.byteLength) {
      throw new TypeError(`installed artifact mismatch: ${artifact.name}`);
    }
    if ((artifact.name === "aloha-revm-worker" || artifact.name === "aloha-proof-signer")
      && (lstatSync(path).mode & 0o111) === 0) {
      throw new TypeError(`installed executable artifact is not executable: ${artifact.name}`);
    }
  }
  const signerPinPath = regularCanonicalPath(input.signerPinPath, "runtime release signer trust pin");
  const signerPinBytes = new Uint8Array(readFileSync(signerPinPath));
  const signerPin = decodeRuntimeReleaseSignerPinV1(decodeCanonicalJson(signerPinBytes) as object);
  assertCanonicalBytes(signerPinBytes, encodeCanonicalBytes(signerPin), "runtime release signer trust pin");
  const packageApprovalPath = regularCanonicalPath(
    input.packageApprovalPath,
    "runtime release package approval",
  );
  const packageApprovalBytes = new Uint8Array(readFileSync(packageApprovalPath));
  const packageApproval = verifyPackageApprovalSignature(
    decodeRuntimeReleasePackageApprovalV1(packageApprovalBytes),
    signerPin,
  );
  assertCanonicalBytes(
    packageApprovalBytes,
    encodeRuntimeReleasePackageApprovalV1(packageApproval),
    "runtime release package approval",
  );
  assertPackageApprovalJoin(manifest, packageApproval);
  verifyReleaseArtifactSemanticsV1(
    manifest,
    signerPin,
    name => {
      const artifact = manifest.artifacts.find(value => value.name === name);
      if (artifact === undefined) throw new TypeError(`installed package artifact is missing: ${name}`);
      return new Uint8Array(readFileSync(artifact.installPath));
    },
  );
  const nodePath = regularCanonicalPath(input.nodeExecutablePath, "installed Node executable");
  const entrypointPath = regularCanonicalPath(input.entrypointPath, "installed searcher entrypoint");
  const deploymentArtifact = manifest.artifacts.find(value => value.name === "searcher-deployment.json");
  if (deploymentArtifact === undefined) throw new TypeError("installed deployment manifest artifact is missing");
  const deployment = decodeDeploymentManifestV1(decodeCanonicalJson(readFileSync(deploymentArtifact.installPath)));
  if (deployment.manifestHash !== manifest.deploymentManifestHash
    || sha256Hex(readFileSync(nodePath)) !== deployment.searcherRuntimeNodeExecutableSha256
    || sha256Hex(readFileSync(entrypointPath)) !== deployment.searcherRuntimeEntrypointSha256) {
    throw new TypeError("installed runtime executable identity mismatch");
  }
  return manifest;
}
