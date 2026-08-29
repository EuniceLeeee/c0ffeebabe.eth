import {
  closeSync,
  constants as fsConstants,
  chmodSync,
  chownSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { decodeCanonicalJson, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { encodeCanonicalBytes, hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  issueQualifiedPreReleaseControllerBoundaryEvidenceV1,
  type BoundaryReceipt,
} from "../../architecture-boundaries/src/index.ts";
import { atomicNoClobberPublishV1 } from "../../pre-release-restart-controller/src/atomic-file.ts";
import {
  PRE_RELEASE_RESTART_TARGET_UNIT_V1,
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1,
} from "../../pre-release-restart-controller/src/spec.ts";
import { readFixedPreReleaseRestartControllerReceiptV1 } from "../../pre-release-restart-controller/src/receipt-reader.ts";
import {
  observeCurrentCheckpointFactV1,
  observePreReleaseBReadyFactsV1,
  observePreReleaseProcessPreFactsV1,
  publishPreReleaseBDurableSnapshotsV1,
} from "../../pre-release-restart-controller/src/durable-owner.ts";
import {
  bindStablePreReleaseFrozenCgroupV1,
  invokeFixedPreReleaseFreezeV1,
  invokeFixedPreReleaseThawV1,
  observeFixedPreReleaseFrozenCgroupV1,
  observeFixedPreReleaseProcessV1,
  observeFixedPreReleaseUnitV1,
  sameProcessObservationV1,
} from "../../pre-release-restart-controller/src/linux-owner.ts";
import {
  decodePreReleaseLaunchAuthorizationV1,
  decodePreReleaseStagingManifestV1,
  hashPreReleaseStagingArtifactSetV1,
  PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1,
  PRE_RELEASE_STAGING_LAYOUT_V1,
  preReleaseStagingArtifactPathV1,
  verifyPreReleaseLaunchAuthorizationSignatureV1,
  type PreReleaseLaunchAuthorizationPayloadV1,
  type PreReleaseLaunchAuthorizationV1,
} from "./internal/pre-release-staging-schema.ts";
import { buildExactPreReleaseStagingRuntimeArtifactsV1 } from "./exact-runtime-artifacts.ts";
import {
  claimFixedPreReleaseAuthorizationV1,
  readFixedPreReleaseAuthorizationClaimV1,
} from "./internal/pre-release-authorization-ledger.ts";
import { sealPreReleaseRestartTerminalV1 } from "../../../apps/searcher-runtime/src/runtime-acceptance-evidence.ts";
import { decodeRuntimeReleaseSignerPinV1 } from "../../../specs/release-authority/src/index.ts";
import { hashProcessAnchor } from "../../../specs/core-envelope/src/index.ts";
import { observeProductionPerformanceDatabaseV1 } from "../../../packages/performance-collector/src/raw-sqlite-observer.ts";
import {
  issueFrozenPreReleaseBQualificationCapabilityV1,
} from "./internal/pre-release-b-qualification-state.ts";
import {
  issueImportedFrozenPreReleaseBAdvisoryMaterialV1,
  importFrozenPreReleaseBRuntimeV1,
  readImportedFrozenPreReleaseBTerminalPhysicalObservationV1,
} from "./internal/pre-release-staging-owner.ts";
import {
  encodePreReleaseFactLogJsonlV1,
  readPreReleaseFactLogV1,
} from "../../pre-release-fact-log/src/index.ts";
import {
  observeProductionReleaseAcceptanceAdvisoryV1,
  type ProductionReleaseAcceptanceAdvisoryStatusV1,
} from "./production-workflow.ts";
import type {
  PreReleaseStagingArtifactIdentityV1,
  PreReleaseStagingArtifactNameV1,
} from "./pre-release-staging-contract.ts";

export interface InstalledPreReleaseRestartControllerV1 {
  readonly candidateReleaseCommit: string;
  readonly controllerEntrypointSha256: string;
  readonly controllerSystemdUnitSha256: string;
  readonly implementationClosureDigest: string;
  readonly sourceInputRoot: string;
  readonly metafileRoot: string;
  readonly controllerBoundaryEvidenceRoot: string;
}

/** The safety owner independently supplies B launch authorization. Acceptance
 * consumes only that signed dry-run authorization and never authors signing
 * material from an acceptance result. */
function assertQualificationFinalSafetyAuthorizationV1(
  finalAuthorizationValue: PreReleaseLaunchAuthorizationV1,
  restartProbeAuthorizationValue: PreReleaseLaunchAuthorizationV1,
  controllerBoundaryEvidenceRoot: `0x${string}`,
): void {
  const controllerReceipt = readFixedPreReleaseRestartControllerReceiptV1();
  const probe = decodePreReleaseLaunchAuthorizationV1(restartProbeAuthorizationValue);
  const finalAuthorization = decodePreReleaseLaunchAuthorizationV1(finalAuthorizationValue);
  if (probe.roundRole !== "restart-probe" || probe.predecessor !== null
    || probe.controllerBoundaryEvidenceRoot !== controllerBoundaryEvidenceRoot
    || controllerReceipt.target.controllerBoundaryEvidenceRoot !== controllerBoundaryEvidenceRoot
    || controllerReceipt.target.authorizationId !== probe.authorizationId
    || controllerReceipt.target.candidateReleaseCommit !== probe.candidateReleaseCommit
    || controllerReceipt.target.runtimeBindingId !== probe.runtimeBindingId
    || controllerReceipt.target.releaseProvenanceHash !== probe.releaseProvenanceHash
    || controllerReceipt.target.stagingArtifactSetRoot !== probe.stagingArtifactSetRoot
    || controllerReceipt.target.stagingManifestRoot !== probe.stagingManifestRoot) {
    throw new TypeError("qualification-final safety authorization predecessor does not exact-join A and its controller receipt");
  }
  const predecessor = Object.freeze({
    authorizationId: probe.authorizationId,
    authorizationClaimId: controllerReceipt.target.authorizationClaimId,
    controllerReceiptId: controllerReceipt.receiptId,
    controllerImplementationIdentityHash: controllerReceipt.controller.implementationIdentityHash,
    targetProcessAnchorHash: controllerReceipt.pre.ready.processAnchorHash,
    processReadyEventId: controllerReceipt.post.ready.eventId,
    sigtermDrainedEventId: controllerReceipt.post.drained.eventId,
    restartTerminalId: controllerReceipt.post.terminal.terminalId,
  });
  const sharedFields = [
    "phase", "candidateReleaseCommit", "runtimeBindingId", "releaseProvenanceHash",
    "releaseAuthorityApprovalId", "releaseRoleManifestRoot", "boundaryRunnerEntrypointId",
    "boundaryRunnerClosureDigest", "boundaryRunnerImplementationExportDigest",
    "controllerBoundaryEvidenceRoot", "stagingArtifactSetRoot", "stagingManifestRoot",
    "runtimeExportSurfaceRoot", "repositoryRoot", "artifactRoot", "manifestPath",
    "canonicalJournalPath", "checkpointDatabasePath", "processEvidenceDatabasePath",
    "observerContentDirectory", "terminalLocatorDirectory", "observerStoreDirectory",
    "logPath", "serviceName", "systemdUnit", "dryRun", "expiresAtUnixNs", "signerKeyId",
  ] as const;
  if (finalAuthorization.roundRole !== "qualification-final"
    || finalAuthorization.allowedTerminal !== "qualification-facts-observed"
    || finalAuthorization.predecessor === null
    || !Buffer.from(encodeCanonicalBytes(finalAuthorization.predecessor)).equals(Buffer.from(encodeCanonicalBytes(predecessor)))
    || sharedFields.some(field => finalAuthorization[field] !== probe[field])
    || BigInt(finalAuthorization.issuedAtUnixNs) < BigInt(probe.issuedAtUnixNs)) {
    throw new TypeError("qualification-final safety authorization does not exact-join A and its controller receipt");
  }
}

function assertTargetUnit(path: string, expectedSha256: string, expectedUid?: number, expectedGid?: number, expectedMode?: number): void {
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) {
    throw new TypeError("pre-release target unit is not a canonical regular file");
  }
  if (sha256Hex(new Uint8Array(readFileSync(path))) !== expectedSha256) {
    throw new TypeError("pre-release target unit does not equal the controller-bound unit");
  }
  const stat = lstatSync(path);
  if ((expectedUid !== undefined && stat.uid !== expectedUid)
    || (expectedGid !== undefined && stat.gid !== expectedGid)
    || (expectedMode !== undefined && (stat.mode & 0o777) !== expectedMode)) {
    throw new TypeError("pre-release installed file owner or mode mismatch");
  }
}

/** Sole root-side installer for the exact-pushed controller artifact. It does
 * not add the controller to the searcher staging denominator or runtime
 * bundle; it publishes the two fixed controller files with no-clobber links. */
export function installExactPreReleaseRestartControllerV1(
  boundaryReceipt: BoundaryReceipt,
): InstalledPreReleaseRestartControllerV1 {
  const repositoryRoot = realpathSync(resolve("/var/lib/aloha/pre-release/repository"));
  const evidence = issueQualifiedPreReleaseControllerBoundaryEvidenceV1(boundaryReceipt, repositoryRoot);
  const { evidenceRoot: _evidenceRoot, ...evidencePayload } = evidence;
  if (evidence.evidenceRoot !== hashDomain("aloha/qualified-pre-release-controller-boundary-evidence/v1", evidencePayload as never)) {
    throw new TypeError("pre-release controller Boundary evidence root mismatch");
  }
  const artifacts = buildExactPreReleaseStagingRuntimeArtifactsV1(repositoryRoot, evidence.candidateReleaseCommit);
  const controller = artifacts.restartController;
  const contract = controller.installContract;
  if (controller.candidateReleaseCommit !== artifacts.candidateReleaseCommit
    || contract.installOwner !== "@aloha/runtime-release-packager/final-pre-release-runner"
    || contract.searcherRuntimeBundleMember !== false
    || evidence.searcherRuntimeBundleMember !== false
    || evidence.controllerBundleSha256 !== controller.sha256
    || evidence.controllerSourceInputRoot !== controller.sourceInputRoot
    || evidence.controllerMetafileRoot !== controller.metafileRoot
    || evidence.controllerImplementationClosureDigest !== controller.implementationClosureDigest
    || evidence.controllerSystemdUnitSha256 !== controller.controllerSystemdUnitSha256
    || evidence.targetSystemdUnitSha256 !== controller.targetSystemdUnitSha256
    || !Buffer.from(encodeCanonicalBytes(evidence.installContract)).equals(Buffer.from(encodeCanonicalBytes(contract)))
    || !Buffer.from(encodeCanonicalBytes(evidence.externalBuiltins)).equals(Buffer.from(encodeCanonicalBytes(controller.externalBuiltins)))) {
    throw new TypeError("pre-release controller install contract is not exact");
  }
  assertTargetUnit(contract.targetSystemdUnitPath, controller.targetSystemdUnitSha256);
  if (existsSync(PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.roundLockPath)
    || existsSync(PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.evidencePath)
    || existsSync(PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.receiptPath)) {
    throw new TypeError("pre-release controller round was already consumed or partially published");
  }
  const directory = contract.controllerDirectory;
  if (dirname(contract.controllerEntrypointPath) !== directory) {
    throw new TypeError("pre-release controller entrypoint is outside its fixed directory");
  }
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: false, mode: Number(contract.controllerDirectoryMode) });
    chownSync(directory, Number(contract.controllerDirectoryUid), Number(contract.controllerDirectoryGid));
    chmodSync(directory, Number(contract.controllerDirectoryMode));
  }
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || realpathSync(directory) !== directory
    || directoryStat.uid !== Number(contract.controllerDirectoryUid)
    || directoryStat.gid !== Number(contract.controllerDirectoryGid)
    || (directoryStat.mode & 0o777) !== Number(contract.controllerDirectoryMode)) {
    throw new TypeError("pre-release controller directory is not the exact protected install directory");
  }
  const unitDirectory = dirname(contract.controllerSystemdUnitPath);
  const unitDirectoryStat = lstatSync(unitDirectory);
  if (!unitDirectoryStat.isDirectory() || realpathSync(unitDirectory) !== unitDirectory
    || unitDirectoryStat.uid !== 0 || (unitDirectoryStat.mode & 0o022) !== 0) {
    throw new TypeError("pre-release controller unit directory is not root-owned and protected");
  }
  const discriminator = String(process.pid);
  if (existsSync(contract.controllerEntrypointPath)) {
    assertTargetUnit(contract.controllerEntrypointPath, controller.sha256, Number(contract.controllerEntrypointUid), Number(contract.controllerEntrypointGid), Number(contract.controllerEntrypointMode));
  }
  if (existsSync(contract.controllerSystemdUnitPath)) {
    if (!existsSync(contract.controllerEntrypointPath)) throw new TypeError("controller ready marker exists without its entrypoint");
    assertTargetUnit(contract.controllerEntrypointPath, controller.sha256, Number(contract.controllerEntrypointUid), Number(contract.controllerEntrypointGid), Number(contract.controllerEntrypointMode));
    assertTargetUnit(contract.controllerSystemdUnitPath, controller.controllerSystemdUnitSha256, Number(contract.controllerSystemdUnitUid), Number(contract.controllerSystemdUnitGid), Number(contract.controllerSystemdUnitMode));
  }
  const entrypoint = existsSync(contract.controllerEntrypointPath) ? Object.freeze({ contentSha256: sha256Hex(new Uint8Array(readFileSync(contract.controllerEntrypointPath))) }) : atomicNoClobberPublishV1({
    directory,
    path: contract.controllerEntrypointPath,
    bytes: controller.bytes,
    uid: Number(contract.controllerEntrypointUid),
    gid: Number(contract.controllerEntrypointGid),
    mode: Number(contract.controllerEntrypointMode),
    tempDiscriminator: discriminator,
  });
  const unit = existsSync(contract.controllerSystemdUnitPath) ? Object.freeze({ contentSha256: sha256Hex(new Uint8Array(readFileSync(contract.controllerSystemdUnitPath))) }) : atomicNoClobberPublishV1({
    directory: unitDirectory,
    path: contract.controllerSystemdUnitPath,
    bytes: controller.controllerSystemdUnitBytes,
    uid: Number(contract.controllerSystemdUnitUid),
    gid: Number(contract.controllerSystemdUnitGid),
    mode: Number(contract.controllerSystemdUnitMode),
    tempDiscriminator: discriminator,
  });
  if (entrypoint.contentSha256 !== controller.sha256
    || unit.contentSha256 !== controller.controllerSystemdUnitSha256) {
    throw new TypeError("installed pre-release controller bytes changed during publication");
  }
  return Object.freeze({
    candidateReleaseCommit: controller.candidateReleaseCommit,
    controllerEntrypointSha256: controller.sha256,
    controllerSystemdUnitSha256: controller.controllerSystemdUnitSha256,
    implementationClosureDigest: controller.implementationClosureDigest,
    sourceInputRoot: controller.sourceInputRoot,
    metafileRoot: controller.metafileRoot,
    controllerBoundaryEvidenceRoot: evidence.evidenceRoot,
  });
}

