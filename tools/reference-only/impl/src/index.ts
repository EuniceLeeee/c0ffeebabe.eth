import {
  assertExactKeys,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  readOwnEnumerableDataProperty,
  sha256Hex,
  type CanonicalJson,
  type CanonicalJsonObject,
  type Hash,
  type ExactFieldDecoder,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeProcessAnchor,
  decodeReadOnlyArtifactRef,
  type GitSha40,
  type ProcessAnchorV1,
  type ReadOnlyArtifactRefV1,
} from "../../../../specs/core-envelope/src/index.ts";
import {
  decimalStringSchema,
  gitSha40Schema,
  hashSchema,
  nonEmptyStringSchema,
} from "../../../../packages/canonical-codec/src/index.ts";

/** The only producer identity this package accepts. */
export const REFERENCE_TRUST_LEVEL = "untrusted-reference" as const;
export const REFERENCE_RECEIPT_KIND = "aloha.impl-reference-witness-receipt" as const;
export const REFERENCE_RAW_KIND = "aloha.impl-reference-raw" as const;
/**
 * The sole calibration reference.  This is deliberately a source-level
 * constant: callers cannot select an impl commit, and the importer never
 * follows a moving branch or repository HEAD.
 */
export const CALIBRATION_REFERENCE_IMPL_SHA: GitSha40 =
  "5f104cedd4b4778316c177ce4fa08a6761af85b1";

export type ReferenceTrustLevel = typeof REFERENCE_TRUST_LEVEL;
export type ReferenceWitnessStatus = "observed" | "missing" | "invalid";

/**
 * These reasons describe the importer's observation boundary. They are not a
 * verdict and deliberately have no success/failure interpretation outside the
 * claim's status.
 */
export type ReferenceWitnessReason =
  | "observed-raw-record"
  | "missing-artifact"
  | "missing-stage"
  | "invalid-lock"
  | "invalid-artifact-ref"
  | "reader-error"
  | "bytes-type-invalid"
  | "bytes-hash-mismatch"
  | "malformed-raw-record"
  | "unknown-stage"
  | "impl-sha-mismatch"
  | "runtime-anchor-mismatch"
  | "duplicate-stage"
  | "out-of-order-stage";

export interface ReferenceStageSpec {
  readonly ordinal: number;
  readonly id: string;
}

/**
 * The only stage denominator accepted for this impl calibration reference.
 * This two-stage reference manifest is not Aloha's six-step production flow.
 */
export const CALIBRATION_REFERENCE_STAGE_MANIFEST: readonly ReferenceStageSpec[] = deepFreeze([
  { ordinal: 1, id: "startup" },
  { ordinal: 2, id: "ready" },
]);

export type ReferenceStageInput = ReferenceStageSpec | string;

export interface ImplReferenceLock {
  /** Exact, user-supplied impl commit. No repository lookup is performed. */
  readonly implCommitSha: GitSha40;
  /** Exact process/runtime anchor selected by the caller. */
  readonly runtimeAnchor: ProcessAnchorV1;
  /** Exact two-stage calibration denominator; runtime stages are not caller-selectable. */
  readonly stages: readonly ReferenceStageInput[];
  /** Exact immutable raw artifact refs selected by the caller. */
  readonly rawArtifactRefs: readonly ReadOnlyArtifactRefV1[];
}

/** Read-only boundary; this package has no write/store/mutation port. */
export interface ReferenceArtifactReadPort {
  read(ref: ReadOnlyArtifactRefV1): Promise<Uint8Array | null>;
}

export interface ImplReferenceImportRequest {
  readonly lock: ImplReferenceLock;
  readonly port: ReferenceArtifactReadPort;
}

export interface ReferenceWitnessClaim {
  readonly claimId: Hash;
  readonly trustLevel: ReferenceTrustLevel;
  readonly implCommitSha: GitSha40;
  readonly runtimeAnchor: ProcessAnchorV1;
  readonly stage: string | null;
  readonly expectedOrdinal: number | null;
  readonly status: ReferenceWitnessStatus;
  readonly reason: ReferenceWitnessReason;
  readonly rawArtifactRefId: Hash | null;
  readonly rawArtifactRef: ReadOnlyArtifactRefV1 | null;
  /** Hash of the bytes returned by the read-only port, when bytes existed. */
  readonly rawBytesSha256: Hash | null;
  readonly rawByteLength: string | null;
  /** Producer claims copied verbatim from an exact-decoded raw record. Never facts/authority. */
  readonly untrustedClaims: CanonicalJsonObject | null;
}

export interface ReferenceWitnessDenominatorEntry {
  readonly claimId: Hash;
  readonly ordinal: number | null;
  readonly stage: string | null;
  readonly rawArtifactRefId: Hash | null;
  readonly status: ReferenceWitnessStatus;
}

