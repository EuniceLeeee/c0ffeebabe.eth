import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeExactObject,
  decimalStringSchema,
  encodeCanonicalBytes,
  hashDomain,
  hashSchema,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  PRE_RELEASE_STAGING_LAYOUT_V1,
  decodePreReleaseLaunchAuthorizationV1,
  type PreReleaseLaunchAuthorizationV1,
} from "./pre-release-staging-schema.ts";
import type {
  DurablePreReleaseAuthorizationClaimV1,
  PreReleaseAuthorizationClaimCapabilityV1,
} from "../pre-release-staging-contract.ts";
import {
  preReleaseAuthorizationClaimIdV1,
  preReleaseAuthorizationClaimPayloadV1,
} from "../pre-release-staging-contract.ts";

const fixedClaimCapabilities = new WeakMap<object, DurablePreReleaseAuthorizationClaimV1>();

const TABLE_SQL = `CREATE TABLE pre_release_authorization_claim_v1 (
  authorization_id TEXT PRIMARY KEY NOT NULL,
  signer_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase = 'pre-release'),
  round_role TEXT NOT NULL CHECK (round_role IN ('restart-probe', 'qualification-final')),
  predecessor_authorization_id TEXT,
  predecessor_authorization_claim_id TEXT,
  predecessor_controller_receipt_id TEXT,
  predecessor_controller_implementation_identity_hash TEXT,
  predecessor_target_process_anchor_hash TEXT,
  predecessor_process_ready_event_id TEXT,
  predecessor_sigterm_drained_event_id TEXT,
  predecessor_restart_terminal_id TEXT,
  candidate_release_commit TEXT NOT NULL,
  runtime_binding_id TEXT NOT NULL,
  release_provenance_hash TEXT NOT NULL,
  controller_boundary_evidence_root TEXT NOT NULL,
  staging_artifact_set_root TEXT NOT NULL,
  staging_manifest_root TEXT NOT NULL,
  observer_store_directory TEXT NOT NULL,
  issued_at_unix_ns TEXT NOT NULL,
  expires_at_unix_ns TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  claim_id TEXT UNIQUE NOT NULL,
  UNIQUE (signer_key_id, nonce),
  UNIQUE (runtime_binding_id, release_provenance_hash, round_role),
  CHECK ((round_role = 'restart-probe'
      AND predecessor_authorization_id IS NULL
      AND predecessor_authorization_claim_id IS NULL
      AND predecessor_controller_receipt_id IS NULL
      AND predecessor_controller_implementation_identity_hash IS NULL
      AND predecessor_target_process_anchor_hash IS NULL
      AND predecessor_process_ready_event_id IS NULL
      AND predecessor_sigterm_drained_event_id IS NULL
      AND predecessor_restart_terminal_id IS NULL)
    OR (round_role = 'qualification-final'
      AND predecessor_authorization_id IS NOT NULL
      AND predecessor_authorization_claim_id IS NOT NULL
      AND predecessor_controller_receipt_id IS NOT NULL
      AND predecessor_controller_implementation_identity_hash IS NOT NULL
      AND predecessor_target_process_anchor_hash IS NOT NULL
      AND predecessor_process_ready_event_id IS NOT NULL
      AND predecessor_sigterm_drained_event_id IS NOT NULL
      AND predecessor_restart_terminal_id IS NOT NULL))
)`;

interface ClaimExpectationV1 {
  readonly authorization: PreReleaseLaunchAuthorizationV1;
  readonly runtimeBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly stagingArtifactSetRoot: Hash;
  readonly stagingManifestRoot: Hash;
  readonly observerStoreDirectory: string;
  readonly nowUnixNs: string;
}

interface ClaimRowV1 {
  readonly authorization_id: string;
  readonly signer_key_id: string;
  readonly nonce: string;
  readonly phase: string;
  readonly round_role: string;
  readonly predecessor_authorization_id: string | null;
  readonly predecessor_authorization_claim_id: string | null;
  readonly predecessor_controller_receipt_id: string | null;
  readonly predecessor_controller_implementation_identity_hash: string | null;
  readonly predecessor_target_process_anchor_hash: string | null;
  readonly predecessor_process_ready_event_id: string | null;
  readonly predecessor_sigterm_drained_event_id: string | null;
  readonly predecessor_restart_terminal_id: string | null;
  readonly candidate_release_commit: string;
  readonly runtime_binding_id: string;
  readonly release_provenance_hash: string;
  readonly controller_boundary_evidence_root: string;
  readonly staging_artifact_set_root: string;
  readonly staging_manifest_root: string;
  readonly observer_store_directory: string;
  readonly issued_at_unix_ns: string;
  readonly expires_at_unix_ns: string;
  readonly payload_hash: string;
  readonly signature_hash: string;
  readonly claim_id: string;
}