export { PRE_RELEASE_RESTART_TARGET_UNIT_V1 };

const SYSTEMCTL_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function ensureRootDirectory(path: string, mode: number): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: false, mode });
    chownSync(path, 0, 0);
    chmodSync(path, mode);
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== 0 || stat.gid !== 0
    || (stat.mode & 0o777) !== mode) throw new TypeError(`final pre-release directory owner/mode mismatch: ${path}`);
}

function stableRootBytes(path: string, mode: number): Uint8Array {
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0) throw new TypeError("final pre-release runner requires effective uid 0");
  if (!existsSync(path) || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new TypeError(`final pre-release fixed file is missing: ${path}`);
  const before = statSync(path, { bigint: true });
  if (before.uid !== 0n || before.gid !== 0n || (before.mode & 0o777n) !== BigInt(mode)) throw new TypeError(`final pre-release fixed file owner/mode mismatch: ${path}`);
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength)) throw new TypeError(`final pre-release fixed file changed during read: ${path}`);
  return bytes;
}

function canonicalAuthorization(path: string): Readonly<{ readonly bytes: Uint8Array; readonly authorization: PreReleaseLaunchAuthorizationV1 }> {
  const bytes = stableRootBytes(path, 0o600);
  const authorization = decodePreReleaseLaunchAuthorizationV1(decodeCanonicalJson(bytes));
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(authorization)))) throw new TypeError("pre-release signed authorization bytes are not canonical");
  return Object.freeze({ bytes, authorization });
}

