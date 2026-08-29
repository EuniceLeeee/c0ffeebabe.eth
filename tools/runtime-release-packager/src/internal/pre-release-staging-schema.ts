import { types as nodeTypes } from "node:util";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  decodeExactObject,
  decimalStringSchema,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  nonEmptyStringSchema,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type {
  PreReleaseStagingArtifactIdentityV1,
  PreReleaseStagingArtifactNameV1,
} from "../pre-release-staging-contract.ts";
import type { RuntimeReleaseSignerPinV1 } from "../../../../specs/release-authority/src/index.ts";

const SIGNATURE = /^0x[0-9a-f]{128}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

export const PRE_RELEASE_STAGING_LAYOUT_V1 = Object.freeze({
  phase: "pre-release" as const,
  repositoryRoot: "/var/lib/aloha/pre-release/repository",
  artifactRoot: "/var/lib/aloha/pre-release/artifacts",
  launcherPath: "/var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs",
  productionLauncherPath: "/var/lib/aloha/pre-release/artifacts/production-launcher.mjs",
  bundlePath: "/var/lib/aloha/pre-release/artifacts/deployment-bundle.mjs",
  catalogGenerationInputPath: "/var/lib/aloha/pre-release/artifacts/runtime-facts/catalog-generation.inputs.json",
  familyCatalogSourcePath: "/var/lib/aloha/pre-release/artifacts/runtime-facts/family-catalog.ts",
  runtimeCompositionSourcePath: "/var/lib/aloha/pre-release/artifacts/runtime-facts/runtime-composition.ts",
  strategyCatalogSourcePath: "/var/lib/aloha/pre-release/artifacts/runtime-facts/strategy-catalog.ts",
  deploymentCompositionPath: "/var/lib/aloha/pre-release/artifacts/deployment-composition.mjs",
  deploymentSourcePath: "/var/lib/aloha/pre-release/artifacts/deployment-source.json",
  runtimePolicyPath: "/var/lib/aloha/pre-release/artifacts/runtime-policy.json",
  runtimeBoundaryProjectionPath: "/var/lib/aloha/pre-release/artifacts/runtime-boundary-projection.json",
  executorStatePath: "/var/lib/aloha/pre-release/artifacts/executor-state.json",
  performanceProfilePath: "/var/lib/aloha/pre-release/artifacts/performance-profile.json",
  qualifiedReleaseRunnerInputPath: "/var/lib/aloha/pre-release/artifacts/qualified-release-runner-input.json",
  releaseIntentPath: "/var/lib/aloha/pre-release/artifacts/release-intent.json",
  candidateProofVerifierBindingPath: "/var/lib/aloha/pre-release/artifacts/candidate-proof-verifier-binding.json",
  manifestPath: "/var/lib/aloha/pre-release/artifacts/staging-manifest.json",
  runtimeBindingPath: "/var/lib/aloha/pre-release/artifacts/runtime-release-binding.json",
  nominationQualificationDeploymentFactPath: "/var/lib/aloha/pre-release/artifacts/nomination-qualification-deployment-fact.json",
  releaseAuthorityApprovalPath: "/var/lib/aloha/pre-release/artifacts/release-authority-approval.json",
  runtimeSignerPinPath: "/var/lib/aloha/pre-release/artifacts/runtime-release-signer-pin.json",
  authorizationPath: "/var/lib/aloha/pre-release/authorization.json",
  authorizationArchiveDirectory: "/var/lib/aloha/pre-release/authorizations",
  restartProbeAuthorizationPath: "/var/lib/aloha/pre-release/authorizations/restart-probe.json",
  qualificationFinalAuthorizationPath: "/var/lib/aloha/pre-release/authorizations/qualification-final.json",
  authorizationLedgerPath: "/var/lib/aloha/pre-release/authorization-ledger/authorization-claims.sqlite",
  advisoryJudgmentPath: "/var/lib/aloha/pre-release/runtime/advisory-judgment.json",
  factLogPath: "/var/lib/aloha/pre-release/runtime/pre-release-fact-log.jsonl",
  qualificationFinalTerminalReadyPath: "/var/lib/aloha/pre-release/runtime/qualification-final-terminal-ready.json",
  runtimeOutputDirectory: "/var/lib/aloha/pre-release/runtime",
  canonicalJournalPath: "/var/lib/aloha/pre-release/runtime/canonical-journal.sqlite",
  checkpointDatabasePath: "/var/lib/aloha/pre-release/runtime/checkpoint.sqlite",
  processEvidenceDatabasePath: "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite",
  observerContentDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/content",
  terminalLocatorDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/terminal-locators",
  observerStoreDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/content",
  logPath: "/var/log/aloha/pre-release.log",
  serviceName: "aloha-searcher-pre-release",
  systemdUnit: "aloha-searcher-pre-release.service",
  systemdUnitPath: "/run/systemd/system/aloha-searcher-pre-release.service",
  releaseEnvironmentPath: "/var/lib/aloha/pre-release/artifacts/searcher-pre-release.env",
} as const);

