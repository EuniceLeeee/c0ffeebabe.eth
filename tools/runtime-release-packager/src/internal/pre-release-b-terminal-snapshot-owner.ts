import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertHash,
  decodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { observeProductionPerformanceDatabaseV1 } from "../../../../packages/performance-collector/src/raw-sqlite-observer.ts";
import {
  runtimeReleaseObserverStoreIdentityV1,
} from "../../../../packages/runtime-release-authority/src/internal/observer-store-owner.ts";
import {
  decodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
} from "../../../../specs/release-authority/src/index.ts";
import { observeFullFamilyReleaseArtifacts } from "../../../../acceptance/collectors/src/full-family-release-artifacts.ts";
import {
  registerProductionTerminalPhaseSnapshotTrustCapabilityV1,
  readProductionTerminalPhaseSnapshotTrustCapabilityV1,
  type ProductionTerminalPhaseSnapshotTrustCapabilityV1,
} from "../../../../acceptance/collectors/src/internal/terminal-phase-snapshot-trust-state.ts";
import {
  assertProductionTerminalPhaseDurableDiscoveryV1,
  type ProductionTerminalPhaseDurableDiscoveryV1,
} from "../../../../acceptance/collectors/src/terminal-phase-locator-index.ts";
import {
  SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1,
} from "../../../../specs/evidence/src/six-step.ts";
import type { PreReleaseControllerDirectorySnapshotV1 } from "../../../pre-release-restart-controller/src/spec.ts";
import {
  readFrozenPreReleaseBQualificationCapabilityV1,
  type FrozenPreReleaseBQualificationCapabilityV1,
} from "./pre-release-b-qualification-state.ts";
import { PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 } from "../../../pre-release-restart-controller/src/spec.ts";
import { observeFrozenPreReleaseBActiveReadyGraphV1 } from "./pre-release-b-active-ready-graph-owner.ts";
import {
  buildProductionReleaseAcceptanceAdvisoryFactIndexV1,
} from "../production-workflow.ts";
import {
  registerPreReleaseBTerminalPhysicalObservationV1,
} from "./pre-release-b-terminal-physical-observation-state.ts";
import type {
  PreReleaseBTerminalPhysicalObservationCapabilityV1,
  PreReleaseBTerminalPhysicalObservationV1,
} from "../pre-release-b-terminal-physical-observation.ts";

export function assertPreReleaseBDirectorySnapshotEntrySetRootV1(
  snapshot: PreReleaseControllerDirectorySnapshotV1,
): void {
  const entrySetRoot = hashDomain("aloha/pre-release-directory-snapshot-entry-set/v1", {
    snapshotKind: snapshot.snapshotKind,
    observerStoreIdentityHash: snapshot.observerStoreIdentityHash,
    entries: snapshot.entries.map(entry => ({
      name: entry.name,
      contentSha256: entry.contentSha256,
      byteLength: entry.byteLength,
    })),
  });
  if (entrySetRoot !== snapshot.entrySetRoot) {
    throw new TypeError("pre-release B terminal snapshot entry-set root mismatch");
  }
}

interface PreReleaseBSnapshotEntryPreflightV1 {
  readonly descriptor: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly byteLength: bigint;
  readonly modifiedAtUnixNs: bigint;
  readonly changedAtUnixNs: bigint;
}

function readExactDescriptorBytes(descriptor: number, byteLength: bigint): Uint8Array {
  if (byteLength < 0n || byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("pre-release B terminal snapshot byte length cannot be allocated exactly");
  }
  const bytes = new Uint8Array(Number(byteLength));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) throw new TypeError("pre-release B terminal snapshot entry was truncated during read");
    offset += count;
  }
  return bytes;
}

function closeSixStepBoundarySnapshotResources(
  resources: ReadonlyMap<string, PreReleaseBSnapshotEntryPreflightV1>,
): void {
  for (const resource of resources.values()) closeSync(resource.descriptor);
}