function installActiveAuthorization(bytes: Uint8Array, expectedPrevious: Uint8Array | null): void {
  const path = PRE_RELEASE_STAGING_LAYOUT_V1.authorizationPath;
  const directory = dirname(path);
  const directoryStat = statSync(directory, { bigint: true });
  if (realpathSync(directory) !== directory || !directoryStat.isDirectory() || directoryStat.uid !== 0n
    || (directoryStat.mode & 0o022n) !== 0n) throw new TypeError("pre-release active authorization directory is not root-controlled");
  if (expectedPrevious === null) {
    if (existsSync(path)) throw new TypeError("pre-release active authorization was precreated");
  } else {
    const current = stableRootBytes(path, 0o644);
    if (!Buffer.from(current).equals(Buffer.from(expectedPrevious))) throw new TypeError("pre-release active A authorization changed before B switch");
  }
  const temporary = `${path}.tmp.${process.pid}`;
  const descriptor = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o644);
  try {
    chownSync(temporary, 0, 0);
    chmodSync(temporary, 0o644);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new TypeError("pre-release active authorization short write");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve switch error */ }
    throw error;
  }
  if (!Buffer.from(stableRootBytes(path, 0o644)).equals(Buffer.from(bytes))) throw new TypeError("pre-release active authorization projection mismatch");
}