export const PRE_RELEASE_SYSTEMD_UNIT_V1 = `[Unit]
Description=Aloha pre-release strict dry-run searcher
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=aloha
WorkingDirectory=/
EnvironmentFile=/var/lib/aloha/pre-release/artifacts/searcher-pre-release.env
Environment=SEARCHER_DRY_RUN=1
UnsetEnvironment=BASH_ENV ENV DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_CONFIG_SYSTEM GIT_DIR GIT_EXEC_PATH GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS GIT_OBJECT_DIRECTORY GIT_OPTIONAL_LOCKS GIT_REPLACE_REF_BASE GIT_WORK_TREE LD_AUDIT LD_DEBUG LD_DEBUG_OUTPUT LD_LIBRARY_PATH LD_PRELOAD LD_PROFILE NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH OPENSSL_CONF OPENSSL_ENGINES OPENSSL_MODULES OWNER_PRIVATE_KEY PRIVATE_KEY SSL_CERT_DIR SSL_CERT_FILE
ExecStart=/usr/bin/node /var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs
Restart=no
RuntimeMaxSec=2h
KillSignal=SIGTERM
TimeoutStopSec=5min
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/var/lib/aloha/pre-release/repository /var/lib/aloha/pre-release/artifacts
ReadWritePaths=/var/lib/aloha/pre-release/runtime /var/lib/aloha-acceptance/pre-release/observer-store /var/log/aloha/pre-release.log
StandardOutput=append:/var/log/aloha/pre-release.log
StandardError=append:/var/log/aloha/pre-release.log

[Install]
WantedBy=multi-user.target
`;

const PRE_RELEASE_SYSTEMD_UNIT_BYTES_V1 = new TextEncoder().encode(PRE_RELEASE_SYSTEMD_UNIT_V1);

export function assertCanonicalPreReleaseSystemdUnitV1(value: unknown, path: string): Uint8Array {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)
    || !ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || Object.getOwnPropertyDescriptor(value, "length") !== undefined
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => descriptor.get !== undefined || descriptor.set !== undefined)) {
    throw new TypeError(`${path} must be a concrete Uint8Array`);
  }
  const concrete = value as Uint8Array;
  const copied = new Uint8Array(concrete.length);
  for (let index = 0; index < concrete.length; index += 1) copied[index] = concrete[index]!;
  if (copied.length !== PRE_RELEASE_SYSTEMD_UNIT_BYTES_V1.length
    || copied.some((byte, index) => byte !== PRE_RELEASE_SYSTEMD_UNIT_BYTES_V1[index])) {
    throw new TypeError(`${path} must equal the canonical hardened pre-release systemd unit`);
  }
  return copied;
}

export const PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1 = hashDomain(
  "aloha/pre-release-runtime-export-surface/v1",
  Object.freeze([
    "issueInstalledProductionStartupCapabilityV1",
    "issuePreReleaseStartupCapabilityV1",
    "startReleaseRuntimeSessionV1",
  ]),
);