interface PhysicalIdentityV1 {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
}

const ROW_FIELDS = Object.freeze([
  "authorization_id", "signer_key_id", "nonce", "phase", "round_role", "candidate_release_commit",
  "predecessor_authorization_id", "predecessor_authorization_claim_id", "predecessor_controller_receipt_id",
  "predecessor_controller_implementation_identity_hash", "predecessor_target_process_anchor_hash",
  "predecessor_process_ready_event_id", "predecessor_sigterm_drained_event_id", "predecessor_restart_terminal_id",
  "runtime_binding_id", "release_provenance_hash", "controller_boundary_evidence_root", "staging_artifact_set_root",
  "staging_manifest_root", "observer_store_directory", "issued_at_unix_ns", "expires_at_unix_ns", "payload_hash",
  "signature_hash", "claim_id",
] as const);

function claimPayload(authorization: PreReleaseLaunchAuthorizationV1) {
  return preReleaseAuthorizationClaimPayloadV1(authorization);
}

function validateExpectation(value: ClaimExpectationV1): PreReleaseLaunchAuthorizationV1 {
  const decoded = decodeExactObject(value, {
    authorization: item => decodePreReleaseLaunchAuthorizationV1(item),
    runtimeBindingId: (item, path) => hashSchema.decode(item, path),
    releaseProvenanceHash: (item, path) => hashSchema.decode(item, path),
    stagingArtifactSetRoot: (item, path) => hashSchema.decode(item, path),
    stagingManifestRoot: (item, path) => hashSchema.decode(item, path),
    observerStoreDirectory: (item, path) => {
      if (item !== PRE_RELEASE_STAGING_LAYOUT_V1.observerStoreDirectory) {
        throw new TypeError(`fixed pre-release value mismatch at ${path}`);
      }
      return item;
    },
    nowUnixNs: (item, path) => decimalStringSchema.decode(item, path),
  }, "preReleaseAuthorizationClaim");
  const authorization = decoded.authorization;
  if (authorization.runtimeBindingId !== decoded.runtimeBindingId
    || authorization.releaseProvenanceHash !== decoded.releaseProvenanceHash
    || authorization.stagingArtifactSetRoot !== decoded.stagingArtifactSetRoot
    || authorization.stagingManifestRoot !== decoded.stagingManifestRoot
    || authorization.observerStoreDirectory !== decoded.observerStoreDirectory) {
    throw new TypeError("pre-release authorization claim exact binding mismatch");
  }
  const now = BigInt(decoded.nowUnixNs);
  if (now < BigInt(authorization.issuedAtUnixNs) || now >= BigInt(authorization.expiresAtUnixNs)) {
    throw new TypeError("pre-release authorization claim is outside its validity interval");
  }
  return authorization;
}

function canonicalDatabasePath(pathValue: string): string {
  if (typeof pathValue !== "string" || !pathValue.startsWith("/") || pathValue.includes("\0")) {
    throw new TypeError("pre-release authorization ledger path must be absolute");
  }
  const path = resolve(pathValue);
  if (path !== pathValue) throw new TypeError("pre-release authorization ledger path must be canonical");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new TypeError("pre-release authorization ledger directory is not canonical");
  const directoryStat = statSync(directory, { bigint: true });
  if (!directoryStat.isDirectory() || directoryStat.uid !== BigInt(process.geteuid?.() ?? -1)
    || (directoryStat.mode & 0o22n) !== 0n) {
    throw new TypeError("pre-release authorization ledger directory is not owner-controlled");
  }
  if (existsSync(path) && (!lstatSync(path).isFile() || realpathSync(path) !== path)) {
    throw new TypeError("pre-release authorization ledger is not a canonical regular file");
  }
  if (existsSync(path)) {
    const file = statSync(path, { bigint: true });
    if (file.uid !== BigInt(process.geteuid?.() ?? -1) || (file.mode & 0o22n) !== 0n) {
      throw new TypeError("pre-release authorization ledger is not an owner-controlled regular file");
    }
  }
  return path;
}