function systemctl(args: readonly string[]): void {
  execFileSync("/usr/bin/systemctl", [...args], { env: SYSTEMCTL_ENV, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 64 * 1024 });
}

async function poll<T>(label: string, timeoutMs: number, read: () => T): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let last: unknown = null;
  while (performance.now() < deadline) {
    try { return read(); } catch (error) { last = error; }
    await sleep(100);
  }
  throw new TypeError(`${label} did not become available: ${last instanceof Error ? last.message : String(last)}`);
}

interface ObservedStagedArtifactsV1 {
  readonly manifest: ReturnType<typeof decodePreReleaseStagingManifestV1>;
  readonly identities: readonly PreReleaseStagingArtifactIdentityV1[];
  readonly bytes: Readonly<Record<PreReleaseStagingArtifactNameV1, Uint8Array>>;
}

function verifyStagedArtifacts(
  authorization: PreReleaseLaunchAuthorizationV1,
  controllerBoundaryEvidenceRoot: Hash,
): ObservedStagedArtifactsV1 {
  const manifestBytes = stableRootBytes(PRE_RELEASE_STAGING_LAYOUT_V1.manifestPath, 0o444);
  const manifest = decodePreReleaseStagingManifestV1(decodeCanonicalJson(manifestBytes));
  if (!Buffer.from(manifestBytes).equals(Buffer.from(encodeCanonicalBytes(manifest)))) throw new TypeError("pre-release staging manifest bytes are not canonical");
  const manifestRoot = hashDomain("aloha/pre-release-staging-manifest/root/v1", { contentSha256: sha256Hex(manifestBytes), byteLength: String(manifestBytes.byteLength) });
  const observedBytes = {} as Record<PreReleaseStagingArtifactNameV1, Uint8Array>;
  const identities = PRE_RELEASE_STAGING_ARTIFACT_NAMES_V1.map(name => {
    const path = preReleaseStagingArtifactPathV1(name);
    const before = statSync(path, { bigint: true });
    if (realpathSync(path) !== path || !before.isFile() || before.uid !== 0n || (before.mode & 0o022n) !== 0n) throw new TypeError(`pre-release staged artifact is not root-controlled: ${name}`);
    const bytes = new Uint8Array(readFileSync(path));
    const after = statSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.size !== BigInt(bytes.byteLength)) throw new TypeError(`pre-release staged artifact changed: ${name}`);
    observedBytes[name] = bytes;
    return Object.freeze({ name, installPath: path, contentSha256: sha256Hex(bytes), byteLength: String(bytes.byteLength) });
  });
  if (hashPreReleaseStagingArtifactSetV1(identities) !== authorization.stagingArtifactSetRoot
    || manifestRoot !== authorization.stagingManifestRoot
    || manifest.controllerBoundaryEvidenceRoot !== controllerBoundaryEvidenceRoot
    || manifest.candidateReleaseCommit !== authorization.candidateReleaseCommit
    || manifest.runtimeBindingId !== authorization.runtimeBindingId
    || manifest.releaseProvenanceHash !== authorization.releaseProvenanceHash) {
    throw new TypeError("pre-release staged artifact denominator does not exact-join signed authorization");
  }
  return Object.freeze({ manifest, identities: Object.freeze(identities), bytes: Object.freeze(observedBytes) });
}