function preflightSixStepBoundarySnapshotResources(
  snapshot: PreReleaseControllerDirectorySnapshotV1,
  names: readonly string[],
): ReadonlyMap<string, PreReleaseBSnapshotEntryPreflightV1> {
  if (snapshot.snapshotKind !== "six-step-boundaries") {
    throw new TypeError("pre-release B Six-Step resource preflight requires the boundary snapshot");
  }
  const limits = SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1;
  if (names.length === 0 || names.length !== snapshot.entries.length) {
    throw new TypeError("pre-release B Six-Step boundary snapshot denominator changed");
  }
  if (names.length > limits.maxEntries) {
    throw new TypeError("pre-release B Six-Step boundary snapshot entry count exceeds policy");
  }
  let totalBytes = 0n;
  const result = new Map<string, PreReleaseBSnapshotEntryPreflightV1>();
  try {
    for (const [index, entry] of snapshot.entries.entries()) {
      if (names[index] !== entry.name) {
        throw new TypeError("pre-release B Six-Step boundary snapshot denominator changed");
      }
      const path = join(snapshot.snapshotDirectory, entry.name);
      if (realpathSync(path) !== path || !lstatSync(path).isFile()) {
        throw new TypeError("pre-release B Six-Step boundary snapshot entry is not a physical file");
      }
      const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const observed = fstatSync(descriptor, { bigint: true });
        if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1n
          || observed.size > BigInt(limits.maxEntryBytes)
          || entry.byteLength !== String(observed.size)
          || entry.device !== String(observed.dev) || entry.inode !== String(observed.ino)) {
          throw new TypeError("pre-release B Six-Step boundary snapshot entry exceeds policy or changed");
        }
        totalBytes += observed.size;
        if (totalBytes > BigInt(limits.maxTotalBytes)) {
          throw new TypeError("pre-release B Six-Step boundary snapshot aggregate exceeds policy");
        }
        result.set(entry.name, Object.freeze({
          descriptor,
          device: observed.dev,
          inode: observed.ino,
          byteLength: observed.size,
          modifiedAtUnixNs: observed.mtimeNs,
          changedAtUnixNs: observed.ctimeNs,
        }));
      } catch (error) {
        closeSync(descriptor);
        throw error;
      }
    }
  } catch (error) {
    closeSixStepBoundarySnapshotResources(result);
    throw error;
  }
  return result;
}

/** Testable projection of the production pre-read physical resource check.
 * It reads directory and inode metadata only; file content is never opened
 * for reading until this complete denominator preflight has succeeded. */
export function assertPreReleaseBSixStepBoundarySnapshotResourcesV1(
  snapshot: PreReleaseControllerDirectorySnapshotV1,
): void {
  if (realpathSync(snapshot.snapshotDirectory) !== snapshot.snapshotDirectory
    || !lstatSync(snapshot.snapshotDirectory).isDirectory()) {
    throw new TypeError("pre-release B Six-Step boundary snapshot directory is not physical");
  }
  const names = readdirSync(snapshot.snapshotDirectory).sort();
  const resources = preflightSixStepBoundarySnapshotResources(snapshot, names);
  closeSixStepBoundarySnapshotResources(resources);
}

export function readPreReleaseBSixStepBoundarySnapshotResourcesForTestV1(
  snapshot: PreReleaseControllerDirectorySnapshotV1,
  afterPreflightForTest: (() => void) | null = null,
): void {
  const names = readdirSync(snapshot.snapshotDirectory).sort();
  const resources = preflightSixStepBoundarySnapshotResources(snapshot, names);
  try {
    afterPreflightForTest?.();
    for (const entry of snapshot.entries) {
      const resource = resources.get(entry.name);
      if (resource === undefined) throw new TypeError("pre-release B Six-Step boundary snapshot denominator changed");
      const bytes = readExactDescriptorBytes(resource.descriptor, resource.byteLength);
      const after = fstatSync(resource.descriptor, { bigint: true });
      if (resource.device !== after.dev || resource.inode !== after.ino
        || resource.byteLength !== after.size || resource.modifiedAtUnixNs !== after.mtimeNs
        || resource.changedAtUnixNs !== after.ctimeNs || after.size !== BigInt(bytes.byteLength)) {
        throw new TypeError("pre-release B Six-Step boundary snapshot changed during bounded read");
      }
    }
  } finally {
    closeSixStepBoundarySnapshotResources(resources);
  }
}

