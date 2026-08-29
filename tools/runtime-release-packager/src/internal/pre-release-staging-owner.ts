import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
} from "../../../../packages/canonical-codec/src/index.ts";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  installQualifiedReleaseAcceptanceRunnerV1,
  readAuthorizedQualifiedReleaseRunnerWireV1,
  readQualifiedReleaseLineageObservationV1,
  type InstallQualifiedReleaseAcceptanceRunnerInputV1,
  type QualifiedReleaseAcceptanceRunnerCapabilityV1,
} from "../assembled-release-acceptance.ts";
import {
  readFrozenPreReleaseBQualificationCapabilityV1,
  type FrozenPreReleaseBQualificationCapabilityV1,
} from "./pre-release-b-qualification-state.ts";
import {
  issueFrozenPreReleaseBTerminalPhysicalObservationV1,
  issueFrozenPreReleaseBTerminalSnapshotTrustV1,
} from "./pre-release-b-terminal-snapshot-owner.ts";
import type {
  ProductionTerminalPhaseSnapshotTrustCapabilityV1,
} from "../../../../acceptance/collectors/src/internal/terminal-phase-snapshot-trust-state.ts";
import type {
  PreReleaseBTerminalPhysicalObservationCapabilityV1,
} from "../pre-release-b-terminal-physical-observation.ts";
import { issueReleaseOwnedObserverSnapshotSinkV1 } from "../../../../acceptance/collectors/src/internal/release-owned-observer-snapshot.ts";
import {
  ProductionTerminalPhaseLocatorIndexV1,
  type ProductionTerminalPhaseDurableDiscoveryV1,
} from "../../../../acceptance/collectors/src/terminal-phase-locator-index.ts";
import {
  decodeRuntimeReleaseBindingV1,
} from "../../../../specs/release-authority/src/index.ts";
import {
  issueReleaseOwnedObserverStoreV1,
  readReleaseOwnedObserverStoreV1,
} from "../../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import { issueProductionPerformanceMaterialObserverPortV1 } from "../../../../acceptance/collectors/src/production-performance-material-observer.ts";
import { issueProductionFrozenTerminalSelectionObserverPortV1 } from "../../../../acceptance/collectors/src/production-terminal-selection-observer.ts";
import { issueProductionRuntimeRestartMaterialObserverPortV1 } from "../../../../acceptance/collectors/src/production-runtime-boundary-observers.ts";
import { issuePreReleaseAdvisoryMaterialCapabilityV1 } from "./pre-release-runtime-receipt-state.ts";
import type { PreReleaseAdvisoryMaterialCapabilityV1 } from "../pre-release-staging-contract.ts";
import {
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1,
} from "../../../pre-release-restart-controller/src/spec.ts";
import {
  preReleaseAuthorizationClaimIdV1,
  type PreReleaseProcessImportReceiptV1,
  type PreReleaseAdvisoryMaterialProjectionV1,
  type PreReleaseStagingArtifactIdentityV1,
  type PreReleaseStagingArtifactNameV1,
} from "../pre-release-staging-contract.ts";
import {
  PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1,
  PRE_RELEASE_STAGING_LAYOUT_V1,
} from "./pre-release-staging-schema.ts";

export type ImportedFrozenPreReleaseBRuntimeCapabilityV1 = object;

interface ImportedFrozenPreReleaseBRuntimeStateV1 {
  readonly projection: PreReleaseAdvisoryMaterialProjectionV1;
  readonly qualifiedReleaseRunner: QualifiedReleaseAcceptanceRunnerCapabilityV1;
  readonly stagingArtifactBytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>;
  readonly terminalSnapshotTrust: ProductionTerminalPhaseSnapshotTrustCapabilityV1;
  readonly terminalDiscovery: ProductionTerminalPhaseDurableDiscoveryV1;
  readonly terminalPhysicalObservation: PreReleaseBTerminalPhysicalObservationCapabilityV1;
  readonly checkpointSnapshotPublication: ReturnType<typeof readFrozenPreReleaseBQualificationCapabilityV1>["snapshots"]["checkpoint"];
}

const importedFrozenRuntimes = new WeakMap<object, ImportedFrozenPreReleaseBRuntimeStateV1>();
const consumedImportedFrozenRuntimes = new WeakSet<object>();