export const PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1 = Object.freeze([
  "aloha-searcher-pre-release.service",
  "candidate-proof-verifier-binding.json",
  "catalog-generation.inputs.json",
  "deployment-bundle.mjs",
  "deployment-composition.mjs",
  "deployment-source.json",
  "executor-state.json",
  "family-catalog.ts",
  "nomination-qualification-deployment-fact.json",
  "performance-profile.json",
  "qualified-release-runner-input.json",
  "release-authority-approval.json",
  "release-intent.json",
  "runtime-policy.json",
  "runtime-boundary-projection.json",
  "runtime-composition.ts",
  "runtime-release-binding.json",
  "runtime-release-signer-pin.json",
  "searcher-pre-release.env",
  "staging-manifest.json",
  "strategy-catalog.ts",
  "pre-release-owner.mjs",
  "production-launcher.mjs",
] as const);

export interface PreReleaseStagingManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-staging-manifest";
  readonly phase: "pre-release";
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly searcherRuntimeArtifactRoot: Hash;
  readonly searcherRuntimeImplementationClosureDigest: Hash;
  readonly searcherRuntimeNodeExecutableSha256: Hash;
  readonly releaseAuthorityApprovalId: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly boundaryRunnerEntrypointId: string;
  readonly boundaryRunnerClosureDigest: Hash;
  readonly boundaryRunnerImplementationExportDigest: Hash;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  readonly launcherPath: string;
  readonly productionLauncherPath: string;
  readonly bundlePath: string;
  readonly catalogGenerationInputPath: string;
  readonly familyCatalogSourcePath: string;
  readonly runtimeCompositionSourcePath: string;
  readonly strategyCatalogSourcePath: string;
  readonly manifestPath: string;
  readonly deploymentCompositionPath: string;
  readonly deploymentSourcePath: string;
  readonly runtimePolicyPath: string;
  readonly runtimeBoundaryProjectionPath: string;
  readonly executorStatePath: string;
  readonly performanceProfilePath: string;
  readonly qualifiedReleaseRunnerInputPath: string;
  readonly releaseIntentPath: string;
  readonly candidateProofVerifierBindingPath: string;
  readonly runtimeBindingPath: string;
  readonly nominationQualificationDeploymentFactPath: string;
  readonly releaseAuthorityApprovalPath: string;
  readonly runtimeSignerPinPath: string;
  readonly canonicalJournalPath: string;
  readonly checkpointDatabasePath: string;
  readonly processEvidenceDatabasePath: string;
  readonly observerContentDirectory: string;
  readonly terminalLocatorDirectory: string;
  readonly observerStoreDirectory: string;
  readonly logPath: string;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly systemdUnitPath: string;
  readonly releaseEnvironmentPath: string;
  readonly launcherSha256: Hash;
  readonly productionLauncherSha256: Hash;
  readonly deploymentBundleSha256: Hash;
  readonly catalogGenerationInputSha256: Hash;
  readonly familyCatalogSourceSha256: Hash;
  readonly runtimeCompositionSourceSha256: Hash;
  readonly strategyCatalogSourceSha256: Hash;
  readonly deploymentCompositionSha256: Hash;
  readonly deploymentSourceSha256: Hash;
  readonly runtimePolicySha256: Hash;
  readonly runtimeBoundaryProjectionSha256: Hash;
  readonly executorStateSha256: Hash;
  readonly performanceProfileSha256: Hash;
  readonly performanceProfileHash: Hash;
  readonly qualifiedReleaseRunnerInputSha256: Hash;
  readonly releaseIntentSha256: Hash;
  readonly candidateProofVerifierBindingSha256: Hash;
  readonly systemdUnitSha256: Hash;
  readonly releaseEnvironmentSha256: Hash;
  readonly runtimeBindingSha256: Hash;
  readonly nominationQualificationDeploymentFactSha256: Hash;
  readonly releaseAuthorityApprovalSha256: Hash;
  readonly runtimeSignerPinSha256: Hash;
  readonly runtimeExportSurfaceRoot: Hash;
  readonly dryRun: true;
}