function physicalIdentity(path: string, kind: "directory" | "file"): PhysicalIdentityV1 {
  const value = lstatSync(path, { bigint: true });
  if ((kind === "directory" ? !value.isDirectory() : !value.isFile()) || realpathSync(path) !== path) {
    throw new TypeError(`pre-release authorization ledger ${kind} is not canonical`);
  }
  return Object.freeze({
    device: value.dev,
    inode: value.ino,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
  });
}

function samePhysicalIdentity(left: PhysicalIdentityV1, right: PhysicalIdentityV1): boolean {
  return left.device === right.device && left.inode === right.inode
    && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}

function assertRootEffectiveOwner(): void {
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    throw new TypeError("fixed pre-release authorization ledger requires effective uid 0");
  }
}

function assertFixedRootLedgerDirectory(): PhysicalIdentityV1 {
  const directory = dirname(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath);
  const identity = physicalIdentity(directory, "directory");
  if (identity.uid !== 0n || identity.gid !== 0n || (identity.mode & 0o777n) !== 0o700n) {
    throw new TypeError("fixed pre-release authorization ledger directory must be root:root mode 0700");
  }
  return identity;
}

function assertFixedRootLedgerFile(): PhysicalIdentityV1 {
  const identity = physicalIdentity(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath, "file");
  if (identity.uid !== 0n || identity.gid !== 0n || (identity.mode & 0o777n) !== 0o600n) {
    throw new TypeError("fixed pre-release authorization ledger must be root:root mode 0600");
  }
  return identity;
}

function prepareFixedRootLedgerPath(): Readonly<{
  readonly directory: PhysicalIdentityV1;
  readonly file: PhysicalIdentityV1;
}> {
  assertRootEffectiveOwner();
  const directory = assertFixedRootLedgerDirectory();
  if (!existsSync(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath)) {
    const descriptor = openSync(
      PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchownSync(descriptor, 0, 0);
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  }
  return Object.freeze({ directory, file: assertFixedRootLedgerFile() });
}

function assertFixedRootLedgerPathStable(
  before: Readonly<{ readonly directory: PhysicalIdentityV1; readonly file: PhysicalIdentityV1 }>,
): void {
  if (!samePhysicalIdentity(before.directory, assertFixedRootLedgerDirectory())
    || !samePhysicalIdentity(before.file, assertFixedRootLedgerFile())) {
    throw new TypeError("fixed pre-release authorization ledger path identity changed");
  }
}

function assertLedgerSchema(database: DatabaseSync): void {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pre_release_authorization_claim_v1'",
  ).get() as { readonly sql?: unknown } | undefined;
  if (row === undefined || row.sql !== TABLE_SQL) {
    throw new TypeError("pre-release authorization ledger schema mismatch");
  }
  const indexes = database.prepare("PRAGMA index_list('pre_release_authorization_claim_v1')").all() as readonly Record<string, unknown>[];
  const uniqueIndexes = indexes.filter(index => index.unique === 1 || index.unique === 1n);
  const columns = uniqueIndexes.map(index => {
    const name = index.name;
    if (typeof name !== "string") throw new TypeError("pre-release authorization ledger index is invalid");
    return (database.prepare(`PRAGMA index_info(${JSON.stringify(name)})`).all() as readonly Record<string, unknown>[])
      .map(entry => entry.name)
      .join("\0");
  }).sort();
  for (const expected of [
    "authorization_id",
    "claim_id",
    "signer_key_id\0nonce",
    "runtime_binding_id\0release_provenance_hash\0round_role",
  ]) {
    if (!columns.includes(expected)) throw new TypeError("pre-release authorization ledger uniqueness contract mismatch");
  }
}

