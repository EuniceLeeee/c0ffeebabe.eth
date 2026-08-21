import { randomUUID } from "node:crypto";
import {
  CanonicalSource,
  type CanonicalSourceView,
  type BlockNumber,
} from "../../canonical-source/src/index.ts";
import {
  CASConflictError,
  CorruptDurableStoreError,
  SQLiteDurableStore,
  type DurableRootRecord,
  type DurableTransaction,
  type WriterLease,
} from "../../durable-store/src/index.ts";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const CHECKPOINT_ROOT_KIND = "aloha/checkpoint-root/v1";
const RUN_KIND = "aloha/in-progress-run/v1";
const CANDIDATE_PARTITION_KIND = "aloha/candidate-partition/v1";
const CANDIDATE_RECORD_KIND = "aloha/candidate-record/v1";
const OUTCOMES_PARTITION_KIND = "aloha/outcomes-partition/v1";
const OUTCOME_KIND = "aloha/run-outcome/v1";
const READY_KIND = "aloha/ready-generation/v1";
const DIAGNOSTIC_KIND = "aloha/run-diagnostic/v1";
const EMPTY_MEMO_KIND = "aloha/verified-memo-root/v1";

export const CHECKPOINT_SCHEMA_HASH = hashDomain(
  "aloha/checkpoint-schema/v1",
  {
    root: CHECKPOINT_ROOT_KIND,
    run: RUN_KIND,
    candidate: CANDIDATE_RECORD_KIND,
    outcome: OUTCOME_KIND,
    ready: READY_KIND,
  },
);

export type U64String = string;

export interface CanonicalCutoff {
  readonly number: BlockNumber;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface BlockRange {
  readonly from: BlockNumber;
  readonly to: BlockNumber;
}

export interface CheckpointRootV1 {
  readonly revision: U64String;
  readonly verifiedMemoRoot: Hash;
  readonly inProgressRunId: string | null;
  readonly latestMemoSeedReceiptHash: Hash | null;
  readonly readyGenerationId: string | null;
  readonly readyGenerationRecordHash: Hash | null;
  readonly schemaHash: Hash;
}

export interface CandidateRecordV1 {
  readonly runCandidateKey: string;
  readonly familyCandidateKey: string;
  readonly familyId: string;
  readonly instanceNominationKey: string;
  readonly candidateSnapshot: CanonicalJson;
  readonly evidenceRefs: readonly Hash[];
}

export interface CandidateRecordInput {
  readonly familyCandidateKey: string;
  readonly familyId: string;
  readonly instanceNominationKey: string;
  readonly candidateSnapshot: CanonicalJson;
  readonly evidenceRefs?: readonly Hash[];
  readonly runCandidateKey?: string;
}

export type OutcomeStatus =
  | "partial"
  | "verified"
  | "chainProvenRejected"
  | "retryable"
  | "invalidProgram";

export interface CompactOutcomeV1 {
  readonly runCandidateKey: string;
  readonly status: OutcomeStatus;
  readonly terminal: boolean;
  readonly stage: string;
  readonly attemptCount: U64String;
  readonly failureCode: string | null;
  readonly candidateSnapshot: CanonicalJson | null;
  readonly evidenceRefs: readonly Hash[];
  readonly payload: CanonicalJson;
}

export interface StoredOutcome extends CompactOutcomeV1 {
  readonly contentHash: Hash;
}

export interface AccountingV1 {
  readonly pending: U64String;
  readonly verified: U64String;
  readonly chainProvenRejected: U64String;
  readonly retryable: U64String;
  readonly invalidProgram: U64String;
}

export interface InProgressRunV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoff;
  readonly recentObservationRange: BlockRange;
  readonly candidateSetHash: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly candidateRecordCount: U64String;
  readonly sourceCoverageRoot: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly outcomesRoot: Hash;
  readonly accounting: AccountingV1;
}

export interface SealedMemoSeedReceiptV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoff;
  readonly definitionCatalogRoot: Hash;
  readonly coreEnvelopeSchemaHash: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  readonly carriedVerifiedMemoRoot: Hash;
  readonly reason: "cutoff-too-old-for-serving";
  readonly sealedRevision: U64String;
}

export interface LoadedRun extends InProgressRunV1 {
  readonly candidates: readonly CandidateRecordV1[];
  readonly outcomes: ReadonlyMap<string, StoredOutcome>;
  readonly contentHash: Hash;
}

export interface ReadyGenerationV1 {
  readonly generationId: string;
  readonly parentGenerationId: string | null;
  readonly generationRefreshPolicyHash: Hash;
  readonly cutoff: CanonicalCutoff;
  readonly recentObservationRange: BlockRange;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly edgeCount: U64String;
  readonly instanceCount: U64String;
  readonly promotionRevision: U64String;
  readonly promotedAtMonotonicNs: U64String;
}

export interface BeginRunRequest {
  readonly runId?: string;
  readonly cutoff: CanonicalCutoff;
  readonly recentObservationRange?: BlockRange;
  readonly candidates: readonly CandidateRecordInput[];
  readonly sourceCoverageRoot?: Hash;
  readonly definitionCatalogRoot?: Hash;
}

export interface OutcomeWriterOptions {
  readonly writerId?: string;
  readonly flushEveryItems?: number;
  readonly flushEveryMs?: number;
  readonly mailboxCapacity?: number;
}

export interface SignalHookPort {
  on(signal: "SIGTERM" | "SIGINT", handler: () => void): void;
  off?(signal: "SIGTERM" | "SIGINT", handler: () => void): void;
}

export class CheckpointError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

export class CheckpointRunStateError extends CheckpointError {
  constructor(message: string) {
    super("run-state", message);
    this.name = "CheckpointRunStateError";
  }
}

export class OutcomeWriterClosedError extends CheckpointError {
  constructor() {
    super("writer-closed", "checkpoint outcome writer is closed");
    this.name = "OutcomeWriterClosedError";
  }
}

export class OutcomeStateConflictError extends CheckpointError {
  constructor(message: string) {
    super("outcome-state-conflict", message);
    this.name = "OutcomeStateConflictError";
  }
}

export class PromotionRejectedError extends CheckpointError {
  constructor(message: string) {
    super("promotion-rejected", message);
    this.name = "PromotionRejectedError";
  }
}

function assertHash(value: unknown, context: string): Hash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new CorruptDurableStoreError(`invalid checkpoint hash at ${context}`);
  }
  return value as Hash;
}

function assertString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CorruptDurableStoreError(`invalid checkpoint string at ${context}`);
  }
  return value;
}

function assertDecimal(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CorruptDurableStoreError(`invalid checkpoint decimal at ${context}`);
  }
  return value;
}