export interface PreReleaseLaunchAuthorizationPayloadV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-launch-authorization";
  readonly phase: "pre-release";
  readonly roundRole: "restart-probe" | "qualification-final";
  readonly predecessor: null | Readonly<{
    readonly authorizationId: Hash;
    readonly authorizationClaimId: Hash;
    readonly controllerReceiptId: Hash;
    readonly controllerImplementationIdentityHash: Hash;
    readonly targetProcessAnchorHash: Hash;
    readonly processReadyEventId: Hash;
    readonly sigtermDrainedEventId: Hash;
    readonly restartTerminalId: Hash;
  }>;
  readonly candidateReleaseCommit: string;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly releaseAuthorityApprovalId: Hash;
  readonly releaseRoleManifestRoot: Hash;
  readonly boundaryRunnerEntrypointId: string;
  readonly boundaryRunnerClosureDigest: Hash;
  readonly boundaryRunnerImplementationExportDigest: Hash;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly runtimeExportSurfaceRoot: Hash;
  readonly repositoryRoot: string;
  readonly artifactRoot: string;
  readonly manifestPath: string;
  readonly canonicalJournalPath: string;
  readonly checkpointDatabasePath: string;
  readonly processEvidenceDatabasePath: string;
  readonly observerContentDirectory: string;
  readonly terminalLocatorDirectory: string;
  readonly observerStoreDirectory: string;
  readonly logPath: string;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly dryRun: true;
  readonly allowedTerminal: "restart-probe-drained" | "qualification-facts-observed";
  readonly permissions: Readonly<{
    readonly runRuntime: true;
    readonly emitRestartMarker: boolean;
    readonly sign: false;
    readonly broadcast: false;
    readonly promote: false;
  }>;
  readonly issuedAtUnixNs: string;
  readonly expiresAtUnixNs: string;
  readonly nonce: Hash;
}

export interface PreReleaseLaunchAuthorizationV1 extends PreReleaseLaunchAuthorizationPayloadV1 {
  readonly payloadHash: Hash;
  readonly authorizationId: Hash;
  readonly signatureAlgorithm: "ed25519";
  readonly signerKeyId: Hash;
  readonly signatureHex: `0x${string}`;
}

function exactLiteral<T extends string | number | boolean>(expected: T) {
  return (value: unknown, path: string): T => {
    if (value !== expected) throw new TypeError(`expected ${JSON.stringify(expected)} at ${path}`);
    return expected;
  };
}

function exactFixed(expected: string) {
  return (value: unknown, path: string): string => {
    const decoded = nonEmptyStringSchema.decode(value, path);
    if (decoded !== expected) throw new TypeError(`fixed pre-release value mismatch at ${path}`);
    return decoded;
  };
}

function decodePredecessor(value: unknown, path: string): PreReleaseLaunchAuthorizationPayloadV1["predecessor"] {
  if (value === null) return null;
  type PredecessorV1 = Exclude<PreReleaseLaunchAuthorizationPayloadV1["predecessor"], null>;
  return decodeExactObject<PredecessorV1>(value, {
    authorizationId: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
    authorizationClaimId: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
    controllerReceiptId: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
    controllerImplementationIdentityHash: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
    targetProcessAnchorHash: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
    processReadyEventId: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
    sigtermDrainedEventId: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
    restartTerminalId: (item: unknown, itemPath: string) => hashSchema.decode(item, itemPath),
  }, path);
}

function exactBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`expected boolean at ${path}`);
  return value;
}

function decodePermissions(value: unknown, path: string): PreReleaseLaunchAuthorizationPayloadV1["permissions"] {
  return Object.freeze(decodeExactObject(value, {
    runRuntime: exactLiteral(true as const),
    emitRestartMarker: exactBoolean,
    sign: exactLiteral(false as const),
    broadcast: exactLiteral(false as const),
    promote: exactLiteral(false as const),
  }, path));
}

