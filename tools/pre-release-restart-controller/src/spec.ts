import {
  assertDecimalString,
  assertExactKeys,
  assertGitSha40,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { candidateFinalOutcomeHash } from "../../../specs/candidate-final-outcome/src/index.ts";
import { decodeProcessAnchor, hashProcessAnchor, type ProcessAnchorV1 } from "../../../specs/core-envelope/src/index.ts";
import { SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1 } from "../../../specs/evidence/src/six-step.ts";

export const PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 = Object.freeze({
  controllerServiceName: "aloha-searcher-pre-release-restart-controller",
  controllerSystemdUnit: "aloha-searcher-pre-release-restart-controller.service",
  controllerSystemdUnitPath: "/run/systemd/system/aloha-searcher-pre-release-restart-controller.service",
  controllerEntrypointPath: "/var/lib/aloha/pre-release/controller/pre-release-restart-controller.mjs",
  controllerDirectory: "/var/lib/aloha/pre-release/controller",
  roundLockPath: "/var/lib/aloha/pre-release/controller/restart-controller-round.lock",
  evidencePath: "/var/lib/aloha/pre-release/controller/restart-controller-evidence.json",
  receiptPath: "/var/lib/aloha/pre-release/controller/restart-controller-receipt.json",
  processEvidenceSnapshotPath: "/var/lib/aloha/pre-release/controller/a-process-evidence.sqlite",
  checkpointSnapshotPath: "/var/lib/aloha/pre-release/controller/a-checkpoint.sqlite",
  observerContentDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/content",
  terminalLocatorDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/terminal-locators",
  sixStepEvidenceDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/six-step-evidence",
  sixStepEvidenceLogPath: "/var/lib/aloha-acceptance/pre-release/observer-store/six-step-evidence/evidence.jsonl",
  sixStepBoundaryDirectory: "/var/lib/aloha-acceptance/pre-release/observer-store/six-step-evidence/boundaries",
  observerContentSnapshotDirectory: "/var/lib/aloha/pre-release/controller/a-observer-content",
  terminalLocatorSnapshotDirectory: "/var/lib/aloha/pre-release/controller/a-terminal-locators",
  sixStepEvidenceLogSnapshotPath: "/var/lib/aloha/pre-release/controller/a-six-step-evidence.jsonl",
  sixStepBoundarySnapshotDirectory: "/var/lib/aloha/pre-release/controller/a-six-step-boundaries",
  bProcessEvidenceSnapshotPath: "/var/lib/aloha/pre-release/controller/b-process-evidence.sqlite",
  bCheckpointSnapshotPath: "/var/lib/aloha/pre-release/controller/b-checkpoint.sqlite",
  bObserverContentSnapshotDirectory: "/var/lib/aloha/pre-release/controller/b-observer-content",
  bTerminalLocatorSnapshotDirectory: "/var/lib/aloha/pre-release/controller/b-terminal-locators",
  bSixStepEvidenceLogSnapshotPath: "/var/lib/aloha/pre-release/controller/b-six-step-evidence.jsonl",
  bSixStepBoundarySnapshotDirectory: "/var/lib/aloha/pre-release/controller/b-six-step-boundaries",
  bQualificationPath: "/var/lib/aloha/pre-release/controller/b-qualification.json",
  targetServiceName: "aloha-searcher-pre-release",
  targetSystemdUnit: "aloha-searcher-pre-release.service",
  targetSystemdUnitPath: "/run/systemd/system/aloha-searcher-pre-release.service",
  targetNodePath: "/usr/bin/node",
  targetEntrypointPath: "/var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs",
  processEvidenceDatabasePath: "/var/lib/aloha/pre-release/runtime/process-evidence.sqlite",
  checkpointDatabasePath: "/var/lib/aloha/pre-release/runtime/checkpoint.sqlite",
  systemctlPath: "/usr/bin/systemctl",
  procRoot: "/proc",
  cgroupRoot: "/sys/fs/cgroup",
  freezeTimeoutMs: 30_000,
  drainTimeoutMs: 300_000,
  pollIntervalMs: 100,
} as const);

export const PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1 = SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1;

export const PRE_RELEASE_RESTART_CONTROLLER_UNIT_V1 = `[Unit]
Description=Aloha pre-release strict restart controller
After=aloha-searcher-pre-release.service

[Service]
Type=oneshot
User=root
WorkingDirectory=/
ExecStart=/usr/bin/node /var/lib/aloha/pre-release/controller/pre-release-restart-controller.mjs
Restart=no
RuntimeMaxSec=10min
KillSignal=SIGTERM
TimeoutStopSec=30s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/var/lib/aloha/pre-release/artifacts /var/lib/aloha/pre-release/runtime /var/lib/aloha-acceptance/pre-release/observer-store /run/systemd/system/aloha-searcher-pre-release.service /proc
ReadWritePaths=/var/lib/aloha/pre-release/controller

[Install]
WantedBy=multi-user.target
`;

/** Exact target unit bytes are duplicated here intentionally so the external
 * controller bundle has no dependency on the candidate runtime packager.
 * Boundary CI must byte-compare this constant with the staged target unit. */
export const PRE_RELEASE_RESTART_TARGET_UNIT_V1 = `[Unit]
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

export interface PreReleaseControllerSystemdObservationV1 {
  readonly id: "aloha-searcher-pre-release.service";
  readonly fragmentPath: "/run/systemd/system/aloha-searcher-pre-release.service";
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly mainPid: string;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly result: string;
  readonly execMainCode: string;
  readonly execMainStatus: string;
  readonly restart: "no";
  readonly observedAtUnixNs: string;
}

export interface PreReleaseControllerProcessObservationV1 {
  readonly pid: string;
  readonly processStartTicks: string;
  readonly bootId: string;
  readonly bootIdHash: Hash;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly executablePath: "/usr/bin/node";
  readonly executableSha256: Hash;
  readonly executableDevice: string;
  readonly executableInode: string;
  readonly argv: readonly ["/usr/bin/node", "/var/lib/aloha/pre-release/artifacts/pre-release-owner.mjs"];
  readonly argvSha256: Hash;
  readonly uid: string;
  readonly processIdentityHash: Hash;
}

export interface PreReleaseRestartControllerOwnerProcessObservationV1 {
  readonly pid: string;
  readonly processStartTicks: string;
  readonly bootId: string;
  readonly bootIdHash: Hash;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly executablePath: "/usr/bin/node";
  readonly executableSha256: Hash;
  readonly executableDevice: string;
  readonly executableInode: string;
  readonly argv: readonly ["/usr/bin/node", "/var/lib/aloha/pre-release/controller/pre-release-restart-controller.mjs"];
  readonly argvSha256: Hash;
  readonly uid: "0";
  readonly processIdentityHash: Hash;
}

export interface PreReleaseControllerEventFactV1 {
  readonly sequence: string;
  readonly kind: "aloha.runtime-process-ready" | "aloha.runtime-sigterm-observed" | "aloha.runtime-sigterm-drained";
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly processAnchorHash: Hash;
  readonly predecessorEventId: Hash | null;
}

export interface PreReleaseControllerCheckpointFactV1 {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly checkpointRevision: string;
  readonly checkpointRootEnvelopeHash: Hash;
  readonly runEnvelopeStorageHash: Hash;
  readonly runId: string;
  readonly cutoff: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
  readonly candidatePartitionRoot: Hash;
  readonly outcomePartitionRoot: Hash;
  readonly candidateCount: string;
  readonly partialCount: string;
  readonly outcomeCount: string;
  readonly outcomeHashes: readonly Hash[];
  readonly candidateKeys: readonly Hash[];
  readonly outcomes: readonly Readonly<Record<string, unknown>>[];
  readonly rawContentRoot: Hash;
}

export interface PreReleaseControllerTerminalFactV1 {
  readonly terminalId: Hash;
  readonly contentSha256: Hash;
  readonly authorizationId: Hash;
  readonly authorizationClaimId: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly controllerBoundaryEvidenceRoot: Hash;
  readonly processReadyEventId: Hash;
  readonly sigtermObservedEventId: Hash;
  readonly sigtermDrainedEventId: Hash;
  readonly checkpointRootEnvelopeHash: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly outcomePartitionRoot: Hash;
  readonly flushedOutcomeHashes: readonly Hash[];
}

export interface PreReleaseControllerCommandFactV1 {
  readonly commandIdentityHash: Hash;
  readonly invokedAtUnixNs: string;
}

export interface PreReleaseControllerDatabaseSnapshotV1 {
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: "0";
  readonly gid: "0";
  readonly mode: "384";
  readonly fileFsynced: true;
  readonly directoryFsynced: true;
}

export interface PreReleaseControllerPhysicalFileSnapshotV1 {
  readonly sourcePath: string;
  readonly sourceDevice: string;
  readonly sourceInode: string;
  readonly snapshotPath: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: "0";
  readonly gid: "0";
  readonly mode: "256";
  readonly fileFsynced: true;
  readonly directoryFsynced: true;
}

export interface PreReleaseControllerDirectorySnapshotEntryV1 {
  readonly name: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: "0";
  readonly gid: "0";
  readonly mode: "256";
  readonly fileFsynced: true;
}

export interface PreReleaseControllerDirectorySnapshotV1 {
  readonly snapshotKind: "observer-content" | "terminal-locator-index" | "six-step-boundaries";
  readonly sourceDirectory: string;
  readonly snapshotDirectory: string;
  readonly observerStoreIdentityHash: Hash | null;
  readonly entries: readonly PreReleaseControllerDirectorySnapshotEntryV1[];
  readonly entrySetRoot: Hash;
  readonly directoryDevice: string;
  readonly directoryInode: string;
  readonly uid: "0";
  readonly gid: "0";
  readonly mode: "448";
  readonly directoryFsynced: true;
}

export interface PreReleaseControllerFrozenStateProofV1 {
  readonly systemdFreezerState: "frozen";
  readonly cgroupPath: string;
  readonly cgroupFreeze: "1";
  readonly tasks: readonly Readonly<{
    readonly pid: string;
    readonly processStartTicks: string;
    readonly controlGroup: string;
  }>[];
  readonly taskSetRoot: Hash;
  readonly observedAtUnixNs: string;
  readonly stableReobservedAtUnixNs: string;
}

export interface PreReleaseControllerRunningThawedStateProofV1 {
  readonly kind: "cgroup-thawed";
  readonly systemdFreezerState: "running";
  readonly cgroupPath: string;
  readonly cgroupFreeze: "0";
  readonly observedAtUnixNs: string;
}

export interface PreReleaseControllerExitedAfterThawProofV1 {
  readonly kind: "exact-process-exited-after-thaw";
  readonly processIdentityHash: Hash;
  readonly observedAtUnixNs: string;
}

export type PreReleaseControllerThawedStateProofV1 =
  | PreReleaseControllerRunningThawedStateProofV1
  | PreReleaseControllerExitedAfterThawProofV1;

export interface PreReleaseRestartControllerReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-restart-controller-receipt";
  readonly controller: Readonly<{
    readonly serviceName: "aloha-searcher-pre-release-restart-controller";
    readonly systemdUnit: "aloha-searcher-pre-release-restart-controller.service";
    readonly systemdUnitSha256: Hash;
    readonly entrypointPath: "/var/lib/aloha/pre-release/controller/pre-release-restart-controller.mjs";
    readonly entrypointSha256: Hash;
    readonly implementationIdentityHash: Hash;
    readonly controllerPid: string;
    readonly ownerProcess: PreReleaseRestartControllerOwnerProcessObservationV1;
    readonly roundLockContentSha256: Hash;
  }>;
  readonly target: Readonly<{
    readonly serviceName: "aloha-searcher-pre-release";
    readonly systemdUnit: "aloha-searcher-pre-release.service";
    readonly systemdUnitSha256: Hash;
    readonly candidateReleaseCommit: string;
    readonly runtimeBindingId: Hash;
    readonly releaseProvenanceHash: Hash;
    readonly stagingArtifactSetRoot: Hash;
    readonly stagingManifestRoot: Hash;
    readonly controllerBoundaryEvidenceRoot: Hash;
    readonly authorizationId: Hash;
    readonly authorizationClaimId: Hash;
  }>;
  readonly pre: Readonly<{
    readonly systemd: PreReleaseControllerSystemdObservationV1;
    readonly process: PreReleaseControllerProcessObservationV1;
    readonly ready: PreReleaseControllerEventFactV1;
    readonly runtimeAnchor: Readonly<Record<string, unknown>>;
    readonly processAnchor: ProcessAnchorV1;
    readonly checkpoint: PreReleaseControllerCheckpointFactV1;
  }>;
  readonly action: Readonly<{
    readonly freezeRequest: PreReleaseControllerCommandFactV1;
    readonly frozenState: PreReleaseControllerFrozenStateProofV1;
    readonly frozenDurableRecheck: Readonly<{
      readonly ready: PreReleaseControllerEventFactV1;
      readonly checkpoint: PreReleaseControllerCheckpointFactV1;
      readonly checkedAtUnixNs: string;
    }>;
    readonly queuedSigterm: PreReleaseControllerCommandFactV1 & Readonly<{
      readonly signal: "SIGTERM";
      readonly target: "main";
    }>;
    readonly thaw: PreReleaseControllerCommandFactV1 & Readonly<{
      readonly proof: PreReleaseControllerThawedStateProofV1;
    }>;
  }>;
  readonly post: Readonly<{
    readonly systemd: PreReleaseControllerSystemdObservationV1;
    readonly exactProcessExited: true;
    readonly ready: PreReleaseControllerEventFactV1;
    readonly observed: PreReleaseControllerEventFactV1;
    readonly drained: PreReleaseControllerEventFactV1;
    readonly terminal: PreReleaseControllerTerminalFactV1;
    readonly checkpoint: PreReleaseControllerCheckpointFactV1;
    readonly durableSnapshots: Readonly<{
      readonly processEvidence: PreReleaseControllerDatabaseSnapshotV1;
      readonly checkpoint: PreReleaseControllerDatabaseSnapshotV1;
      readonly observerContent: PreReleaseControllerDirectorySnapshotV1;
      readonly terminalLocators: PreReleaseControllerDirectorySnapshotV1;
      readonly sixStepEvidenceLog: PreReleaseControllerPhysicalFileSnapshotV1;
      readonly sixStepBoundaries: PreReleaseControllerDirectorySnapshotV1;
      readonly snapshotRoot: Hash;
    }>;
  }>;
  readonly publication: Readonly<{
    readonly evidencePath: "/var/lib/aloha/pre-release/controller/restart-controller-evidence.json";
    readonly evidenceId: Hash;
    readonly contentSha256: Hash;
    readonly byteLength: string;
    readonly device: string;
    readonly inode: string;
    readonly uid: "0";
    readonly gid: string;
    readonly mode: "384";
    readonly mtimeUnixNs: string;
    readonly atomicNoClobberLink: true;
    readonly fileFsynced: true;
    readonly directoryFsynced: true;
    readonly publishedAtUnixNs: string;
  }>;
  readonly receiptId: Hash;
}

const RECEIPT_DOMAIN = "aloha/pre-release-restart-controller-receipt/v1";
const ROUND_LOCK_DOMAIN = "aloha/pre-release-restart-controller-round-lock/v1";

export interface PreReleaseRestartControllerRoundLockV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.pre-release-restart-controller-round-lock";
  readonly implementationIdentityHash: Hash;
  readonly controllerPid: string;
  readonly acquiredAtUnixNs: string;
  readonly lockId: Hash;
}

export function sealPreReleaseRestartControllerRoundLockV1(input: Omit<PreReleaseRestartControllerRoundLockV1, "schemaVersion" | "kind" | "lockId">): PreReleaseRestartControllerRoundLockV1 {
  const payload = Object.freeze({ schemaVersion: 1 as const, kind: "aloha.pre-release-restart-controller-round-lock" as const, ...input });
  return decodePreReleaseRestartControllerRoundLockV1({ ...payload, lockId: hashDomain(ROUND_LOCK_DOMAIN, payload) });
}

export function decodePreReleaseRestartControllerRoundLockV1(value: unknown): PreReleaseRestartControllerRoundLockV1 {
  const lock = object(value, "preReleaseRestartControllerRoundLock") as unknown as PreReleaseRestartControllerRoundLockV1;
  assertExactKeys(lock, ["schemaVersion", "kind", "implementationIdentityHash", "controllerPid", "acquiredAtUnixNs", "lockId"], "preReleaseRestartControllerRoundLock");
  if (lock.schemaVersion !== 1 || lock.kind !== "aloha.pre-release-restart-controller-round-lock" || !/^[1-9][0-9]*$/.test(lock.controllerPid)) throw new TypeError("pre-release restart controller round lock header is invalid");
  assertHash(lock.implementationIdentityHash, "preReleaseRestartControllerRoundLock.implementationIdentityHash");
  decimal(lock.acquiredAtUnixNs, "preReleaseRestartControllerRoundLock.acquiredAtUnixNs");
  const { lockId: _lockId, ...payload } = lock;
  if (assertHash(lock.lockId, "preReleaseRestartControllerRoundLock.lockId") !== hashDomain(ROUND_LOCK_DOMAIN, payload)) throw new TypeError("pre-release restart controller round lock id mismatch");
  return decodeCanonicalJson(encodeCanonicalBytes(lock)) as unknown as PreReleaseRestartControllerRoundLockV1;
}

function object(value: unknown, path: string): Readonly<Record<string, unknown>> {
  assertPlainObject(value, path);
  return value as Readonly<Record<string, unknown>>;
}

function decimal(value: unknown, path: string): string {
  return assertDecimalString(value, path);
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function exactSystemd(value: unknown, path: string): PreReleaseControllerSystemdObservationV1 {
  const record = object(value, path) as unknown as PreReleaseControllerSystemdObservationV1;
  assertExactKeys(record, ["id", "fragmentPath", "loadState", "activeState", "subState", "mainPid", "invocationId", "controlGroup", "result", "execMainCode", "execMainStatus", "restart", "observedAtUnixNs"], path);
  if (record.id !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetSystemdUnit
    || record.fragmentPath !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetSystemdUnitPath
    || record.loadState !== "loaded" || record.restart !== "no") throw new TypeError(`${path} fixed systemd identity mismatch`);
  decimal(record.mainPid, `${path}.mainPid`);
  decimal(record.observedAtUnixNs, `${path}.observedAtUnixNs`);
  if (record.invocationId !== "" && !/^[0-9a-f]{32}$/.test(record.invocationId)) throw new TypeError(`${path}.invocationId is invalid`);
  if (record.controlGroup !== "" && !record.controlGroup.startsWith("/")) throw new TypeError(`${path}.controlGroup is invalid`);
  decimal(record.execMainCode, `${path}.execMainCode`);
  decimal(record.execMainStatus, `${path}.execMainStatus`);
  return record;
}

function exactEvent(value: unknown, path: string, kind: PreReleaseControllerEventFactV1["kind"], sequence: string): PreReleaseControllerEventFactV1 {
  const record = object(value, path) as unknown as PreReleaseControllerEventFactV1;
  assertExactKeys(record, ["sequence", "kind", "eventId", "contentSha256", "processAnchorHash", "predecessorEventId"], path);
  if (record.kind !== kind || record.sequence !== sequence) throw new TypeError(`${path} kind or sequence mismatch`);
  assertHash(record.eventId, `${path}.eventId`);
  assertHash(record.contentSha256, `${path}.contentSha256`);
  assertHash(record.processAnchorHash, `${path}.processAnchorHash`);
  if (kind === "aloha.runtime-process-ready") {
    if (record.predecessorEventId !== null) throw new TypeError(`${path} ready predecessor must be null`);
  } else assertHash(record.predecessorEventId, `${path}.predecessorEventId`);
  return record;
}

function sortedHashes(value: unknown, path: string, nonEmpty = false): readonly Hash[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) throw new TypeError(`${path} must be a non-empty hash array`);
  const hashes = value.map((item, index) => assertHash(item, `${path}[${index}]`));
  for (let index = 1; index < hashes.length; index += 1) if (hashes[index - 1]! >= hashes[index]!) throw new TypeError(`${path} must be strictly sorted and unique`);
  return Object.freeze(hashes);
}

function exactCheckpoint(value: unknown, path: string): PreReleaseControllerCheckpointFactV1 {
  const record = object(value, path) as unknown as PreReleaseControllerCheckpointFactV1;
  assertExactKeys(record, ["path", "device", "inode", "checkpointRevision", "checkpointRootEnvelopeHash", "runEnvelopeStorageHash", "runId", "cutoff", "candidatePartitionRoot", "outcomePartitionRoot", "candidateCount", "partialCount", "outcomeCount", "outcomeHashes", "candidateKeys", "outcomes", "rawContentRoot"], path);
  if (record.path !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.checkpointDatabasePath) throw new TypeError(`${path}.path is not fixed`);
  for (const field of ["device", "inode", "checkpointRevision", "candidateCount", "partialCount", "outcomeCount"] as const) decimal(record[field], `${path}.${field}`);
  if (record.partialCount !== "0" || BigInt(record.candidateCount) === 0n || BigInt(record.outcomeCount) === 0n) throw new TypeError(`${path} is not a non-empty final partition`);
  for (const field of ["checkpointRootEnvelopeHash", "runEnvelopeStorageHash", "candidatePartitionRoot", "outcomePartitionRoot", "rawContentRoot"] as const) assertHash(record[field], `${path}.${field}`);
  assertNonEmptyString(record.runId, `${path}.runId`);
  const cutoff = object(record.cutoff, `${path}.cutoff`);
  assertExactKeys(cutoff, ["chainId", "number", "hash", "stateRoot"], `${path}.cutoff`);
  assertNonEmptyString(cutoff.chainId, `${path}.cutoff.chainId`);
  decimal(cutoff.number, `${path}.cutoff.number`);
  assertHash(cutoff.hash, `${path}.cutoff.hash`);
  assertHash(cutoff.stateRoot, `${path}.cutoff.stateRoot`);
  const outcomeHashes = sortedHashes(record.outcomeHashes, `${path}.outcomeHashes`, true);
  const candidateKeys = sortedHashes(record.candidateKeys, `${path}.candidateKeys`, true);
  if (!Array.isArray(record.outcomes) || record.outcomes.length !== Number(record.outcomeCount) || candidateKeys.length !== Number(record.candidateCount)) throw new TypeError(`${path} denominator counts mismatch`);
  const candidateSet = new Set(candidateKeys);
  const recomputedHashes = record.outcomes.map((outcome, index) => {
    const decoded = object(outcome, `${path}.outcomes[${index}]`);
    if (!candidateSet.has(assertHash(decoded.familyCandidateKey, `${path}.outcomes[${index}].familyCandidateKey`))) throw new TypeError(`${path} outcome is outside candidate partition`);
    return candidateFinalOutcomeHash(decoded as never);
  }).sort();
  if (!same(recomputedHashes, outcomeHashes)) throw new TypeError(`${path} outcome hashes are not recomputed from exact outcomes`);
  const recomputedOutcomeRoot = hashDomain("aloha/checkpoint-outcome-partition/v1", {
    runId: record.runId,
    outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", record.outcomes),
  });
  if (recomputedOutcomeRoot !== record.outcomePartitionRoot) throw new TypeError(`${path} outcome partition root mismatch`);
  return record;
}

function exactTerminal(value: unknown, path: string): PreReleaseControllerTerminalFactV1 {
  const record = object(value, path) as unknown as PreReleaseControllerTerminalFactV1;
  assertExactKeys(record, ["terminalId", "contentSha256", "authorizationId", "authorizationClaimId", "stagingArtifactSetRoot", "stagingManifestRoot", "controllerBoundaryEvidenceRoot", "processReadyEventId", "sigtermObservedEventId", "sigtermDrainedEventId", "checkpointRootEnvelopeHash", "candidatePartitionRoot", "outcomePartitionRoot", "flushedOutcomeHashes"], path);
  for (const field of ["terminalId", "contentSha256", "authorizationId", "authorizationClaimId", "stagingArtifactSetRoot", "stagingManifestRoot", "controllerBoundaryEvidenceRoot", "processReadyEventId", "sigtermObservedEventId", "sigtermDrainedEventId", "checkpointRootEnvelopeHash", "candidatePartitionRoot", "outcomePartitionRoot"] as const) assertHash(record[field], `${path}.${field}`);
  sortedHashes(record.flushedOutcomeHashes, `${path}.flushedOutcomeHashes`, true);
  return record;
}

function exactCommand(value: unknown, path: string): PreReleaseControllerCommandFactV1 {
  const record = object(value, path) as unknown as PreReleaseControllerCommandFactV1;
  assertExactKeys(record, ["commandIdentityHash", "invokedAtUnixNs"], path);
  assertHash(record.commandIdentityHash, `${path}.commandIdentityHash`);
  decimal(record.invokedAtUnixNs, `${path}.invokedAtUnixNs`);
  return record;
}

function exactDatabaseSnapshot(
  value: unknown,
  path: string,
  sourcePath: string,
  snapshotPath: string,
): PreReleaseControllerDatabaseSnapshotV1 {
  const record = object(value, path) as unknown as PreReleaseControllerDatabaseSnapshotV1;
  assertExactKeys(record, ["sourcePath", "snapshotPath", "contentSha256", "byteLength", "device", "inode", "uid", "gid", "mode", "fileFsynced", "directoryFsynced"], path);
  if (record.sourcePath !== sourcePath || record.snapshotPath !== snapshotPath
    || record.uid !== "0" || record.gid !== "0" || record.mode !== "384"
    || record.fileFsynced !== true || record.directoryFsynced !== true) {
    throw new TypeError(`${path} is not the fixed root-owned fsynced snapshot`);
  }
  assertHash(record.contentSha256, `${path}.contentSha256`);
  for (const field of ["byteLength", "device", "inode"] as const) decimal(record[field], `${path}.${field}`);
  return record;
}

function exactPhysicalFileSnapshot(
  value: unknown,
  path: string,
  sourcePath: string,
  snapshotPath: string,
): PreReleaseControllerPhysicalFileSnapshotV1 {
  const record = object(value, path) as unknown as PreReleaseControllerPhysicalFileSnapshotV1;
  assertExactKeys(record, [
    "sourcePath", "sourceDevice", "sourceInode", "snapshotPath", "contentSha256", "byteLength",
    "device", "inode", "uid", "gid", "mode", "fileFsynced", "directoryFsynced",
  ], path);
  if (record.sourcePath !== sourcePath || record.snapshotPath !== snapshotPath
    || record.uid !== "0" || record.gid !== "0" || record.mode !== "256"
    || record.fileFsynced !== true || record.directoryFsynced !== true) {
    throw new TypeError(`${path} is not the fixed root-owned fsynced physical-file snapshot`);
  }
  assertHash(record.contentSha256, `${path}.contentSha256`);
  for (const field of ["sourceDevice", "sourceInode", "byteLength", "device", "inode"] as const) {
    decimal(record[field], `${path}.${field}`);
  }
  if (BigInt(record.byteLength) > BigInt(PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes)) {
    throw new TypeError(`${path} exceeds the Six-Step source-ledger byte policy`);
  }
  return record;
}

function exactDirectorySnapshot(
  value: unknown,
  path: string,
  snapshotKind: "observer-content" | "terminal-locator-index" | "six-step-boundaries",
  sourceDirectory: string,
  snapshotDirectory: string,
): PreReleaseControllerDirectorySnapshotV1 {
  const record = object(value, path) as unknown as PreReleaseControllerDirectorySnapshotV1;
  assertExactKeys(record, [
    "snapshotKind", "sourceDirectory", "snapshotDirectory", "observerStoreIdentityHash", "entries", "entrySetRoot",
    "directoryDevice", "directoryInode", "uid", "gid", "mode", "directoryFsynced",
  ], path);
  if (record.snapshotKind !== snapshotKind || record.sourceDirectory !== sourceDirectory
    || record.snapshotDirectory !== snapshotDirectory || record.uid !== "0" || record.gid !== "0"
    || record.mode !== "448" || record.directoryFsynced !== true || !Array.isArray(record.entries)
    || (record.entries.length === 0 && snapshotKind !== "six-step-boundaries")
    || (snapshotKind === "terminal-locator-index" && record.entries.length !== 1)) {
    throw new TypeError(`${path} is not the fixed root-owned directory snapshot`);
  }
  if (snapshotKind === "six-step-boundaries"
    && record.entries.length > PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntries) {
    throw new TypeError(`${path} Six-Step boundary entry count exceeds policy`);
  }
  if (snapshotKind === "observer-content") {
    assertHash(record.observerStoreIdentityHash, `${path}.observerStoreIdentityHash`);
  } else if (record.observerStoreIdentityHash !== null) {
    throw new TypeError(`${path}.observerStoreIdentityHash must be null for a locator index`);
  }
  for (const field of ["directoryDevice", "directoryInode"] as const) decimal(record[field], `${path}.${field}`);
  let previousName: string | null = null;
  let totalBytes = 0n;
  const entries = record.entries.map((entryValue, index) => {
    const entryPath = `${path}.entries[${index}]`;
    const entry = object(entryValue, entryPath) as unknown as PreReleaseControllerDirectorySnapshotEntryV1;
    assertExactKeys(entry, ["name", "contentSha256", "byteLength", "device", "inode", "uid", "gid", "mode", "fileFsynced"], entryPath);
    const name = assertNonEmptyString(entry.name, `${entryPath}.name`);
    const validName = snapshotKind === "observer-content"
      ? name === ".aloha-observer-store-identity-v1" || /^[0-9a-f]{64}$/.test(name)
      : snapshotKind === "terminal-locator-index"
        ? /^[0-9a-f]{64}\.json$/.test(name)
        : /^[0-9a-f]{64}\.v8$/.test(name);
    if (!validName || (previousName !== null && previousName >= name)
      || entry.uid !== "0" || entry.gid !== "0" || entry.mode !== "256" || entry.fileFsynced !== true) {
      throw new TypeError(`${entryPath} is not a sorted immutable root-owned snapshot entry`);
    }
    previousName = name;
    const contentSha256 = assertHash(entry.contentSha256, `${entryPath}.contentSha256`);
    if (snapshotKind === "observer-content" && /^[0-9a-f]{64}$/.test(name)
      && name !== contentSha256.slice(2)) {
      throw new TypeError(`${entryPath} content-object name/hash mismatch`);
    }
    for (const field of ["byteLength", "device", "inode"] as const) decimal(entry[field], `${entryPath}.${field}`);
    const byteLength = BigInt(entry.byteLength);
    if (snapshotKind === "six-step-boundaries") {
      if (byteLength > BigInt(PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntryBytes)) {
        throw new TypeError(`${entryPath} Six-Step boundary file exceeds policy`);
      }
      totalBytes += byteLength;
      if (totalBytes > BigInt(PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxTotalBytes)) {
        throw new TypeError(`${path} Six-Step boundary aggregate exceeds policy`);
      }
    }
    return entry;
  });
  if (snapshotKind === "observer-content" && !entries.some(entry => entry.name === ".aloha-observer-store-identity-v1")) {
    throw new TypeError(`${path} lacks the observer-store identity marker`);
  }
  const entrySetRoot = hashDomain("aloha/pre-release-directory-snapshot-entry-set/v1", {
    snapshotKind,
    observerStoreIdentityHash: record.observerStoreIdentityHash,
    entries: entries.map(entry => ({ name: entry.name, contentSha256: entry.contentSha256, byteLength: entry.byteLength })),
  });
  if (assertHash(record.entrySetRoot, `${path}.entrySetRoot`) !== entrySetRoot) {
    throw new TypeError(`${path} entry-set root mismatch`);
  }
  return record;
}

export function sealPreReleaseRestartControllerReceiptV1(
  input: Omit<PreReleaseRestartControllerReceiptV1, "receiptId">,
): PreReleaseRestartControllerReceiptV1 {
  return decodePreReleaseRestartControllerReceiptV1({
    ...input,
    receiptId: hashDomain(RECEIPT_DOMAIN, input as never),
  });
}

export function decodePreReleaseRestartControllerReceiptV1(value: unknown): PreReleaseRestartControllerReceiptV1 {
  const receipt = object(value, "preReleaseRestartControllerReceipt") as unknown as PreReleaseRestartControllerReceiptV1;
  assertExactKeys(receipt, ["schemaVersion", "kind", "controller", "target", "pre", "action", "post", "publication", "receiptId"], "preReleaseRestartControllerReceipt");
  if (receipt.schemaVersion !== 1 || receipt.kind !== "aloha.pre-release-restart-controller-receipt") throw new TypeError("pre-release restart controller receipt header is invalid");
  const controller = object(receipt.controller, "preReleaseRestartControllerReceipt.controller");
  assertExactKeys(controller, ["serviceName", "systemdUnit", "systemdUnitSha256", "entrypointPath", "entrypointSha256", "implementationIdentityHash", "controllerPid", "ownerProcess", "roundLockContentSha256"], "preReleaseRestartControllerReceipt.controller");
  if (controller.serviceName !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.controllerServiceName
    || controller.systemdUnit !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.controllerSystemdUnit
    || controller.entrypointPath !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.controllerEntrypointPath) throw new TypeError("pre-release restart controller identity is not fixed");
  for (const field of ["systemdUnitSha256", "entrypointSha256", "implementationIdentityHash"] as const) assertHash(controller[field], `preReleaseRestartControllerReceipt.controller.${field}`);
  decimal(controller.controllerPid, "preReleaseRestartControllerReceipt.controller.controllerPid");
  assertHash(controller.roundLockContentSha256, "preReleaseRestartControllerReceipt.controller.roundLockContentSha256");
  const ownerProcess = object(controller.ownerProcess, "preReleaseRestartControllerReceipt.controller.ownerProcess");
  assertExactKeys(ownerProcess, ["pid", "processStartTicks", "bootId", "bootIdHash", "invocationId", "controlGroup", "executablePath", "executableSha256", "executableDevice", "executableInode", "argv", "argvSha256", "uid", "processIdentityHash"], "preReleaseRestartControllerReceipt.controller.ownerProcess");
  for (const field of ["pid", "processStartTicks", "executableDevice", "executableInode"] as const) decimal(ownerProcess[field], `preReleaseRestartControllerReceipt.controller.ownerProcess.${field}`);
  for (const field of ["bootIdHash", "executableSha256", "argvSha256", "processIdentityHash"] as const) assertHash(ownerProcess[field], `preReleaseRestartControllerReceipt.controller.ownerProcess.${field}`);
  assertNonEmptyString(ownerProcess.bootId, "preReleaseRestartControllerReceipt.controller.ownerProcess.bootId");
  assertNonEmptyString(ownerProcess.invocationId, "preReleaseRestartControllerReceipt.controller.ownerProcess.invocationId");
  assertNonEmptyString(ownerProcess.controlGroup, "preReleaseRestartControllerReceipt.controller.ownerProcess.controlGroup");
  if (ownerProcess.pid !== controller.controllerPid || ownerProcess.uid !== "0"
    || ownerProcess.executablePath !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetNodePath
    || !Array.isArray(ownerProcess.argv) || ownerProcess.argv.length !== 2
    || ownerProcess.argv[0] !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetNodePath
    || ownerProcess.argv[1] !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.controllerEntrypointPath) throw new TypeError("pre-release controller receipt is not bound to the fixed systemd owner process");
  const ownerBootIdHash = hashDomain("aloha/runtime-boot-id/v1", ownerProcess.bootId);
  const ownerArgvSha256 = sha256Hex(Buffer.from([...ownerProcess.argv, ""].join("\0")));
  const { processIdentityHash: _ownerProcessIdentityHash, ...ownerIdentity } = ownerProcess;
  if (ownerProcess.bootIdHash !== ownerBootIdHash || ownerProcess.argvSha256 !== ownerArgvSha256
    || ownerProcess.processIdentityHash !== hashDomain("aloha/pre-release-restart-controller-owner-process-identity/v1", ownerIdentity as never)) throw new TypeError("pre-release controller owner process identity hash mismatch");
  const target = object(receipt.target, "preReleaseRestartControllerReceipt.target");
  assertExactKeys(target, ["serviceName", "systemdUnit", "systemdUnitSha256", "candidateReleaseCommit", "runtimeBindingId", "releaseProvenanceHash", "stagingArtifactSetRoot", "stagingManifestRoot", "controllerBoundaryEvidenceRoot", "authorizationId", "authorizationClaimId"], "preReleaseRestartControllerReceipt.target");
  if (target.serviceName !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetServiceName || target.systemdUnit !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetSystemdUnit) throw new TypeError("pre-release restart target is not fixed");
  assertHash(target.systemdUnitSha256, "preReleaseRestartControllerReceipt.target.systemdUnitSha256");
  assertGitSha40(target.candidateReleaseCommit, "preReleaseRestartControllerReceipt.target.candidateReleaseCommit");
  assertHash(target.runtimeBindingId, "preReleaseRestartControllerReceipt.target.runtimeBindingId");
  assertHash(target.releaseProvenanceHash, "preReleaseRestartControllerReceipt.target.releaseProvenanceHash");
  for (const field of ["stagingArtifactSetRoot", "stagingManifestRoot", "controllerBoundaryEvidenceRoot", "authorizationId", "authorizationClaimId"] as const) assertHash(target[field], `preReleaseRestartControllerReceipt.target.${field}`);
  const pre = object(receipt.pre, "preReleaseRestartControllerReceipt.pre");
  const post = object(receipt.post, "preReleaseRestartControllerReceipt.post");
  assertExactKeys(pre, ["systemd", "process", "ready", "runtimeAnchor", "processAnchor", "checkpoint"], "preReleaseRestartControllerReceipt.pre");
  assertExactKeys(post, ["systemd", "exactProcessExited", "ready", "observed", "drained", "terminal", "checkpoint", "durableSnapshots"], "preReleaseRestartControllerReceipt.post");
  if (post.exactProcessExited !== true) throw new TypeError("pre-release restart receipt must prove exact process exit");
  const action = object(receipt.action, "preReleaseRestartControllerReceipt.action");
  assertExactKeys(action, ["freezeRequest", "frozenState", "frozenDurableRecheck", "queuedSigterm", "thaw"], "preReleaseRestartControllerReceipt.action");
  const freezeRequest = exactCommand(action.freezeRequest, "preReleaseRestartControllerReceipt.action.freezeRequest");
  const frozenState = object(action.frozenState, "preReleaseRestartControllerReceipt.action.frozenState");
  assertExactKeys(frozenState, ["systemdFreezerState", "cgroupPath", "cgroupFreeze", "tasks", "taskSetRoot", "observedAtUnixNs", "stableReobservedAtUnixNs"], "preReleaseRestartControllerReceipt.action.frozenState");
  if (frozenState.systemdFreezerState !== "frozen" || frozenState.cgroupFreeze !== "1") throw new TypeError("pre-release restart action does not prove the cgroup was frozen");
  assertNonEmptyString(frozenState.cgroupPath, "preReleaseRestartControllerReceipt.action.frozenState.cgroupPath");
  decimal(frozenState.observedAtUnixNs, "preReleaseRestartControllerReceipt.action.frozenState.observedAtUnixNs");
  decimal(frozenState.stableReobservedAtUnixNs, "preReleaseRestartControllerReceipt.action.frozenState.stableReobservedAtUnixNs");
  const frozenTaskValues = frozenState.tasks;
  if (!Array.isArray(frozenTaskValues) || frozenTaskValues.length === 0) throw new TypeError("pre-release frozen cgroup task set is empty");
  let previousFrozenTaskPid: bigint | null = null;
  const frozenTasks = frozenTaskValues.map((item, index) => {
    const task = object(item, `preReleaseRestartControllerReceipt.action.frozenState.tasks[${index}]`);
    assertExactKeys(task, ["pid", "processStartTicks", "controlGroup"], `preReleaseRestartControllerReceipt.action.frozenState.tasks[${index}]`);
    decimal(task.pid, `preReleaseRestartControllerReceipt.action.frozenState.tasks[${index}].pid`);
    decimal(task.processStartTicks, `preReleaseRestartControllerReceipt.action.frozenState.tasks[${index}].processStartTicks`);
    assertNonEmptyString(task.controlGroup, `preReleaseRestartControllerReceipt.action.frozenState.tasks[${index}].controlGroup`);
    const taskPid = BigInt(String(task.pid));
    if (previousFrozenTaskPid !== null && previousFrozenTaskPid >= taskPid) throw new TypeError("pre-release frozen cgroup tasks are not strictly sorted and unique");
    previousFrozenTaskPid = taskPid;
    return task;
  });
  if (assertHash(frozenState.taskSetRoot, "preReleaseRestartControllerReceipt.action.frozenState.taskSetRoot")
    !== hashDomain("aloha/pre-release-controller-frozen-cgroup-task-set/v1", frozenTasks as never)) throw new TypeError("pre-release frozen cgroup task-set root mismatch");
  const frozenDurableRecheck = object(action.frozenDurableRecheck, "preReleaseRestartControllerReceipt.action.frozenDurableRecheck");
  assertExactKeys(frozenDurableRecheck, ["ready", "checkpoint", "checkedAtUnixNs"], "preReleaseRestartControllerReceipt.action.frozenDurableRecheck");
  decimal(frozenDurableRecheck.checkedAtUnixNs, "preReleaseRestartControllerReceipt.action.frozenDurableRecheck.checkedAtUnixNs");
  const queuedSigterm = object(action.queuedSigterm, "preReleaseRestartControllerReceipt.action.queuedSigterm");
  assertExactKeys(queuedSigterm, ["commandIdentityHash", "invokedAtUnixNs", "signal", "target"], "preReleaseRestartControllerReceipt.action.queuedSigterm");
  assertHash(queuedSigterm.commandIdentityHash, "preReleaseRestartControllerReceipt.action.queuedSigterm.commandIdentityHash");
  decimal(queuedSigterm.invokedAtUnixNs, "preReleaseRestartControllerReceipt.action.queuedSigterm.invokedAtUnixNs");
  if (queuedSigterm.signal !== "SIGTERM" || queuedSigterm.target !== "main") throw new TypeError("pre-release restart action does not queue the fixed main-process SIGTERM");
  const thaw = object(action.thaw, "preReleaseRestartControllerReceipt.action.thaw");
  assertExactKeys(thaw, ["commandIdentityHash", "invokedAtUnixNs", "proof"], "preReleaseRestartControllerReceipt.action.thaw");
  assertHash(thaw.commandIdentityHash, "preReleaseRestartControllerReceipt.action.thaw.commandIdentityHash");
  decimal(thaw.invokedAtUnixNs, "preReleaseRestartControllerReceipt.action.thaw.invokedAtUnixNs");
  const thawProof = object(thaw.proof, "preReleaseRestartControllerReceipt.action.thaw.proof");
  if (thawProof.kind === "cgroup-thawed") {
    assertExactKeys(thawProof, ["kind", "systemdFreezerState", "cgroupPath", "cgroupFreeze", "observedAtUnixNs"], "preReleaseRestartControllerReceipt.action.thaw.proof");
    if (thawProof.systemdFreezerState !== "running" || thawProof.cgroupFreeze !== "0") throw new TypeError("pre-release restart action does not prove the cgroup was thawed");
    assertNonEmptyString(thawProof.cgroupPath, "preReleaseRestartControllerReceipt.action.thaw.proof.cgroupPath");
  } else if (thawProof.kind === "exact-process-exited-after-thaw") {
    assertExactKeys(thawProof, ["kind", "processIdentityHash", "observedAtUnixNs"], "preReleaseRestartControllerReceipt.action.thaw.proof");
    assertHash(thawProof.processIdentityHash, "preReleaseRestartControllerReceipt.action.thaw.proof.processIdentityHash");
  } else {
    throw new TypeError("pre-release restart action has no valid thaw terminal proof");
  }
  decimal(thawProof.observedAtUnixNs, "preReleaseRestartControllerReceipt.action.thaw.proof.observedAtUnixNs");
  const process = object(pre.process, "preReleaseRestartControllerReceipt.pre.process");
  assertExactKeys(process, ["pid", "processStartTicks", "bootId", "bootIdHash", "invocationId", "controlGroup", "executablePath", "executableSha256", "executableDevice", "executableInode", "argv", "argvSha256", "uid", "processIdentityHash"], "preReleaseRestartControllerReceipt.pre.process");
  decimal(process.pid, "preReleaseRestartControllerReceipt.pre.process.pid");
  decimal(process.processStartTicks, "preReleaseRestartControllerReceipt.pre.process.processStartTicks");
  decimal(process.uid, "preReleaseRestartControllerReceipt.pre.process.uid");
  assertNonEmptyString(process.bootId, "preReleaseRestartControllerReceipt.pre.process.bootId");
  assertNonEmptyString(process.invocationId, "preReleaseRestartControllerReceipt.pre.process.invocationId");
  assertNonEmptyString(process.controlGroup, "preReleaseRestartControllerReceipt.pre.process.controlGroup");
  for (const field of ["bootIdHash", "executableSha256", "argvSha256", "processIdentityHash"] as const) assertHash(process[field], `preReleaseRestartControllerReceipt.pre.process.${field}`);
  if (process.executablePath !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetNodePath
    || !Array.isArray(process.argv) || process.argv.length !== 2
    || process.argv[0] !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetNodePath
    || process.argv[1] !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetEntrypointPath) throw new TypeError("pre-release restart receipt process command is not fixed");
  const recomputedBootIdHash = hashDomain("aloha/runtime-boot-id/v1", process.bootId);
  const recomputedArgvSha256 = sha256Hex(Buffer.from([...process.argv, ""].join("\0")));
  const { processIdentityHash: _processIdentityHash, ...processIdentity } = process;
  if (process.bootIdHash !== recomputedBootIdHash || process.argvSha256 !== recomputedArgvSha256
    || process.processIdentityHash !== hashDomain("aloha/pre-release-controller-process-identity/v1", processIdentity as never)) throw new TypeError("pre-release restart receipt process identity hash mismatch");
  const preSystemd = exactSystemd(pre.systemd, "preReleaseRestartControllerReceipt.pre.systemd");
  const postSystemd = exactSystemd(post.systemd, "preReleaseRestartControllerReceipt.post.systemd");
  if (preSystemd.activeState !== "active" || preSystemd.subState !== "running" || preSystemd.mainPid !== process.pid
    || preSystemd.invocationId !== process.invocationId || preSystemd.controlGroup !== process.controlGroup) throw new TypeError("pre-release ready process is not the exact systemd main invocation");
  if (postSystemd.mainPid !== "0" || postSystemd.activeState === "active" || postSystemd.subState === "running"
    || postSystemd.invocationId !== preSystemd.invocationId || (postSystemd.controlGroup !== "" && postSystemd.controlGroup !== preSystemd.controlGroup)
    || postSystemd.result !== "success" || postSystemd.execMainCode !== "1" || postSystemd.execMainStatus !== "0") throw new TypeError("pre-release post state does not prove the same invocation exited without restart");
  const runtimeAnchor = object(pre.runtimeAnchor, "preReleaseRestartControllerReceipt.pre.runtimeAnchor");
  assertExactKeys(runtimeAnchor, ["kind", "bindingId", "releaseProvenanceHash", "manifestHash", "manifestArtifactSha256", "runtimeArtifactRoot", "implementationClosureDigest", "candidateReleaseCommit", "entrypointSha256", "nodeExecutableSha256", "bundleModulePath", "bundleModuleSha256", "serviceName", "systemdUnit", "bootId", "invocationId", "logDevice", "logInode", "pid", "processStartTicks", "dryRun"], "preReleaseRestartControllerReceipt.pre.runtimeAnchor");
  if (runtimeAnchor.kind !== "aloha.searcher-runtime-anchor-v1" || runtimeAnchor.dryRun !== true
    || runtimeAnchor.bindingId !== target.runtimeBindingId || runtimeAnchor.releaseProvenanceHash !== target.releaseProvenanceHash
    || runtimeAnchor.candidateReleaseCommit !== target.candidateReleaseCommit || runtimeAnchor.nodeExecutableSha256 !== process.executableSha256
    || runtimeAnchor.serviceName !== target.serviceName || runtimeAnchor.systemdUnit !== target.systemdUnit
    || runtimeAnchor.bootId !== process.bootId || runtimeAnchor.invocationId !== process.invocationId
    || runtimeAnchor.pid !== process.pid || runtimeAnchor.processStartTicks !== process.processStartTicks) throw new TypeError("runtime ready anchor is not joined to the independently observed process");
  const processAnchor = decodeProcessAnchor(pre.processAnchor as object);
  if (processAnchor.commitSha !== target.candidateReleaseCommit || processAnchor.executableHash !== process.executableSha256
    || processAnchor.pid !== process.pid || processAnchor.processStartTicks !== process.processStartTicks
    || processAnchor.bootIdHash !== process.bootIdHash) throw new TypeError("runtime process anchor is not joined to the independently observed process");
  const preReady = exactEvent(pre.ready, "preReleaseRestartControllerReceipt.pre.ready", "aloha.runtime-process-ready", "0");
  const postReady = exactEvent(post.ready, "preReleaseRestartControllerReceipt.post.ready", "aloha.runtime-process-ready", "0");
  const postObserved = exactEvent(post.observed, "preReleaseRestartControllerReceipt.post.observed", "aloha.runtime-sigterm-observed", "1");
  const postDrained = exactEvent(post.drained, "preReleaseRestartControllerReceipt.post.drained", "aloha.runtime-sigterm-drained", "2");
  const processAnchorHash = hashProcessAnchor(processAnchor as ProcessAnchorV1);
  const frozenReady = exactEvent(frozenDurableRecheck.ready, "preReleaseRestartControllerReceipt.action.frozenDurableRecheck.ready", "aloha.runtime-process-ready", "0");
  const frozenCheckpoint = exactCheckpoint(frozenDurableRecheck.checkpoint, "preReleaseRestartControllerReceipt.action.frozenDurableRecheck.checkpoint");
  if (!same(frozenReady, preReady) || !same(frozenCheckpoint, pre.checkpoint)) throw new TypeError("pre-release frozen durable recheck does not exactly match the pre-signal ready/checkpoint facts");
  const expectedCgroupPath = `${PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.cgroupRoot}${process.controlGroup}`;
  if (frozenState.cgroupPath !== expectedCgroupPath
    || !frozenTasks.some(task => task.pid === process.pid)
    || frozenTasks.some(task => task.controlGroup !== process.controlGroup)) throw new TypeError("pre-release frozen/thawed cgroup proof is not exact-bound to the anchored task set");
  if (thawProof.kind === "cgroup-thawed" && thawProof.cgroupPath !== expectedCgroupPath) throw new TypeError("pre-release thawed cgroup proof changed the anchored cgroup");
  if (thawProof.kind === "exact-process-exited-after-thaw" && thawProof.processIdentityHash !== process.processIdentityHash) throw new TypeError("pre-release thaw exact-exit proof changed the anchored process");
  if (!same(preReady, postReady) || preReady.processAnchorHash !== processAnchorHash
    || postObserved.processAnchorHash !== processAnchorHash || postDrained.processAnchorHash !== processAnchorHash
    || postObserved.predecessorEventId !== postReady.eventId || postDrained.predecessorEventId !== postObserved.eventId) throw new TypeError("pre-release ready/observed/drained process anchor lineage mismatch");
  const preCheckpoint = exactCheckpoint(pre.checkpoint, "preReleaseRestartControllerReceipt.pre.checkpoint");
  const postCheckpoint = exactCheckpoint(post.checkpoint, "preReleaseRestartControllerReceipt.post.checkpoint");
  if (preCheckpoint.path !== postCheckpoint.path || preCheckpoint.device !== postCheckpoint.device || preCheckpoint.inode !== postCheckpoint.inode
    || preCheckpoint.runId !== postCheckpoint.runId || !same(preCheckpoint.cutoff, postCheckpoint.cutoff)
    || preCheckpoint.candidatePartitionRoot !== postCheckpoint.candidatePartitionRoot) throw new TypeError("pre-release drain did not preserve the exact physical checkpoint run and candidate partition");
  const durableSnapshots = object(post.durableSnapshots, "preReleaseRestartControllerReceipt.post.durableSnapshots");
  assertExactKeys(durableSnapshots, [
    "processEvidence", "checkpoint", "observerContent", "terminalLocators", "sixStepEvidenceLog",
    "sixStepBoundaries", "snapshotRoot",
  ], "preReleaseRestartControllerReceipt.post.durableSnapshots");
  const processEvidenceSnapshot = exactDatabaseSnapshot(
    durableSnapshots.processEvidence,
    "preReleaseRestartControllerReceipt.post.durableSnapshots.processEvidence",
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.processEvidenceDatabasePath,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.processEvidenceSnapshotPath,
  );
  const checkpointSnapshot = exactDatabaseSnapshot(
    durableSnapshots.checkpoint,
    "preReleaseRestartControllerReceipt.post.durableSnapshots.checkpoint",
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.checkpointDatabasePath,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.checkpointSnapshotPath,
  );
  const observerContentSnapshot = exactDirectorySnapshot(
    durableSnapshots.observerContent,
    "preReleaseRestartControllerReceipt.post.durableSnapshots.observerContent",
    "observer-content",
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.observerContentDirectory,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.observerContentSnapshotDirectory,
  );
  const terminalLocatorSnapshot = exactDirectorySnapshot(
    durableSnapshots.terminalLocators,
    "preReleaseRestartControllerReceipt.post.durableSnapshots.terminalLocators",
    "terminal-locator-index",
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.terminalLocatorDirectory,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.terminalLocatorSnapshotDirectory,
  );
  const sixStepEvidenceLogSnapshot = exactPhysicalFileSnapshot(
    durableSnapshots.sixStepEvidenceLog,
    "preReleaseRestartControllerReceipt.post.durableSnapshots.sixStepEvidenceLog",
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.sixStepEvidenceLogPath,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.sixStepEvidenceLogSnapshotPath,
  );
  const sixStepBoundarySnapshot = exactDirectorySnapshot(
    durableSnapshots.sixStepBoundaries,
    "preReleaseRestartControllerReceipt.post.durableSnapshots.sixStepBoundaries",
    "six-step-boundaries",
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.sixStepBoundaryDirectory,
    PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.sixStepBoundarySnapshotDirectory,
  );
  if (assertHash(durableSnapshots.snapshotRoot, "preReleaseRestartControllerReceipt.post.durableSnapshots.snapshotRoot")
    !== hashDomain("aloha/pre-release-a-durable-snapshots/v1", {
      processEvidence: processEvidenceSnapshot,
      checkpoint: checkpointSnapshot,
      observerContent: observerContentSnapshot,
      terminalLocators: terminalLocatorSnapshot,
      sixStepEvidenceLog: sixStepEvidenceLogSnapshot,
      sixStepBoundaries: sixStepBoundarySnapshot,
    })) {
    throw new TypeError("pre-release durable snapshot root mismatch");
  }
  const terminal = exactTerminal(post.terminal, "preReleaseRestartControllerReceipt.post.terminal");
  if (terminal.processReadyEventId !== postReady.eventId || terminal.sigtermObservedEventId !== postObserved.eventId
    || terminal.sigtermDrainedEventId !== postDrained.eventId || terminal.checkpointRootEnvelopeHash !== postCheckpoint.checkpointRootEnvelopeHash
    || terminal.candidatePartitionRoot !== postCheckpoint.candidatePartitionRoot || terminal.outcomePartitionRoot !== postCheckpoint.outcomePartitionRoot
    || !same(terminal.flushedOutcomeHashes, postCheckpoint.outcomeHashes)
    || target.stagingArtifactSetRoot !== terminal.stagingArtifactSetRoot || target.stagingManifestRoot !== terminal.stagingManifestRoot
    || target.controllerBoundaryEvidenceRoot !== terminal.controllerBoundaryEvidenceRoot
    || target.authorizationId !== terminal.authorizationId || target.authorizationClaimId !== terminal.authorizationClaimId) throw new TypeError("pre-release terminal is not exact-bound to process, checkpoint, and signed staging identity");
  const expectedTargetUnitHash = sha256Hex(new TextEncoder().encode(PRE_RELEASE_RESTART_TARGET_UNIT_V1));
  if (target.systemdUnitSha256 !== expectedTargetUnitHash) throw new TypeError("pre-release target does not bind the canonical Restart=no systemd unit");
  const commandIdentity = (args: readonly string[]) => hashDomain("aloha/pre-release-controller-systemctl-command/v1", {
    executable: PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.systemctlPath,
    args,
  });
  if (freezeRequest.commandIdentityHash !== commandIdentity(["freeze", PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetSystemdUnit])
    || queuedSigterm.commandIdentityHash !== commandIdentity(["kill", "--kill-whom=main", "--signal=SIGTERM", PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetSystemdUnit])
    || thaw.commandIdentityHash !== commandIdentity(["thaw", PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.targetSystemdUnit])) throw new TypeError("pre-release receipt command identity is not derived from the fixed freeze/signal/thaw actions");
  const actionTimes = [freezeRequest.invokedAtUnixNs, String(frozenState.observedAtUnixNs), String(frozenDurableRecheck.checkedAtUnixNs), String(frozenState.stableReobservedAtUnixNs), String(queuedSigterm.invokedAtUnixNs), String(thaw.invokedAtUnixNs), String(thawProof.observedAtUnixNs)].map(BigInt);
  if (actionTimes.some((time, index) => index > 0 && time < actionTimes[index - 1]!)) throw new TypeError("pre-release receipt freeze/signal/thaw action order is invalid");
  const expectedImplementationIdentity = hashDomain("aloha/pre-release-restart-controller-implementation/v1", {
    systemdUnitSha256: controller.systemdUnitSha256,
    entrypointSha256: controller.entrypointSha256,
    fixedLayout: PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1,
    receiptSchema: "aloha.pre-release-restart-controller-receipt/v1",
  });
  if (controller.implementationIdentityHash !== expectedImplementationIdentity) throw new TypeError("pre-release controller implementation identity mismatch");
  const publication = object(receipt.publication, "preReleaseRestartControllerReceipt.publication");
  assertExactKeys(publication, ["evidencePath", "evidenceId", "contentSha256", "byteLength", "device", "inode", "uid", "gid", "mode", "mtimeUnixNs", "atomicNoClobberLink", "fileFsynced", "directoryFsynced", "publishedAtUnixNs"], "preReleaseRestartControllerReceipt.publication");
  if (publication.evidencePath !== PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1.evidencePath || publication.uid !== "0" || publication.mode !== "384"
    || publication.atomicNoClobberLink !== true || publication.fileFsynced !== true || publication.directoryFsynced !== true) throw new TypeError("pre-release restart evidence publication is not the fixed root-owned atomic mode");
  for (const field of ["evidenceId", "contentSha256"] as const) assertHash(publication[field], `preReleaseRestartControllerReceipt.publication.${field}`);
  for (const field of ["byteLength", "device", "inode", "gid", "mtimeUnixNs", "publishedAtUnixNs"] as const) decimal(publication[field], `preReleaseRestartControllerReceipt.publication.${field}`);
  const evidencePayload = Object.freeze({
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    controller: receipt.controller,
    target: receipt.target,
    pre: receipt.pre,
    action: receipt.action,
    post: receipt.post,
  });
  const evidenceBytes = encodeCanonicalBytes(evidencePayload);
  if (publication.contentSha256 !== sha256Hex(evidenceBytes) || publication.byteLength !== String(evidenceBytes.byteLength)
    || publication.evidenceId !== hashDomain("aloha/pre-release-restart-controller-evidence/v1", evidencePayload as never)) throw new TypeError("pre-release restart evidence publication content mismatch");
  const { receiptId: _receiptId, ...payload } = receipt;
  if (assertHash(receipt.receiptId, "preReleaseRestartControllerReceipt.receiptId") !== hashDomain(RECEIPT_DOMAIN, payload as never)) throw new TypeError("pre-release restart controller receipt id mismatch");
  return decodeCanonicalJson(encodeCanonicalBytes(receipt)) as unknown as PreReleaseRestartControllerReceiptV1;
}