function rowForAuthorization(database: DatabaseSync, authorization: PreReleaseLaunchAuthorizationV1): ClaimRowV1 | null {
  const rows = database.prepare(`SELECT ${ROW_FIELDS.join(", ")} FROM pre_release_authorization_claim_v1
    WHERE authorization_id = ? OR (signer_key_id = ? AND nonce = ?)
    ORDER BY authorization_id`).all(
    authorization.authorizationId,
    authorization.signerKeyId,
    authorization.nonce,
  ) as readonly unknown[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new TypeError("pre-release authorization ledger contains conflicting claims");
  return decodeExactObject(rows[0], Object.fromEntries(ROW_FIELDS.map(field => [field, (item: unknown, path: string) => {
    if (item === null && field.startsWith("predecessor_")) return null;
    if (typeof item !== "string") throw new TypeError(`expected string at ${path}`);
    return item;
  }])) as { [K in keyof ClaimRowV1]: (value: unknown, path: string) => ClaimRowV1[K] }, "preReleaseAuthorizationClaimRow");
}

function rowsForRelease(database: DatabaseSync, authorization: PreReleaseLaunchAuthorizationV1): readonly ClaimRowV1[] {
  const rows = database.prepare(`SELECT ${ROW_FIELDS.join(", ")} FROM pre_release_authorization_claim_v1
    WHERE runtime_binding_id = ?
      AND release_provenance_hash = ?
    ORDER BY round_role`).all(
    authorization.runtimeBindingId,
    authorization.releaseProvenanceHash,
  ) as readonly unknown[];
  return Object.freeze(rows.map((row, index) => decodeExactObject(
    row,
    Object.fromEntries(ROW_FIELDS.map(field => [field, (item: unknown, path: string) => {
      if (item === null && field.startsWith("predecessor_")) return null;
      if (typeof item !== "string") throw new TypeError(`expected string at ${path}`);
      return item;
    }])) as { [K in keyof ClaimRowV1]: (value: unknown, path: string) => ClaimRowV1[K] },
    `preReleaseAuthorizationReleaseRow[${index}]`,
  )));
}

function assertNextReleaseTransition(
  authorization: PreReleaseLaunchAuthorizationV1,
  releaseRows: readonly ClaimRowV1[],
): void {
  if (releaseRows.length > 2) throw new TypeError("pre-release authorization ledger contains a third round");
  if (releaseRows.some(row => row.candidate_release_commit !== authorization.candidateReleaseCommit
    || row.staging_artifact_set_root !== authorization.stagingArtifactSetRoot
    || row.controller_boundary_evidence_root !== authorization.controllerBoundaryEvidenceRoot
    || row.staging_manifest_root !== authorization.stagingManifestRoot)) {
    throw new TypeError("pre-release authorization ledger cross-staging transition is invalid");
  }
  const probe = releaseRows.find(row => row.round_role === "restart-probe");
  const final = releaseRows.find(row => row.round_role === "qualification-final");
  if (releaseRows.some(row => row.round_role !== "restart-probe" && row.round_role !== "qualification-final")
    || (probe === undefined && final !== undefined)) {
    throw new TypeError("pre-release authorization ledger release transition is invalid");
  }
  if (authorization.roundRole === "restart-probe") {
    if (releaseRows.length !== 0) throw new TypeError("pre-release release already has a restart-probe round");
    return;
  }
  if (probe === undefined) throw new TypeError("pre-release qualification-final requires a durable restart-probe claim");
  if (final !== undefined || releaseRows.length !== 1) {
    throw new TypeError("pre-release release already has a qualification-final round");
  }
  const predecessor = authorization.predecessor;
  if (predecessor === null
    || predecessor.authorizationId !== probe.authorization_id
    || predecessor.authorizationClaimId !== probe.claim_id) {
    throw new TypeError("pre-release qualification-final predecessor claim was spliced");
  }
}

function expectedRow(authorization: PreReleaseLaunchAuthorizationV1): ClaimRowV1 {
  const payload = claimPayload(authorization);
  const claimId = preReleaseAuthorizationClaimIdV1(authorization);
  return Object.freeze({
    authorization_id: payload.authorizationId,
    signer_key_id: payload.signerKeyId,
    nonce: payload.nonce,
    phase: payload.phase,
    round_role: payload.roundRole,
    predecessor_authorization_id: authorization.predecessor?.authorizationId ?? null,
    predecessor_authorization_claim_id: authorization.predecessor?.authorizationClaimId ?? null,
    predecessor_controller_receipt_id: authorization.predecessor?.controllerReceiptId ?? null,
    predecessor_controller_implementation_identity_hash: authorization.predecessor?.controllerImplementationIdentityHash ?? null,
    predecessor_target_process_anchor_hash: authorization.predecessor?.targetProcessAnchorHash ?? null,
    predecessor_process_ready_event_id: authorization.predecessor?.processReadyEventId ?? null,
    predecessor_sigterm_drained_event_id: authorization.predecessor?.sigtermDrainedEventId ?? null,
    predecessor_restart_terminal_id: authorization.predecessor?.restartTerminalId ?? null,
    candidate_release_commit: payload.candidateReleaseCommit,
    runtime_binding_id: payload.runtimeBindingId,
    release_provenance_hash: payload.releaseProvenanceHash,
    controller_boundary_evidence_root: payload.controllerBoundaryEvidenceRoot,
    staging_artifact_set_root: payload.stagingArtifactSetRoot,
    staging_manifest_root: payload.stagingManifestRoot,
    observer_store_directory: payload.observerStoreDirectory,
    issued_at_unix_ns: payload.issuedAtUnixNs,
    expires_at_unix_ns: payload.expiresAtUnixNs,
    payload_hash: payload.payloadHash,
    signature_hash: payload.signatureHash,
    claim_id: claimId,
  });
}

function sameRow(left: ClaimRowV1, right: ClaimRowV1): boolean {
  return ROW_FIELDS.every(field => left[field] === right[field]);
}

function receipt(row: ClaimRowV1, path: string): DurablePreReleaseAuthorizationClaimV1 {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || realpathSync(path) !== path || stat.uid !== BigInt(process.geteuid?.() ?? -1)
    || (stat.mode & 0o22n) !== 0n) {
    throw new TypeError("pre-release authorization ledger is not an owner-controlled regular file");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.pre-release-authorization-claim",
    claimId: row.claim_id as Hash,
    authorizationId: row.authorization_id as Hash,
    signerKeyId: row.signer_key_id as Hash,
    nonce: row.nonce as Hash,
    phase: "pre-release",
    roundRole: row.round_role as "restart-probe" | "qualification-final",
    predecessor: row.predecessor_authorization_id === null ? null : Object.freeze({
      authorizationId: row.predecessor_authorization_id as Hash,
      authorizationClaimId: row.predecessor_authorization_claim_id as Hash,
      controllerReceiptId: row.predecessor_controller_receipt_id as Hash,
      controllerImplementationIdentityHash: row.predecessor_controller_implementation_identity_hash as Hash,
      targetProcessAnchorHash: row.predecessor_target_process_anchor_hash as Hash,
      processReadyEventId: row.predecessor_process_ready_event_id as Hash,
      sigtermDrainedEventId: row.predecessor_sigterm_drained_event_id as Hash,
      restartTerminalId: row.predecessor_restart_terminal_id as Hash,
    }),
    candidateReleaseCommit: row.candidate_release_commit,
    runtimeBindingId: row.runtime_binding_id as Hash,
    releaseProvenanceHash: row.release_provenance_hash as Hash,
    controllerBoundaryEvidenceRoot: row.controller_boundary_evidence_root as Hash,
    stagingArtifactSetRoot: row.staging_artifact_set_root as Hash,
    stagingManifestRoot: row.staging_manifest_root as Hash,
    observerStoreDirectory: row.observer_store_directory,
    issuedAtUnixNs: row.issued_at_unix_ns,
    expiresAtUnixNs: row.expires_at_unix_ns,
    payloadHash: row.payload_hash as Hash,
    signatureHash: row.signature_hash as Hash,
    ledgerPath: path,
    ledgerDevice: String(stat.dev),
    ledgerInode: String(stat.ino),
  });
}