export interface ReferenceWitnessDenominator {
  readonly expectedStages: readonly ReferenceStageSpec[];
  readonly entries: readonly ReferenceWitnessDenominatorEntry[];
}

/**
 * A neutral receipt. There is intentionally no verdict, expected verdict,
 * oracle count, qualification, or producer-specific acceptance field.
 */
export interface ReferenceWitnessReceipt {
  readonly schemaVersion: 1;
  readonly kind: typeof REFERENCE_RECEIPT_KIND;
  readonly receiptId: Hash;
  readonly trustLevel: ReferenceTrustLevel;
  readonly implCommitSha: GitSha40;
  readonly runtimeAnchor: ProcessAnchorV1;
  readonly stageManifestHash: Hash;
  readonly rawArtifactRefIds: readonly Hash[];
  readonly denominator: ReferenceWitnessDenominator;
  readonly claims: readonly ReferenceWitnessClaim[];
}

export interface ReferenceRawRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof REFERENCE_RAW_KIND;
  readonly stage: string;
  readonly implCommitSha: GitSha40;
  readonly runtimeAnchor: ProcessAnchorV1;
  readonly untrustedClaims: CanonicalJsonObject;
}

interface ArtifactAttempt {
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claim: ReferenceWitnessClaim;
  readonly stageIndex: number | null;
  readonly stage: string | null;
}

interface NormalizedImplReferenceLock extends Omit<ImplReferenceLock, "stages"> {
  readonly stages: readonly ReferenceStageSpec[];
}

const hashDecoder: ExactFieldDecoder<Hash> = (value, path) => hashSchema.decode(value, path);
const shaDecoder: ExactFieldDecoder<GitSha40> = (value, path) => gitSha40Schema.decode(value, path);
const textDecoder: ExactFieldDecoder<string> = (value, path) => nonEmptyStringSchema.decode(value, path);
const decimalDecoder: ExactFieldDecoder<string> = (value, path) => decimalStringSchema.decode(value, path);

function isExactNativeBytes(value: unknown): value is Uint8Array {
  return (
    typeof value === "object" &&
    value !== null &&
    ArrayBuffer.isView(value) &&
    Object.getPrototypeOf(value) === Uint8Array.prototype &&
    Object.getOwnPropertyDescriptor(value, "length") === undefined
  );
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function normalizeStage(value: ReferenceStageInput, index: number): ReferenceStageSpec {
  if (typeof value === "string") {
    if (value.length === 0) throw new TypeError(`empty stage at $.stages[${index}]`);
    return Object.freeze({ ordinal: index + 1, id: value });
  }
  assertExactKeys(value, ["ordinal", "id"], `$.stages[${index}]`);
  const ordinal = readOwnEnumerableDataProperty(value, "ordinal", `$.stages[${index}]`);
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
    throw new TypeError(`stage ordinal must be a positive safe integer at $.stages[${index}].ordinal`);
  }
  const id = textDecoder(readOwnEnumerableDataProperty(value, "id", `$.stages[${index}]`), `$.stages[${index}].id`);
  return Object.freeze({ ordinal, id });
}

function normalizeStages(values: readonly ReferenceStageInput[]): readonly ReferenceStageSpec[] {
  if (!Array.isArray(values)) throw new TypeError("stages must be an array");
  const stages = values.map(normalizeStage);
  if (stages.length === 0) throw new TypeError("stages must not be empty");
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    if (ids.has(stage.id)) throw new TypeError(`duplicate stage ${stage.id}`);
    if (ordinals.has(stage.ordinal)) throw new TypeError(`duplicate stage ordinal ${stage.ordinal}`);
    if (stage.ordinal !== index + 1) throw new TypeError("stage ordinals must be strictly ordered from one");
    ids.add(stage.id);
    ordinals.add(stage.ordinal);
  }
  return Object.freeze(stages);
}

export function computeReferenceStageManifestHash(stages: readonly ReferenceStageInput[]): Hash {
  return hashDomain("aloha/impl-reference-stage-manifest/v1", normalizeStages(stages));
}