function assertJson(value: unknown, context: string): CanonicalJson {
  try {
    return decodeCanonicalJson(encodeCanonicalJson(value));
  } catch (error) {
    throw new CorruptDurableStoreError(
      `invalid canonical JSON at ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CorruptDurableStoreError(`expected object at ${context}`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new CorruptDurableStoreError(`unexpected fields at ${context}`);
  }
}

function readNullableHash(value: unknown, context: string): Hash | null {
  return value === null ? null : assertHash(value, context);
}

function readStringArray(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) throw new CorruptDurableStoreError(`expected array at ${context}`);
  return Object.freeze(value.map((item, index) => assertString(item, `${context}[${index}]`)));
}

function readHashArray(value: unknown, context: string): readonly Hash[] {
  return Object.freeze(readStringArray(value, context).map((item, index) =>
    assertHash(item, `${context}[${index}]`)));
}

function readCutoff(value: unknown, context: string): CanonicalCutoff {
  const object = objectValue(value, context);
  exactKeys(object, ["number", "hash", "stateRoot"], context);
  return Object.freeze({
    number: assertDecimal(object.number, `${context}.number`) as BlockNumber,
    hash: assertHash(object.hash, `${context}.hash`),
    stateRoot: assertHash(object.stateRoot, `${context}.stateRoot`),
  });
}

function readRange(value: unknown, context: string): BlockRange {
  const object = objectValue(value, context);
  exactKeys(object, ["from", "to"], context);
  const from = assertDecimal(object.from, `${context}.from`);
  const to = assertDecimal(object.to, `${context}.to`);
  if (BigInt(from) > BigInt(to)) throw new CorruptDurableStoreError(`range is inverted at ${context}`);
  return Object.freeze({ from, to });
}

function readAccounting(value: unknown, context: string): AccountingV1 {
  const object = objectValue(value, context);
  exactKeys(object, ["pending", "verified", "chainProvenRejected", "retryable", "invalidProgram"], context);
  return Object.freeze({
    pending: assertDecimal(object.pending, `${context}.pending`),
    verified: assertDecimal(object.verified, `${context}.verified`),
    chainProvenRejected: assertDecimal(object.chainProvenRejected, `${context}.chainProvenRejected`),
    retryable: assertDecimal(object.retryable, `${context}.retryable`),
    invalidProgram: assertDecimal(object.invalidProgram, `${context}.invalidProgram`),
  });
}

function encodeRoot(root: CheckpointRootV1): Uint8Array {
  return encodeCanonicalBytes(root);
}

function decodeRoot(bytes: Uint8Array): CheckpointRootV1 {
  const object = objectValue(decodeCanonicalJson(bytes), "checkpoint root");
  exactKeys(object, [
    "revision",
    "verifiedMemoRoot",
    "inProgressRunId",
    "latestMemoSeedReceiptHash",
    "readyGenerationId",
    "readyGenerationRecordHash",
    "schemaHash",
  ], "checkpoint root");
  const root = {
    revision: assertDecimal(object.revision, "root.revision"),
    verifiedMemoRoot: assertHash(object.verifiedMemoRoot, "root.verifiedMemoRoot"),
    inProgressRunId: object.inProgressRunId === null ? null : assertString(object.inProgressRunId, "root.inProgressRunId"),
    latestMemoSeedReceiptHash: readNullableHash(object.latestMemoSeedReceiptHash, "root.latestMemoSeedReceiptHash"),
    readyGenerationId: object.readyGenerationId === null ? null : assertString(object.readyGenerationId, "root.readyGenerationId"),
    readyGenerationRecordHash: readNullableHash(object.readyGenerationRecordHash, "root.readyGenerationRecordHash"),
    schemaHash: assertHash(object.schemaHash, "root.schemaHash"),
  } satisfies CheckpointRootV1;
  if (root.schemaHash !== CHECKPOINT_SCHEMA_HASH) {
    throw new CorruptDurableStoreError("checkpoint schema hash mismatch");
  }
  return Object.freeze(root);
}

function encodeCandidate(candidate: CandidateRecordV1): Uint8Array {
  return encodeCanonicalBytes({
    runCandidateKey: candidate.runCandidateKey,
    familyCandidateKey: candidate.familyCandidateKey,
    familyId: candidate.familyId,
    instanceNominationKey: candidate.instanceNominationKey,
    candidateSnapshot: candidate.candidateSnapshot,
    evidenceRefs: candidate.evidenceRefs,
  });
}

function decodeCandidate(bytes: Uint8Array): CandidateRecordV1 {
  const object = objectValue(decodeCanonicalJson(bytes), "candidate record");
  exactKeys(object, [
    "runCandidateKey",
    "familyCandidateKey",
    "familyId",
    "instanceNominationKey",
    "candidateSnapshot",
    "evidenceRefs",
  ], "candidate record");
  return Object.freeze({
    runCandidateKey: assertString(object.runCandidateKey, "candidate.runCandidateKey"),
    familyCandidateKey: assertString(object.familyCandidateKey, "candidate.familyCandidateKey"),
    familyId: assertString(object.familyId, "candidate.familyId"),
    instanceNominationKey: assertString(object.instanceNominationKey, "candidate.instanceNominationKey"),
    candidateSnapshot: assertJson(object.candidateSnapshot, "candidate.candidateSnapshot"),
    evidenceRefs: readHashArray(object.evidenceRefs, "candidate.evidenceRefs"),
  });
}

function outcomeTerminal(status: OutcomeStatus): boolean {
  return status === "verified" || status === "chainProvenRejected" || status === "invalidProgram";
}

function encodeOutcome(outcome: CompactOutcomeV1): Uint8Array {
  return encodeCanonicalBytes(outcome);
}

function decodeOutcome(bytes: Uint8Array): CompactOutcomeV1 {
  const object = objectValue(decodeCanonicalJson(bytes), "run outcome");
  exactKeys(object, [
    "runCandidateKey",
    "status",
    "terminal",
    "stage",
    "attemptCount",
    "failureCode",
    "candidateSnapshot",
    "evidenceRefs",
    "payload",
  ], "run outcome");
  const status = object.status;
  if (
    status !== "partial" && status !== "verified" && status !== "chainProvenRejected" &&
    status !== "retryable" && status !== "invalidProgram"
  ) throw new CorruptDurableStoreError("unknown run outcome status");
  if (object.terminal !== outcomeTerminal(status)) {
    throw new CorruptDurableStoreError("run outcome terminal flag is inconsistent");
  }
  return Object.freeze({
    runCandidateKey: assertString(object.runCandidateKey, "outcome.runCandidateKey"),
    status,
    terminal: outcomeTerminal(status),
    stage: assertString(object.stage, "outcome.stage"),
    attemptCount: assertDecimal(object.attemptCount, "outcome.attemptCount"),
    failureCode: object.failureCode === null ? null : assertString(object.failureCode, "outcome.failureCode"),
    candidateSnapshot: object.candidateSnapshot === null ? null : assertJson(object.candidateSnapshot, "outcome.candidateSnapshot"),
    evidenceRefs: readHashArray(object.evidenceRefs, "outcome.evidenceRefs"),
    payload: assertJson(object.payload, "outcome.payload"),
  });
}

function encodePartition(
  runId: string,
  entries: readonly { readonly key: string; readonly contentHash: Hash }[],
): Uint8Array {
  return encodeCanonicalBytes({
    runId,
    entries: entries.map((entry) => ({ key: entry.key, contentHash: entry.contentHash })),
  });
}

function decodePartition(bytes: Uint8Array, runId: string, context: string): readonly { key: string; contentHash: Hash }[] {
  const object = objectValue(decodeCanonicalJson(bytes), context);
  exactKeys(object, ["runId", "entries"], context);
  if (object.runId !== runId || !Array.isArray(object.entries)) {
    throw new CorruptDurableStoreError(`partition run mismatch at ${context}`);
  }
  const entries: { key: string; contentHash: Hash }[] = [];
  let previous = "";
  for (const [index, item] of object.entries.entries()) {
    const entry = objectValue(item, `${context}.entries[${index}]`);
    exactKeys(entry, ["key", "contentHash"], `${context}.entries[${index}]`);
    const key = assertString(entry.key, `${context}.entries[${index}].key`);
    if (index > 0 && key <= previous) {
      throw new CorruptDurableStoreError(`partition keys are not strictly ordered at ${context}`);
    }
    previous = key;
    entries.push({ key, contentHash: assertHash(entry.contentHash, `${context}.entries[${index}].contentHash`) });
  }
  return Object.freeze(entries);
}

function encodeRun(run: InProgressRunV1): Uint8Array {
  return encodeCanonicalBytes(run);
}

function decodeRun(bytes: Uint8Array): InProgressRunV1 {
  const object = objectValue(decodeCanonicalJson(bytes), "in-progress run");
  exactKeys(object, [
    "runId",
    "cutoff",
    "recentObservationRange",
    "candidateSetHash",
    "candidatePartitionRoot",
    "candidateRecordCount",
    "sourceCoverageRoot",
    "definitionCatalogRoot",
    "outcomesRoot",
    "accounting",
  ], "in-progress run");
  return Object.freeze({
    runId: assertString(object.runId, "run.runId"),
    cutoff: readCutoff(object.cutoff, "run.cutoff"),
    recentObservationRange: readRange(object.recentObservationRange, "run.recentObservationRange"),
    candidateSetHash: assertHash(object.candidateSetHash, "run.candidateSetHash"),
    candidatePartitionRoot: assertHash(object.candidatePartitionRoot, "run.candidatePartitionRoot"),
    candidateRecordCount: assertDecimal(object.candidateRecordCount, "run.candidateRecordCount"),
    sourceCoverageRoot: assertHash(object.sourceCoverageRoot, "run.sourceCoverageRoot"),
    definitionCatalogRoot: assertHash(object.definitionCatalogRoot, "run.definitionCatalogRoot"),
    outcomesRoot: assertHash(object.outcomesRoot, "run.outcomesRoot"),
    accounting: readAccounting(object.accounting, "run.accounting"),
  });
}

function encodeReady(ready: ReadyGenerationV1): Uint8Array {
  return encodeCanonicalBytes(ready);
}

function decodeReady(bytes: Uint8Array): ReadyGenerationV1 {
  const object = objectValue(decodeCanonicalJson(bytes), "ready generation");
  exactKeys(object, [
    "generationId",
    "parentGenerationId",
    "generationRefreshPolicyHash",
    "cutoff",
    "recentObservationRange",
    "definitionCatalogRoot",
    "sourceCoverageRoot",
    "candidatePartitionRoot",
    "verifiedMemoSetRoot",
    "instanceCatalogRoot",
    "graphRoot",
    "edgeCount",
    "instanceCount",
    "promotionRevision",
    "promotedAtMonotonicNs",
  ], "ready generation");
  return Object.freeze({
    generationId: assertString(object.generationId, "ready.generationId"),
    parentGenerationId: object.parentGenerationId === null ? null : assertString(object.parentGenerationId, "ready.parentGenerationId"),
    generationRefreshPolicyHash: assertHash(object.generationRefreshPolicyHash, "ready.generationRefreshPolicyHash"),
    cutoff: readCutoff(object.cutoff, "ready.cutoff"),
    recentObservationRange: readRange(object.recentObservationRange, "ready.recentObservationRange"),
    definitionCatalogRoot: assertHash(object.definitionCatalogRoot, "ready.definitionCatalogRoot"),
    sourceCoverageRoot: assertHash(object.sourceCoverageRoot, "ready.sourceCoverageRoot"),
    candidatePartitionRoot: assertHash(object.candidatePartitionRoot, "ready.candidatePartitionRoot"),
    verifiedMemoSetRoot: assertHash(object.verifiedMemoSetRoot, "ready.verifiedMemoSetRoot"),
    instanceCatalogRoot: assertHash(object.instanceCatalogRoot, "ready.instanceCatalogRoot"),
    graphRoot: assertHash(object.graphRoot, "ready.graphRoot"),
    edgeCount: assertDecimal(object.edgeCount, "ready.edgeCount"),
    instanceCount: assertDecimal(object.instanceCount, "ready.instanceCount"),
    promotionRevision: assertDecimal(object.promotionRevision, "ready.promotionRevision"),
    promotedAtMonotonicNs: assertDecimal(object.promotedAtMonotonicNs, "ready.promotedAtMonotonicNs"),
  });
}

function rootFromRecord(record: DurableRootRecord): CheckpointRootV1 {
  return decodeRoot(record.envelopeBytes);
}

function sortedEntries(map: ReadonlyMap<string, Hash>): readonly { key: string; contentHash: Hash }[] {
  return Object.freeze([...map.entries()]
    .map(([key, contentHash]) => ({ key, contentHash }))
    .sort((left, right) => left.key.localeCompare(right.key)));
}

function countAccounting(
  candidateCount: bigint,
  outcomes: ReadonlyMap<string, CompactOutcomeV1>,
): AccountingV1 {
  let verified = 0n;
  let chainProvenRejected = 0n;
  let retryable = 0n;
  let invalidProgram = 0n;
  let partial = 0n;
  for (const outcome of outcomes.values()) {
    if (outcome.status === "verified") verified += 1n;
    else if (outcome.status === "chainProvenRejected") chainProvenRejected += 1n;
    else if (outcome.status === "retryable") retryable += 1n;
    else if (outcome.status === "invalidProgram") invalidProgram += 1n;
    else partial += 1n;
  }
  const pending = candidateCount - BigInt(outcomes.size) + partial;
  return Object.freeze({
    pending: (pending < 0n ? 0n : pending).toString(),
    verified: verified.toString(),
    chainProvenRejected: chainProvenRejected.toString(),
    retryable: retryable.toString(),
    invalidProgram: invalidProgram.toString(),
  });
}

function defaultRange(cutoff: CanonicalCutoff): BlockRange {
  const number = BigInt(cutoff.number);
  return Object.freeze({
    from: (number >= 49n ? number - 49n : 0n).toString(),
    to: cutoff.number,
  });
}

function readRootFromTx(tx: DurableTransaction): CheckpointRootV1 {
  const root = tx.readRoot();
  if (!root) throw new CorruptDurableStoreError("checkpoint root does not exist");
  return rootFromRecord(root);
}

function verifyContent(
  store: SQLiteDurableStore,
  hash: Hash,
  kind: string,
  context: string,
): Uint8Array {
  const content = store.readContent(hash);
  if (!content) throw new CorruptDurableStoreError(`${context} points at missing content ${hash}`);
  if (content.kind !== kind) throw new CorruptDurableStoreError(`${context} kind mismatch for ${hash}`);
  return content.bytes;
}

function requireContentTx(
  tx: DurableTransaction,
  hash: Hash,
  context: string,
): void {
  if (!tx.readContent(hash)) throw new CorruptDurableStoreError(`${context} points at missing content ${hash}`);
}

function candidateSetHash(entries: readonly { key: string; contentHash: Hash }[]): Hash {
  return hashDomain("aloha/candidate-set/v1", entries.map((entry) => ({
    key: entry.key,
    contentHash: entry.contentHash,
  })));
}

function assertOutcomeTransition(
  previous: CompactOutcomeV1 | null,
  next: CompactOutcomeV1,
): void {
  if (previous === null) return;
  if (previous.runCandidateKey !== next.runCandidateKey) {
    throw new OutcomeStateConflictError("outcome key changed");
  }
  if (previous.terminal) {
    if (encodeCanonicalJson(previous) !== encodeCanonicalJson(next)) {
      throw new OutcomeStateConflictError(`terminal outcome ${next.runCandidateKey} cannot be replaced`);
    }
    return;
  }
  if (previous.status === "retryable" && next.status === "retryable" &&
      BigInt(next.attemptCount) < BigInt(previous.attemptCount)) {
    throw new OutcomeStateConflictError("retryable attempt count regressed");
  }
}

function normalizeOutcome(input: CompactOutcomeInput): CompactOutcomeV1 {
  const status = input.status;
  if (
    status !== "partial" && status !== "verified" && status !== "chainProvenRejected" &&
    status !== "retryable" && status !== "invalidProgram"
  ) throw new CheckpointError("invalid-outcome", "unknown checkpoint outcome status");
  const attemptCount = input.attemptCount ?? "0";
  assertDecimal(attemptCount, "outcome.attemptCount");
  const outcome = {
    runCandidateKey: assertString(input.runCandidateKey, "outcome.runCandidateKey"),
    status,
    terminal: outcomeTerminal(status),
    stage: assertString(input.stage, "outcome.stage"),
    attemptCount,
    failureCode: input.failureCode ?? null,
    candidateSnapshot: input.candidateSnapshot ?? null,
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])].map((hash) => assertHash(hash, "outcome.evidenceRefs"))),
    payload: input.payload ?? null,
  } satisfies CompactOutcomeV1;
  if (outcome.failureCode !== null) assertString(outcome.failureCode, "outcome.failureCode");
  assertJson(outcome.candidateSnapshot, "outcome.candidateSnapshot");
  assertJson(outcome.payload, "outcome.payload");
  return Object.freeze(outcome);
}

export interface CompactOutcomeInput {
  readonly runCandidateKey: string;
  readonly status: OutcomeStatus;
  readonly stage: string;
  readonly attemptCount?: U64String;
  readonly failureCode?: string | null;
  readonly candidateSnapshot?: CanonicalJson | null;
  readonly evidenceRefs?: readonly Hash[];
  readonly payload?: CanonicalJson;
}

function loadOutcomeMap(
  store: SQLiteDurableStore,
  runId: string,
  root: Hash,
): ReadonlyMap<string, StoredOutcome> {
  const bytes = verifyContent(store, root, OUTCOMES_PARTITION_KIND, `run ${runId} outcomes`);
  const entries = decodePartition(bytes, runId, "outcomes partition");
  const outcomes = new Map<string, StoredOutcome>();
  for (const entry of entries) {
    if (outcomes.has(entry.key)) throw new CorruptDurableStoreError(`duplicate outcome key ${entry.key}`);
    const content = store.readContent(entry.contentHash);
    if (!content || content.kind !== OUTCOME_KIND) {
      throw new CorruptDurableStoreError(`outcome partition points at missing content ${entry.contentHash}`);
    }
    const outcome = decodeOutcome(content.bytes);
    if (outcome.runCandidateKey !== entry.key) throw new CorruptDurableStoreError(`outcome key mismatch ${entry.key}`);
    outcomes.set(entry.key, Object.freeze({ ...outcome, contentHash: entry.contentHash }));
  }
  return outcomes;
}

export class CheckpointStore {
  readonly durableStore: SQLiteDurableStore;
  readonly canonicalSource?: CanonicalSource;

  constructor(
    durableStore: SQLiteDurableStore,
    canonicalSource?: CanonicalSource,
  ) {
    this.durableStore = durableStore;
    this.canonicalSource = canonicalSource;
  }

  /** Create the single logical root atomically on first open. */
  ensureRoot(): CheckpointRootV1 {
    const existing = this.durableStore.readRoot();
    if (existing) return this.validateRoot(existing);
    const owner = `checkpoint-init/${randomUUID()}`;
    const lease = this.durableStore.acquireWriterLease(owner);
    try {
      return this.durableStore.transaction(lease, (tx) => {
        const raced = tx.readRoot();
        if (raced) return this.validateRoot(raced);
        const memoBytes = encodeCanonicalBytes({ version: 1, memos: [] });
        const memoHash = tx.putImmutable(EMPTY_MEMO_KIND, memoBytes);
        const root: CheckpointRootV1 = Object.freeze({
          revision: "1",
          verifiedMemoRoot: memoHash,
          inProgressRunId: null,
          latestMemoSeedReceiptHash: null,
          readyGenerationId: null,
          readyGenerationRecordHash: null,
          schemaHash: CHECKPOINT_SCHEMA_HASH,
        });
        const committed = tx.compareAndSwapRoot("0", encodeRoot(root), [memoHash]);
        return rootFromRecord(committed);
      });
    } finally {
      this.durableStore.releaseWriterLease(lease);
    }
  }

  loadRoot(): CheckpointRootV1 {
    const root = this.durableStore.readRoot();
    return root ? this.validateRoot(root) : this.ensureRoot();
  }

  validateRoot(record = this.durableStore.readRoot()): CheckpointRootV1 {
    if (!record) throw new CorruptDurableStoreError("checkpoint root is missing");
    const root = rootFromRecord(record);
    if (root.revision !== record.revision) {
      throw new CorruptDurableStoreError("root envelope revision differs from SQLite revision");
    }
    verifyContent(this.durableStore, root.verifiedMemoRoot, EMPTY_MEMO_KIND, "verified memo root");
    if (!record.references.includes(root.verifiedMemoRoot)) {
      throw new CorruptDurableStoreError("checkpoint root does not retain its memo root");
    }
    if (root.inProgressRunId !== null) {
      const runHash = this.durableStore.readIndex("run", root.inProgressRunId);
      if (!runHash) throw new CorruptDurableStoreError(`active run index missing for ${root.inProgressRunId}`);
      if (!record.references.includes(runHash)) throw new CorruptDurableStoreError("checkpoint root does not retain active run");
      verifyContent(this.durableStore, runHash, RUN_KIND, "active run");
    }
    if (root.readyGenerationRecordHash !== null) {
      if (!record.references.includes(root.readyGenerationRecordHash)) throw new CorruptDurableStoreError("checkpoint root does not retain ready generation");
      decodeReady(verifyContent(this.durableStore, root.readyGenerationRecordHash, READY_KIND, "ready generation"));
    }
    return root;
  }

  putImmutableContent(kind: string, bytes: Uint8Array, references: readonly Hash[] = []): Hash {
    return this.durableStore.putImmutableContent(kind, bytes, references);
  }

  beginNewRun(request: BeginRunRequest): InProgressRunV1 {
    this.ensureRoot();
    const runId = request.runId ?? randomUUID();
    assertString(runId, "runId");
    const cutoff = readCutoff(request.cutoff, "begin.cutoff");
    const range = request.recentObservationRange ?? defaultRange(cutoff);
    readRange(range, "begin.recentObservationRange");
    const candidates = this.normalizeCandidates(runId, request.candidates);
    const sourceCoverageRoot = request.sourceCoverageRoot ?? this.putEmptyRoot("coverage");
    const definitionCatalogRoot = request.definitionCatalogRoot ?? this.putEmptyRoot("definition-catalog");
    assertHash(sourceCoverageRoot, "sourceCoverageRoot");
    assertHash(definitionCatalogRoot, "definitionCatalogRoot");
    const owner = `checkpoint-run/${runId}/${randomUUID()}`;
    const lease = this.durableStore.acquireWriterLease(owner);
    try {
      return this.durableStore.transaction(lease, (tx) => {
        const root = readRootFromTx(tx);
        if (root.inProgressRunId !== null) {
          throw new CheckpointRunStateError(`in-progress run ${root.inProgressRunId} already exists`);
        }
        if (tx.getIndex("run", runId) !== null) {
          throw new CheckpointRunStateError(`run id ${runId} already exists`);
        }
        requireContentTx(tx, sourceCoverageRoot, "source coverage root");
        requireContentTx(tx, definitionCatalogRoot, "definition catalog root");
        const candidateHashes = new Map<string, Hash>();
        for (const candidate of candidates) {
          const hash = tx.putImmutable(CANDIDATE_RECORD_KIND, encodeCandidate(candidate));
          candidateHashes.set(candidate.runCandidateKey, hash);
        }
        const candidateEntries = sortedEntries(candidateHashes);
        const candidatePartitionRoot = tx.putImmutable(
          CANDIDATE_PARTITION_KIND,
          encodePartition(runId, candidateEntries),
          candidateEntries.map((entry) => entry.contentHash),
        );
        const outcomesRoot = tx.putImmutable(
          OUTCOMES_PARTITION_KIND,
          encodePartition(runId, []),
        );
        const run: InProgressRunV1 = Object.freeze({
          runId,
          cutoff,
          recentObservationRange: range,
          candidateSetHash: candidateSetHash(candidateEntries),
          candidatePartitionRoot,
          candidateRecordCount: String(candidates.length),
          sourceCoverageRoot,
          definitionCatalogRoot,
          outcomesRoot,
          accounting: countAccounting(BigInt(candidates.length), new Map()),
        });
        const runHash = tx.putImmutable(
          RUN_KIND,
          encodeRun(run),
          [candidatePartitionRoot, outcomesRoot, sourceCoverageRoot, definitionCatalogRoot],
        );
        tx.setIndex("run", runId, runHash);
        const nextRoot: CheckpointRootV1 = Object.freeze({
          ...root,
          revision: (BigInt(root.revision) + 1n).toString(),
          inProgressRunId: runId,
          readyGenerationId: null,
          readyGenerationRecordHash: null,
        });
        tx.compareAndSwapRoot(root.revision, encodeRoot(nextRoot), [root.verifiedMemoRoot, runHash]);
        return run;
      });
    } finally {
      this.durableStore.releaseWriterLease(lease);
    }
  }

  loadRun(runId: string): LoadedRun {
    assertString(runId, "runId");
    const runHash = this.durableStore.readIndex("run", runId);
    if (!runHash) throw new CheckpointRunStateError(`run ${runId} is not recoverable`);
    const runContent = this.durableStore.readContent(runHash);
    if (!runContent || runContent.kind !== RUN_KIND) throw new CorruptDurableStoreError(`run ${runId} record missing`);
    const run = decodeRun(runContent.bytes);
    if (run.runId !== runId) throw new CorruptDurableStoreError(`run index key mismatch for ${runId}`);
    const candidates = this.loadCandidates(runId, run.candidatePartitionRoot);
    const outcomes = loadOutcomeMap(this.durableStore, runId, run.outcomesRoot);
    if (BigInt(run.candidateRecordCount) !== BigInt(candidates.length)) {
      throw new CorruptDurableStoreError(`candidate count mismatch for ${runId}`);
    }
    if (candidateSetHash(this.partitionEntries(runId, run.candidatePartitionRoot)) !== run.candidateSetHash) {
      throw new CorruptDurableStoreError(`candidate set hash mismatch for ${runId}`);
    }
    const recomputed = countAccounting(BigInt(candidates.length), new Map(
      [...outcomes.entries()].map(([key, outcome]) => [key, outcome] as const),
    ));
    if (encodeCanonicalJson(recomputed) !== encodeCanonicalJson(run.accounting)) {
      throw new CorruptDurableStoreError(`run accounting mismatch for ${runId}`);
    }
    return Object.freeze({ ...run, candidates, outcomes, contentHash: runHash });
  }

  loadOutcome(runId: string, runCandidateKey: string): StoredOutcome | null {
    const run = this.loadRun(runId);
    return run.outcomes.get(runCandidateKey) ?? null;
  }

  assertExactPartitionAndNoUnresolved(runId: string): LoadedRun {
    const run = this.loadRun(runId);
    const candidateKeys = new Set(run.candidates.map((candidate) => candidate.runCandidateKey));
    if (run.outcomes.size !== candidateKeys.size ||
        [...candidateKeys].some((key) => !run.outcomes.has(key))) {
      throw new PromotionRejectedError(`run ${runId} does not have an exact outcome partition`);
    }
    if (run.accounting.pending !== "0" || run.accounting.retryable !== "0" || run.accounting.invalidProgram !== "0") {
      throw new PromotionRejectedError(`run ${runId} has unresolved outcomes`);
    }
    if (
      BigInt(run.accounting.verified) + BigInt(run.accounting.chainProvenRejected) !== BigInt(run.candidateRecordCount)
    ) {
      throw new PromotionRejectedError(`run ${runId} final outcome partition is incomplete`);
    }
    return run;
  }

  createOutcomeWriter(runId: string, options: OutcomeWriterOptions = {}): DurableOutcomeWriterActor {
    this.loadRun(runId);
    return new DurableOutcomeWriterActor(this, runId, options);
  }

  startOutcomeWriterActor(runId: string, options: OutcomeWriterOptions = {}): DurableOutcomeWriterActor {
    return this.createOutcomeWriter(runId, options);
  }

  beginNewRunAndPersistPartition(request: BeginRunRequest): InProgressRunV1 {
    return this.beginNewRun(request);
  }

  loadExactCandidatePartition(runId: string): readonly CandidateRecordV1[] {
    return this.loadRun(runId).candidates;
  }

  requireIncompleteRun(runId: string): LoadedRun {
    const root = this.loadRoot();
    if (root.inProgressRunId !== runId) throw new CheckpointRunStateError(`run ${runId} is not the incomplete active run`);
    return this.loadRun(runId);
  }

  async singleWriterReplace(
    runId: string,
    runCandidateKey: string,
    expectedContentHash: Hash,
    outcomeInput: CompactOutcomeInput,
  ): Promise<StoredOutcome> {
    const outcome = normalizeOutcome({ ...outcomeInput, runCandidateKey });
    const owner = `checkpoint-probe/${runId}/${randomUUID()}`;
    const lease = this.durableStore.acquireWriterLease(owner);
    try {
      return this.durableStore.transaction(lease, (tx) => {
        const root = readRootFromTx(tx);
        if (root.inProgressRunId !== runId) throw new CheckpointRunStateError(`run ${runId} is not active`);
        const runHash = tx.getIndex("run", runId);
        if (!runHash) throw new CheckpointRunStateError(`run ${runId} index is missing`);
        const runContent = tx.readContent(runHash);
        if (!runContent || runContent.kind !== RUN_KIND) throw new CorruptDurableStoreError(`run ${runId} missing`);
        const run = decodeRun(runContent.bytes);
        const existingOutcomes = this.loadOutcomeMapTx(tx, runId, run.outcomesRoot);
        const previous = existingOutcomes.get(runCandidateKey);
        if (!previous || previous.contentHash !== expectedContentHash || previous.status !== "retryable") {
          throw new OutcomeStateConflictError(`probe expected retryable outcome ${runCandidateKey}`);
        }
        assertOutcomeTransition(previous, outcome);
        const outcomeHash = tx.putImmutable(OUTCOME_KIND, encodeOutcome(outcome));
        existingOutcomes.set(runCandidateKey, Object.freeze({ ...outcome, contentHash: outcomeHash }));
        const outcomeEntries = sortedEntries(new Map(
          [...existingOutcomes.entries()].map(([key, value]) => [key, value.contentHash] as const),
        ));
        const outcomesRoot = tx.putImmutable(
          OUTCOMES_PARTITION_KIND,
          encodePartition(runId, outcomeEntries),
          outcomeEntries.map((entry) => entry.contentHash),
        );
        const nextRun: InProgressRunV1 = Object.freeze({
          ...run,
          outcomesRoot,
          accounting: countAccounting(BigInt(run.candidateRecordCount), new Map(
            [...existingOutcomes.entries()].map(([key, value]) => [key, value] as const),
          )),
        });
        const nextRunHash = tx.putImmutable(RUN_KIND, encodeRun(nextRun), [
          nextRun.candidatePartitionRoot,
          nextRun.outcomesRoot,
          nextRun.sourceCoverageRoot,
          nextRun.definitionCatalogRoot,
        ]);
        tx.setIndex("run", runId, nextRunHash);
        const nextRoot = Object.freeze({
          ...root,
          revision: (BigInt(root.revision) + 1n).toString(),
        });
        tx.compareAndSwapRoot(root.revision, encodeRoot(nextRoot), [root.verifiedMemoRoot, nextRunHash]);
        return Object.freeze({ ...outcome, contentHash: outcomeHash });
      });
    } finally {
      this.durableStore.releaseWriterLease(lease);
    }
  }

  async promoteReadyGeneration(input: {
    readonly runId: string;
    readonly generation: Omit<ReadyGenerationV1, "promotionRevision"> & { readonly promotionRevision?: U64String };
    readonly expectedRootRevision?: U64String;
    readonly canonicalView: CanonicalSourceView;
  }): Promise<ReadyGenerationV1> {
    if (!this.canonicalSource) throw new PromotionRejectedError("canonical source is required for promotion");
    await this.canonicalSource.assertStillCanonical(input.canonicalView);
    const run = this.assertExactPartitionAndNoUnresolved(input.runId);
    if (run.cutoff.number !== input.canonicalView.number || run.cutoff.hash !== input.canonicalView.hash || run.cutoff.stateRoot !== input.canonicalView.stateRoot) {
      throw new PromotionRejectedError("run cutoff does not match canonical source fence");
    }
    if (
      input.generation.candidatePartitionRoot !== run.candidatePartitionRoot ||
      input.generation.sourceCoverageRoot !== run.sourceCoverageRoot ||
      input.generation.definitionCatalogRoot !== run.definitionCatalogRoot
    ) {
      throw new PromotionRejectedError("ready generation roots do not match the completed run");
    }
    const owner = `checkpoint-promote/${input.runId}/${randomUUID()}`;
    const lease = this.durableStore.acquireWriterLease(owner);
    try {
      return this.durableStore.transaction(lease, (tx) => {
        const root = readRootFromTx(tx);
        if (root.inProgressRunId !== input.runId) throw new PromotionRejectedError("run is not the active in-progress run");
        if (input.expectedRootRevision !== undefined && root.revision !== input.expectedRootRevision) {
          throw new CASConflictError(input.expectedRootRevision, root.revision);
        }
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const generation: ReadyGenerationV1 = Object.freeze({
          ...input.generation,
          promotionRevision: nextRevision,
        });
        this.requireReadyReferences(tx, generation);
        const readyHash = tx.putImmutable(
          READY_KIND,
          encodeReady(generation),
          [
            generation.definitionCatalogRoot,
            generation.sourceCoverageRoot,
            generation.candidatePartitionRoot,
            generation.verifiedMemoSetRoot,
            generation.instanceCatalogRoot,
            generation.graphRoot,
          ],
        );
        const nextRoot: CheckpointRootV1 = Object.freeze({
          ...root,
          revision: nextRevision,
          verifiedMemoRoot: generation.verifiedMemoSetRoot,
          inProgressRunId: null,
          readyGenerationId: generation.generationId,
          readyGenerationRecordHash: readyHash,
        });
        tx.deleteIndex("run", input.runId);
        tx.compareAndSwapRoot(root.revision, encodeRoot(nextRoot), [nextRoot.verifiedMemoRoot, readyHash]);
        return generation;
      });
    } finally {
      this.durableStore.releaseWriterLease(lease);
    }
  }

  async sealCompletedRunStaleAndClearWithoutCarryCAS(
    runId: string,
    reason: string,
  ): Promise<CheckpointRootV1> {
    return this.sealRunAndClear(runId, reason, null);
  }

  async sealCompletedRunAsMemoSeedAndClearCAS(input: {
    readonly runId: string;
    readonly carriedVerifiedMemoRoot: Hash;
    readonly reason?: string;
  }): Promise<CheckpointRootV1> {
    return this.sealRunAndClear(input.runId, input.reason ?? "cutoff-too-old-for-serving", input.carriedVerifiedMemoRoot);
  }

  garbageCollect(): readonly Hash[] {
    return this.durableStore.garbageCollect();
  }

  private normalizeCandidates(runId: string, inputs: readonly CandidateRecordInput[]): readonly CandidateRecordV1[] {
    const byKey = new Map<string, CandidateRecordV1>();
    for (const input of inputs) {
      const familyCandidateKey = assertString(input.familyCandidateKey, "candidate.familyCandidateKey");
      const runCandidateKey = input.runCandidateKey ?? hashDomain(
        "aloha/run-candidate/v1",
        { runId, familyCandidateKey },
      );
      const candidate: CandidateRecordV1 = Object.freeze({
        runCandidateKey: assertString(runCandidateKey, "candidate.runCandidateKey"),
        familyCandidateKey,
        familyId: assertString(input.familyId, "candidate.familyId"),
        instanceNominationKey: assertString(input.instanceNominationKey, "candidate.instanceNominationKey"),
        candidateSnapshot: assertJson(input.candidateSnapshot, "candidate.candidateSnapshot"),
        evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])].map((hash) => assertHash(hash, "candidate.evidenceRefs"))),
      });
      if (byKey.has(candidate.runCandidateKey)) throw new CheckpointRunStateError(`duplicate opaque candidate key ${candidate.runCandidateKey}`);
      byKey.set(candidate.runCandidateKey, candidate);
    }
    return Object.freeze([...byKey.values()].sort((left, right) => left.runCandidateKey.localeCompare(right.runCandidateKey)));
  }

  private putEmptyRoot(label: string): Hash {
    return this.durableStore.putImmutableContent(
      `aloha/${label}-root/v1`,
      encodeCanonicalBytes({ label, version: 1 }),
    );
  }

  private loadCandidates(runId: string, root: Hash): readonly CandidateRecordV1[] {
    const entries = this.partitionEntries(runId, root);
    const candidates: CandidateRecordV1[] = [];
    for (const entry of entries) {
      const content = this.durableStore.readContent(entry.contentHash);
      if (!content || content.kind !== CANDIDATE_RECORD_KIND) throw new CorruptDurableStoreError(`candidate record missing ${entry.contentHash}`);
      const candidate = decodeCandidate(content.bytes);
      if (candidate.runCandidateKey !== entry.key) throw new CorruptDurableStoreError(`candidate key mismatch ${entry.key}`);
      candidates.push(candidate);
    }
    return Object.freeze(candidates);
  }

  private partitionEntries(runId: string, root: Hash): readonly { key: string; contentHash: Hash }[] {
    const bytes = verifyContent(this.durableStore, root, CANDIDATE_PARTITION_KIND, `run ${runId} candidate partition`);
    return decodePartition(bytes, runId, "candidate partition");
  }

  loadOutcomeMapTx(
    tx: DurableTransaction,
    runId: string,
    root: Hash,
  ): Map<string, StoredOutcome> {
    const content = tx.readContent(root);
    if (!content || content.kind !== OUTCOMES_PARTITION_KIND) throw new CorruptDurableStoreError(`outcomes partition missing ${root}`);
    const entries = decodePartition(content.bytes, runId, "outcomes partition");
    const outcomes = new Map<string, StoredOutcome>();
    for (const entry of entries) {
      const outcomeContent = tx.readContent(entry.contentHash);
      if (!outcomeContent || outcomeContent.kind !== OUTCOME_KIND) throw new CorruptDurableStoreError(`outcome missing ${entry.contentHash}`);
      const outcome = decodeOutcome(outcomeContent.bytes);
      if (outcome.runCandidateKey !== entry.key) throw new CorruptDurableStoreError(`outcome key mismatch ${entry.key}`);
      outcomes.set(entry.key, Object.freeze({ ...outcome, contentHash: entry.contentHash }));
    }
    return outcomes;
  }

  partitionEntriesTx(
    tx: DurableTransaction,
    runId: string,
    root: Hash,
  ): readonly { key: string; contentHash: Hash }[] {
    const content = tx.readContent(root);
    if (!content || content.kind !== CANDIDATE_PARTITION_KIND) {
      throw new CorruptDurableStoreError(`candidate partition missing ${root}`);
    }
    return decodePartition(content.bytes, runId, "candidate partition");
  }

  private requireReadyReferences(tx: DurableTransaction, ready: ReadyGenerationV1): void {
    const refs: readonly [Hash, string][] = [
      [ready.definitionCatalogRoot, "ready definition catalog"],
      [ready.sourceCoverageRoot, "ready source coverage"],
      [ready.candidatePartitionRoot, "ready candidate partition"],
      [ready.verifiedMemoSetRoot, "ready verified memo"],
      [ready.instanceCatalogRoot, "ready instance catalog"],
      [ready.graphRoot, "ready graph"],
    ];
    for (const [hash, context] of refs) requireContentTx(tx, hash, context);
  }

  private async sealRunAndClear(
    runId: string,
    reason: string,
    carriedVerifiedMemoRoot: Hash | null,
  ): Promise<CheckpointRootV1> {
    const owner = `checkpoint-seal/${runId}/${randomUUID()}`;
    const lease = this.durableStore.acquireWriterLease(owner);
    try {
      return this.durableStore.transaction(lease, (tx) => {
        const root = readRootFromTx(tx);
        if (root.inProgressRunId !== runId) throw new CheckpointRunStateError(`run ${runId} is not active`);
        const runHash = tx.getIndex("run", runId);
        if (!runHash) throw new CheckpointRunStateError(`run ${runId} index is missing`);
        const runContent = tx.readContent(runHash);
        if (!runContent || runContent.kind !== RUN_KIND) throw new CorruptDurableStoreError(`run ${runId} record is missing`);
        const run = decodeRun(runContent.bytes);
        if (carriedVerifiedMemoRoot !== null) requireContentTx(tx, carriedVerifiedMemoRoot, "carried memo root");
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const receiptValue = carriedVerifiedMemoRoot === null
          ? { runId, reason }
          : {
            runId,
            cutoff: run.cutoff,
            definitionCatalogRoot: run.definitionCatalogRoot,
            coreEnvelopeSchemaHash: CHECKPOINT_SCHEMA_HASH,
            candidatePartitionRoot: run.candidatePartitionRoot,
            sourceCoverageRoot: run.sourceCoverageRoot,
            exactOutcomePartitionRoot: run.outcomesRoot,
            carriedVerifiedMemoRoot,
            reason: "cutoff-too-old-for-serving" as const,
            sealedRevision: nextRevision,
          } satisfies SealedMemoSeedReceiptV1;
        const receiptRefs = carriedVerifiedMemoRoot === null
          ? []
          : [run.candidatePartitionRoot, run.sourceCoverageRoot, run.outcomesRoot, carriedVerifiedMemoRoot];
        const receipt = tx.putImmutable(DIAGNOSTIC_KIND, encodeCanonicalBytes(receiptValue), receiptRefs);
        const nextRoot: CheckpointRootV1 = Object.freeze({
          ...root,
          revision: nextRevision,
          verifiedMemoRoot: carriedVerifiedMemoRoot ?? root.verifiedMemoRoot,
          inProgressRunId: null,
          latestMemoSeedReceiptHash: receipt,
        });
        tx.deleteIndex("run", runId);
        tx.compareAndSwapRoot(root.revision, encodeRoot(nextRoot), [nextRoot.verifiedMemoRoot, receipt]);
        return nextRoot;
      });
    } finally {
      this.durableStore.releaseWriterLease(lease);
    }
  }
}

export class DurableOutcomeWriterActor {
  private readonly checkpoint: CheckpointStore;
  private readonly runId: string;
  private readonly flushEveryItems: number;
  private readonly flushEveryMs: number;
  private readonly mailboxCapacity: number;
  private readonly lease: WriterLease;
  private readonly queue: CompactOutcomeV1[] = [];
  private readonly pending = new Map<string, CompactOutcomeV1>();
  private readonly flushWaiters: { readonly resolve: () => void; readonly reject: (error: unknown) => void }[] = [];
  private accepting = true;
  private forceFlush = false;
  private wakeWaiter: (() => void) | null = null;
  private readonly loopTask: Promise<void>;
  private done = false;

  constructor(
    checkpoint: CheckpointStore,
    runId: string,
    options: OutcomeWriterOptions = {},
  ) {
    this.checkpoint = checkpoint;
    this.runId = runId;
    this.flushEveryItems = options.flushEveryItems ?? 25;
    this.flushEveryMs = options.flushEveryMs ?? 3_000;
    this.mailboxCapacity = options.mailboxCapacity ?? 1_024;
    if (!Number.isInteger(this.flushEveryItems) || this.flushEveryItems < 1) throw new RangeError("flushEveryItems must be positive");
    if (!Number.isInteger(this.flushEveryMs) || this.flushEveryMs < 2_000 || this.flushEveryMs > 5_000) throw new RangeError("flushEveryMs must be between 2000ms and 5000ms");
    if (!Number.isInteger(this.mailboxCapacity) || this.mailboxCapacity < 1) throw new RangeError("mailboxCapacity must be positive");
    const writerId = options.writerId ?? `checkpoint-writer/${runId}/${randomUUID()}`;
    this.lease = checkpoint.durableStore.acquireWriterLease(writerId);
    this.loopTask = this.runLoop();
  }

  enqueue(input: CompactOutcomeInput): Promise<void> {
    if (!this.accepting) return Promise.reject(new OutcomeWriterClosedError());
    if (this.queue.length >= this.mailboxCapacity) {
      return Promise.reject(new CheckpointError("writer-mailbox-full", "checkpoint writer mailbox is full"));
    }
    const outcome = normalizeOutcome(input);
    this.queue.push(outcome);
    this.wakeWaiter?.();
    this.wakeWaiter = null;
    return Promise.resolve();
  }

  loadSealedOrPartial(runCandidateKey: string): StoredOutcome | null {
    return this.checkpoint.loadOutcome(this.runId, runCandidateKey);
  }

  requestStop(): void {
    this.accepting = false;
    this.wakeWaiter?.();
    this.wakeWaiter = null;
  }

  flush(): Promise<void> {
    if (this.done) return Promise.resolve();
    this.forceFlush = true;
    this.wakeWaiter?.();
    this.wakeWaiter = null;
    return new Promise((resolve, reject) => this.flushWaiters.push({ resolve, reject }));
  }

  async closeAfterAllProducersAndFlush(): Promise<void> {
    this.requestStop();
    await this.loopTask;
  }

  private async runLoop(): Promise<void> {
    let lastFlush = Date.now();
    try {
      while (this.accepting || this.queue.length > 0 || this.pending.size > 0) {
        if (this.queue.length > 0) {
          const outcome = this.queue.shift()!;
          const previous = this.pending.get(outcome.runCandidateKey) ?? this.checkpoint.loadOutcome(this.runId, outcome.runCandidateKey);
          assertOutcomeTransition(previous, outcome);
          this.pending.set(outcome.runCandidateKey, outcome);
        } else if (this.accepting && !this.forceFlush) {
          await this.waitForMessage(Math.max(0, this.flushEveryMs - (Date.now() - lastFlush)));
        }
        if (this.pending.size >= this.flushEveryItems || this.forceFlush || Date.now() - lastFlush >= this.flushEveryMs || (!this.accepting && this.queue.length === 0)) {
          await this.flushPending();
          lastFlush = Date.now();
          this.forceFlush = false;
          this.resolveFlushWaiters();
        }
      }
      await this.flushPending();
      this.resolveFlushWaiters();
    } catch (error) {
      this.rejectFlushWaiters(error);
      throw error;
    } finally {
      this.resolveFlushWaiters();
      this.done = true;
      this.checkpoint.durableStore.releaseWriterLease(this.lease);
    }
  }

  private waitForMessage(timeoutMs: number): Promise<void> {
    if (this.queue.length > 0 || !this.accepting || this.forceFlush) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.wakeWaiter = null;
        resolve();
      }, timeoutMs);
      this.wakeWaiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeWaiter = null;
        resolve();
      };
    });
  }

  private async flushPending(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.entries()].sort(([left], [right]) => left.localeCompare(right));
    const ownerLease = this.lease;
    this.checkpoint.durableStore.transaction(ownerLease, (tx) => {
      const root = readRootFromTx(tx);
      if (root.inProgressRunId !== this.runId) throw new CheckpointRunStateError(`run ${this.runId} is not active`);
      const runHash = tx.getIndex("run", this.runId);
      if (!runHash) throw new CorruptDurableStoreError(`run ${this.runId} index is missing`);
      const runContent = tx.readContent(runHash);
      if (!runContent || runContent.kind !== RUN_KIND) throw new CorruptDurableStoreError(`run ${this.runId} record missing`);
      const run = decodeRun(runContent.bytes);
      const candidates = this.checkpoint.partitionEntriesTx(tx, this.runId, run.candidatePartitionRoot);
      const candidateKeys = new Set(candidates.map((entry) => entry.key));
      const outcomes = this.checkpoint.loadOutcomeMapTx(tx, this.runId, run.outcomesRoot);
      for (const [key, outcome] of batch) {
        if (!candidateKeys.has(key)) throw new CheckpointRunStateError(`unknown opaque candidate key ${key}`);
        const previous = outcomes.get(key) ?? null;
        assertOutcomeTransition(previous, outcome);
        const contentHash = tx.putImmutable(OUTCOME_KIND, encodeOutcome(outcome));
        outcomes.set(key, Object.freeze({ ...outcome, contentHash }));
      }
      const outcomeEntries = sortedEntries(new Map(
        [...outcomes.entries()].map(([key, value]) => [key, value.contentHash] as const),
      ));
      const outcomesRoot = tx.putImmutable(
        OUTCOMES_PARTITION_KIND,
        encodePartition(this.runId, outcomeEntries),
        outcomeEntries.map((entry) => entry.contentHash),
      );
      const nextRun: InProgressRunV1 = Object.freeze({
        ...run,
        outcomesRoot,
        accounting: countAccounting(BigInt(run.candidateRecordCount), new Map(
          [...outcomes.entries()].map(([key, value]) => [key, value] as const),
        )),
      });
      const nextRunHash = tx.putImmutable(RUN_KIND, encodeRun(nextRun), [
        nextRun.candidatePartitionRoot,
        nextRun.outcomesRoot,
        nextRun.sourceCoverageRoot,
        nextRun.definitionCatalogRoot,
      ]);
      tx.setIndex("run", this.runId, nextRunHash);
      const nextRoot = Object.freeze({ ...root, revision: (BigInt(root.revision) + 1n).toString() });
      tx.compareAndSwapRoot(root.revision, encodeRoot(nextRoot), [root.verifiedMemoRoot, nextRunHash]);
    });
    for (const [key] of batch) this.pending.delete(key);
  }

  private resolveFlushWaiters(): void {
    while (this.flushWaiters.length > 0) this.flushWaiters.shift()!.resolve();
  }

  private rejectFlushWaiters(error: unknown): void {
    while (this.flushWaiters.length > 0) this.flushWaiters.shift()!.reject(error);
  }
}

export function installCheckpointSignalHooks(
  writer: DurableOutcomeWriterActor,
  hooks: SignalHookPort,
): () => void {
  const onSignal = (): void => writer.requestStop();
  hooks.on("SIGTERM", onSignal);
  hooks.on("SIGINT", onSignal);
  return (): void => {
    hooks.off?.("SIGTERM", onSignal);
    hooks.off?.("SIGINT", onSignal);
  };
}

export function createCheckpointStore(
  durableStore: SQLiteDurableStore,
  canonicalSource?: CanonicalSource,
): CheckpointStore {
  return new CheckpointStore(durableStore, canonicalSource);
}

export function runCandidateKey(runId: string, familyCandidateKey: string): Hash {
  return hashDomain("aloha/run-candidate/v1", { runId, familyCandidateKey });
}

export function isTerminalOutcome(outcome: CompactOutcomeV1): boolean {
  return outcomeTerminal(outcome.status);
}

export function hashExactCandidatePartition(
  candidates: readonly CandidateRecordInput[],
  runId = "hash-only",
): Hash {
  const entries = candidates.map((input) => {
    const candidate: CandidateRecordV1 = {
      runCandidateKey: input.runCandidateKey ?? runCandidateKey(runId, input.familyCandidateKey),
      familyCandidateKey: input.familyCandidateKey,
      familyId: input.familyId,
      instanceNominationKey: input.instanceNominationKey,
      candidateSnapshot: input.candidateSnapshot,
      evidenceRefs: input.evidenceRefs ?? [],
    };
    return { key: candidate.runCandidateKey, contentHash: sha256Hex(encodeCandidate(candidate)) };
  }).sort((left, right) => left.key.localeCompare(right.key));
  return candidateSetHash(entries);
}