/**
 * Internal transaction core. Production always calls it with the fixed path;
 * the path parameter exists solely so the package test closure can exercise
 * reopen/rollback/splice behavior without touching the host ledger.
 */
export function claimPreReleaseAuthorizationInDatabaseV1(
  databasePathValue: string,
  expectation: ClaimExpectationV1,
): DurablePreReleaseAuthorizationClaimV1 {
  const authorization = validateExpectation(expectation);
  const path = canonicalDatabasePath(databasePathValue);
  const beforeOpen = existsSync(path) ? statSync(path, { bigint: true }) : null;
  const database = new DatabaseSync(path);
  try {
    const databaseList = database.prepare("PRAGMA database_list").all() as readonly Record<string, unknown>[];
    if (databaseList.length !== 1 || databaseList[0]?.name !== "main" || databaseList[0]?.file !== path) {
      throw new TypeError("pre-release authorization ledger connection is not bound to the canonical main database path");
    }
    const afterOpen = statSync(path, { bigint: true });
    if (!afterOpen.isFile() || afterOpen.uid !== BigInt(process.geteuid?.() ?? -1) || (afterOpen.mode & 0o22n) !== 0n
      || (beforeOpen !== null && (beforeOpen.dev !== afterOpen.dev || beforeOpen.ino !== afterOpen.ino
        || beforeOpen.uid !== afterOpen.uid || beforeOpen.mode !== afterOpen.mode))) {
      throw new TypeError("pre-release authorization ledger path changed across database open");
    }
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    database.exec(TABLE_SQL.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
    assertLedgerSchema(database);
    database.exec("BEGIN IMMEDIATE");
    let preparedReceipt: DurablePreReleaseAuthorizationClaimV1;
    try {
      const expected = expectedRow(authorization);
      const existing = rowForAuthorization(database, authorization);
      if (existing !== null) {
        if (existing.authorization_id !== expected.authorization_id) {
          throw new TypeError("pre-release authorization nonce was already durably consumed");
        }
        if (!sameRow(existing, expected)) throw new TypeError("pre-release authorization durable claim was spliced");
        throw new TypeError("pre-release launch authorization was already durably consumed");
      }
      assertNextReleaseTransition(authorization, rowsForRelease(database, authorization));
      database.prepare(`INSERT INTO pre_release_authorization_claim_v1 (${ROW_FIELDS.join(", ")})
        VALUES (${ROW_FIELDS.map(() => "?").join(", ")})`).run(...ROW_FIELDS.map(field => expected[field]));
      const inserted = rowForAuthorization(database, authorization);
      if (inserted === null || !sameRow(inserted, expected)) {
        throw new TypeError("pre-release authorization durable claim verification failed");
      }
      // All checks that can fail happen before COMMIT. A failed receipt fence
      // therefore rolls the INSERT back instead of burning the authorization.
      preparedReceipt = receipt(expected, path);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* original error remains authoritative */ }
      throw error;
    }
    return preparedReceipt!;
  } finally {
    database.close();
  }
}