function normalizeLock(lock: ImplReferenceLock): NormalizedImplReferenceLock {
  assertExactKeys(lock, ["implCommitSha", "runtimeAnchor", "stages", "rawArtifactRefs"], "$.lock");
  const implCommitSha = shaDecoder(readOwnEnumerableDataProperty(lock, "implCommitSha", "$.lock"), "$.lock.implCommitSha");
  if (implCommitSha !== CALIBRATION_REFERENCE_IMPL_SHA) {
    throw new TypeError(`impl reference lock must pin ${CALIBRATION_REFERENCE_IMPL_SHA}`);
  }
  const runtimeAnchor = decodeProcessAnchor(
    readOwnEnumerableDataProperty(lock, "runtimeAnchor", "$.lock") as object,
  );
  if (runtimeAnchor.commitSha !== implCommitSha) {
    throw new TypeError("runtime anchor commitSha does not equal the locked implCommitSha");
  }
  const stages = normalizeStages(
    readOwnEnumerableDataProperty(lock, "stages", "$.lock") as readonly ReferenceStageInput[],
  );
  if (!canonicalEqual(stages, CALIBRATION_REFERENCE_STAGE_MANIFEST)) {
    throw new TypeError("impl reference stage manifest must exactly match startup→ready calibration stages");
  }
  const rawInput = readOwnEnumerableDataProperty(lock, "rawArtifactRefs", "$.lock");
  if (!Array.isArray(rawInput)) throw new TypeError("lock.rawArtifactRefs must be an array");
  const rawArtifactRefs = rawInput.map((value, index) => {
    try {
      return decodeReadOnlyArtifactRef(value as object);
    } catch (error) {
      throw new TypeError(`invalid raw artifact ref at $.lock.rawArtifactRefs[${index}]: ${String(error)}`);
    }
  });
  const ids = new Set<Hash>();
  for (const ref of rawArtifactRefs) {
    if (ids.has(ref.artifactRefId)) throw new TypeError(`duplicate raw artifact ref ${ref.artifactRefId}`);
    ids.add(ref.artifactRefId);
  }
  return Object.freeze({ implCommitSha, runtimeAnchor, stages, rawArtifactRefs: Object.freeze(rawArtifactRefs) });
}

function decodeFacts(value: unknown, path: string): CanonicalJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`raw facts must be a canonical object at ${path}`);
  }
  // decodeCanonicalJson has already frozen the complete raw value. Re-encoding
  // here is an explicit exact-decode check, not a normalization step.
  encodeCanonicalJson(value);
  return value as CanonicalJsonObject;
}

function decodeReferenceRawRecord(
  value: string | Uint8Array | object,
): ReferenceRawRecordV1 {
  const decoded = typeof value === "string" || ArrayBuffer.isView(value)
    ? decodeCanonicalJson(value as string | Uint8Array)
    : value;
  const raw = decoded;
  assertExactKeys(
    raw,
    ["schemaVersion", "kind", "stage", "implCommitSha", "runtimeAnchor", "untrustedClaims"],
    "$.raw",
  );
  const schemaVersion = readOwnEnumerableDataProperty(raw, "schemaVersion", "$.raw");
  if (schemaVersion !== 1) throw new TypeError("unsupported raw record schemaVersion");
  const kind = readOwnEnumerableDataProperty(raw, "kind", "$.raw");
  if (kind !== REFERENCE_RAW_KIND) throw new TypeError("unknown raw record kind");
  const stage = textDecoder(readOwnEnumerableDataProperty(raw, "stage", "$.raw"), "$.raw.stage");
  const implCommitSha = shaDecoder(readOwnEnumerableDataProperty(raw, "implCommitSha", "$.raw"), "$.raw.implCommitSha");
  const runtimeAnchor = decodeProcessAnchor(readOwnEnumerableDataProperty(raw, "runtimeAnchor", "$.raw") as object);
  const untrustedClaims = decodeFacts(
    readOwnEnumerableDataProperty(raw, "untrustedClaims", "$.raw"),
    "$.raw.untrustedClaims",
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: REFERENCE_RAW_KIND,
    stage,
    implCommitSha,
    runtimeAnchor,
    untrustedClaims,
  });
}

const decodeRawRecord = (bytes: Uint8Array): ReferenceRawRecordV1 => decodeReferenceRawRecord(bytes);

function claimPayload(value: Omit<ReferenceWitnessClaim, "claimId">): CanonicalJsonObject {
  return value;
}

function makeClaim(value: Omit<ReferenceWitnessClaim, "claimId">): ReferenceWitnessClaim {
  const payload = deepFreeze(value);
  return deepFreeze({
    ...payload,
    claimId: hashDomain("aloha/reference-witness-claim/v1", claimPayload(payload)),
  });
}

function makeReceipt(value: Omit<ReferenceWitnessReceipt, "receiptId">): ReferenceWitnessReceipt {
  const payload = deepFreeze(value);
  return deepFreeze({
    ...payload,
    receiptId: hashDomain("aloha/reference-witness-receipt/v1", payload),
  });
}

function refId(ref: ReadOnlyArtifactRefV1 | null): Hash | null {
  return ref?.artifactRefId ?? null;
}