const manifestFields = {
  schemaVersion: exactLiteral(1 as const),
  kind: exactLiteral("aloha.pre-release-staging-manifest" as const),
  phase: exactLiteral("pre-release" as const),
  candidateReleaseCommit: (value: unknown, path: string) => gitSha40Schema.decode(value, path),
  runtimeBindingId: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseProvenanceHash: (value: unknown, path: string) => hashSchema.decode(value, path),
  searcherRuntimeArtifactRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  searcherRuntimeImplementationClosureDigest: (value: unknown, path: string) => hashSchema.decode(value, path),
  searcherRuntimeNodeExecutableSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseAuthorityApprovalId: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseRoleManifestRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  boundaryRunnerEntrypointId: (value: unknown, path: string) => nonEmptyStringSchema.decode(value, path),
  boundaryRunnerClosureDigest: (value: unknown, path: string) => hashSchema.decode(value, path),
  boundaryRunnerImplementationExportDigest: (value: unknown, path: string) => hashSchema.decode(value, path),
  controllerBoundaryEvidenceRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  repositoryRoot: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.repositoryRoot),
  artifactRoot: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.artifactRoot),
  launcherPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.launcherPath),
  productionLauncherPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.productionLauncherPath),
  bundlePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.bundlePath),
  catalogGenerationInputPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.catalogGenerationInputPath),
  familyCatalogSourcePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.familyCatalogSourcePath),
  runtimeCompositionSourcePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.runtimeCompositionSourcePath),
  strategyCatalogSourcePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.strategyCatalogSourcePath),
  manifestPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.manifestPath),
  deploymentCompositionPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.deploymentCompositionPath),
  deploymentSourcePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.deploymentSourcePath),
  runtimePolicyPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.runtimePolicyPath),
  runtimeBoundaryProjectionPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.runtimeBoundaryProjectionPath),
  executorStatePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.executorStatePath),
  performanceProfilePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.performanceProfilePath),
  qualifiedReleaseRunnerInputPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.qualifiedReleaseRunnerInputPath),
  releaseIntentPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.releaseIntentPath),
  candidateProofVerifierBindingPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.candidateProofVerifierBindingPath),
  runtimeBindingPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.runtimeBindingPath),
  nominationQualificationDeploymentFactPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.nominationQualificationDeploymentFactPath),
  releaseAuthorityApprovalPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.releaseAuthorityApprovalPath),
  runtimeSignerPinPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.runtimeSignerPinPath),
  canonicalJournalPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.canonicalJournalPath),
  checkpointDatabasePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.checkpointDatabasePath),
  processEvidenceDatabasePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.processEvidenceDatabasePath),
  observerContentDirectory: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.observerContentDirectory),
  terminalLocatorDirectory: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.terminalLocatorDirectory),
  observerStoreDirectory: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.observerStoreDirectory),
  logPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.logPath),
  serviceName: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.serviceName),
  systemdUnit: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit),
  systemdUnitPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnitPath),
  releaseEnvironmentPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.releaseEnvironmentPath),
  launcherSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  productionLauncherSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  deploymentBundleSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  catalogGenerationInputSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  familyCatalogSourceSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  runtimeCompositionSourceSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  strategyCatalogSourceSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  deploymentCompositionSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  deploymentSourceSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  runtimePolicySha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  runtimeBoundaryProjectionSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  executorStateSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  performanceProfileSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  performanceProfileHash: (value: unknown, path: string) => hashSchema.decode(value, path),
  qualifiedReleaseRunnerInputSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseIntentSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  candidateProofVerifierBindingSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  systemdUnitSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseEnvironmentSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  runtimeBindingSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  nominationQualificationDeploymentFactSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseAuthorityApprovalSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  runtimeSignerPinSha256: (value: unknown, path: string) => hashSchema.decode(value, path),
  runtimeExportSurfaceRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  dryRun: exactLiteral(true as const),
} as const;

