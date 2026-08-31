import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  gitSha40Schema,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { RawSixStepWindowSelectionV1 } from "../../../packages/performance-collector/src/raw-sqlite-observer.ts";
import type { PreReleaseControllerDatabaseSnapshotPublicationV1 } from "../../pre-release-restart-controller/src/durable-owner.ts";
import { SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1 } from "../../../specs/evidence/src/six-step.ts";
import type { ProductionReleaseAcceptanceAdvisoryFactIndexV1 } from "./production-workflow.ts";
import { readRegisteredPreReleaseBTerminalPhysicalObservationV1 } from "./internal/pre-release-b-terminal-physical-observation-state.ts";

export type PreReleaseBTerminalPhysicalObservationCapabilityV1 = object;

/** Narrow read-only projection of facts observed together by the frozen-B
 * terminal snapshot owner. It carries no release, acceptance, signing,
 * promotion, or runtime authority. */
export interface PreReleaseBTerminalPhysicalObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-b-terminal-physical-observation-v1";
  readonly release: Readonly<{
    readonly candidateReleaseCommit: string;
    readonly runtimeBindingId: Hash;
    readonly releaseProvenanceHash: Hash;
    readonly authorizationId: Hash;
  }>;
  readonly process: Readonly<{
    readonly processImportReceiptId: Hash;
    readonly processAnchorHash: Hash;
    readonly pid: string;
    readonly processStartTicks: string;
    readonly bootIdHash: Hash;
    readonly executableHash: Hash;
  }>;
  readonly logWindow: Readonly<{
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly startInclusive: string;
    readonly endExclusive: string;
    readonly contentSha256: Hash;
  }>;
  readonly processEvidence: Readonly<{
    readonly publication: PreReleaseControllerDatabaseSnapshotPublicationV1;
    readonly databaseSha256Before: Hash;
    readonly databaseSha256After: Hash;
    readonly storageSetRootBefore: Hash;
    readonly storageSetRootAfter: Hash;
    readonly rawRowRoot: Hash;
    readonly eventRoot: Hash;
  }>;
  readonly terminal: Readonly<{
    readonly snapshotRoot: Hash;
    readonly snapshotTrustRoot: Hash;
    readonly finalDurableWindowId: Hash;
    readonly sixStepWindowSelection: RawSixStepWindowSelectionV1;
    readonly sixStepSourceLedger: Readonly<{
      readonly sourceDevice: string;
      readonly sourceInode: string;
      readonly snapshotPath: string;
      readonly snapshotDevice: string;
      readonly snapshotInode: string;
      readonly contentSha256: Hash;
      readonly byteLength: string;
      readonly fsynced: true;
    }>;
    readonly sixStepBoundaryEntrySetRoot: Hash;
    readonly sixStepBoundaryFiles: readonly Readonly<{
      readonly name: string;
      readonly contentSha256: Hash;
      readonly byteLength: string;
      readonly device: string;
      readonly inode: string;
      readonly fsynced: true;
    }>[];
    readonly factIndex: ProductionReleaseAcceptanceAdvisoryFactIndexV1;
  }>;
  readonly observationRoot: Hash;
}

/** Exact reader only. Possession of the returned DTO grants no owner or
 * runtime authority, and a cloned capability cannot recover the projection. */