function exactArtifactDenominator(
  identities: readonly PreReleaseStagingArtifactIdentityV1[],
  bytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>,
): Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>> {
  const names = Reflect.ownKeys(bytes);
  if (identities.length !== PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.length
    || names.length !== PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.length
    || names.some(name => typeof name !== "string"
      || !PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.includes(name as PreReleaseStagingArtifactNameV1))) {
    throw new TypeError("frozen pre-release B staging artifact denominator mismatch");
  }
  const copied = {} as Record<PreReleaseStagingArtifactNameV1, Uint8Array>;
  for (const [index, name] of PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.entries()) {
    const identity = identities[index];
    const value = bytes[name];
    if (identity === undefined || identity.name !== name || !(value instanceof Uint8Array)) {
      throw new TypeError(`frozen pre-release B staging artifact is absent or out of order: ${name}`);
    }
    if (realpathSync(identity.installPath) !== identity.installPath || !lstatSync(identity.installPath).isFile()) {
      throw new TypeError(`frozen pre-release B staging artifact path is not canonical: ${name}`);
    }
    const before = statSync(identity.installPath, { bigint: true });
    const concrete = new Uint8Array(readFileSync(identity.installPath));
    const after = statSync(identity.installPath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.uid !== 0n || (after.mode & 0o022n) !== 0n
      || after.size !== BigInt(concrete.byteLength)
      || !Buffer.from(concrete).equals(Buffer.from(value))) {
      throw new TypeError(`frozen pre-release B staged artifact changed during owner reopen: ${name}`);
    }
    if (identity.contentSha256 !== sha256Hex(concrete)
      || identity.byteLength !== String(concrete.byteLength)) {
      throw new TypeError(`frozen pre-release B staging artifact identity mismatch: ${name}`);
    }
    copied[name] = concrete;
  }
  return Object.freeze(copied);
}

function reopenRootSqliteSnapshot(
  publication: ReturnType<typeof readFrozenPreReleaseBQualificationCapabilityV1>["snapshots"]["processEvidence"],
  expectedPath: string,
) {
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0
    || publication.snapshotPath !== expectedPath
    || realpathSync(expectedPath) !== expectedPath || !lstatSync(expectedPath).isFile()) {
    throw new TypeError("frozen pre-release B snapshot is not the fixed root-owned file");
  }
  const before = statSync(expectedPath, { bigint: true });
  const bytes = new Uint8Array(readFileSync(expectedPath));
  const afterRead = statSync(expectedPath, { bigint: true });
  if (before.dev !== afterRead.dev || before.ino !== afterRead.ino || before.size !== afterRead.size
    || before.mtimeNs !== afterRead.mtimeNs || before.ctimeNs !== afterRead.ctimeNs
    || afterRead.uid !== 0n || afterRead.gid !== 0n || (afterRead.mode & 0o777n) !== 0o600n
    || afterRead.size !== BigInt(bytes.byteLength)
    || publication.device !== String(afterRead.dev) || publication.inode !== String(afterRead.ino)
    || publication.byteLength !== String(bytes.byteLength)
    || publication.contentSha256 !== sha256Hex(bytes)
    || publication.uid !== "0" || publication.gid !== "0" || publication.mode !== "384"
    || publication.fileFsynced !== true || publication.directoryFsynced !== true) {
    throw new TypeError("frozen pre-release B snapshot publication does not match reopened bytes");
  }
  const database = new DatabaseSync(expectedPath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const integrity = database.prepare("PRAGMA integrity_check").all() as readonly { integrity_check?: unknown }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new TypeError("frozen pre-release B snapshot SQLite integrity check failed");
    }
  } finally {
    database.close();
  }
  const afterSqlite = statSync(expectedPath, { bigint: true });
  if (afterRead.dev !== afterSqlite.dev || afterRead.ino !== afterSqlite.ino
    || afterRead.size !== afterSqlite.size || afterRead.mtimeNs !== afterSqlite.mtimeNs
    || afterRead.ctimeNs !== afterSqlite.ctimeNs
    || sha256Hex(new Uint8Array(readFileSync(expectedPath))) !== publication.contentSha256) {
    throw new TypeError("frozen pre-release B snapshot changed across SQLite verification");
  }
  return publication;
}