function reopenRootDirectorySnapshot(
  snapshot: PreReleaseControllerDirectorySnapshotV1,
): ReadonlyMap<string, Uint8Array> {
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0
    || realpathSync(snapshot.snapshotDirectory) !== snapshot.snapshotDirectory
    || !lstatSync(snapshot.snapshotDirectory).isDirectory()) {
    throw new TypeError("pre-release B terminal snapshot is not a fixed root-owned directory");
  }
  const before = statSync(snapshot.snapshotDirectory, { bigint: true });
  const names = readdirSync(snapshot.snapshotDirectory).sort();
  if (before.uid !== 0n || before.gid !== 0n || (before.mode & 0o777n) !== 0o700n
    || snapshot.directoryDevice !== String(before.dev)
    || snapshot.directoryInode !== String(before.ino)
    || snapshot.uid !== "0" || snapshot.gid !== "0" || snapshot.mode !== "448"
    || names.length !== snapshot.entries.length
    || names.some((name, index) => name !== snapshot.entries[index]?.name)) {
    throw new TypeError("pre-release B terminal snapshot directory identity changed");
  }
  const sixStepPreflight = snapshot.snapshotKind === "six-step-boundaries"
    ? preflightSixStepBoundarySnapshotResources(snapshot, names)
    : null;
  const result = new Map<string, Uint8Array>();
  try {
    for (const entry of snapshot.entries) {
      const path = join(snapshot.snapshotDirectory, entry.name);
      const preflight = sixStepPreflight?.get(entry.name) ?? null;
      if (preflight === null && (realpathSync(path) !== path || !lstatSync(path).isFile())) {
        throw new TypeError("pre-release B terminal snapshot entry is not a physical file");
      }
      const descriptor = preflight?.descriptor
        ?? openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const entryBefore = fstatSync(descriptor, { bigint: true });
        if (preflight !== null && (entryBefore.dev !== preflight.device
          || entryBefore.ino !== preflight.inode || entryBefore.size !== preflight.byteLength
          || entryBefore.mtimeNs !== preflight.modifiedAtUnixNs
          || entryBefore.ctimeNs !== preflight.changedAtUnixNs)) {
          throw new TypeError("pre-release B Six-Step boundary snapshot changed after resource preflight");
        }
        const bytes = readExactDescriptorBytes(descriptor, entryBefore.size);
        const entryAfter = fstatSync(descriptor, { bigint: true });
        if (entryBefore.dev !== entryAfter.dev || entryBefore.ino !== entryAfter.ino
          || entryBefore.size !== entryAfter.size || entryBefore.mtimeNs !== entryAfter.mtimeNs
          || entryBefore.ctimeNs !== entryAfter.ctimeNs
          || entryAfter.uid !== 0n || entryAfter.gid !== 0n || (entryAfter.mode & 0o777n) !== 0o400n
          || entry.device !== String(entryAfter.dev) || entry.inode !== String(entryAfter.ino)
          || entry.uid !== "0" || entry.gid !== "0" || entry.mode !== "256"
          || entry.byteLength !== String(bytes.byteLength)
          || entry.contentSha256 !== sha256Hex(bytes)) {
          throw new TypeError("pre-release B terminal snapshot entry identity changed");
        }
        result.set(entry.name, bytes);
      } finally {
        if (preflight === null) closeSync(descriptor);
      }
    }
    const after = statSync(snapshot.snapshotDirectory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new TypeError("pre-release B terminal snapshot changed during reopen");
    }
    assertPreReleaseBDirectorySnapshotEntrySetRootV1(snapshot);
    return result;
  } finally {
    if (sixStepPreflight !== null) closeSixStepBoundarySnapshotResources(sixStepPreflight);
  }
}

/** The only production mint for terminal snapshot trust. It consumes the
 * opaque frozen-B qualification, reopens both root-owned directory snapshots,
 * derives the release-scoped store marker from the exact staged signed
 * binding, and selects B's final window from the frozen SQLite snapshot. */
