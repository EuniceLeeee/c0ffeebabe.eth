import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { hashProcessAnchor } from "../../../specs/core-envelope/src/index.ts";
import {
  observeCurrentCheckpointFactV1,
  publishPreReleaseADurableSnapshotsV1,
  observePreReleaseProcessPostFactsV1,
  observePreReleaseProcessPreFactsV1,
  type PreReleaseProcessPostFactsV1,
  type PreReleaseProcessPreFactsV1,
} from "./durable-owner.ts";
import { atomicNoClobberPublishV1 } from "./atomic-file.ts";
import { readStableOwnedPhysicalFileV1 } from "./stable-owned-file.ts";
import {
  assertFixedPreReleaseUnitBytesV1,
  assertRootControllerHostV1,
  bestEffortFixedPreReleaseThawV1,
  bindStablePreReleaseFrozenCgroupV1,
  controllerImplementationFactsV1,
  exactProcessStillExistsV1,
  invokeFixedPreReleaseFreezeV1,
  invokeFixedPreReleaseSigtermV1,
  invokeFixedPreReleaseThawV1,
  observeFixedPreReleaseFrozenCgroupV1,
  observeFixedPreReleaseProcessV1,
  observeFixedPreReleaseUnitV1,
  sameProcessObservationV1,
} from "./linux-owner.ts";
import {
  decodePreReleaseRestartControllerReceiptV1,
  decodePreReleaseRestartControllerRoundLockV1,
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 as LAYOUT,
  PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1,
  sealPreReleaseRestartControllerReceiptV1,
  sealPreReleaseRestartControllerRoundLockV1,
  type PreReleaseControllerProcessObservationV1,
  type PreReleaseControllerSystemdObservationV1,
  type PreReleaseRestartControllerReceiptV1,
} from "./spec.ts";

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function unixNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function assertRootDirectory(path: string): void {
  if (!path.startsWith("/") || realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new TypeError(`controller path is not a canonical directory: ${path}`);
  const stat = statSync(path, { bigint: true });
  if (stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) throw new TypeError(`controller directory is not root-owned and non-writable by group/world: ${path}`);
}

function acquirePermanentRoundLock(implementationIdentityHash: Hash): Readonly<{ readonly descriptor: number; readonly contentSha256: Hash }> {
  assertRootDirectory(LAYOUT.controllerDirectory);
  if (existsSync(LAYOUT.receiptPath) || existsSync(LAYOUT.evidencePath)) throw new TypeError("pre-release restart controller round is already published");
  const descriptor = openSync(LAYOUT.roundLockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    fchownSync(descriptor, 0, 0);
    fchmodSync(descriptor, 0o600);
    const bytes = encodeCanonicalBytes(sealPreReleaseRestartControllerRoundLockV1({
      implementationIdentityHash,
      controllerPid: String(process.pid),
      acquiredAtUnixNs: unixNs(),
    }));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new TypeError("pre-release restart controller round lock short write");
      offset += written;
    }
    fsyncSync(descriptor);
    const directoryDescriptor = openSync(LAYOUT.controllerDirectory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    return Object.freeze({ descriptor, contentSha256: sha256Hex(bytes) });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function atomicPublishRootFile(path: string, bytes: Uint8Array) {
  assertRootDirectory(LAYOUT.controllerDirectory);
  const publication = atomicNoClobberPublishV1({
    directory: LAYOUT.controllerDirectory,
    path,
    bytes,
    uid: 0,
    gid: 0,
    mode: 0o600,
    tempDiscriminator: String(process.pid),
  });
  if (publication.uid !== "0" || publication.gid !== "0" || publication.mode !== "384") throw new TypeError("controller root publication owner/mode mismatch");
  return Object.freeze({ ...publication, uid: "0" as const, mode: "384" as const });
}

function stableSystemdIdentity(left: PreReleaseControllerSystemdObservationV1, right: PreReleaseControllerSystemdObservationV1): boolean {
  const { observedAtUnixNs: _leftTime, ...leftIdentity } = left;
  const { observedAtUnixNs: _rightTime, ...rightIdentity } = right;
  return same(leftIdentity, rightIdentity);
}

function assertReadyJoins(
  pre: PreReleaseProcessPreFactsV1,
  process: PreReleaseControllerProcessObservationV1,
  systemd: PreReleaseControllerSystemdObservationV1,
  checkpoint: ReturnType<typeof observeCurrentCheckpointFactV1>,
  targetSystemdUnitSha256: Hash,
): void {
  const runtime = pre.runtimeAnchor;
  const anchor = pre.processAnchor;
  if (runtime.pid !== process.pid || runtime.processStartTicks !== process.processStartTicks || runtime.bootId !== process.bootId
    || runtime.invocationId !== process.invocationId || runtime.nodeExecutableSha256 !== process.executableSha256
    || runtime.systemdUnit !== LAYOUT.targetSystemdUnit || runtime.serviceName !== LAYOUT.targetServiceName
    || anchor.pid !== process.pid || anchor.processStartTicks !== process.processStartTicks || anchor.bootIdHash !== process.bootIdHash
    || anchor.executableHash !== process.executableSha256 || pre.ready.processAnchorHash !== hashProcessAnchor(anchor as never)
    || systemd.mainPid !== process.pid || systemd.invocationId !== process.invocationId || systemd.controlGroup !== process.controlGroup
    || pre.targetSystemdUnitSha256 !== targetSystemdUnitSha256) throw new TypeError("pre-release ready evidence is not joined to the independently observed systemd/proc process");
  const checkpointRoot = pre.readyEvent.checkpointRoot as Readonly<Record<string, unknown>>;
  const checkpointStore = pre.readyEvent.checkpointStore as Readonly<Record<string, unknown>>;
  if (checkpointRoot === null || typeof checkpointRoot !== "object" || checkpointStore === null || typeof checkpointStore !== "object"
    || checkpointRoot.revision !== checkpoint.checkpointRevision || checkpointRoot.inProgressRunId !== checkpoint.runId
    || checkpointStore.path !== checkpoint.path || checkpointStore.device !== checkpoint.device || checkpointStore.inode !== checkpoint.inode) throw new TypeError("pre-release ready evidence is not joined to the current root-reachable checkpoint");
}

async function waitForExactExit(processIdentity: PreReleaseControllerProcessObservationV1): Promise<PreReleaseControllerSystemdObservationV1> {
  const deadline = performance.now() + LAYOUT.drainTimeoutMs;
  while (performance.now() < deadline) {
    const exists = exactProcessStillExistsV1(processIdentity);
    const systemd = observeFixedPreReleaseUnitV1();
    if (!exists) {
      if (systemd.mainPid !== "0" || systemd.activeState === "active" || systemd.subState === "running"
        || systemd.invocationId !== processIdentity.invocationId || (systemd.controlGroup !== "" && systemd.controlGroup !== processIdentity.controlGroup)
        || systemd.restart !== "no") throw new TypeError("systemd did not preserve the exact stopped invocation without restart");
      return systemd;
    }
    if (systemd.mainPid !== processIdentity.pid || systemd.invocationId !== processIdentity.invocationId) throw new TypeError("systemd changed MainPID or InvocationID before exact process exit");
    await sleep(LAYOUT.pollIntervalMs);
  }
  throw new TypeError("pre-release A did not exit within the fixed drain timeout");
}

async function waitForPostFacts(pre: PreReleaseProcessPreFactsV1): Promise<PreReleaseProcessPostFactsV1> {
  const deadline = performance.now() + LAYOUT.drainTimeoutMs;
  let lastPending: Error | null = null;
  while (performance.now() < deadline) {
    try {
      return observePreReleaseProcessPostFactsV1(pre);
    } catch (error) {
      if (!(error instanceof Error) || (!error.message.includes("requires exactly ready, observed, drained")
        && !error.message.includes("requires exactly one durable restart terminal"))) throw error;
      lastPending = error;
      await sleep(LAYOUT.pollIntervalMs);
    }
  }
  throw new TypeError(`pre-release A durable drain evidence did not become terminal: ${lastPending?.message ?? "missing"}`);
}

function evidencePayload(input: Omit<PreReleaseRestartControllerReceiptV1, "publication" | "receiptId">): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    controller: input.controller,
    target: input.target,
    pre: input.pre,
    action: input.action,
    post: input.post,
  });
}