function installFrozenQualifiedRunner(
  qualification: ReturnType<typeof readFrozenPreReleaseBQualificationCapabilityV1>,
  artifactBytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>,
): QualifiedReleaseAcceptanceRunnerCapabilityV1 {
  const wireBytes = artifactBytes["qualified-release-runner-input.json"];
  const wire = decodeCanonicalJson(wireBytes) as unknown as ReturnType<typeof readAuthorizedQualifiedReleaseRunnerWireV1>;
  const runner = installPreReleaseQualifiedReleaseRunnerV1(Object.freeze({
    boundaryReceipt: qualification.boundaryReceipt,
    runtimeBinding: wire.runtimeBinding,
    runtimeSignerPin: wire.runtimeSignerPin,
    externalQualifications: wire.externalQualifications,
    predicateMaterials: wire.predicateMaterials,
  }));
  if (!Buffer.from(readPreReleaseQualifiedRunnerInputBytesV1(runner)).equals(Buffer.from(wireBytes))) {
    throw new TypeError("staged qualified release runner wire does not equal the genuine Boundary-derived runner");
  }
  return runner;
}

function processImportReceipt(
  qualification: ReturnType<typeof readFrozenPreReleaseBQualificationCapabilityV1>,
  runner: QualifiedReleaseAcceptanceRunnerCapabilityV1,
  artifactBytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>,
): PreReleaseProcessImportReceiptV1 {
  const { authorization, authorizationClaim, manifest, ready, systemd, process, frozen, snapshots, log } = qualification;
  const lineage = readQualifiedReleaseLineageObservationV1(runner);
  const processEvidence = reopenRootSqliteSnapshot(
    snapshots.processEvidence,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.bProcessEvidenceSnapshotPath,
  );
  const checkpoint = reopenRootSqliteSnapshot(
    snapshots.checkpoint,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.bCheckpointSnapshotPath,
  );
  if (authorization.roundRole !== "qualification-final"
    || authorizationClaim.roundRole !== "qualification-final"
    || authorizationClaim.authorizationId !== authorization.authorizationId
    || authorizationClaim.claimId !== preReleaseAuthorizationClaimIdV1(authorization)
    || authorization.candidateReleaseCommit !== lineage.boundary.candidateReleaseCommit
    || authorization.runtimeBindingId !== lineage.runtimeBinding.bindingId
    || authorization.releaseAuthorityApprovalId !== lineage.releaseAuthorityApproval.approvalId
    || authorization.releaseRoleManifestRoot !== lineage.boundary.releaseRoleManifestRoot
    || authorization.boundaryRunnerEntrypointId !== lineage.boundary.qualifiedRunnerEntrypointId
    || authorization.boundaryRunnerClosureDigest !== lineage.boundary.qualifiedRunnerClosureDigest
    || authorization.boundaryRunnerImplementationExportDigest !== lineage.boundary.qualifiedRunnerImplementationExportDigest
    || manifest.candidateReleaseCommit !== authorization.candidateReleaseCommit
    || manifest.runtimeBindingId !== authorization.runtimeBindingId
    || manifest.releaseProvenanceHash !== authorization.releaseProvenanceHash
    || manifest.controllerBoundaryEvidenceRoot !== authorization.controllerBoundaryEvidenceRoot
    || manifest.runtimeExportSurfaceRoot !== authorization.runtimeExportSurfaceRoot
    || manifest.deploymentBundleSha256 !== sha256Hex(artifactBytes["deployment-bundle.mjs"])
    || manifest.nominationQualificationDeploymentFactPath !== PRE_RELEASE_STAGING_LAYOUT_V1.nominationQualificationDeploymentFactPath
    || manifest.nominationQualificationDeploymentFactSha256 !== sha256Hex(artifactBytes["nomination-qualification-deployment-fact.json"])
    || manifest.launcherSha256 !== sha256Hex(artifactBytes["pre-release-owner.mjs"])) {
    throw new TypeError("frozen pre-release B release lineage does not exact-join the staged qualified runner");
  }
  if (frozen.systemdFreezerState !== "frozen"
    || frozen.cgroupFreeze !== "1"
    || systemd.activeState !== "active"
    || systemd.subState !== "running"
    || systemd.mainPid !== process.pid
    || systemd.invocationId !== process.invocationId
    || ready.processAnchor.pid !== process.pid
    || ready.processAnchor.processStartTicks !== process.processStartTicks
    || ready.processAnchor.bootIdHash !== process.bootIdHash
    || ready.processAnchor.executableHash !== process.executableSha256
    || processEvidence.snapshotPath !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.bProcessEvidenceSnapshotPath
    || checkpoint.snapshotPath !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.bCheckpointSnapshotPath
    || processEvidence.uid !== "0" || processEvidence.gid !== "0" || processEvidence.mode !== "384"
    || checkpoint.uid !== "0" || checkpoint.gid !== "0" || checkpoint.mode !== "384"
    || log.path !== manifest.logPath
    || log.device !== (ready.readyEvent.logStart as Readonly<Record<string, unknown>>).device
    || log.inode !== (ready.readyEvent.logStart as Readonly<Record<string, unknown>>).inode
    || log.startInclusive !== (ready.readyEvent.logStart as Readonly<Record<string, unknown>>).startInclusive
    || BigInt(log.startInclusive) >= BigInt(log.endExclusive)) {
    throw new TypeError("frozen pre-release B physical process, snapshot, or log lineage mismatch");
  }
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.pre-release-process-import-receipt" as const,
    phase: "pre-release" as const,
    authorizationId: authorization.authorizationId,
    authorizationClaimId: authorizationClaim.claimId,
    candidateReleaseCommit: authorization.candidateReleaseCommit,
    runtimeBindingId: authorization.runtimeBindingId,
    releaseProvenanceHash: authorization.releaseProvenanceHash,
    stagingArtifactSetRoot: authorization.stagingArtifactSetRoot,
    stagingManifestRoot: authorization.stagingManifestRoot,
    stagingArtifacts: qualification.stagingArtifacts,
    processAnchor: ready.processAnchor,
    processAnchorHash: ready.ready.processAnchorHash,
    entrypointPath: manifest.launcherPath,
    entrypointSha256: manifest.launcherSha256,
    bundlePath: manifest.bundlePath,
    bundleSha256: manifest.deploymentBundleSha256,
    runtimeExportSurfaceRoot: manifest.runtimeExportSurfaceRoot,
    manifestPath: manifest.manifestPath,
    processEvidenceDatabasePath: processEvidence.snapshotPath,
    checkpointDatabasePath: checkpoint.snapshotPath,
    observerStoreDirectory: manifest.observerStoreDirectory,
    databaseDevice: processEvidence.device,
    databaseInode: processEvidence.inode,
    databaseContentSha256: processEvidence.contentSha256,
    databaseStoreIdentityHash: hashDomain("aloha/pre-release-runtime-store-identity/v1", {
      authorizationId: authorization.authorizationId,
      databasePath: processEvidence.snapshotPath,
      device: processEvidence.device,
      inode: processEvidence.inode,
    }),
    serviceName: manifest.serviceName,
    systemdUnit: manifest.systemdUnit,
    systemdInvocationId: systemd.invocationId,
    logPath: log.path,
    logDevice: log.device,
    logInode: log.inode,
    logStartInclusive: log.startInclusive,
    logEndExclusive: log.endExclusive,
    logContentSha256: log.contentSha256,
    importedAtUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
    dryRun: true as const,
  });
  return Object.freeze({
    ...payload,
    receiptId: hashDomain("aloha/pre-release-process-import-receipt/id/v1", payload as never),
  });
}