function baseClaim(
  lock: ImplReferenceLock,
  value: Pick<ReferenceWitnessClaim, "stage" | "expectedOrdinal" | "status" | "reason" | "rawArtifactRef" | "rawBytesSha256" | "rawByteLength" | "untrustedClaims">,
): ReferenceWitnessClaim {
  return makeClaim({
    trustLevel: REFERENCE_TRUST_LEVEL,
    implCommitSha: lock.implCommitSha,
    runtimeAnchor: lock.runtimeAnchor,
    stage: value.stage,
    expectedOrdinal: value.expectedOrdinal,
    status: value.status,
    reason: value.reason,
    rawArtifactRefId: refId(value.rawArtifactRef),
    rawArtifactRef: value.rawArtifactRef,
    rawBytesSha256: value.rawBytesSha256,
    rawByteLength: value.rawByteLength,
    untrustedClaims: value.untrustedClaims,
  });
}

function denominatorEntry(claim: ReferenceWitnessClaim): ReferenceWitnessDenominatorEntry {
  return Object.freeze({
    claimId: claim.claimId,
    ordinal: claim.expectedOrdinal,
    stage: claim.stage,
    rawArtifactRefId: claim.rawArtifactRefId,
    status: claim.status,
  });
}

function invalidAttempt(
  lock: ImplReferenceLock,
  ref: ReadOnlyArtifactRefV1,
  reason: ReferenceWitnessReason,
  stage: string | null = null,
  expectedOrdinal: number | null = null,
  rawBytesSha256: Hash | null = null,
  rawByteLength: string | null = null,
): ArtifactAttempt {
  const claim = baseClaim(lock, {
    stage,
    expectedOrdinal,
    status: "invalid",
    reason,
    rawArtifactRef: ref,
    rawBytesSha256,
    rawByteLength,
    untrustedClaims: null,
  });
  return { ref, claim, stageIndex: expectedOrdinal === null ? null : expectedOrdinal - 1, stage };
}

function missingArtifact(lock: ImplReferenceLock, ref: ReadOnlyArtifactRefV1): ArtifactAttempt {
  const claim = baseClaim(lock, {
    stage: null,
    expectedOrdinal: null,
    status: "missing",
    reason: "missing-artifact",
    rawArtifactRef: ref,
    rawBytesSha256: null,
    rawByteLength: null,
    untrustedClaims: null,
  });
  return { ref, claim, stageIndex: null, stage: null };
}

function stageIndexFor(stage: string, stages: readonly ReferenceStageSpec[]): number | null {
  const index = stages.findIndex((entry) => entry.id === stage);
  return index < 0 ? null : index;
}

function observedAttempt(
  lock: ImplReferenceLock,
  ref: ReadOnlyArtifactRefV1,
  record: ReferenceRawRecordV1,
  stageIndex: number,
  rawBytesSha256: Hash,
  rawByteLength: string,
): ArtifactAttempt {
  const claim = baseClaim(lock, {
    stage: record.stage,
    expectedOrdinal: stageIndex + 1,
    status: "observed",
    reason: "observed-raw-record",
    rawArtifactRef: ref,
    rawBytesSha256,
    rawByteLength,
    untrustedClaims: record.untrustedClaims,
  });
  return { ref, claim, stageIndex, stage: record.stage };
}

function replaceAttemptClaim(
  lock: ImplReferenceLock,
  attempt: ArtifactAttempt,
  reason: ReferenceWitnessReason,
): ArtifactAttempt {
  const claim = baseClaim(lock, {
    stage: attempt.stage,
    expectedOrdinal: attempt.stageIndex === null ? null : attempt.stageIndex + 1,
    status: "invalid",
    reason,
    rawArtifactRef: attempt.ref,
    rawBytesSha256: attempt.claim.rawBytesSha256,
    rawByteLength: attempt.claim.rawByteLength,
    untrustedClaims: null,
  });
  return { ...attempt, claim };
}

function missingStageClaim(lock: ImplReferenceLock, stage: ReferenceStageSpec): ReferenceWitnessClaim {
  return baseClaim(lock, {
    stage: stage.id,
    expectedOrdinal: stage.ordinal,
    status: "missing",
    reason: "missing-stage",
    rawArtifactRef: null,
    rawBytesSha256: null,
    rawByteLength: null,
    untrustedClaims: null,
  });
}