const authorizationPayloadFields = {
  schemaVersion: exactLiteral(1 as const),
  kind: exactLiteral("aloha.pre-release-launch-authorization" as const),
  phase: exactLiteral("pre-release" as const),
  roundRole: (value: unknown, path: string) => {
    if (value !== "restart-probe" && value !== "qualification-final") {
      throw new TypeError(`invalid pre-release round role at ${path}`);
    }
    return value;
  },
  predecessor: decodePredecessor,
  candidateReleaseCommit: (value: unknown, path: string) => gitSha40Schema.decode(value, path),
  runtimeBindingId: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseProvenanceHash: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseAuthorityApprovalId: (value: unknown, path: string) => hashSchema.decode(value, path),
  releaseRoleManifestRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  boundaryRunnerEntrypointId: (value: unknown, path: string) => nonEmptyStringSchema.decode(value, path),
  boundaryRunnerClosureDigest: (value: unknown, path: string) => hashSchema.decode(value, path),
  boundaryRunnerImplementationExportDigest: (value: unknown, path: string) => hashSchema.decode(value, path),
  controllerBoundaryEvidenceRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  stagingArtifactSetRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  stagingManifestRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  runtimeExportSurfaceRoot: (value: unknown, path: string) => hashSchema.decode(value, path),
  repositoryRoot: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.repositoryRoot),
  artifactRoot: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.artifactRoot),
  manifestPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.manifestPath),
  canonicalJournalPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.canonicalJournalPath),
  checkpointDatabasePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.checkpointDatabasePath),
  processEvidenceDatabasePath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.processEvidenceDatabasePath),
  observerContentDirectory: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.observerContentDirectory),
  terminalLocatorDirectory: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.terminalLocatorDirectory),
  observerStoreDirectory: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.observerStoreDirectory),
  logPath: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.logPath),
  serviceName: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.serviceName),
  systemdUnit: exactFixed(PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit),
  dryRun: exactLiteral(true as const),
  allowedTerminal: (value: unknown, path: string) => {
    if (value !== "restart-probe-drained" && value !== "qualification-facts-observed") {
      throw new TypeError(`invalid pre-release allowed terminal at ${path}`);
    }
    return value;
  },
  permissions: decodePermissions,
  issuedAtUnixNs: (value: unknown, path: string) => decimalStringSchema.decode(value, path),
  expiresAtUnixNs: (value: unknown, path: string) => decimalStringSchema.decode(value, path),
  nonce: (value: unknown, path: string) => hashSchema.decode(value, path),
} as const;

export function decodePreReleaseStagingManifestV1(value: unknown): PreReleaseStagingManifestV1 {
  const decoded = decodeExactObject(value, manifestFields) as PreReleaseStagingManifestV1;
  if (decoded.runtimeExportSurfaceRoot !== PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1) {
    throw new TypeError("pre-release runtime export surface mismatch");
  }
  return decoded;
}

export function decodePreReleaseLaunchAuthorizationPayloadV1(
  value: unknown,
): PreReleaseLaunchAuthorizationPayloadV1 {
  const decoded = decodeExactObject(value, authorizationPayloadFields) as PreReleaseLaunchAuthorizationPayloadV1;
  if (decoded.nonce === ZERO_HASH) throw new TypeError("pre-release authorization nonce must be non-zero");
  if (BigInt(decoded.issuedAtUnixNs) >= BigInt(decoded.expiresAtUnixNs)) {
    throw new TypeError("pre-release authorization validity interval must be positive");
  }
  if (decoded.runtimeExportSurfaceRoot !== PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1) {
    throw new TypeError("pre-release authorization runtime export surface mismatch");
  }
  if ((decoded.roundRole === "restart-probe") !== (decoded.predecessor === null)) {
    throw new TypeError("pre-release authorization predecessor does not match its round role");
  }
  const probe = decoded.roundRole === "restart-probe";
  const expectedTerminal = probe ? "restart-probe-drained" : "qualification-facts-observed";
  const permissions = decoded.permissions;
  if (decoded.allowedTerminal !== expectedTerminal
    || permissions.emitRestartMarker !== probe) {
    throw new TypeError("pre-release authorization permissions do not match its round role");
  }
  return decoded;
}

function payloadIdentity(payload: PreReleaseLaunchAuthorizationPayloadV1, signerKeyId: Hash) {
  const payloadHash = hashDomain("aloha/pre-release-launch-authorization/payload/v1", payload);
  const authorizationId = hashDomain(
    "aloha/pre-release-launch-authorization/id/v1",
    Object.freeze({ payloadHash, signerKeyId }),
  );
  return Object.freeze({ payloadHash, authorizationId });
}