export function issueFrozenPreReleaseBTerminalSnapshotTrustV1(
  capability: FrozenPreReleaseBQualificationCapabilityV1,
): ProductionTerminalPhaseSnapshotTrustCapabilityV1 {
  const qualification = readFrozenPreReleaseBQualificationCapabilityV1(capability);
  const binding = decodeRuntimeReleaseBindingV1(
    qualification.stagingArtifactBytes["runtime-release-binding.json"],
  );
  const expectedStoreIdentity = runtimeReleaseObserverStoreIdentityV1(
    binding,
    qualification.snapshots.observerContent.sourceDirectory,
  );
  const observerEntries = reopenRootDirectorySnapshot(qualification.snapshots.observerContent);
  const marker = observerEntries.get(".aloha-observer-store-identity-v1");
  if (qualification.snapshots.observerContent.snapshotKind !== "observer-content"
    || qualification.snapshots.observerContent.observerStoreIdentityHash !== expectedStoreIdentity
    || marker === undefined
    || Buffer.from(marker).toString("utf8") !== `${expectedStoreIdentity}\n`) {
    throw new TypeError("pre-release B observer snapshot marker/release binding mismatch");
  }
  const terminalEntries = reopenRootDirectorySnapshot(qualification.snapshots.terminalLocators);
  if (qualification.snapshots.terminalLocators.snapshotKind !== "terminal-locator-index"
    || qualification.snapshots.terminalLocators.observerStoreIdentityHash !== null) {
    throw new TypeError("pre-release B terminal locator snapshot kind is invalid");
  }
  reopenRootDirectorySnapshot(qualification.snapshots.sixStepBoundaries);
  if (qualification.snapshots.sixStepBoundaries.snapshotKind !== "six-step-boundaries"
    || qualification.snapshots.sixStepBoundaries.observerStoreIdentityHash !== null) {
    throw new TypeError("pre-release B Six-Step boundary snapshot kind is invalid");
  }
  const raw = observeProductionPerformanceDatabaseV1(qualification.snapshots.processEvidence.snapshotPath);
  if (raw.status !== "raw-complete" || raw.sixStepWindowSelection === null) {
    throw new TypeError("pre-release B frozen SQLite snapshot has no final durable window");
  }
  const finalDurableWindowId = raw.sixStepWindowSelection.finalDurableWindowId;
  const indexFileName = `${finalDurableWindowId.slice(2)}.json`;
  const indexBytes = terminalEntries.get(indexFileName);
  if (indexBytes === undefined) {
    throw new TypeError("pre-release B terminal locator snapshot lacks the exact frozen final window");
  }
  const index = decodeCanonicalBytes(indexBytes) as Readonly<Record<string, unknown>>;
  const indexRoot = assertHash(index.indexRoot, "preReleaseBTerminalSnapshot.indexRoot");
  if (index.finalDurableWindowId !== finalDurableWindowId) {
    throw new TypeError("pre-release B terminal locator index/window splice");
  }
  const release = observeFullFamilyReleaseArtifacts({
    releaseIntentCanonicalBytes: qualification.stagingArtifactBytes["release-intent.json"],
    familyCatalogSourceBytes: qualification.stagingArtifactBytes["family-catalog.ts"],
    runtimeCompositionSourceBytes: qualification.stagingArtifactBytes["runtime-composition.ts"],
    strategyCatalogSourceBytes: qualification.stagingArtifactBytes["strategy-catalog.ts"],
  });
  if (release.globalDefinitionCatalogRoot.kind !== "complete"
    || binding.bindingId !== qualification.authorization.runtimeBindingId
    || binding.candidateReleaseCommit !== qualification.authorization.candidateReleaseCommit
    || runtimeReleaseBindingProvenanceHash(binding) !== qualification.authorization.releaseProvenanceHash) {
    throw new TypeError("pre-release B staged generated denominator/release authorization splice");
  }
  const activeReadyGraph = observeFrozenPreReleaseBActiveReadyGraphV1(
    qualification.snapshots.checkpoint,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.bCheckpointSnapshotPath,
  );
  if (activeReadyGraph.checkpointRootEnvelopeHash !== qualification.ready.checkpoint.checkpointRootEnvelopeHash
    || activeReadyGraph.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)) {
    throw new TypeError("pre-release B active Ready Graph/checkpoint/release splice");
  }
  const registered = Object.freeze(Object.create(null)) as ProductionTerminalPhaseSnapshotTrustCapabilityV1;
  registerProductionTerminalPhaseSnapshotTrustCapabilityV1(registered, {
    snapshotRoot: qualification.snapshots.snapshotRoot,
    observerContentDirectory: qualification.snapshots.observerContent.snapshotDirectory,
    observerContentEntrySetRoot: qualification.snapshots.observerContent.entrySetRoot,
    terminalLocatorDirectory: qualification.snapshots.terminalLocators.snapshotDirectory,
    terminalLocatorEntrySetRoot: qualification.snapshots.terminalLocators.entrySetRoot,
    sixStepSourceLedger: Object.freeze({
      sourceDevice: qualification.snapshots.sixStepEvidenceLog.sourceDevice,
      sourceInode: qualification.snapshots.sixStepEvidenceLog.sourceInode,
      snapshotPath: qualification.snapshots.sixStepEvidenceLog.snapshotPath,
      snapshotDevice: qualification.snapshots.sixStepEvidenceLog.device,
      snapshotInode: qualification.snapshots.sixStepEvidenceLog.inode,
      contentSha256: qualification.snapshots.sixStepEvidenceLog.contentSha256,
      byteLength: qualification.snapshots.sixStepEvidenceLog.byteLength,
      fsynced: qualification.snapshots.sixStepEvidenceLog.fileFsynced,
    }),
    sixStepBoundaryDirectory: qualification.snapshots.sixStepBoundaries.snapshotDirectory,
    sixStepBoundaryEntrySetRoot: qualification.snapshots.sixStepBoundaries.entrySetRoot,
    sixStepBoundaryFiles: Object.freeze(qualification.snapshots.sixStepBoundaries.entries.map(entry => Object.freeze({
      name: entry.name,
      contentSha256: entry.contentSha256,
      byteLength: entry.byteLength,
      device: entry.device,
      inode: entry.inode,
      fsynced: entry.fileFsynced,
    }))),
    finalDurableWindowId,
    indexFileName,
    indexContentSha256: sha256Hex(indexBytes),
    indexByteLength: String(indexBytes.byteLength),
    indexRoot,
    observerStoreIdentityHash: expectedStoreIdentity,
    runtimeBindingId: binding.bindingId,
    candidateReleaseCommit: binding.candidateReleaseCommit,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    activeReadyGraph,
    generatedRuntimeMetadata: Object.freeze({
      releaseIntentRoot: release.releaseIntentRoot,
      definitionCatalogRoot: release.globalDefinitionCatalogRoot.definitionCatalogRoot,
      descriptorRoot: release.runtimeDescriptorRoot,
      families: Object.freeze(release.families.map(family => Object.freeze({
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
        sourcePlanRoot: family.sourcePlanRoot,
        sourcePlanRefs: family.sourcePlanRefs,
      }))),
    }),
  });
  return registered;
}