async function readAttempt(
  lock: ImplReferenceLock,
  ref: ReadOnlyArtifactRefV1,
  stages: readonly ReferenceStageSpec[],
  port: ReferenceArtifactReadPort,
): Promise<ArtifactAttempt> {
  let raw: Uint8Array | null;
  try {
    raw = await port.read(ref);
  } catch {
    return invalidAttempt(lock, ref, "reader-error");
  }
  if (raw === null) return missingArtifact(lock, ref);
  if (!isExactNativeBytes(raw)) return invalidAttempt(lock, ref, "bytes-type-invalid");

  // Copy by indexed access. Uint8Array.from(raw) is iterable-aware and would
  // execute a caller-owned Symbol.iterator property on an otherwise native
  // typed array; a raw artifact port is not allowed to smuggle code through
  // the binary boundary.
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw[index]!;
  const actualHash = sha256Hex(bytes);
  const actualLength = String(bytes.length);
  if (actualHash !== ref.contentSha256 || actualLength !== ref.byteLength) {
    return invalidAttempt(lock, ref, "bytes-hash-mismatch", null, null, actualHash, actualLength);
  }

  let record: ReferenceRawRecordV1;
  try {
    record = decodeRawRecord(bytes);
  } catch {
    return invalidAttempt(lock, ref, "malformed-raw-record", null, null, actualHash, actualLength);
  }
  const index = stageIndexFor(record.stage, stages);
  if (index === null) {
    return invalidAttempt(lock, ref, "unknown-stage", record.stage, null, actualHash, actualLength);
  }
  if (record.implCommitSha !== lock.implCommitSha) {
    return invalidAttempt(lock, ref, "impl-sha-mismatch", record.stage, index + 1, actualHash, actualLength);
  }
  if (!canonicalEqual(record.runtimeAnchor, lock.runtimeAnchor)) {
    return invalidAttempt(lock, ref, "runtime-anchor-mismatch", record.stage, index + 1, actualHash, actualLength);
  }
  return observedAttempt(lock, ref, record, index, actualHash, actualLength);
}

/**
 * Import already materialized impl bytes. This function does no repository,
 * network, filesystem, runtime, or producer lookup: every identity and every
 * artifact ref is supplied in the request and read through the read-only port.
 */
export async function importImplReference(
  request: ImplReferenceImportRequest,
): Promise<ReferenceWitnessReceipt> {
  const lock = normalizeLock(request.lock);
  const stages = lock.stages;
  if (request.port === null || typeof request.port !== "object" || typeof request.port.read !== "function") {
    throw new TypeError("a read-only artifact port is required");
  }

  const attempts: ArtifactAttempt[] = [];
  for (const ref of lock.rawArtifactRefs) {
    attempts.push(await readAttempt(lock, ref, stages, request.port));
  }

  const counts = new Map<number, number>();
  for (const attempt of attempts) {
    if (attempt.stageIndex !== null) counts.set(attempt.stageIndex, (counts.get(attempt.stageIndex) ?? 0) + 1);
  }
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    if (attempt.claim.status === "observed" && attempt.stageIndex !== null && counts.get(attempt.stageIndex)! > 1) {
      attempts[index] = replaceAttemptClaim(lock, attempt, "duplicate-stage");
    }
  }

  let previousIndex: number | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    if (attempt.stageIndex === null) continue;
    if (attempt.claim.status === "observed" && previousIndex !== null && attempt.stageIndex < previousIndex) {
      attempts[index] = replaceAttemptClaim(lock, attempt, "out-of-order-stage");
    }
    previousIndex = attempt.stageIndex;
  }

  const attemptedStages = new Set<number>();
  for (const attempt of attempts) {
    if (attempt.stageIndex !== null) attemptedStages.add(attempt.stageIndex);
  }

  const claims: ReferenceWitnessClaim[] = attempts.map((attempt) => attempt.claim);
  for (let index = 0; index < stages.length; index += 1) {
    if (!attemptedStages.has(index)) claims.push(missingStageClaim(lock, stages[index]!));
  }
  const frozenClaims = Object.freeze(claims);
  const denominator = Object.freeze({
    expectedStages: stages,
    entries: Object.freeze(frozenClaims.map(denominatorEntry)),
  });
  return makeReceipt({
    schemaVersion: 1,
    kind: REFERENCE_RECEIPT_KIND,
    trustLevel: REFERENCE_TRUST_LEVEL,
    implCommitSha: lock.implCommitSha,
    runtimeAnchor: lock.runtimeAnchor,
    stageManifestHash: computeReferenceStageManifestHash(stages),
    rawArtifactRefIds: Object.freeze(lock.rawArtifactRefs.map((ref) => ref.artifactRefId)),
    denominator,
    claims: frozenClaims,
  });
}

export function recomputeReferenceWitnessClaimId(value: ReferenceWitnessClaim): Hash {
  const { claimId: _claimId, ...payload } = value;
  return hashDomain("aloha/reference-witness-claim/v1", payload);
}

export function recomputeReferenceWitnessReceiptId(value: ReferenceWitnessReceipt): Hash {
  const { receiptId: _receiptId, ...payload } = value;
  return hashDomain("aloha/reference-witness-receipt/v1", payload);
}

function nullable<T>(decoder: ExactFieldDecoder<T>): ExactFieldDecoder<T | null> {
  return (value, path) => value === null ? null : decoder(value, path);
}