function observeFrozenPreReleaseLogV1(
  ready: ReturnType<typeof observePreReleaseBReadyFactsV1>,
): Readonly<{
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly startInclusive: string;
  readonly endExclusive: string;
  readonly contentSha256: Hash;
}> {
  const path = PRE_RELEASE_STAGING_LAYOUT_V1.logPath;
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) {
    throw new TypeError("pre-release B log is not a canonical regular file");
  }
  const logStart = ready.readyEvent.logStart as Readonly<Record<string, unknown>>;
  const before = statSync(path, { bigint: true });
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  const startInclusive = logStart.startInclusive;
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength)
    || logStart.device !== String(after.dev) || logStart.inode !== String(after.ino)
    || typeof startInclusive !== "string" || !/^(0|[1-9][0-9]*)$/.test(startInclusive)
    || BigInt(startInclusive) >= after.size || after.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("pre-release B frozen log window is unstable, empty, or does not join ready");
  }
  const endExclusive = String(after.size);
  return Object.freeze({
    path,
    device: String(after.dev),
    inode: String(after.ino),
    startInclusive,
    endExclusive,
    contentSha256: sha256Hex(bytes.slice(Number(startInclusive), Number(endExclusive))),
  });
}

function observeQualificationFinalTerminalReadyV1(
  authorization: PreReleaseLaunchAuthorizationV1,
  ready: ReturnType<typeof observePreReleaseBReadyFactsV1>,
): void {
  const path = PRE_RELEASE_STAGING_LAYOUT_V1.qualificationFinalTerminalReadyPath;
  if (!existsSync(path) || realpathSync(path) !== path || !lstatSync(path).isFile()) {
    throw new TypeError("qualification-final terminal-ready locator is absent");
  }
  const before = statSync(path, { bigint: true });
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength) || (after.mode & 0o022n) !== 0n) {
    throw new TypeError("qualification-final terminal-ready locator changed during read");
  }
  const locator = decodeCanonicalJson(bytes) as unknown as Readonly<Record<string, unknown>>;
  const keys = Object.keys(locator).sort();
  const expectedKeys = ["authorizationId", "kind", "pid", "schemaVersion"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || locator.schemaVersion !== 1
    || locator.kind !== "aloha.pre-release-qualification-final-terminal-ready-locator"
    || locator.authorizationId !== authorization.authorizationId
    || locator.pid !== ready.processAnchor.pid
    || !Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(locator as never)))) {
    throw new TypeError("qualification-final terminal-ready locator does not exact-join B");
  }
  const raw = observeProductionPerformanceDatabaseV1(PRE_RELEASE_STAGING_LAYOUT_V1.processEvidenceDatabasePath);
  const finalGeneration = raw.bundle?.generationSegments.at(-1);
  if (raw.status !== "raw-complete" || raw.release === null || raw.bundle === null
    || raw.sixStepWindowSelection === null
    || raw.release.bindingId !== authorization.runtimeBindingId
    || raw.release.releaseProvenanceHash !== authorization.releaseProvenanceHash
    || raw.release.candidateReleaseCommit !== authorization.candidateReleaseCommit
    || finalGeneration?.lastHeadOrdinal !== "100") {
    throw new TypeError(`qualification-final terminal-ready SQLite denominator is incomplete: ${raw.reasons.join(",")}`);
  }
}