export function preReleaseLaunchAuthorizationSigningBytesV1(
  payloadValue: PreReleaseLaunchAuthorizationPayloadV1,
  signerKeyIdValue: Hash,
): Uint8Array {
  const payload = decodePreReleaseLaunchAuthorizationPayloadV1(payloadValue);
  const signerKeyId = hashSchema.decode(signerKeyIdValue, "preReleaseAuthorization.signerKeyId");
  const identity = payloadIdentity(payload, signerKeyId);
  return encodeCanonicalBytes(Object.freeze({
    domain: "aloha/pre-release-launch-authorization/signing/v1",
    version: 1,
    ...payload,
    ...identity,
    signatureAlgorithm: "ed25519",
    signerKeyId,
  }));
}

export function createPreReleaseLaunchAuthorizationV1(
  payloadValue: PreReleaseLaunchAuthorizationPayloadV1,
  signerKeyIdValue: Hash,
  signatureHexValue: `0x${string}`,
): PreReleaseLaunchAuthorizationV1 {
  const payload = decodePreReleaseLaunchAuthorizationPayloadV1(payloadValue);
  const signerKeyId = hashSchema.decode(signerKeyIdValue, "preReleaseAuthorization.signerKeyId");
  if (!SIGNATURE.test(signatureHexValue)) throw new TypeError("pre-release authorization signature is invalid");
  return Object.freeze({
    ...payload,
    ...payloadIdentity(payload, signerKeyId),
    signatureAlgorithm: "ed25519" as const,
    signerKeyId,
    signatureHex: signatureHexValue,
  });
}

export function verifyPreReleaseLaunchAuthorizationSignatureV1(
  authorizationValue: PreReleaseLaunchAuthorizationV1,
  pin: RuntimeReleaseSignerPinV1,
): void {
  const authorization = decodePreReleaseLaunchAuthorizationV1(authorizationValue);
  if (authorization.signerKeyId !== pin.signerKeyId) {
    throw new TypeError("pre-release authorization signer pin mismatch");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pin.publicKeyHex.slice(2), "hex")]),
    format: "der",
    type: "spki",
  });
  const {
    payloadHash: _payloadHash,
    authorizationId: _authorizationId,
    signatureAlgorithm: _signatureAlgorithm,
    signerKeyId: _signerKeyId,
    signatureHex: _signatureHex,
    ...payload
  } = authorization;
  if (!verifySignature(
    null,
    Buffer.from(preReleaseLaunchAuthorizationSigningBytesV1(payload, authorization.signerKeyId)),
    publicKey,
    Buffer.from(authorization.signatureHex.slice(2), "hex"),
  )) {
    throw new TypeError("pre-release launch authorization signature invalid");
  }
}

export function decodePreReleaseLaunchAuthorizationV1(value: unknown): PreReleaseLaunchAuthorizationV1 {
  const decoded = decodeExactObject(value, {
    ...authorizationPayloadFields,
    payloadHash: (item, path) => hashSchema.decode(item, path),
    authorizationId: (item, path) => hashSchema.decode(item, path),
    signatureAlgorithm: exactLiteral("ed25519" as const),
    signerKeyId: (item, path) => hashSchema.decode(item, path),
    signatureHex: (item, path) => {
      if (typeof item !== "string" || !SIGNATURE.test(item)) throw new TypeError(`invalid signature at ${path}`);
      return item as `0x${string}`;
    },
  }) as PreReleaseLaunchAuthorizationV1;
  const payload = decodePreReleaseLaunchAuthorizationPayloadV1(Object.fromEntries(
    Object.keys(authorizationPayloadFields).map(key => [
      key,
      decoded[key as keyof PreReleaseLaunchAuthorizationPayloadV1],
    ]),
  ));
  const identity = payloadIdentity(payload, decoded.signerKeyId);
  if (decoded.payloadHash !== identity.payloadHash || decoded.authorizationId !== identity.authorizationId) {
    throw new TypeError("pre-release authorization identity mismatch");
  }
  return decoded;
}