/** Root-only A controller. It accepts no paths, PIDs, signals, process DTOs,
 * callbacks, or verdicts. Every mutable fact is independently re-read from a
 * fixed systemd unit, /proc, or the two fixed SQLite stores. */
export async function runPreReleaseRestartControllerV1(): Promise<PreReleaseRestartControllerReceiptV1> {
  if (process.argv.length !== 2 || process.argv[1] !== LAYOUT.controllerEntrypointPath) throw new TypeError("pre-release restart controller entrypoint or argv is not fixed");
  const controllerOwner = assertRootControllerHostV1();
  const implementation = controllerImplementationFactsV1();
  const roundLock = acquirePermanentRoundLock(implementation.implementationIdentityHash);
  try {
    const targetSystemdUnitSha256 = assertFixedPreReleaseUnitBytesV1();
    const preSystemd = observeFixedPreReleaseUnitV1();
    const preProcess = observeFixedPreReleaseProcessV1(preSystemd);
    const preProcessFacts = observePreReleaseProcessPreFactsV1();
    const preCheckpoint = observeCurrentCheckpointFactV1();
    assertReadyJoins(preProcessFacts, preProcess, preSystemd, preCheckpoint, targetSystemdUnitSha256);
    let freezeRequested = false;
    let thawed = false;
    let freezeRequest: ReturnType<typeof invokeFixedPreReleaseFreezeV1>;
    let frozenState: ReturnType<typeof observeFixedPreReleaseFrozenCgroupV1>;
    let frozenPreFacts: PreReleaseProcessPreFactsV1;
    let frozenCheckpoint: ReturnType<typeof observeCurrentCheckpointFactV1>;
    let frozenCheckedAtUnixNs: string;
    let queuedSigterm: ReturnType<typeof invokeFixedPreReleaseSigtermV1>;
    let thaw: ReturnType<typeof invokeFixedPreReleaseThawV1>;
    try {
      freezeRequest = invokeFixedPreReleaseFreezeV1();
      freezeRequested = true;
      const initialFrozenState = observeFixedPreReleaseFrozenCgroupV1(preProcess);
      frozenPreFacts = observePreReleaseProcessPreFactsV1();
      frozenCheckpoint = observeCurrentCheckpointFactV1();
      frozenCheckedAtUnixNs = unixNs();
      if (!same(preProcessFacts, frozenPreFacts) || !same(preCheckpoint, frozenCheckpoint)) throw new TypeError("pre-release A durable ready/checkpoint facts changed before the frozen signal boundary");
      const systemdFence = observeFixedPreReleaseUnitV1();
      const processFence = observeFixedPreReleaseProcessV1(systemdFence);
      if (!stableSystemdIdentity(preSystemd, systemdFence) || !sameProcessObservationV1(preProcess, processFence)) throw new TypeError("pre-release A changed inside the frozen signal boundary");
      frozenState = bindStablePreReleaseFrozenCgroupV1(
        initialFrozenState,
        observeFixedPreReleaseFrozenCgroupV1(preProcess),
      );
      queuedSigterm = invokeFixedPreReleaseSigtermV1();
      thaw = invokeFixedPreReleaseThawV1(preProcess);
      thawed = true;
    } finally {
      if (freezeRequested && !thawed) bestEffortFixedPreReleaseThawV1();
    }
    const postSystemd = await waitForExactExit(preProcess);
    const postFacts = await waitForPostFacts(preProcessFacts);
    if (postSystemd.result !== "success" || postSystemd.execMainCode !== "1" || postSystemd.execMainStatus !== "0") throw new TypeError("pre-release A did not complete its SIGTERM drain successfully");
    const durableSnapshots = await publishPreReleaseADurableSnapshotsV1();
    const snapshotPostFacts = observePreReleaseProcessPostFactsV1(preProcessFacts, Object.freeze({
      processEvidence: durableSnapshots.processEvidence.snapshotPath,
      checkpoint: durableSnapshots.checkpoint.snapshotPath,
    }));
    const semanticCheckpoint = (value: typeof postFacts.checkpoint) => {
      const { path: _path, device: _device, inode: _inode, ...semantic } = value;
      return semantic;
    };
    if (!same(postFacts.ready, snapshotPostFacts.ready)
      || !same(postFacts.observed, snapshotPostFacts.observed)
      || !same(postFacts.drained, snapshotPostFacts.drained)
      || !same(postFacts.terminal, snapshotPostFacts.terminal)
      || !same(semanticCheckpoint(postFacts.checkpoint), semanticCheckpoint(snapshotPostFacts.checkpoint))) {
      throw new TypeError("pre-release A root-owned durable snapshots do not reproduce the stopped source facts");
    }
    const runtime = preProcessFacts.runtimeAnchor;
    const terminal = postFacts.terminal;
    const unsigned = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.pre-release-restart-controller-receipt" as const,
      controller: Object.freeze({
        serviceName: LAYOUT.controllerServiceName,
        systemdUnit: LAYOUT.controllerSystemdUnit,
        systemdUnitSha256: implementation.systemdUnitSha256,
        entrypointPath: LAYOUT.controllerEntrypointPath,
        entrypointSha256: implementation.entrypointSha256,
        implementationIdentityHash: implementation.implementationIdentityHash,
        controllerPid: String(process.pid),
        ownerProcess: controllerOwner,
        roundLockContentSha256: roundLock.contentSha256,
      }),
      target: Object.freeze({
        serviceName: LAYOUT.targetServiceName,
        systemdUnit: LAYOUT.targetSystemdUnit,
        systemdUnitSha256: targetSystemdUnitSha256,
        candidateReleaseCommit: preProcessFacts.release.candidateReleaseCommit,
        runtimeBindingId: preProcessFacts.release.bindingId,
        releaseProvenanceHash: preProcessFacts.release.releaseProvenanceHash,
        stagingArtifactSetRoot: terminal.stagingArtifactSetRoot,
        stagingManifestRoot: terminal.stagingManifestRoot,
        controllerBoundaryEvidenceRoot: terminal.controllerBoundaryEvidenceRoot,
        authorizationId: terminal.authorizationId,
        authorizationClaimId: terminal.authorizationClaimId,
      }),
      pre: Object.freeze({
        systemd: preSystemd,
        process: preProcess,
        ready: preProcessFacts.ready,
        runtimeAnchor: runtime,
        processAnchor: preProcessFacts.processAnchor,
        checkpoint: preCheckpoint,
      }),
      action: Object.freeze({
        freezeRequest,
        frozenState,
        frozenDurableRecheck: Object.freeze({ ready: frozenPreFacts.ready, checkpoint: frozenCheckpoint, checkedAtUnixNs: frozenCheckedAtUnixNs }),
        queuedSigterm: Object.freeze({ ...queuedSigterm, signal: "SIGTERM" as const, target: "main" as const }),
        thaw,
      }),
      post: Object.freeze({
        systemd: postSystemd,
        exactProcessExited: true as const,
        ready: postFacts.ready,
        observed: postFacts.observed,
        drained: postFacts.drained,
        terminal,
        checkpoint: postFacts.checkpoint,
        durableSnapshots,
      }),
    });
    const evidence = evidencePayload(unsigned);
    const evidenceBytes = encodeCanonicalBytes(evidence);
    const evidencePublication = atomicPublishRootFile(LAYOUT.evidencePath, evidenceBytes);
    const receipt = sealPreReleaseRestartControllerReceiptV1({
      ...unsigned,
      publication: Object.freeze({
        evidencePath: LAYOUT.evidencePath,
        evidenceId: hashDomain("aloha/pre-release-restart-controller-evidence/v1", evidence as never),
        ...evidencePublication,
        atomicNoClobberLink: true,
        fileFsynced: true,
        directoryFsynced: true,
      }),
    });
    atomicPublishRootFile(LAYOUT.receiptPath, encodeCanonicalBytes(receipt));
    return readFixedPreReleaseRestartControllerReceiptV1();
  } finally {
    // The lock file remains as a durable one-shot round claim. Closing the fd
    // releases no authority to re-run this A controller.
    closeSync(roundLock.descriptor);
  }
}