export function readPreReleaseBTerminalPhysicalObservationV1(
  capability: PreReleaseBTerminalPhysicalObservationCapabilityV1,
): PreReleaseBTerminalPhysicalObservationV1 {
  const observation = readRegisteredPreReleaseBTerminalPhysicalObservationV1(capability);
  assertPlainObject(observation, "preReleaseBTerminalPhysical");
  assertExactKeys(observation, [
    "schemaVersion", "kind", "release", "process", "logWindow", "processEvidence", "terminal",
    "observationRoot",
  ], "preReleaseBTerminalPhysical");
  if (observation.schemaVersion !== 1
    || observation.kind !== "aloha.pre-release-b-terminal-physical-observation-v1") {
    throw new TypeError("pre-release B terminal physical observation kind/version mismatch");
  }
  assertPlainObject(observation.release, "preReleaseBTerminalPhysical.release");
  assertExactKeys(observation.release, [
    "candidateReleaseCommit", "runtimeBindingId", "releaseProvenanceHash", "authorizationId",
  ], "preReleaseBTerminalPhysical.release");
  gitSha40Schema.decode(observation.release.candidateReleaseCommit, "preReleaseBTerminalPhysical.release.candidateReleaseCommit");
  for (const field of ["runtimeBindingId", "releaseProvenanceHash", "authorizationId"] as const) {
    assertHash(observation.release[field], `preReleaseBTerminalPhysical.release.${field}`);
  }
  assertPlainObject(observation.process, "preReleaseBTerminalPhysical.process");
  assertExactKeys(observation.process, [
    "processImportReceiptId", "processAnchorHash", "pid", "processStartTicks", "bootIdHash", "executableHash",
  ], "preReleaseBTerminalPhysical.process");
  for (const field of ["processImportReceiptId", "processAnchorHash", "bootIdHash", "executableHash"] as const) {
    assertHash(observation.process[field], `preReleaseBTerminalPhysical.process.${field}`);
  }
  assertDecimalString(observation.process.pid, "preReleaseBTerminalPhysical.process.pid");
  assertDecimalString(observation.process.processStartTicks, "preReleaseBTerminalPhysical.process.processStartTicks");
  assertPlainObject(observation.logWindow, "preReleaseBTerminalPhysical.logWindow");
  assertExactKeys(observation.logWindow, [
    "path", "device", "inode", "startInclusive", "endExclusive", "contentSha256",
  ], "preReleaseBTerminalPhysical.logWindow");
  assertNonEmptyString(observation.logWindow.path, "preReleaseBTerminalPhysical.logWindow.path");
  for (const field of ["device", "inode", "startInclusive", "endExclusive"] as const) {
    assertDecimalString(observation.logWindow[field], `preReleaseBTerminalPhysical.logWindow.${field}`);
  }
  assertHash(observation.logWindow.contentSha256, "preReleaseBTerminalPhysical.logWindow.contentSha256");
  assertPlainObject(observation.processEvidence, "preReleaseBTerminalPhysical.processEvidence");
  assertExactKeys(observation.processEvidence, [
    "publication", "databaseSha256Before", "databaseSha256After", "storageSetRootBefore",
    "storageSetRootAfter", "rawRowRoot", "eventRoot",
  ], "preReleaseBTerminalPhysical.processEvidence");
  const publication = observation.processEvidence.publication;
  assertPlainObject(publication, "preReleaseBTerminalPhysical.processEvidence.publication");
  assertExactKeys(publication, [
    "sourcePath", "snapshotPath", "contentSha256", "byteLength", "device", "inode", "uid", "gid",
    "mode", "fileFsynced", "directoryFsynced",
  ], "preReleaseBTerminalPhysical.processEvidence.publication");
  if (publication.uid !== "0" || publication.gid !== "0" || publication.mode !== "384"
    || publication.fileFsynced !== true || publication.directoryFsynced !== true) {
    throw new TypeError("pre-release B terminal physical SQLite publication is not root-fsynced");
  }
  for (const field of [
    "databaseSha256Before", "databaseSha256After", "storageSetRootBefore", "storageSetRootAfter",
    "rawRowRoot", "eventRoot",
  ] as const) assertHash(observation.processEvidence[field], `preReleaseBTerminalPhysical.processEvidence.${field}`);
  assertPlainObject(observation.terminal, "preReleaseBTerminalPhysical.terminal");
  assertExactKeys(observation.terminal, [
    "snapshotRoot", "snapshotTrustRoot", "finalDurableWindowId", "sixStepWindowSelection",
    "sixStepSourceLedger", "sixStepBoundaryEntrySetRoot", "sixStepBoundaryFiles", "factIndex",
  ], "preReleaseBTerminalPhysical.terminal");
  for (const field of ["snapshotRoot", "snapshotTrustRoot", "finalDurableWindowId", "sixStepBoundaryEntrySetRoot"] as const) {
    assertHash(observation.terminal[field], `preReleaseBTerminalPhysical.terminal.${field}`);
  }
  const sourceLedger = observation.terminal.sixStepSourceLedger;
  assertPlainObject(sourceLedger, "preReleaseBTerminalPhysical.terminal.sixStepSourceLedger");
  assertExactKeys(sourceLedger, [
    "sourceDevice", "sourceInode", "snapshotPath", "snapshotDevice", "snapshotInode", "contentSha256",
    "byteLength", "fsynced",
  ], "preReleaseBTerminalPhysical.terminal.sixStepSourceLedger");
  if (sourceLedger.fsynced !== true) throw new TypeError("pre-release B terminal physical source ledger is not fsynced");
  assertHash(sourceLedger.contentSha256, "preReleaseBTerminalPhysical.terminal.sixStepSourceLedger.contentSha256");
  if (!Array.isArray(observation.terminal.sixStepBoundaryFiles)
    || observation.terminal.sixStepBoundaryFiles.length === 0) {
    throw new TypeError("pre-release B terminal physical boundary denominator is empty");
  }
  if (observation.terminal.sixStepBoundaryFiles.length
    > SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntries) {
    throw new TypeError("pre-release B terminal physical boundary entry count exceeds policy");
  }
  let sixStepBoundaryTotalBytes = 0n;
  for (const [index, file] of observation.terminal.sixStepBoundaryFiles.entries()) {
    assertPlainObject(file, `preReleaseBTerminalPhysical.terminal.sixStepBoundaryFiles[${index}]`);
    assertExactKeys(file, ["name", "contentSha256", "byteLength", "device", "inode", "fsynced"], `preReleaseBTerminalPhysical.terminal.sixStepBoundaryFiles[${index}]`);
    if (file.fsynced !== true) throw new TypeError("pre-release B terminal physical boundary file is not fsynced");
    assertHash(file.contentSha256, `preReleaseBTerminalPhysical.terminal.sixStepBoundaryFiles[${index}].contentSha256`);
    const name = assertNonEmptyString(
      file.name,
      `preReleaseBTerminalPhysical.terminal.sixStepBoundaryFiles[${index}].name`,
    );
    if (!/^[0-9a-f]{64}\.v8$/.test(name)
      || (index > 0 && observation.terminal.sixStepBoundaryFiles[index - 1]!.name >= name)) {
      throw new TypeError("pre-release B terminal physical boundary names are not exact-sorted");
    }
    const byteLength = BigInt(assertDecimalString(
      file.byteLength,
      `preReleaseBTerminalPhysical.terminal.sixStepBoundaryFiles[${index}].byteLength`,
    ));
    assertDecimalString(file.device, `preReleaseBTerminalPhysical.terminal.sixStepBoundaryFiles[${index}].device`);
    assertDecimalString(file.inode, `preReleaseBTerminalPhysical.terminal.sixStepBoundaryFiles[${index}].inode`);
    if (byteLength > BigInt(SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntryBytes)) {
      throw new TypeError("pre-release B terminal physical boundary file exceeds policy");
    }
    sixStepBoundaryTotalBytes += byteLength;
    if (sixStepBoundaryTotalBytes
      > BigInt(SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxTotalBytes)) {
      throw new TypeError("pre-release B terminal physical boundary aggregate exceeds policy");
    }
  }
  const factIndex = observation.terminal.factIndex;
  assertPlainObject(factIndex, "preReleaseBTerminalPhysical.terminal.factIndex");
  assertExactKeys(factIndex, ["terminalPhase", "processEvidenceQuery"], "preReleaseBTerminalPhysical.terminal.factIndex");
  assertPlainObject(factIndex.terminalPhase, "preReleaseBTerminalPhysical.terminal.factIndex.terminalPhase");
  assertExactKeys(factIndex.terminalPhase, [
    "finalDurableWindowId", "terminalLocatorDirectory", "observerContentStore", "index", "locator", "manifest",
    "fullFamilyTerminalBinding", "fullGraphCoarseSweep", "sixStepPhysicalStatus", "sixStepPhysicalReason",
  ], "preReleaseBTerminalPhysical.terminal.factIndex.terminalPhase");
  const { observationRoot, ...body } = observation;
  if (assertHash(observationRoot, "preReleaseBTerminalPhysical.observationRoot")
    !== hashDomain("aloha/pre-release-b-terminal-physical-observation/v1", body as never)) {
    throw new TypeError("pre-release B terminal physical observation root mismatch");
  }
  return observation;
}