/** Import the exact frozen B process without importing caller-authored facts.
 * The returned capability is intentionally incomplete until fixed collector
 * owners attach independently verified material in the same frozen window. */
export async function importFrozenPreReleaseBRuntimeV1(
  capability: FrozenPreReleaseBQualificationCapabilityV1,
): Promise<ImportedFrozenPreReleaseBRuntimeCapabilityV1> {
  if (arguments.length !== 1) throw new TypeError("frozen pre-release B import accepts only one opaque qualification");
  const qualification = readFrozenPreReleaseBQualificationCapabilityV1(capability);
  const stagingArtifactBytes = exactArtifactDenominator(
    qualification.stagingArtifacts,
    qualification.stagingArtifactBytes,
  );
  const qualifiedReleaseRunner = installFrozenQualifiedRunner(qualification, stagingArtifactBytes);
  const terminalSnapshotTrust = issueFrozenPreReleaseBTerminalSnapshotTrustV1(capability);
  const runtimeBinding = decodeRuntimeReleaseBindingV1(stagingArtifactBytes["runtime-release-binding.json"]);
  const snapshotSink = issueReleaseOwnedObserverSnapshotSinkV1({
    binding: runtimeBinding,
    sourceDirectory: qualification.snapshots.observerContent.sourceDirectory,
    snapshotDirectory: qualification.snapshots.observerContent.snapshotDirectory,
  });
  const snapshotIndex = new ProductionTerminalPhaseLocatorIndexV1({
    directory: qualification.snapshots.terminalLocators.snapshotDirectory,
    sink: snapshotSink,
  });
  const terminalDiscovery = await snapshotIndex.readSnapshot(terminalSnapshotTrust);
  const processReceipt = processImportReceipt(
    qualification,
    qualifiedReleaseRunner,
    stagingArtifactBytes,
  );
  const terminalPhysicalObservation = issueFrozenPreReleaseBTerminalPhysicalObservationV1(
    capability,
    terminalSnapshotTrust,
    terminalDiscovery,
    processReceipt.receiptId,
  );
  const projection: PreReleaseAdvisoryMaterialProjectionV1 = Object.freeze({
    phase: "pre-release",
    locators: Object.freeze({
      repositoryRoot: qualification.manifest.repositoryRoot,
      artifactRoot: qualification.manifest.artifactRoot,
      manifestPath: qualification.manifest.manifestPath,
      processEvidenceDatabasePath: qualification.snapshots.processEvidence.snapshotPath,
      checkpointDatabasePath: qualification.snapshots.checkpoint.snapshotPath,
      observerStoreDirectory: qualification.manifest.observerStoreDirectory,
      logPath: qualification.log.path,
      authorizationPath: PRE_RELEASE_STAGING_LAYOUT_V1.authorizationPath,
      restartProbeAuthorizationPath: PRE_RELEASE_STAGING_LAYOUT_V1.restartProbeAuthorizationPath,
      qualificationFinalAuthorizationPath: PRE_RELEASE_STAGING_LAYOUT_V1.qualificationFinalAuthorizationPath,
      authorizationLedgerPath: PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath,
      advisoryJudgmentPath: PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath,
    }),
    signedAuthorization: qualification.authorization,
    authorizationClaim: qualification.authorizationClaim,
    stagingArtifactSetRoot: qualification.authorization.stagingArtifactSetRoot,
    stagingManifestRoot: qualification.authorization.stagingManifestRoot,
    stagingArtifacts: qualification.stagingArtifacts,
    processImportReceipt: processReceipt,
  });
  const imported = Object.freeze(Object.create(null)) as ImportedFrozenPreReleaseBRuntimeCapabilityV1;
  importedFrozenRuntimes.set(imported, Object.freeze({
    projection,
    qualifiedReleaseRunner,
    stagingArtifactBytes,
    terminalSnapshotTrust,
    terminalDiscovery,
    terminalPhysicalObservation,
    checkpointSnapshotPublication: qualification.snapshots.checkpoint,
  }));
  return imported;
}