const statusDecoder: ExactFieldDecoder<ReferenceWitnessStatus> = (value, path) => {
  if (value !== "observed" && value !== "missing" && value !== "invalid") throw new TypeError(`invalid claim status at ${path}`);
  return value;
};
const reasonDecoder: ExactFieldDecoder<ReferenceWitnessReason> = (value, path) => {
  const reasons: readonly ReferenceWitnessReason[] = [
    "observed-raw-record", "missing-artifact", "missing-stage", "invalid-lock", "invalid-artifact-ref",
    "reader-error", "bytes-type-invalid", "bytes-hash-mismatch", "malformed-raw-record", "unknown-stage",
    "impl-sha-mismatch", "runtime-anchor-mismatch", "duplicate-stage", "out-of-order-stage",
  ];
  if (typeof value !== "string" || !reasons.includes(value as ReferenceWitnessReason)) throw new TypeError(`invalid claim reason at ${path}`);
  return value as ReferenceWitnessReason;
};

function decodeClaim(value: unknown, path: string, lock?: Pick<ReferenceWitnessReceipt, "implCommitSha" | "runtimeAnchor">): ReferenceWitnessClaim {
  assertExactKeys(value, [
    "claimId", "trustLevel", "implCommitSha", "runtimeAnchor", "stage", "expectedOrdinal", "status", "reason",
    "rawArtifactRefId", "rawArtifactRef", "rawBytesSha256", "rawByteLength", "untrustedClaims",
  ], path);
  const claim = decodeExactObject<ReferenceWitnessClaim>(value, {
    claimId: hashDecoder,
    trustLevel: (item, itemPath) => item === REFERENCE_TRUST_LEVEL ? REFERENCE_TRUST_LEVEL : (() => { throw new TypeError(`invalid trust level at ${itemPath}`); })(),
    implCommitSha: shaDecoder,
    runtimeAnchor: (item, itemPath) => decodeProcessAnchor(item as object),
    stage: nullable(textDecoder),
    expectedOrdinal: nullable((item, itemPath) => {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) throw new TypeError(`invalid expected ordinal at ${itemPath}`);
      return item;
    }),
    status: statusDecoder,
    reason: reasonDecoder,
    rawArtifactRefId: nullable(hashDecoder),
    rawArtifactRef: nullable((item) => decodeReadOnlyArtifactRef(item as object)),
    rawBytesSha256: nullable(hashDecoder),
    rawByteLength: nullable(decimalDecoder),
    untrustedClaims: nullable((item, itemPath) => decodeFacts(item, itemPath)),
  });
  if (lock && (claim.implCommitSha !== lock.implCommitSha || !canonicalEqual(claim.runtimeAnchor, lock.runtimeAnchor))) {
    throw new TypeError(`claim lock mismatch at ${path}`);
  }
  if (claim.runtimeAnchor.commitSha !== claim.implCommitSha) {
    throw new TypeError(`claim runtime anchor commit mismatch at ${path}`);
  }
  if (claim.rawArtifactRefId !== claim.rawArtifactRef?.artifactRefId) {
    if (claim.rawArtifactRefId !== null || claim.rawArtifactRef !== null) throw new TypeError(`claim raw ref mismatch at ${path}`);
  }
  if (claim.status === "observed" && claim.rawArtifactRef !== null) {
    if (claim.rawBytesSha256 !== claim.rawArtifactRef.contentSha256 || claim.rawByteLength !== claim.rawArtifactRef.byteLength) {
      throw new TypeError(`observed claim bytes are not bound to its raw ref at ${path}`);
    }
  }
  if (claim.status === "observed" && (claim.stage === null || claim.expectedOrdinal === null || claim.rawArtifactRef === null || claim.rawBytesSha256 === null || claim.rawByteLength === null || claim.untrustedClaims === null || claim.reason !== "observed-raw-record")) {
    throw new TypeError(`observed claim is incomplete at ${path}`);
  }
  if (claim.status === "missing" && (claim.untrustedClaims !== null || claim.rawBytesSha256 !== null || claim.rawByteLength !== null || (claim.reason !== "missing-artifact" && claim.reason !== "missing-stage"))) {
    throw new TypeError(`missing claim carries observed bytes/claims at ${path}`);
  }
  if (claim.status === "missing" && claim.reason === "missing-stage" && (claim.stage === null || claim.expectedOrdinal === null || claim.rawArtifactRef !== null)) {
    throw new TypeError(`missing-stage claim has the wrong shape at ${path}`);
  }
  if (claim.status === "missing" && claim.reason === "missing-artifact" && (claim.stage !== null || claim.expectedOrdinal !== null || claim.rawArtifactRef === null)) {
    throw new TypeError(`missing-artifact claim has the wrong shape at ${path}`);
  }
  if (claim.status === "invalid" && claim.untrustedClaims !== null) {
    throw new TypeError(`invalid claim carries decoded producer claims at ${path}`);
  }
  if (claim.status === "invalid" && (claim.reason === "observed-raw-record" || claim.reason === "missing-artifact" || claim.reason === "missing-stage")) {
    throw new TypeError(`invalid claim carries a non-invalid reason at ${path}`);
  }
  if ((claim.rawBytesSha256 === null) !== (claim.rawByteLength === null)) {
    throw new TypeError(`claim raw byte diagnostics are partially present at ${path}`);
  }
  if (claim.claimId !== recomputeReferenceWitnessClaimId(claim)) throw new TypeError(`claimId mismatch at ${path}`);
  return claim;
}