export function claimFixedPreReleaseAuthorizationV1(
  expectation: ClaimExpectationV1,
): PreReleaseAuthorizationClaimCapabilityV1 {
  const fixedPath = prepareFixedRootLedgerPath();
  const projection = claimPreReleaseAuthorizationInDatabaseV1(
    PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath,
    expectation,
  );
  assertFixedRootLedgerPathStable(fixedPath);
  const capability = Object.freeze(Object.create(null)) as PreReleaseAuthorizationClaimCapabilityV1;
  fixedClaimCapabilities.set(capability, projection);
  return capability;
}

/** Reopen and exact-join a projected claim to the owner-controlled durable
 * row. This is a fact check, not a replay path and cannot issue a new claim. */
export function readFixedPreReleaseAuthorizationClaimV1(
  authorizationValue: PreReleaseLaunchAuthorizationV1,
  claimCapability: PreReleaseAuthorizationClaimCapabilityV1,
): DurablePreReleaseAuthorizationClaimV1 {
  const authorization = decodePreReleaseLaunchAuthorizationV1(authorizationValue);
  const claimValue = claimCapability !== null && typeof claimCapability === "object"
    ? fixedClaimCapabilities.get(claimCapability)
    : undefined;
  if (claimValue === undefined) {
    throw new TypeError("pre-release authorization claim capability was not fixed-ledger-issued");
  }
  const fixedPath = prepareFixedRootLedgerPath();
  const path = canonicalDatabasePath(PRE_RELEASE_STAGING_LAYOUT_V1.authorizationLedgerPath);
  const beforeOpen = statSync(path, { bigint: true });
  const database = new DatabaseSync(path);
  try {
    const databaseList = database.prepare("PRAGMA database_list").all() as readonly Record<string, unknown>[];
    const afterOpen = statSync(path, { bigint: true });
    if (databaseList.length !== 1 || databaseList[0]?.name !== "main" || databaseList[0]?.file !== path
      || beforeOpen.dev !== afterOpen.dev || beforeOpen.ino !== afterOpen.ino
      || beforeOpen.uid !== afterOpen.uid || beforeOpen.mode !== afterOpen.mode) {
      throw new TypeError("pre-release authorization ledger changed across receipt reopen");
    }
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;");
    assertLedgerSchema(database);
    const row = rowForAuthorization(database, authorization);
    const expected = expectedRow(authorization);
    if (row === null || !sameRow(row, expected)) {
      throw new TypeError("pre-release authorization claim does not resolve to its durable ledger row");
    }
    const durable = receipt(row, path);
    if (!Buffer.from(encodeCanonicalBytes(durable)).equals(Buffer.from(encodeCanonicalBytes(claimValue)))) {
      throw new TypeError("pre-release authorization claim projection was structurally substituted");
    }
    assertFixedRootLedgerPathStable(fixedPath);
    return durable;
  } finally {
    database.close();
  }
}

export type { DurablePreReleaseAuthorizationClaimV1 } from "../pre-release-staging-contract.ts";