/** B-side read-only primitive for later predecessor wiring. It does not start
 * B or issue any launcher capability; it only proves both root-owned atomic
 * files still equal the receipt's exact canonical evidence. */
export function readFixedPreReleaseRestartControllerReceiptV1(): PreReleaseRestartControllerReceiptV1 {
  assertRootDirectory(LAYOUT.controllerDirectory);
  const stableRootFile = (
    path: string,
    expectedMode = 0o600,
    maximumByteLength: bigint | null = null,
  ) => readStableOwnedPhysicalFileV1(path, Object.freeze({
    uid: 0n,
    gid: 0n,
    mode: BigInt(expectedMode),
    maximumByteLength,
  }));
  const receiptFile = stableRootFile(LAYOUT.receiptPath);
  const receiptBytes = receiptFile.bytes;
  const receipt = decodePreReleaseRestartControllerReceiptV1(decodeCanonicalJson(receiptBytes));
  for (const snapshot of [receipt.post.durableSnapshots.processEvidence, receipt.post.durableSnapshots.checkpoint]) {
    const file = stableRootFile(snapshot.snapshotPath);
    const metadata = file.stat as unknown as { readonly dev: bigint; readonly ino: bigint };
    if (snapshot.device !== String(metadata.dev) || snapshot.inode !== String(metadata.ino)
      || snapshot.byteLength !== String(file.bytes.byteLength) || snapshot.contentSha256 !== sha256Hex(file.bytes)) {
      throw new TypeError("pre-release controller durable database snapshot changed");
    }
  }
  const sixStepEvidenceLog = receipt.post.durableSnapshots.sixStepEvidenceLog;
  const sixStepEvidenceFile = stableRootFile(
    sixStepEvidenceLog.snapshotPath,
    0o400,
    BigInt(PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes),
  );
  const sixStepEvidenceMetadata = sixStepEvidenceFile.stat as unknown as { readonly dev: bigint; readonly ino: bigint };
  if (sixStepEvidenceLog.device !== String(sixStepEvidenceMetadata.dev)
    || sixStepEvidenceLog.inode !== String(sixStepEvidenceMetadata.ino)
    || sixStepEvidenceLog.byteLength !== String(sixStepEvidenceFile.bytes.byteLength)
    || sixStepEvidenceLog.contentSha256 !== sha256Hex(sixStepEvidenceFile.bytes)) {
    throw new TypeError("pre-release controller Six-Step source-ledger snapshot changed");
  }
  for (const snapshot of [
    receipt.post.durableSnapshots.observerContent,
    receipt.post.durableSnapshots.terminalLocators,
    receipt.post.durableSnapshots.sixStepBoundaries,
  ]) {
    if (!existsSync(snapshot.snapshotDirectory) || realpathSync(snapshot.snapshotDirectory) !== snapshot.snapshotDirectory
      || !lstatSync(snapshot.snapshotDirectory).isDirectory()) throw new TypeError("pre-release controller durable directory snapshot is missing");
    const directoryBefore = statSync(snapshot.snapshotDirectory, { bigint: true });
    const names = readdirSync(snapshot.snapshotDirectory).sort();
    if (snapshot.directoryDevice !== String(directoryBefore.dev) || snapshot.directoryInode !== String(directoryBefore.ino)
      || names.length !== snapshot.entries.length || names.some((name, index) => name !== snapshot.entries[index]?.name)) {
      throw new TypeError("pre-release controller durable directory snapshot identity changed");
    }
    for (const entry of snapshot.entries) {
      const file = stableRootFile(`${snapshot.snapshotDirectory}/${entry.name}`, 0o400);
      const metadata = file.stat as unknown as { readonly dev: bigint; readonly ino: bigint };
      if (entry.device !== String(metadata.dev) || entry.inode !== String(metadata.ino)
        || entry.byteLength !== String(file.bytes.byteLength) || entry.contentSha256 !== sha256Hex(file.bytes)) {
        throw new TypeError("pre-release controller durable directory snapshot entry changed");
      }
      if (snapshot.snapshotKind === "observer-content"
        && entry.name === ".aloha-observer-store-identity-v1"
        && `${snapshot.observerStoreIdentityHash}\n` !== Buffer.from(file.bytes).toString("utf8")) {
        throw new TypeError("pre-release controller observer-store identity marker mismatched");
      }
    }
    const directoryAfter = statSync(snapshot.snapshotDirectory, { bigint: true });
    if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
      || directoryBefore.mtimeNs !== directoryAfter.mtimeNs || directoryBefore.ctimeNs !== directoryAfter.ctimeNs) {
      throw new TypeError("pre-release controller durable directory snapshot changed during read");
    }
  }
  const evidenceFile = stableRootFile(LAYOUT.evidencePath);
  const evidenceBytes = evidenceFile.bytes;
  const evidenceStat = evidenceFile.stat as unknown as { readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint; readonly mode: bigint; readonly mtimeNs: bigint };
  if (receipt.publication.device !== String(evidenceStat.dev) || receipt.publication.inode !== String(evidenceStat.ino)
    || receipt.publication.uid !== String(evidenceStat.uid) || receipt.publication.gid !== String(evidenceStat.gid)
    || receipt.publication.mode !== String(evidenceStat.mode & 0o777n) || receipt.publication.mtimeUnixNs !== String(evidenceStat.mtimeNs)
    || receipt.publication.byteLength !== String(evidenceBytes.byteLength) || receipt.publication.contentSha256 !== sha256Hex(evidenceBytes)
    || !same(decodeCanonicalJson(evidenceBytes), evidencePayload(receipt))) throw new TypeError("pre-release controller root-owned evidence publication changed or mismatched");
  const lockFile = stableRootFile(LAYOUT.roundLockPath);
  const lockRecord = decodePreReleaseRestartControllerRoundLockV1(decodeCanonicalJson(lockFile.bytes));
  if (lockRecord.implementationIdentityHash !== receipt.controller.implementationIdentityHash
    || lockRecord.controllerPid !== receipt.controller.controllerPid
    || receipt.controller.roundLockContentSha256 !== sha256Hex(lockFile.bytes)) throw new TypeError("pre-release controller round lock does not bind the receipt implementation/invocation");
  return receipt;
}