function decodeStage(value: unknown, path: string): ReferenceStageSpec {
  assertExactKeys(value, ["ordinal", "id"], path);
  const stage = decodeExactObject<ReferenceStageSpec>(value, {
    ordinal: (item, itemPath) => {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) throw new TypeError(`invalid stage ordinal at ${itemPath}`);
      return item;
    },
    id: textDecoder,
  });
  return stage;
}

function decodeDenominatorEntry(value: unknown, path: string): ReferenceWitnessDenominatorEntry {
  assertExactKeys(value, ["claimId", "ordinal", "stage", "rawArtifactRefId", "status"], path);
  return decodeExactObject<ReferenceWitnessDenominatorEntry>(value, {
    claimId: hashDecoder,
    ordinal: nullable((item, itemPath) => {
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) throw new TypeError(`invalid denominator ordinal at ${itemPath}`);
      return item;
    }),
    stage: nullable(textDecoder),
    rawArtifactRefId: nullable(hashDecoder),
    status: statusDecoder,
  });
}

/** Decode a previously emitted neutral receipt without accepting any extra authority fields. */
export function decodeReferenceWitnessReceipt(
  value: string | Uint8Array | object,
): ReferenceWitnessReceipt {
  const parsed = typeof value === "string" || ArrayBuffer.isView(value)
    ? decodeCanonicalJson(value as string | Uint8Array)
    : value;
  assertExactKeys(parsed, [
    "schemaVersion", "kind", "receiptId", "trustLevel", "implCommitSha", "runtimeAnchor", "stageManifestHash", "rawArtifactRefIds", "denominator", "claims",
  ], "$");
  const receipt = decodeExactObject<ReferenceWitnessReceipt>(parsed, {
    schemaVersion: (item) => item === 1 ? 1 : (() => { throw new TypeError("unsupported receipt schemaVersion"); })(),
    kind: (item) => item === REFERENCE_RECEIPT_KIND ? REFERENCE_RECEIPT_KIND : (() => { throw new TypeError("unknown receipt kind"); })(),
    receiptId: hashDecoder,
    trustLevel: (item) => item === REFERENCE_TRUST_LEVEL ? REFERENCE_TRUST_LEVEL : (() => { throw new TypeError("invalid receipt trust level"); })(),
    implCommitSha: shaDecoder,
    runtimeAnchor: (item) => decodeProcessAnchor(item as object),
    stageManifestHash: hashDecoder,
    rawArtifactRefIds: (item, path) => {
      if (!Array.isArray(item)) throw new TypeError(`rawArtifactRefIds must be an array at ${path}`);
      return Object.freeze(item.map((entry, index) => hashDecoder(entry, `${path}[${index}]`)));
    },
    denominator: (item, path) => {
      assertExactKeys(item, ["expectedStages", "entries"], path);
      const denominator = decodeExactObject<ReferenceWitnessDenominator>(item, {
        expectedStages: (entries, entriesPath) => {
          if (!Array.isArray(entries)) throw new TypeError(`expectedStages must be an array at ${entriesPath}`);
          return Object.freeze(entries.map((entry, index) => decodeStage(entry, `${entriesPath}[${index}]`)));
        },
        entries: (entries, entriesPath) => {
          if (!Array.isArray(entries)) throw new TypeError(`denominator entries must be an array at ${entriesPath}`);
          return Object.freeze(entries.map((entry, index) => decodeDenominatorEntry(entry, `${entriesPath}[${index}]`)));
        },
      });
      return denominator;
    },
    claims: (item, path) => {
      if (!Array.isArray(item)) throw new TypeError(`claims must be an array at ${path}`);
      return Object.freeze(item.map((entry, index) => decodeClaim(entry, `${path}[${index}]`)));
    },
  });
  if (receipt.implCommitSha !== CALIBRATION_REFERENCE_IMPL_SHA) {
    throw new TypeError(`receipt implCommitSha must pin ${CALIBRATION_REFERENCE_IMPL_SHA}`);
  }
  const lockedClaims = receipt.claims.map((claim, index) => decodeClaim(claim, `$.claims[${index}]`, receipt));
  const normalized = { ...receipt, claims: Object.freeze(lockedClaims) } as ReferenceWitnessReceipt;
  if (normalized.runtimeAnchor.commitSha !== normalized.implCommitSha) {
    throw new TypeError("receipt runtime anchor commit does not match implCommitSha");
  }
  const stages = normalizeStages(normalized.denominator.expectedStages);
  if (!canonicalEqual(stages, CALIBRATION_REFERENCE_STAGE_MANIFEST)) {
    throw new TypeError("receipt stage manifest must exactly match startup→ready calibration stages");
  }
  if (!canonicalEqual(stages, normalized.denominator.expectedStages)) {
    throw new TypeError("receipt denominator stages are not strictly ordered");
  }
  if (normalized.stageManifestHash !== computeReferenceStageManifestHash(stages)) {
    throw new TypeError("receipt stage manifest hash does not match denominator stages");
  }
  const claimEntries = normalized.claims.map(denominatorEntry);
  if (!canonicalEqual(claimEntries, normalized.denominator.entries)) {
    throw new TypeError("receipt denominator does not cover every claim exactly");
  }
  const rawClaimIds = normalized.claims
    .filter((claim) => claim.rawArtifactRef !== null)
    .map((claim) => claim.rawArtifactRefId as Hash);
  if (new Set(rawClaimIds).size !== rawClaimIds.length || !canonicalEqual(rawClaimIds, normalized.rawArtifactRefIds)) {
    throw new TypeError("receipt raw artifact refs are not bound to claims in exact order");
  }
  const expectedOrdinals = new Map(stages.map((stage) => [stage.id, stage.ordinal]));
  let previousAttemptOrdinal: number | null = null;
  for (const claim of normalized.claims) {
    const expectedOrdinal = claim.stage === null ? undefined : expectedOrdinals.get(claim.stage);
    if (claim.rawArtifactRef !== null && expectedOrdinal !== undefined) {
      const decreased = previousAttemptOrdinal !== null && expectedOrdinal < previousAttemptOrdinal;
      const isOutOfOrder = claim.status === "invalid" && claim.reason === "out-of-order-stage";
      if (claim.status === "observed" && decreased) {
        throw new TypeError("observed claim is out of importer stage order");
      }
      if (isOutOfOrder && !decreased) {
        throw new TypeError("out-of-order claim does not match importer stage order");
      }
      previousAttemptOrdinal = expectedOrdinal;
    }
    if (claim.status === "observed") {
      if (expectedOrdinal === undefined || claim.expectedOrdinal !== expectedOrdinal) {
        throw new TypeError("observed claim stage is not in the locked denominator");
      }
      if (claim.reason !== "observed-raw-record") {
        throw new TypeError("observed claim has a non-observation reason");
      }
      continue;
    }
    if (claim.reason === "unknown-stage") {
      if (claim.status !== "invalid" || claim.stage === null || expectedOrdinal !== undefined || claim.expectedOrdinal !== null) {
        throw new TypeError("unknown-stage claim has the wrong invalid shape");
      }
      continue;
    }
    if (claim.reason === "out-of-order-stage") {
      if (claim.status !== "invalid" || claim.rawArtifactRef === null || expectedOrdinal === undefined || claim.expectedOrdinal !== expectedOrdinal) {
        throw new TypeError("out-of-order claim has the wrong invalid shape");
      }
      continue;
    }
    if (claim.stage !== null && (expectedOrdinal === undefined || claim.expectedOrdinal !== expectedOrdinal)) {
      throw new TypeError("known claim stage is not bound to its locked ordinal");
    }
    if (claim.stage === null && claim.expectedOrdinal !== null) {
      throw new TypeError("unstaged claim carries an ordinal");
    }
  }
  for (const stage of stages) {
    const stageClaims = normalized.claims.filter((claim) => claim.stage === stage.id && claim.expectedOrdinal === stage.ordinal);
    const observed = stageClaims.filter((claim) => claim.status === "observed");
    const invalid = stageClaims.filter((claim) => claim.status === "invalid");
    const missing = stageClaims.filter((claim) => claim.status === "missing" && claim.rawArtifactRef === null);
    const closedAsObserved = observed.length === 1 && invalid.length === 0 && missing.length === 0;
    const closedAsInvalid = observed.length === 0 && invalid.length > 0 && missing.length === 0;
    const closedAsMissing = observed.length === 0 && invalid.length === 0 && missing.length === 1;
    if (!closedAsObserved && !closedAsInvalid && !closedAsMissing) {
      throw new TypeError(`receipt denominator does not close expected stage ${stage.id}`);
    }
  }
  if (receipt.receiptId !== recomputeReferenceWitnessReceiptId(normalized)) throw new TypeError("receiptId mismatch");
  return deepFreeze(normalized);
}

export function encodeReferenceWitnessReceipt(value: ReferenceWitnessReceipt): Uint8Array {
  return encodeCanonicalBytes(decodeReferenceWitnessReceipt(value));
}