/** Owner-internal reader for the subsequent fixed collector/material join. */
export function readImportedFrozenPreReleaseBRuntimeV1(
  capability: ImportedFrozenPreReleaseBRuntimeCapabilityV1,
): ImportedFrozenPreReleaseBRuntimeStateV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("imported frozen pre-release B runtime capability is invalid");
  }
  const state = importedFrozenRuntimes.get(capability);
  if (state === undefined) throw new TypeError("frozen pre-release B runtime was not staging-owner-imported");
  return state;
}

/** Final-runner-only extraction of the narrow FactLog observation. The broad
 * imported runtime and terminal snapshot state remain private. */
export function readImportedFrozenPreReleaseBTerminalPhysicalObservationV1(
  capability: ImportedFrozenPreReleaseBRuntimeCapabilityV1,
): PreReleaseBTerminalPhysicalObservationCapabilityV1 {
  return readImportedFrozenPreReleaseBRuntimeV1(capability).terminalPhysicalObservation;
}

/** Close the frozen-B import into the sole process-local receipt consumed by
 * advisory acceptance. The raw SQLite/checkpoint paths and durable terminal
 * discovery are retained; no producer verdict is stored in the receipt. */
export function issueImportedFrozenPreReleaseBAdvisoryMaterialV1(
  capability: ImportedFrozenPreReleaseBRuntimeCapabilityV1,
): PreReleaseAdvisoryMaterialCapabilityV1 {
  const state = readImportedFrozenPreReleaseBRuntimeV1(capability);
  if (consumedImportedFrozenRuntimes.has(capability)) {
    throw new TypeError("frozen pre-release B import was already consumed into advisory material");
  }
  const runtimeBinding = decodeRuntimeReleaseBindingV1(state.stagingArtifactBytes["runtime-release-binding.json"]);
  const observerStore = issueReleaseOwnedObserverStoreV1(Object.freeze({
    directory: state.projection.locators.observerStoreDirectory,
    observedStoreEpoch: BigInt(runtimeBinding.bindingId).toString(10),
    authority: Object.freeze({
      bindingId: runtimeBinding.bindingId,
      releaseAuthorityApprovalId: runtimeBinding.releaseAuthorityApprovalId,
      qualificationRegistryRoot: runtimeBinding.qualificationRegistryRoot,
      predicateCompositionRootDigest: runtimeBinding.predicateCompositionRootDigest,
      releaseRoleManifestRoot: runtimeBinding.releaseRoleManifestRoot,
      candidateReleaseCommit: runtimeBinding.candidateReleaseCommit,
    }),
  }));
  const sink = readReleaseOwnedObserverStoreV1(observerStore).sink;
  const performanceObserver = issueProductionPerformanceMaterialObserverPortV1(
    state.qualifiedReleaseRunner,
  );
  const terminalSelectionObserver = issueProductionFrozenTerminalSelectionObserverPortV1({
    databasePath: state.projection.locators.processEvidenceDatabasePath,
    sink,
    durableDiscovery: state.terminalDiscovery,
    qualifiedReleaseRunner: state.qualifiedReleaseRunner,
  });
  const runtimeRestartObserver = issueProductionRuntimeRestartMaterialObserverPortV1({
    productionEvidenceDatabasePath: state.projection.locators.processEvidenceDatabasePath,
    checkpointDatabasePath: state.projection.locators.checkpointDatabasePath,
    sink,
    qualifiedReleaseRunner: state.qualifiedReleaseRunner,
  });
  const advisoryMaterial = issuePreReleaseAdvisoryMaterialCapabilityV1(state.projection, Object.freeze({
    qualifiedReleaseRunner: state.qualifiedReleaseRunner,
    observerStore,
    performanceObserver,
    durableTerminalDiscovery: state.terminalDiscovery,
    terminalSelectionObserver,
    runtimeRestartObserver,
    checkpointSnapshotPublication: state.checkpointSnapshotPublication,
    stagingArtifactBytes: state.stagingArtifactBytes,
  }));
  consumedImportedFrozenRuntimes.add(capability);
  return advisoryMaterial;
}