/** Sole issuer of the FactLog terminal physical denominator. The capability
 * is created only after the root-owned frozen qualification, snapshot trust,
 * issued locator discovery, and raw SQLite observation exact-join in one
 * process. No serialized report or producer verdict can mint it. */
export function issueFrozenPreReleaseBTerminalPhysicalObservationV1(
  qualificationCapability: FrozenPreReleaseBQualificationCapabilityV1,
  snapshotTrustCapability: ProductionTerminalPhaseSnapshotTrustCapabilityV1,
  discovery: ProductionTerminalPhaseDurableDiscoveryV1,
  processImportReceiptId: Hash,
): PreReleaseBTerminalPhysicalObservationCapabilityV1 {
  const qualification = readFrozenPreReleaseBQualificationCapabilityV1(qualificationCapability);
  const trust = readProductionTerminalPhaseSnapshotTrustCapabilityV1(snapshotTrustCapability);
  assertProductionTerminalPhaseDurableDiscoveryV1(discovery);
  if (discovery.snapshotTrustRoot !== trust.trustRoot
    || discovery.index.finalDurableWindowId !== trust.finalDurableWindowId
    || discovery.indexPath !== `${discovery.indexDirectory}/${trust.indexFileName}`
    || discovery.indexContentSha256 !== trust.indexContentSha256
    || discovery.indexByteLength !== trust.indexByteLength
    || discovery.index.indexRoot !== trust.indexRoot
    || discovery.observerContentDirectory !== trust.observerContentDirectory
    || discovery.observerStoreIdentityHash !== trust.observerStoreIdentityHash
    || discovery.sixStepPhysicalStatus !== "observed"
    || discovery.sixStepPhysicalReason !== null
    || discovery.selectedProcessArtifact === null
    || discovery.sixStepTerminalBindingArtifact === null
    || discovery.sixStepPredicateArtifacts.length === 0
    || discovery.sixStepArtifactMaterials.length === 0) {
    throw new TypeError("pre-release B terminal physical discovery/trust denominator mismatch");
  }
  const raw = observeProductionPerformanceDatabaseV1(
    qualification.snapshots.processEvidence.snapshotPath,
  );
  if (raw.status !== "raw-complete" || raw.sixStepWindowSelection === null
    || raw.sixStepWindowSelection.finalDurableWindowId !== trust.finalDurableWindowId
    || raw.databaseSha256Before !== qualification.snapshots.processEvidence.contentSha256
    || raw.databaseSha256After !== qualification.snapshots.processEvidence.contentSha256) {
    throw new TypeError("pre-release B terminal physical SQLite/window denominator mismatch");
  }
  const factIndex = buildProductionReleaseAcceptanceAdvisoryFactIndexV1(
    qualification.snapshots.processEvidence.snapshotPath,
    discovery,
  );
  const body: Omit<PreReleaseBTerminalPhysicalObservationV1, "observationRoot"> = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.pre-release-b-terminal-physical-observation-v1" as const,
    release: Object.freeze({
      candidateReleaseCommit: trust.candidateReleaseCommit,
      runtimeBindingId: trust.runtimeBindingId,
      releaseProvenanceHash: trust.releaseProvenanceHash,
      authorizationId: qualification.authorization.authorizationId,
    }),
    process: Object.freeze({
      processImportReceiptId: assertHash(processImportReceiptId, "preReleaseBTerminalPhysical.processImportReceiptId"),
      processAnchorHash: qualification.ready.ready.processAnchorHash,
      pid: qualification.process.pid,
      processStartTicks: qualification.process.processStartTicks,
      bootIdHash: qualification.process.bootIdHash,
      executableHash: qualification.process.executableSha256,
    }),
    logWindow: Object.freeze({ ...qualification.log }),
    processEvidence: Object.freeze({
      publication: qualification.snapshots.processEvidence,
      databaseSha256Before: raw.databaseSha256Before,
      databaseSha256After: raw.databaseSha256After,
      storageSetRootBefore: raw.storageSetRootBefore,
      storageSetRootAfter: raw.storageSetRootAfter,
      rawRowRoot: raw.rawRowRoot,
      eventRoot: raw.eventRoot,
    }),
    terminal: Object.freeze({
      snapshotRoot: trust.snapshotRoot,
      snapshotTrustRoot: trust.trustRoot,
      finalDurableWindowId: trust.finalDurableWindowId,
      sixStepWindowSelection: raw.sixStepWindowSelection,
      sixStepSourceLedger: trust.sixStepSourceLedger,
      sixStepBoundaryEntrySetRoot: trust.sixStepBoundaryEntrySetRoot,
      sixStepBoundaryFiles: trust.sixStepBoundaryFiles,
      factIndex,
    }),
  });
  const observation: PreReleaseBTerminalPhysicalObservationV1 = Object.freeze({
    ...body,
    observationRoot: hashDomain("aloha/pre-release-b-terminal-physical-observation/v1", body as never),
  });
  const issued = Object.freeze(Object.create(null)) as PreReleaseBTerminalPhysicalObservationCapabilityV1;
  registerPreReleaseBTerminalPhysicalObservationV1(issued, observation);
  return issued;
}