function claimExpectation(authorization: PreReleaseLaunchAuthorizationV1) {
  return Object.freeze({
    authorization,
    runtimeBindingId: authorization.runtimeBindingId,
    releaseProvenanceHash: authorization.releaseProvenanceHash,
    stagingArtifactSetRoot: authorization.stagingArtifactSetRoot,
    stagingManifestRoot: authorization.stagingManifestRoot,
    observerStoreDirectory: authorization.observerStoreDirectory,
    nowUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
  });
}

export interface FinalPreReleaseQualificationV1 {
  readonly controllerReceiptId: Hash;
  readonly restartProbeAuthorizationId: Hash;
  readonly qualificationFinalAuthorizationId: Hash;
  readonly bProcessAnchorHash: Hash;
  readonly bFrozenTaskSetRoot: Hash;
  readonly bSnapshotRoot: Hash;
  readonly bQualificationId: Hash;
  readonly advisoryJudgmentPath: string;
  readonly advisoryJudgmentRoot: Hash;
  readonly advisoryStatus: ProductionReleaseAcceptanceAdvisoryStatusV1;
  readonly factLogPath: string;
  readonly factLogSha256: Hash;
}

/** Sole fixed root workflow. It accepts only a genuine in-process Boundary
 * receipt and never signs, broadcasts, promotes, or invokes production. */