export function hashPreReleaseStagingArtifactSetV1(
  entriesValue: readonly PreReleaseStagingArtifactIdentityV1[],
): Hash {
  const entries = entriesValue.map((entry, index) => decodeExactObject(entry, {
    name: (value, path) => {
      if (typeof value !== "string" || !PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.includes(value as never)) {
        throw new TypeError(`unknown pre-release artifact name at ${path}`);
      }
      return value as PreReleaseStagingArtifactNameV1;
    },
    installPath: (value, path) => nonEmptyStringSchema.decode(value, path),
    contentSha256: (value, path) => hashSchema.decode(value, path),
    byteLength: (value, path) => decimalStringSchema.decode(value, path),
  }, `preReleaseArtifacts[${index}]`));
  if (entries.length !== PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.length
    || entries.some((entry, index) => entry.name !== PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1[index])) {
    throw new TypeError("pre-release staging artifact denominator mismatch");
  }
  if (entries.some(entry => entry.installPath !== preReleaseStagingArtifactPathV1(entry.name))) {
    throw new TypeError("pre-release staging artifact path mismatch");
  }
  return hashDomain("aloha/pre-release-staging-artifact-set/v1", entries);
}

export function preReleaseStagingArtifactPathV1(name: PreReleaseStagingArtifactNameV1): string {
  switch (name) {
    case "aloha-searcher-pre-release.service": return PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnitPath;
    case "candidate-proof-verifier-binding.json": return PRE_RELEASE_STAGING_LAYOUT_V1.candidateProofVerifierBindingPath;
    case "catalog-generation.inputs.json": return PRE_RELEASE_STAGING_LAYOUT_V1.catalogGenerationInputPath;
    case "deployment-bundle.mjs": return PRE_RELEASE_STAGING_LAYOUT_V1.bundlePath;
    case "deployment-composition.mjs": return PRE_RELEASE_STAGING_LAYOUT_V1.deploymentCompositionPath;
    case "deployment-source.json": return PRE_RELEASE_STAGING_LAYOUT_V1.deploymentSourcePath;
    case "executor-state.json": return PRE_RELEASE_STAGING_LAYOUT_V1.executorStatePath;
    case "family-catalog.ts": return PRE_RELEASE_STAGING_LAYOUT_V1.familyCatalogSourcePath;
    case "nomination-qualification-deployment-fact.json": return PRE_RELEASE_STAGING_LAYOUT_V1.nominationQualificationDeploymentFactPath;
    case "performance-profile.json": return PRE_RELEASE_STAGING_LAYOUT_V1.performanceProfilePath;
    case "qualified-release-runner-input.json": return PRE_RELEASE_STAGING_LAYOUT_V1.qualifiedReleaseRunnerInputPath;
    case "release-authority-approval.json": return PRE_RELEASE_STAGING_LAYOUT_V1.releaseAuthorityApprovalPath;
    case "release-intent.json": return PRE_RELEASE_STAGING_LAYOUT_V1.releaseIntentPath;
    case "runtime-policy.json": return PRE_RELEASE_STAGING_LAYOUT_V1.runtimePolicyPath;
    case "runtime-boundary-projection.json": return PRE_RELEASE_STAGING_LAYOUT_V1.runtimeBoundaryProjectionPath;
    case "runtime-composition.ts": return PRE_RELEASE_STAGING_LAYOUT_V1.runtimeCompositionSourcePath;
    case "runtime-release-binding.json": return PRE_RELEASE_STAGING_LAYOUT_V1.runtimeBindingPath;
    case "runtime-release-signer-pin.json": return PRE_RELEASE_STAGING_LAYOUT_V1.runtimeSignerPinPath;
    case "searcher-pre-release.env": return PRE_RELEASE_STAGING_LAYOUT_V1.releaseEnvironmentPath;
    case "staging-manifest.json": return PRE_RELEASE_STAGING_LAYOUT_V1.manifestPath;
    case "strategy-catalog.ts": return PRE_RELEASE_STAGING_LAYOUT_V1.strategyCatalogSourcePath;
    case "pre-release-owner.mjs": return PRE_RELEASE_STAGING_LAYOUT_V1.launcherPath;
    case "production-launcher.mjs": return PRE_RELEASE_STAGING_LAYOUT_V1.productionLauncherPath;
  }
}
