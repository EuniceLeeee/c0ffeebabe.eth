import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  sha256Hex,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 as LAYOUT,
  PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1,
  decodePreReleaseRestartControllerReceiptV1,
  decodePreReleaseRestartControllerRoundLockV1,
  type PreReleaseRestartControllerReceiptV1,
} from "./spec.ts";
import { readStableOwnedPhysicalFileV1 } from "./stable-owned-file.ts";

function assertRootDirectory(path: string): void {
  if (!path.startsWith("/") || realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new TypeError(`controller path is not a canonical directory: ${path}`);
  }
  const stat = statSync(path, { bigint: true });
  if (stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) {
    throw new TypeError(`controller directory is not root-owned and non-writable by group/world: ${path}`);
  }
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

/** Runtime-side read-only receipt verifier. This module deliberately contains
 * no controller action, process runner, builder, or compiler import. */
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
  const receipt = decodePreReleaseRestartControllerReceiptV1(decodeCanonicalJson(receiptFile.bytes));
  for (const snapshot of [receipt.post.durableSnapshots.processEvidence, receipt.post.durableSnapshots.checkpoint]) {
    const snapshotFile = stableRootFile(snapshot.snapshotPath);
    const snapshotStat = snapshotFile.stat as unknown as {
      readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint;
      readonly mode: bigint;
    };
    if (snapshot.device !== String(snapshotStat.dev) || snapshot.inode !== String(snapshotStat.ino)
      || snapshot.uid !== String(snapshotStat.uid) || snapshot.gid !== String(snapshotStat.gid)
      || snapshot.mode !== String(snapshotStat.mode & 0o777n)
      || snapshot.byteLength !== String(snapshotFile.bytes.byteLength)
      || snapshot.contentSha256 !== sha256Hex(snapshotFile.bytes)) {
      throw new TypeError("pre-release controller durable snapshot changed or mismatched");
    }
  }
  const sixStepEvidenceLog = receipt.post.durableSnapshots.sixStepEvidenceLog;
  const sixStepEvidenceFile = stableRootFile(
    sixStepEvidenceLog.snapshotPath,
    0o400,
    BigInt(PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes),
  );
  const sixStepEvidenceMetadata = sixStepEvidenceFile.stat as unknown as {
    readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint; readonly mode: bigint;
  };
  if (sixStepEvidenceLog.device !== String(sixStepEvidenceMetadata.dev)
    || sixStepEvidenceLog.inode !== String(sixStepEvidenceMetadata.ino)
    || sixStepEvidenceLog.uid !== String(sixStepEvidenceMetadata.uid)
    || sixStepEvidenceLog.gid !== String(sixStepEvidenceMetadata.gid)
    || sixStepEvidenceLog.mode !== String(sixStepEvidenceMetadata.mode & 0o777n)
    || sixStepEvidenceLog.byteLength !== String(sixStepEvidenceFile.bytes.byteLength)
    || sixStepEvidenceLog.contentSha256 !== sha256Hex(sixStepEvidenceFile.bytes)) {
    throw new TypeError("pre-release controller Six-Step source-ledger snapshot changed or mismatched");
  }
  for (const snapshot of [
    receipt.post.durableSnapshots.observerContent,
    receipt.post.durableSnapshots.terminalLocators,
    receipt.post.durableSnapshots.sixStepBoundaries,
  ]) {
    if (!existsSync(snapshot.snapshotDirectory) || realpathSync(snapshot.snapshotDirectory) !== snapshot.snapshotDirectory
      || !lstatSync(snapshot.snapshotDirectory).isDirectory()) {
      throw new TypeError("pre-release controller durable directory snapshot is missing");
    }
    const directoryBefore = statSync(snapshot.snapshotDirectory, { bigint: true });
    const names = readdirSync(snapshot.snapshotDirectory).sort();
    if (snapshot.directoryDevice !== String(directoryBefore.dev)
      || snapshot.directoryInode !== String(directoryBefore.ino)
      || snapshot.uid !== String(directoryBefore.uid) || snapshot.gid !== String(directoryBefore.gid)
      || snapshot.mode !== String(directoryBefore.mode & 0o777n)
      || names.length !== snapshot.entries.length
      || names.some((name, index) => name !== snapshot.entries[index]?.name)) {
      throw new TypeError("pre-release controller durable directory snapshot identity changed");
    }
    for (const entry of snapshot.entries) {
      const file = stableRootFile(`${snapshot.snapshotDirectory}/${entry.name}`, 0o400);
      const metadata = file.stat as unknown as {
        readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint; readonly mode: bigint;
      };
      if (entry.device !== String(metadata.dev) || entry.inode !== String(metadata.ino)
        || entry.uid !== String(metadata.uid) || entry.gid !== String(metadata.gid)
        || entry.mode !== String(metadata.mode & 0o777n)
        || entry.byteLength !== String(file.bytes.byteLength)
        || entry.contentSha256 !== sha256Hex(file.bytes)) {
        throw new TypeError("pre-release controller durable directory snapshot entry changed");
      }
      if (snapshot.snapshotKind === "observer-content"
        && entry.name === ".aloha-observer-store-identity-v1"
        && (`${snapshot.observerStoreIdentityHash}\n` !== Buffer.from(file.bytes).toString("utf8")
          || !/^0x[0-9a-f]{64}\n$/.test(Buffer.from(file.bytes).toString("utf8")))) {
        throw new TypeError("pre-release controller observer-store identity marker changed or mismatched");
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
  const evidenceStat = evidenceFile.stat as unknown as {
    readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint;
    readonly mode: bigint; readonly mtimeNs: bigint;
  };
  if (receipt.publication.device !== String(evidenceStat.dev)
    || receipt.publication.inode !== String(evidenceStat.ino)
    || receipt.publication.uid !== String(evidenceStat.uid)
    || receipt.publication.gid !== String(evidenceStat.gid)
    || receipt.publication.mode !== String(evidenceStat.mode & 0o777n)
    || receipt.publication.mtimeUnixNs !== String(evidenceStat.mtimeNs)
    || receipt.publication.byteLength !== String(evidenceBytes.byteLength)
    || receipt.publication.contentSha256 !== sha256Hex(evidenceBytes)
    || encodeCanonicalJson(decodeCanonicalJson(evidenceBytes)) !== encodeCanonicalJson(evidencePayload(receipt))) {
    throw new TypeError("pre-release controller root-owned evidence publication changed or mismatched");
  }
  const lockFile = stableRootFile(LAYOUT.roundLockPath);
  const lockRecord = decodePreReleaseRestartControllerRoundLockV1(decodeCanonicalJson(lockFile.bytes));
  if (lockRecord.implementationIdentityHash !== receipt.controller.implementationIdentityHash
    || lockRecord.controllerPid !== receipt.controller.controllerPid
    || receipt.controller.roundLockContentSha256 !== sha256Hex(lockFile.bytes)) {
    throw new TypeError("pre-release controller round lock does not bind the receipt implementation/invocation");
  }
  return receipt;
}