/** Controller-only Boundary-backed runner installation. The resulting
 * process-local capability never crosses into the systemd PID. */
export function installPreReleaseQualifiedReleaseRunnerV1(
  input: InstallQualifiedReleaseAcceptanceRunnerInputV1,
): QualifiedReleaseAcceptanceRunnerCapabilityV1 {
  return installQualifiedReleaseAcceptanceRunnerV1(
    input,
  );
}

/** Durable signed staging projection derived only from a genuine
 * Boundary-authorized process-local runner. */
export function readPreReleaseQualifiedRunnerInputBytesV1(
  runner: QualifiedReleaseAcceptanceRunnerCapabilityV1,
): Uint8Array {
  return encodeCanonicalBytes(readAuthorizedQualifiedReleaseRunnerWireV1(runner));
}

export {
  PRE_RELEASE_RUNTIME_EXPORT_SURFACE_ROOT_V1,
  PRE_RELEASE_STAGING_LAYOUT_V1,
  createPreReleaseLaunchAuthorizationV1,
  preReleaseLaunchAuthorizationSigningBytesV1,
  verifyPreReleaseLaunchAuthorizationSignatureV1,
} from "./pre-release-staging-schema.ts";

export type {
  PreReleaseLaunchAuthorizationPayloadV1,
  PreReleaseLaunchAuthorizationV1,
  PreReleaseStagingManifestV1,
} from "./pre-release-staging-schema.ts";