export async function runFinalPreReleaseV1(boundaryReceipt: BoundaryReceipt): Promise<FinalPreReleaseQualificationV1> {
  if (arguments.length !== 1) throw new TypeError("final pre-release runner accepts only one Boundary receipt");
  if (process.platform !== "linux" || typeof process.geteuid !== "function" || process.geteuid() !== 0) throw new TypeError("final pre-release runner requires a root Linux host");
  ensureRootDirectory(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationArchiveDirectory, 0o700);
  ensureRootDirectory(dirname(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath), 0o700);
  const installedController = installExactPreReleaseRestartControllerV1(boundaryReceipt);
  const probeRaw = canonicalAuthorization(PRE_RELEASE_STAGING_LAYOUT_V1.restartProbeAuthorizationPath);
  const signerPin = decodeRuntimeReleaseSignerPinV1(decodeCanonicalJson(stableRootBytes(PRE_RELEASE_STAGING_LAYOUT_V1.runtimeSignerPinPath, 0o444)) as object);
  verifyPreReleaseLaunchAuthorizationSignatureV1(probeRaw.authorization, signerPin);
  if (probeRaw.authorization.roundRole !== "restart-probe" || probeRaw.authorization.predecessor !== null
    || probeRaw.authorization.controllerBoundaryEvidenceRoot !== installedController.controllerBoundaryEvidenceRoot) throw new TypeError("signed A authorization is not the fixed restart-probe round");
  verifyStagedArtifacts(probeRaw.authorization, installedController.controllerBoundaryEvidenceRoot as Hash);
  const probeClaim = claimFixedPreReleaseAuthorizationV1(claimExpectation(probeRaw.authorization));
  installActiveAuthorization(probeRaw.bytes, null);
  systemctl(["daemon-reload"]);
  systemctl(["start", PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit]);
  await poll("pre-release A ready", 300_000, () => observePreReleaseProcessPreFactsV1());
  systemctl(["start", "--no-block", PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.controllerSystemdUnit]);
  await poll("pre-release A restart terminal", 300_000, () => sealPreReleaseRestartTerminalV1({
    databasePath: PRE_RELEASE_STAGING_LAYOUT_V1.processEvidenceDatabasePath,
    authorization: probeRaw.authorization,
    authorizationClaim: probeClaim,
  }));
  const controllerReceipt = await poll("pre-release controller receipt", 300_000, () => readFixedPreReleaseRestartControllerReceiptV1());
  await poll("externally signed B authorization", 300_000, () => {
    if (!existsSync(PRE_RELEASE_STAGING_LAYOUT_V1.qualificationFinalAuthorizationPath)) throw new TypeError("B authorization is not published");
    return true;
  });
  const finalRaw = canonicalAuthorization(PRE_RELEASE_STAGING_LAYOUT_V1.qualificationFinalAuthorizationPath);
  verifyPreReleaseLaunchAuthorizationSignatureV1(finalRaw.authorization, signerPin);
  assertQualificationFinalSafetyAuthorizationV1(
    finalRaw.authorization,
    probeRaw.authorization,
    installedController.controllerBoundaryEvidenceRoot as Hash,
  );
  const finalClaimCapability = claimFixedPreReleaseAuthorizationV1(claimExpectation(finalRaw.authorization));
  const finalClaim = readFixedPreReleaseAuthorizationClaimV1(finalRaw.authorization, finalClaimCapability);
  installActiveAuthorization(finalRaw.bytes, probeRaw.bytes);
  systemctl(["start", PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit]);
  try {
  const predecessor = Object.freeze({
    releaseProvenanceHash: controllerReceipt.target.releaseProvenanceHash,
    candidateReleaseCommit: controllerReceipt.target.candidateReleaseCommit,
    runtimeBindingId: controllerReceipt.target.runtimeBindingId,
    processReadyEventId: controllerReceipt.post.ready.eventId,
    sigtermObservedEventId: controllerReceipt.post.observed.eventId,
    sigtermDrainedEventId: controllerReceipt.post.drained.eventId,
    predecessorProcessAnchorHash: controllerReceipt.pre.ready.processAnchorHash,
    checkpointRootEnvelopeHash: controllerReceipt.post.checkpoint.checkpointRootEnvelopeHash,
    candidatePartitionRoot: controllerReceipt.post.checkpoint.candidatePartitionRoot,
    outcomePartitionRoot: controllerReceipt.post.checkpoint.outcomePartitionRoot,
    outcomeHashes: controllerReceipt.post.checkpoint.outcomeHashes,
  });
  const bFacts = await poll("pre-release B ready", 300_000, () => observePreReleaseBReadyFactsV1(predecessor));
  await poll("pre-release B qualification-final terminal ready", 600_000, () => {
    observeQualificationFinalTerminalReadyV1(finalRaw.authorization, bFacts);
    return true;
  });
  const bSystemd = observeFixedPreReleaseUnitV1();
  const bProcess = observeFixedPreReleaseProcessV1(bSystemd);
  if (bSystemd.mainPid !== bProcess.pid || bSystemd.invocationId !== bProcess.invocationId
    || bFacts.processAnchor.pid !== bProcess.pid || bFacts.processAnchor.processStartTicks !== bProcess.processStartTicks
    || bFacts.processAnchor.bootIdHash !== bProcess.bootIdHash || bFacts.processAnchor.executableHash !== bProcess.executableSha256
    || bFacts.ready.processAnchorHash !== hashProcessAnchor(bFacts.processAnchor)) throw new TypeError("pre-release B ready does not exact-join root-observed systemd/proc identity");
  invokeFixedPreReleaseFreezeV1();
  let thawed = false;
  try {
    const initialFrozen = observeFixedPreReleaseFrozenCgroupV1(bProcess);
    const frozenFacts = observePreReleaseBReadyFactsV1(predecessor);
    const frozenSystemd = observeFixedPreReleaseUnitV1();
    const frozenProcess = observeFixedPreReleaseProcessV1(frozenSystemd);
    if (!sameProcessObservationV1(bProcess, frozenProcess)
      || Buffer.from(encodeCanonicalBytes(bFacts)).compare(Buffer.from(encodeCanonicalBytes(frozenFacts))) !== 0) throw new TypeError("pre-release B changed inside frozen qualification boundary");
    const frozen = bindStablePreReleaseFrozenCgroupV1(initialFrozen, observeFixedPreReleaseFrozenCgroupV1(bProcess));
    const bSnapshots = await publishPreReleaseBDurableSnapshotsV1();
    const snapshotFacts = observePreReleaseBReadyFactsV1(predecessor, Object.freeze({ processEvidence: bSnapshots.processEvidence.snapshotPath, checkpoint: bSnapshots.checkpoint.snapshotPath }));
    const semantic = (value: typeof bFacts) => {
      const { path: _path, device: _device, inode: _inode, ...checkpoint } = value.checkpoint;
      return Object.freeze({ ...value, checkpoint });
    };
    if (Buffer.from(encodeCanonicalBytes(semantic(bFacts))).compare(Buffer.from(encodeCanonicalBytes(semantic(snapshotFacts)))) !== 0) throw new TypeError("pre-release B root-owned snapshots do not reproduce frozen B facts");
    const frozenStaging = verifyStagedArtifacts(
      finalRaw.authorization,
      installedController.controllerBoundaryEvidenceRoot as Hash,
    );
    const frozenLog = observeFrozenPreReleaseLogV1(bFacts);
    const bQualificationCapability = issueFrozenPreReleaseBQualificationCapabilityV1(Object.freeze({
      boundaryReceipt,
      authorization: finalRaw.authorization,
      authorizationClaim: finalClaim,
      manifest: frozenStaging.manifest,
      stagingArtifacts: frozenStaging.identities,
      stagingArtifactBytes: frozenStaging.bytes,
      ready: snapshotFacts,
      systemd: frozenSystemd,
      process: frozenProcess,
      frozen,
      snapshots: bSnapshots,
      log: frozenLog,
    }));
    const importedB = await importFrozenPreReleaseBRuntimeV1(bQualificationCapability);
    const advisoryMaterial = issueImportedFrozenPreReleaseBAdvisoryMaterialV1(importedB);
    const advisoryJudgment = await observeProductionReleaseAcceptanceAdvisoryV1(advisoryMaterial);
    atomicNoClobberPublishV1({
      directory: PRE_RELEASE_STAGING_LAYOUT_V1.runtimeOutputDirectory,
      path: PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath,
      bytes: encodeCanonicalBytes(advisoryJudgment),
      uid: 0,
      gid: 0,
      mode: 0o600,
      tempDiscriminator: String(process.pid),
    });
    const terminalPhysicalObservation = readImportedFrozenPreReleaseBTerminalPhysicalObservationV1(importedB);
    const factLogBytes = encodePreReleaseFactLogJsonlV1(readPreReleaseFactLogV1(
      PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath,
      terminalPhysicalObservation,
    ));
    atomicNoClobberPublishV1({
      directory: PRE_RELEASE_STAGING_LAYOUT_V1.runtimeOutputDirectory,
      path: PRE_RELEASE_STAGING_LAYOUT_V1.factLogPath,
      bytes: factLogBytes,
      uid: 0,
      gid: 0,
      mode: 0o600,
      tempDiscriminator: String(process.pid),
    });
    const bThaw = invokeFixedPreReleaseThawV1(bProcess);
    thawed = true;
    const qualificationPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.pre-release-b-root-qualification" as const,
      controllerReceiptId: controllerReceipt.receiptId,
      restartProbeAuthorizationId: probeRaw.authorization.authorizationId,
      qualificationFinalAuthorizationId: finalRaw.authorization.authorizationId,
      controllerBoundaryEvidenceRoot: finalRaw.authorization.controllerBoundaryEvidenceRoot,
      systemd: bSystemd,
      process: bProcess,
      ready: bFacts.ready,
      processAnchor: bFacts.processAnchor,
      frozenSystemd,
      frozenProcess,
      frozen,
      durableSnapshots: bSnapshots,
      thaw: bThaw,
    });
    const bQualificationId = hashDomain("aloha/pre-release-b-root-qualification/v1", qualificationPayload as never);
    atomicNoClobberPublishV1({
      directory: PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.controllerDirectory,
      path: PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.bQualificationPath,
      bytes: encodeCanonicalBytes(Object.freeze({ ...qualificationPayload, bQualificationId })),
      uid: 0,
      gid: 0,
      mode: 0o600,
      tempDiscriminator: String(process.pid),
    });
    return Object.freeze({
      controllerReceiptId: controllerReceipt.receiptId,
      restartProbeAuthorizationId: probeRaw.authorization.authorizationId,
      qualificationFinalAuthorizationId: finalRaw.authorization.authorizationId,
      bProcessAnchorHash: bFacts.ready.processAnchorHash,
      bFrozenTaskSetRoot: frozen.taskSetRoot,
      bSnapshotRoot: bSnapshots.snapshotRoot,
      bQualificationId,
      advisoryJudgmentPath: PRE_RELEASE_STAGING_LAYOUT_V1.advisoryJudgmentPath,
      advisoryJudgmentRoot: advisoryJudgment.judgmentRoot,
      advisoryStatus: advisoryJudgment.status,
      factLogPath: PRE_RELEASE_STAGING_LAYOUT_V1.factLogPath,
      factLogSha256: sha256Hex(factLogBytes),
    });
  } finally {
    if (!thawed) {
      try { invokeFixedPreReleaseThawV1(bProcess); } catch { /* frozen failure remains authoritative */ }
    }
  }
  } finally {
    systemctl(["stop", PRE_RELEASE_STAGING_LAYOUT_V1.systemdUnit]);
    await poll("pre-release B exact stop", 30_000, () => {
      const stopped = observeFixedPreReleaseUnitV1();
      if (stopped.mainPid !== "0" || stopped.activeState !== "inactive" || stopped.subState !== "dead") {
        throw new TypeError("pre-release B did not reach exact inactive/dead state");
      }
      return true;
    });
  }
}
