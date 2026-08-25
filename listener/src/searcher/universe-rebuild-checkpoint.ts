import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";

/**
 * Durable universe-rebuild checkpoint (adversarial audit §1-§4). Four
 * durable state classes only:
 * - verifiedMemos: cross-rebuild reusable Family + InstanceKey proofs;
 * - inProgressRun: the single unfinished rebuild at one fixed cutoff;
 * - retryableAttemptsByCandidateKey: independent one-candidate repair queue;
 * - readyGeneration: the last complete usable Graph/catalog snapshot.
 * No long-term raw tx inbox and no recovery from progress counters. A
 * verified memo owns the one complete candidate snapshot needed to retain
 * that verified instance across rolling discovery windows; there is no
 * separate candidate journal or second admission authority.
 */

export interface DurableVerifiedMemo {
  readonly familyCandidateKey: string;
  readonly familyInstanceKey: string;
  readonly familyId: string;
  readonly candidateKey: string;
  readonly instanceKey: string;
  /** Static candidate identity only; no swapCount/lastSwapBlock etc. */
  readonly candidateFingerprint: string;
  /** Per-Family definition hash; never the global catalog hash. */
  readonly familyDefinitionHash: string;
  readonly validity: {
    readonly policy: "immutable-code" | "dependency-proof";
    readonly authorityFingerprint: string;
    readonly proofSource: { readonly number: number; readonly hash: string };
  };
  readonly verifiedIdentity: unknown;
  readonly compiledDescriptor: unknown;
  readonly staticProjection: unknown;
  readonly evidenceFingerprint: string;
  /** Complete JSON-safe candidate needed for permanent cross-window retention. */
  readonly candidateSnapshot: unknown;
  readonly memoFingerprint: string;
}

/** Read-only compatibility shape accepted only by the one-time upgrader. */
export type LegacyDurableVerifiedMemo = Omit<
  DurableVerifiedMemo,
  "candidateSnapshot"
>;

export interface RetryableAttempt {
  readonly status: "retryable";
  readonly familyCandidateKey: string;
  readonly familyId: string;
  /** Enough to retry one instance; never the full raw tx. */
  readonly candidateSnapshot: unknown;
  readonly evidenceRef?: {
    readonly blockNumber: number;
    readonly blockHash: string;
    readonly txHash?: string;
    readonly logIndex?: number;
  };
  readonly stage:
    | "nomination"
    | "identity"
    | "funding"
    | "materialization"
    | "projection";
  readonly failureCode: "rpc" | "deadline" | "aborted" | "resource-limited";
  readonly requestFingerprint?: string;
  readonly reasonCode: string;
  readonly attemptCount: number;
  readonly lastAttemptAt: string;
}

/**
 * Retryable work is durable, but it is not an unfinished rebuild.  Once an
 * exact candidate partition is promoted, retryables move here with the
 * canonical cutoff needed by the one-candidate probe.
 */
export interface DurableRetryableQueueEntry extends RetryableAttempt {
  readonly runId: string;
  readonly cutoff: CanonicalSource;
}

export type RunOutcome =
  | {
    readonly status: "verified";
    readonly familyCandidateKey: string;
    readonly familyInstanceKey: string;
    readonly memoFingerprint: string;
  }
  | {
    readonly status: "terminal-rejected";
    readonly familyCandidateKey: string;
    readonly reasonCode: string;
    /**
     * Family-declared chain-proven negative evidence. Every binding must
     * equal the current value on resume or the candidate is re-attested:
     * a Family definition/request-program/authority/cutoff change invalidates
     * the old terminal outcome instead of silently keeping an instance
     * permanently excluded.
     */
    readonly familyDefinitionHash: string;
    readonly requestFingerprint: string;
    readonly trustedResultsFingerprint: string;
    readonly authorityFingerprint: string;
    readonly candidateFingerprint: string;
    readonly cutoff: { readonly number: number; readonly hash: string };
  }
  | RetryableAttempt;

export interface DurableSourceChunkReceipt {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly resultCount: number;
  readonly resultHash: string;
}

/**
 * Durable proof that one exact startup source query completed at the fixed
 * cutoff. A receipt may grant several Family x source coverage keys when one
 * catalog-issued topic-union query covers them atomically, but it must name
 * that exact set and every completed range chunk.
 */
export interface DurableSourceReceipt {
  readonly sourceKey: string;
  readonly sourceKind: "startup-candidate-union" | "catalog-event-union";
  readonly providerIdentity: string;
  readonly queryFingerprint: string;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly cutoffNumber: number;
  readonly cutoffHash: string;
  readonly coverageKeys: readonly string[];
  readonly completedChunks: readonly DurableSourceChunkReceipt[];
  readonly observationSetHash: string;
  readonly observedThrough: { readonly number: number; readonly hash: string };
  readonly appliedThrough: { readonly number: number; readonly hash: string };
  readonly retryableCount: 0;
  readonly status: "complete";
}

export interface InProgressUniverseRun {
  readonly runId: string;
  readonly cutoff: CanonicalSource;
  readonly fromBlock: number;
  readonly universeHash: string;
  readonly candidateSetHash: string;
  readonly candidateCount: number;
  /** Compact exact partition; sufficient to resume without rescanning. */
  readonly candidatesByKey: Readonly<Record<string, unknown>>;
  /** Swap range fully scanned; never advances appliedThrough by itself. */
  readonly observedThrough: { readonly number: number; readonly hash: string };
  readonly sourceReceipts: readonly DurableSourceReceipt[];
  /**
   * Null until the completed exact partition is promoted.  An in-progress
   * run must never advertise an applied cursor merely because observation or
   * some instance attestations finished.
   */
  readonly appliedThrough: null;
  readonly outcomesByCandidateKey: Readonly<Record<string, RunOutcome>>;
}

export interface ReadyUniverseGeneration {
  readonly generation: number;
  readonly cutoff: CanonicalSource;
  readonly universeRange: {
    readonly fromBlock: number;
    readonly toBlock: number;
  };
  readonly universeHash: string;
  readonly catalogHash: string;
  readonly activeInstanceKeys: readonly string[];
  readonly publicationSetHash: string;
  readonly candidateAccounting: {
    readonly total: number;
    readonly verified: number;
    readonly terminalRejected: number;
    readonly retryable: number;
    readonly remainingUnaccounted: 0;
  };
  readonly observedThrough: { readonly number: number; readonly hash: string };
  readonly appliedThrough: { readonly number: number; readonly hash: string };
  readonly sourceCoverage: readonly {
    readonly familyId: string;
    readonly sourceId: string;
    readonly completeThroughBlock: number;
    readonly completeThroughHash: string | null;
  }[];
  readonly graphSnapshot: unknown;
  readonly graphHash: string;
  readonly catalogSnapshot: unknown;
}

export interface AttestationCheckpointWrite {
  readonly outcome: RunOutcome;
  /** Present exactly when a verified outcome introduces/replaces its memo. */
  readonly memo?: DurableVerifiedMemo;
}

export interface StartupCheckpointEnvelope {
  readonly revision: number;
  readonly verifiedMemos: Readonly<Record<string, DurableVerifiedMemo>>;
  readonly inProgressRun: InProgressUniverseRun | null;
  readonly retryableAttemptsByCandidateKey: Readonly<
    Record<string, DurableRetryableQueueEntry>
  >;
  readonly readyGeneration: ReadyUniverseGeneration | null;
  readonly checkpointFingerprint: string;
}

/** Deterministic canonical JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("checkpoint canonical value number must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(
      "unsupported checkpoint canonical value type: " + typeof value,
    );
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("checkpoint canonical values must be plain records");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])
  ).join(",") + "}";
}

export function hasDurableCandidateSnapshot(
  memo: DurableVerifiedMemo | LegacyDurableVerifiedMemo,
): memo is DurableVerifiedMemo {
  return Object.prototype.hasOwnProperty.call(memo, "candidateSnapshot") &&
    (memo as { readonly candidateSnapshot?: unknown }).candidateSnapshot !==
      undefined;
}

/**
 * One fingerprint projection for both deployed legacy memos and the current
 * retained-candidate shape. The legacy projection omits candidateSnapshot;
 * every newly sealed/upgraded memo includes it in the same projection and is
 * therefore cryptographically bound to the candidate it can restore.
 */
export function durableVerifiedMemoFingerprint(
  memo: DurableVerifiedMemo | LegacyDurableVerifiedMemo,
): string {
  return createHash("sha256")
    .update("memo-v1:" + canonicalJson({
      familyCandidateKey: memo.familyCandidateKey,
      familyInstanceKey: memo.familyInstanceKey,
      candidateFingerprint: memo.candidateFingerprint,
      familyDefinitionHash: memo.familyDefinitionHash,
      validity: memo.validity,
      verifiedIdentity: memo.verifiedIdentity,
      compiledDescriptor: memo.compiledDescriptor,
      staticProjection: memo.staticProjection,
      evidenceFingerprint: memo.evidenceFingerprint,
      ...(hasDurableCandidateSnapshot(memo)
        ? { candidateSnapshot: memo.candidateSnapshot }
        : {}),
    }))
    .digest("hex");
}

export function assertDurableVerifiedMemoFingerprint(
  memo: DurableVerifiedMemo | LegacyDurableVerifiedMemo,
): void {
  if (memo.memoFingerprint !== durableVerifiedMemoFingerprint(memo)) {
    throw new Error(
      "universe rebuild checkpoint: verified memo fingerprint mismatch " +
        memo.familyCandidateKey,
    );
  }
}

function retryableAttemptFromQueueEntry(
  entry: DurableRetryableQueueEntry,
): RetryableAttempt {
  const attempt = { ...entry } as Record<string, unknown>;
  delete attempt.runId;
  delete attempt.cutoff;
  return Object.freeze(attempt) as unknown as RetryableAttempt;
}

function queueEntryMatchesOutcome(
  entry: DurableRetryableQueueEntry,
  outcome: RetryableAttempt,
): boolean {
  return canonicalJson(retryableAttemptFromQueueEntry(entry)) ===
    canonicalJson(outcome);
}

function inheritedQueuedRetryables(
  queue: Readonly<Record<string, DurableRetryableQueueEntry>>,
  candidatesByKey: Readonly<Record<string, unknown>>,
): Record<string, RunOutcome> {
  const inherited: Record<string, RunOutcome> = {};
  for (const [candidateKey, candidateSnapshot] of Object.entries(
    candidatesByKey,
  )) {
    const queued = queue[candidateKey];
    if (
      queued !== undefined &&
      canonicalJson(queued.candidateSnapshot) === canonicalJson(candidateSnapshot)
    ) {
      inherited[candidateKey] = retryableAttemptFromQueueEntry(queued);
    }
  }
  return inherited;
}

function assertRetryableQueue(
  queue: Readonly<Record<string, DurableRetryableQueueEntry>>,
): void {
  for (const [candidateKey, entry] of Object.entries(queue)) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      entry.status !== "retryable" ||
      entry.familyCandidateKey !== candidateKey ||
      typeof entry.runId !== "string" ||
      entry.runId.length === 0 ||
      !Number.isSafeInteger(entry.cutoff?.number) ||
      entry.cutoff.number < 0 ||
      typeof entry.cutoff.hash !== "string" ||
      !Number.isSafeInteger(entry.cutoff.generation) ||
      !Number.isSafeInteger(entry.attemptCount) ||
      entry.attemptCount < 1 ||
      typeof entry.lastAttemptAt !== "string" ||
      !("candidateSnapshot" in entry)
    ) {
      throw new Error(
        "universe rebuild retryable queue entry is invalid: " + candidateKey,
      );
    }
  }
}

/**
 * Streaming canonical hash: feeds the exact canonicalJson byte sequence
 * (sorted keys, no whitespace) into sha256 incrementally instead of
 * building one giant string. A ready envelope carries hundreds of MB of
 * snapshots; a single concatenated canonical string can exceed V8's string
 * limit ("Invalid string length"). The byte stream is identical to
 * canonicalJson's output, so digests stay compatible with previously
 * sealed checkpoints.
 */
export function envelopeFingerprint(
  envelope: Omit<StartupCheckpointEnvelope, "checkpointFingerprint">,
): string {
  return fingerprintProjection({
    revision: envelope.revision,
    verifiedMemos: envelope.verifiedMemos,
    inProgressRun: envelope.inProgressRun,
    retryableAttemptsByCandidateKey:
      envelope.retryableAttemptsByCandidateKey,
    readyGeneration: envelope.readyGeneration,
  });
}

function fingerprintProjection(projection: unknown): string {
  const hash = createHash("sha256");
  canonicalWrite(hash, projection);
  return hash.digest("hex");
}

function legacyEnvelopeFingerprint(input: {
  readonly revision: number;
  readonly verifiedMemos: Readonly<Record<string, DurableVerifiedMemo>>;
  readonly inProgressRun: InProgressUniverseRun | null;
  readonly readyGeneration: ReadyUniverseGeneration | null;
}): string {
  return fingerprintProjection({
    revision: input.revision,
    verifiedMemos: input.verifiedMemos,
    inProgressRun: input.inProgressRun,
    readyGeneration: input.readyGeneration,
  });
}

function canonicalWrite(
  hash: ReturnType<typeof createHash>,
  value: unknown,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("checkpoint canonical value number must be finite");
    }
    hash.update(JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") {
    throw new Error(
      "unsupported checkpoint canonical value type: " + typeof value,
    );
  }
  if (Array.isArray(value)) {
    hash.update("[");
    for (let index = 0; index < value.length; index++) {
      if (index > 0) hash.update(",");
      canonicalWrite(hash, value[index]);
    }
    hash.update("]");
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("checkpoint canonical values must be plain records");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  hash.update("{");
  for (let index = 0; index < keys.length; index++) {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(keys[index]));
    hash.update(":");
    canonicalWrite(hash, record[keys[index]]);
  }
  hash.update("}");
}

function parseEnvelopeValue(parsed: unknown): StartupCheckpointEnvelope {
  const record = parsed as Record<string, unknown>;
  if (typeof record !== "object" || record === null) {
    throw new Error("universe rebuild checkpoint must be an object");
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
    throw new Error("universe rebuild checkpoint revision is invalid");
  }
  if (
    typeof record.verifiedMemos !== "object" ||
    record.verifiedMemos === null ||
    typeof record.checkpointFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.checkpointFingerprint)
  ) {
    throw new Error("universe rebuild checkpoint fields are invalid");
  }
  const legacyEnvelope = record as unknown as Omit<
    StartupCheckpointEnvelope,
    "retryableAttemptsByCandidateKey"
  >;
  const hasRetryableQueue = Object.prototype.hasOwnProperty.call(
    record,
    "retryableAttemptsByCandidateKey",
  );
  const retryableQueue = hasRetryableQueue
    ? record.retryableAttemptsByCandidateKey
    : {};
  if (
    typeof retryableQueue !== "object" ||
    retryableQueue === null ||
    Array.isArray(retryableQueue)
  ) {
    throw new Error("universe rebuild retryable queue is invalid");
  }
  const actualFingerprint = hasRetryableQueue
    ? envelopeFingerprint({
        revision: legacyEnvelope.revision,
        verifiedMemos: legacyEnvelope.verifiedMemos,
        inProgressRun: legacyEnvelope.inProgressRun ?? null,
        retryableAttemptsByCandidateKey: retryableQueue as Readonly<
          Record<string, DurableRetryableQueueEntry>
        >,
        readyGeneration: legacyEnvelope.readyGeneration ?? null,
      })
    : legacyEnvelopeFingerprint({
        revision: legacyEnvelope.revision,
        verifiedMemos: legacyEnvelope.verifiedMemos,
        inProgressRun: legacyEnvelope.inProgressRun ?? null,
        readyGeneration: legacyEnvelope.readyGeneration ?? null,
      });
  if (actualFingerprint !== legacyEnvelope.checkpointFingerprint) {
    throw new Error("universe rebuild checkpoint fingerprint mismatch");
  }
  const inProgressRun = legacyEnvelope.inProgressRun ?? null;
  if (
    inProgressRun !== null &&
    !Array.isArray(inProgressRun.sourceReceipts)
  ) {
    throw new Error(
      "universe rebuild checkpoint: in-progress run source receipts are absent",
    );
  }
  if (inProgressRun !== null) {
    assertCompleteSourceReceipts(inProgressRun.sourceReceipts);
    assertSourceReceiptsBindRun(inProgressRun.sourceReceipts, inProgressRun);
  }
  assertRetryableQueue(
    retryableQueue as Readonly<Record<string, DurableRetryableQueueEntry>>,
  );
  return Object.freeze({
    ...legacyEnvelope,
    inProgressRun,
    retryableAttemptsByCandidateKey: Object.freeze({
      ...(retryableQueue as Readonly<Record<string, DurableRetryableQueueEntry>>),
    }),
    readyGeneration: legacyEnvelope.readyGeneration ?? null,
  });
}

/**
 * Parse one top-level JSON field at a time. A production checkpoint contains
 * two independently large objects (verified memos and the last ready graph),
 * and their combined file can exceed V8's maximum string length even though
 * each field is valid and individually parseable. This reader never creates
 * a string for the whole file; it retains only the current field's source
 * text until JSON.parse has materialized that field.
 */
async function readTopLevelJsonObject(
  path: string,
  chunkBytes: number,
): Promise<Record<string, unknown> | null> {
  const fields: Record<string, unknown> = {};
  let rootStarted = false;
  let done = false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let sawNonWhitespace = false;
  let fieldParts: string[] = [];

  const whitespace = (char: string): boolean =>
    char === " " || char === "\n" || char === "\r" || char === "\t";
  const invalid = (detail: string): never => {
    throw new Error("universe rebuild checkpoint is not valid JSON: " + detail);
  };
  const completeField = (): void => {
    const raw = fieldParts.join("").trim();
    fieldParts = [];
    if (raw.length === 0) invalid("empty top-level field");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse("{" + raw + "}") as Record<string, unknown>;
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error));
    }
    const keys = Object.keys(parsed!);
    if (keys.length !== 1) invalid("top-level field is malformed");
    const key = keys[0]!;
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      invalid("duplicate top-level field " + key);
    }
    fields[key] = parsed![key];
  };

  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: chunkBytes,
  });
  for await (const rawChunk of stream) {
    const chunk = String(rawChunk);
    let index = 0;
    let segmentStart = rootStarted && !done ? 0 : -1;
    while (index < chunk.length) {
      const char = chunk[index]!;
      if (!whitespace(char)) sawNonWhitespace = true;

      if (!rootStarted) {
        if (whitespace(char)) {
          index++;
          continue;
        }
        if (char !== "{") invalid("top-level value must be an object");
        rootStarted = true;
        depth = 1;
        segmentStart = index + 1;
        index++;
        continue;
      }

      if (done) {
        if (!whitespace(char)) invalid("trailing content after top-level object");
        index++;
        continue;
      }

      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === "\\") {
          escape = true;
        } else if (char === "\"") {
          inString = false;
        }
        index++;
        continue;
      }
      if (char === "\"") {
        inString = true;
        index++;
        continue;
      }
      if (char === "{" || char === "[") {
        depth++;
        index++;
        continue;
      }
      if (char === "}" && depth === 1) {
        const tail = chunk.slice(segmentStart, index);
        if (tail.trim().length > 0 || fieldParts.length > 0) {
          fieldParts.push(tail);
          completeField();
        }
        segmentStart = -1;
        depth = 0;
        done = true;
        index++;
        continue;
      }
      if (char === "}" || char === "]") {
        depth--;
        if (depth < 1) invalid("unbalanced JSON container");
        index++;
        continue;
      }
      if (char === "," && depth === 1) {
        fieldParts.push(chunk.slice(segmentStart, index));
        completeField();
        segmentStart = index + 1;
        index++;
        continue;
      }
      index++;
    }
    if (rootStarted && !done && segmentStart >= 0) {
      fieldParts.push(chunk.slice(segmentStart));
    }
  }

  if (!sawNonWhitespace) return null;
  if (!done || inString || depth !== 0) invalid("unexpected end of file");
  return fields;
}

interface AttestationJournalRecord {
  readonly version: 1;
  readonly expectedRevision: number;
  readonly resultRevision: number;
  readonly expectedCheckpointFingerprint: string;
  readonly resultCheckpointFingerprint: string;
  readonly runId: string;
  readonly writes: readonly AttestationCheckpointWrite[];
  readonly recordFingerprint: string;
}

function sealEnvelope(
  next: StartupCheckpointEnvelope,
): StartupCheckpointEnvelope {
  return Object.freeze({
    ...next,
    checkpointFingerprint: envelopeFingerprint({
      revision: next.revision,
      verifiedMemos: next.verifiedMemos,
      inProgressRun: next.inProgressRun,
      retryableAttemptsByCandidateKey:
        next.retryableAttemptsByCandidateKey,
      readyGeneration: next.readyGeneration,
    }),
  });
}

function mergeAttestationWrites(
  current: StartupCheckpointEnvelope | null,
  runId: string,
  writes: readonly AttestationCheckpointWrite[],
): StartupCheckpointEnvelope {
  if (writes.length === 0) {
    throw new Error("universe rebuild checkpoint: empty outcome batch");
  }
  if (current === null) {
    throw new Error(
      "universe rebuild checkpoint: no matching in-progress run " + runId,
    );
  }
  const run = current.inProgressRun;
  if (run === null || run.runId !== runId) {
    throw new Error(
      "universe rebuild checkpoint: no matching in-progress run " + runId,
    );
  }
  const merged: Record<string, RunOutcome> = {
    ...run.outcomesByCandidateKey,
  };
  let memos: Readonly<Record<string, DurableVerifiedMemo>> =
    current.verifiedMemos;
  let mutableMemos: Record<string, DurableVerifiedMemo> | null = null;
  const writableMemos = (): Record<string, DurableVerifiedMemo> => {
    if (mutableMemos === null) {
      mutableMemos = { ...memos };
      memos = mutableMemos;
    }
    return mutableMemos;
  };
  for (const write of writes) {
    const { outcome, memo } = write;
    if (memo !== undefined) {
      assertMemoMatchesVerifiedOutcome(memo, outcome);
      writableMemos()[memo.familyCandidateKey] = Object.freeze(memo);
    }
    if (outcome.status === "verified") {
      const durableMemo = memos[outcome.familyCandidateKey];
      if (durableMemo === undefined) {
        throw new Error(
          "universe rebuild checkpoint: verified outcome has no memo " +
            outcome.familyCandidateKey,
        );
      }
      assertMemoMatchesVerifiedOutcome(durableMemo, outcome);
    } else {
      if (memo !== undefined) {
        throw new Error(
          "universe rebuild checkpoint: non-verified outcome carried memo",
        );
      }
      if (outcome.status === "terminal-rejected") {
        delete writableMemos()[outcome.familyCandidateKey];
      }
    }
    merged[outcome.familyCandidateKey] = outcome;
  }
  return Object.freeze({
    ...current,
    revision: current.revision + 1,
    verifiedMemos: mutableMemos === null
      ? current.verifiedMemos
      : Object.freeze(mutableMemos),
    inProgressRun: Object.freeze({
      ...run,
      outcomesByCandidateKey: Object.freeze(merged),
    }),
  });
}

function journalRecordFingerprint(
  record: Omit<
    AttestationJournalRecord,
    "recordFingerprint" | "resultCheckpointFingerprint"
  >,
): string {
  return createHash("sha256")
    .update("universe-attestation-journal-v1:" + canonicalJson(record))
    .digest("hex");
}

function journalResultFingerprint(
  expectedCheckpointFingerprint: string,
  recordFingerprint: string,
): string {
  return createHash("sha256")
    .update(
      "universe-attestation-journal-state-v1:" +
        expectedCheckpointFingerprint + ":" + recordFingerprint,
    )
    .digest("hex");
}

function parseJournalRecord(line: string): AttestationJournalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      "universe rebuild attestation journal is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const record = parsed as AttestationJournalRecord;
  if (
    typeof record !== "object" ||
    record === null ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.expectedRevision) ||
    !Number.isSafeInteger(record.resultRevision) ||
    record.resultRevision !== record.expectedRevision + 1 ||
    typeof record.expectedCheckpointFingerprint !== "string" ||
    typeof record.resultCheckpointFingerprint !== "string" ||
    typeof record.runId !== "string" ||
    record.runId.length === 0 ||
    !Array.isArray(record.writes) ||
    record.writes.length === 0 ||
    typeof record.recordFingerprint !== "string"
  ) {
    throw new Error("universe rebuild attestation journal record is invalid");
  }
  const {
    recordFingerprint,
    resultCheckpointFingerprint,
    ...unsigned
  } = record;
  if (
    !/^[0-9a-f]{64}$/.test(recordFingerprint) ||
    journalRecordFingerprint(unsigned) !== recordFingerprint ||
    journalResultFingerprint(
      record.expectedCheckpointFingerprint,
      recordFingerprint,
    ) !== resultCheckpointFingerprint
  ) {
    throw new Error(
      "universe rebuild attestation journal fingerprint mismatch",
    );
  }
  return record;
}

/**
 * Single-writer file-backed CAS store. Every mutation is read-verify-apply
 * with an expected revision, temp-file + fsync + atomic rename + directory
 * fsync, and a sidecar lock file (matching the discovery checkpoint
 * backend). Corruption, tampering or a CAS conflict fail closed (throw);
 * a partial write can never become the incumbent envelope.
 */
export class UniverseRebuildCheckpointStore {
  readonly #path: string;
  readonly #journalPath: string;
  readonly #lockPath: string;
  readonly #lockWaitTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #readChunkBytes: number;
  #mutex: Promise<void> = Promise.resolve();
  #cachedEnvelope: StartupCheckpointEnvelope | null | undefined;
  #cachedBaseSignature: string | null = null;
  #cachedJournalSignature: string | null = null;
  #journalCommittedBytes = 0;
  #journalTotalBytes = 0;

  constructor(input: {
    readonly path: string;
    /** Bound for a different process's short atomic-write critical section. */
    readonly lockWaitTimeoutMs?: number;
    readonly lockRetryMs?: number;
    /** Test seam for proving that every JSON token may cross read chunks. */
    readonly readChunkBytes?: number;
  }) {
    this.#path = input.path;
    this.#journalPath = input.path + ".attestation-journal";
    this.#lockPath = input.path + ".lock";
    this.#lockWaitTimeoutMs = input.lockWaitTimeoutMs ?? 5_000;
    this.#lockRetryMs = input.lockRetryMs ?? 10;
    this.#readChunkBytes = input.readChunkBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.#lockWaitTimeoutMs) || this.#lockWaitTimeoutMs < 1) {
      throw new Error("universe rebuild checkpoint lock wait must be positive");
    }
    if (!Number.isSafeInteger(this.#lockRetryMs) || this.#lockRetryMs < 1) {
      throw new Error("universe rebuild checkpoint lock retry must be positive");
    }
    if (!Number.isSafeInteger(this.#readChunkBytes) || this.#readChunkBytes < 1) {
      throw new Error("universe rebuild checkpoint read chunk must be positive");
    }
  }

  async load(): Promise<StartupCheckpointEnvelope | null> {
    return this.#withLock(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await this.#acquireLock();
      try {
        return await this.#loadUnlocked();
      } finally {
        await unlink(this.#lockPath).catch(() => undefined);
      }
    });
  }

  async #fileSignature(path: string): Promise<string | null> {
    try {
      const value = await stat(path);
      return [
        value.dev,
        value.ino,
        value.size,
        value.mtimeMs,
      ].join(":");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async #remember(
    envelope: StartupCheckpointEnvelope | null,
  ): Promise<void> {
    this.#cachedEnvelope = envelope;
    [this.#cachedBaseSignature, this.#cachedJournalSignature] =
      await Promise.all([
        this.#fileSignature(this.#path),
        this.#fileSignature(this.#journalPath),
      ]);
  }

  async #loadUnlocked(): Promise<StartupCheckpointEnvelope | null> {
    const [baseSignature, journalSignature] = await Promise.all([
      this.#fileSignature(this.#path),
      this.#fileSignature(this.#journalPath),
    ]);
    if (
      this.#cachedEnvelope !== undefined &&
      baseSignature === this.#cachedBaseSignature &&
      journalSignature === this.#cachedJournalSignature
    ) {
      return this.#cachedEnvelope;
    }

    let parsed: Record<string, unknown> | null;
    try {
      parsed = await readTopLevelJsonObject(this.#path, this.#readChunkBytes);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "ENOENT") throw error;
      parsed = null;
    }
    let envelope = parsed === null ? null : parseEnvelopeValue(parsed);
    envelope = await this.#replayAttestationJournal(envelope);
    this.#cachedEnvelope = envelope;
    this.#cachedBaseSignature = baseSignature;
    this.#cachedJournalSignature = journalSignature;
    return envelope;
  }

  async #replayAttestationJournal(
    base: StartupCheckpointEnvelope | null,
  ): Promise<StartupCheckpointEnvelope | null> {
    let raw: Buffer;
    try {
      raw = await readFile(this.#journalPath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code === "ENOENT") {
        this.#journalCommittedBytes = 0;
        this.#journalTotalBytes = 0;
        return base;
      }
      throw error;
    }
    this.#journalTotalBytes = raw.byteLength;
    const lastNewline = raw.lastIndexOf(0x0a);
    this.#journalCommittedBytes = lastNewline < 0 ? 0 : lastNewline + 1;
    const committed = raw.subarray(0, this.#journalCommittedBytes)
      .toString("utf8");
    let current = base;
    for (const line of committed.split("\n")) {
      if (line.length === 0) continue;
      const record = parseJournalRecord(line);
      if (current === null) {
        throw new Error(
          "universe rebuild attestation journal has no base checkpoint",
        );
      }
      if (record.resultRevision <= current.revision) {
        if (record.resultRevision === current.revision) {
          throw new Error(
            "universe rebuild attestation journal compacted-state mismatch",
          );
        }
        continue;
      }
      if (
        record.expectedRevision !== current.revision ||
        record.expectedCheckpointFingerprint !==
          current.checkpointFingerprint
      ) {
        throw new Error(
          "universe rebuild attestation journal revision conflict",
        );
      }
      const next = mergeAttestationWrites(
        current,
        record.runId,
        record.writes,
      );
      if (next.revision !== record.resultRevision) {
        throw new Error(
          "universe rebuild attestation journal result mismatch",
        );
      }
      current = Object.freeze({
        ...next,
        checkpointFingerprint: record.resultCheckpointFingerprint,
      });
    }
    return current;
  }

  /**
   * Write the envelope one top-level field per chunk. Stringifying the
   * whole envelope (verifiedMemos + run outcomes + a ready generation with
   * its catalog/graph snapshots) pretty-printed exceeds V8's single-string
   * limit ("Invalid string length"); each field alone stays well under it.
   * The file remains plain JSON (JSON.parse-compatible).
   */
  async #writeEnvelope(
    path: string,
    envelope: StartupCheckpointEnvelope,
  ): Promise<void> {
    const field = (key: string, value: unknown): string =>
      JSON.stringify(key) + ":" + JSON.stringify(value);
    const file = await open(path, "w", 0o600);
    try {
      await file.write("{");
      await file.write(field("revision", envelope.revision) + ",");
      await file.write(field("verifiedMemos", envelope.verifiedMemos) + ",");
      await file.write(field("inProgressRun", envelope.inProgressRun) + ",");
      await file.write(
        field(
          "retryableAttemptsByCandidateKey",
          envelope.retryableAttemptsByCandidateKey,
        ) + ",",
      );
      await file.write(field("readyGeneration", envelope.readyGeneration) + ",");
      await file.write(field("checkpointFingerprint", envelope.checkpointFingerprint));
      await file.write("}\n");
    } finally {
      await file.close();
    }
  }

  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutex.then(fn, fn);
    this.#mutex = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Sidecar lock with stale-PID recovery: a crashed/killed writer leaves
   * the lock file behind, and the next writer must reclaim it once the
   * recorded holder PID is provably dead (ESRCH). A live holder is allowed
   * to finish its bounded atomic write so the startup writer and an explicit
   * single-pool probe remain one serialized writer instead of killing each
   * other. A holder that exceeds the bound still fails closed.
   */
  async #acquireLock(): Promise<void> {
    const deadline = Date.now() + this.#lockWaitTimeoutMs;
    while (true) {
      try {
        await writeFile(this.#lockPath, String(process.pid) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code !== "EEXIST") throw error;
      }
      let holderPid: number | null = null;
      try {
        const content = await readFile(this.#lockPath, "utf8");
        const parsed = Number(content.trim());
        holderPid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      } catch {
        holderPid = null;
      }
      let holderAlive = false;
      if (holderPid !== null) {
        try {
          process.kill(holderPid, 0);
          holderAlive = true;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
          if (code !== "ESRCH") throw error;
        }
      }
      if (!holderAlive) {
        await unlink(this.#lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "universe rebuild checkpoint CAS lock is held by writer " +
            holderPid,
        );
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(this.#lockRetryMs, deadline - Date.now()))
      );
    }
  }

  async #cas(
    expectedRevision: number | undefined,
    mutate: (current: StartupCheckpointEnvelope | null) => StartupCheckpointEnvelope,
  ): Promise<StartupCheckpointEnvelope> {
    return this.#withLock(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await this.#acquireLock();
      try {
        const current = await this.#loadUnlocked();
        if (
          expectedRevision !== undefined &&
          (current?.revision ?? 0) !== expectedRevision
        ) {
          throw new Error(
            "universe rebuild checkpoint CAS conflict: revision " +
              (current?.revision ?? 0) + " != expected " + expectedRevision,
          );
        }
        const next = mutate(current);
        if (next === current) return next;
        const sealed = sealEnvelope(next);
        const tmp = this.#path + ".tmp." + process.pid;
        await this.#writeEnvelope(tmp, sealed);
        const fs = await import("node:fs/promises");
        const file = await fs.open(tmp, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, this.#path);
        // The base now includes every replayed attestation delta. Removing
        // the old journal after the atomic rename is crash-safe: if a crash
        // happens between the two operations, replay skips records whose
        // result revision is already present in the new base.
        await unlink(this.#journalPath).catch((error) => {
          const code = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
          if (code !== "ENOENT") throw error;
        });
        await fs.open(dirname(this.#path), "r").then(async (dir) => {
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }).catch(() => {
          // Directory fsync is best-effort on platforms that refuse it.
        });
        this.#journalCommittedBytes = 0;
        this.#journalTotalBytes = 0;
        await this.#remember(sealed);
        return sealed;
      } finally {
        await import("node:fs/promises").then((fs) =>
          fs.unlink(this.#lockPath).catch(() => undefined)
        );
      }
    });
  }

  /** Append a batch of run outcomes (single CAS; never advances ready). */
  async casMergeRunOutcomes(
    runId: string,
    outcomes: readonly RunOutcome[],
  ): Promise<StartupCheckpointEnvelope> {
    return this.casMergeAttestationWrites(
      runId,
      outcomes.map((outcome) => Object.freeze({ outcome })),
    );
  }

  /**
   * Atomically merge attestation outcomes and their verified memos.  A
   * verified outcome can never become durable before the memo it names; a
   * crash therefore leaves either the old envelope or the complete pair.
   */
  async casMergeAttestationWrites(
    runId: string,
    writes: readonly AttestationCheckpointWrite[],
  ): Promise<StartupCheckpointEnvelope> {
    if (writes.length === 0) {
      throw new Error("universe rebuild checkpoint: empty outcome batch");
    }
    return this.#withLock(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await this.#acquireLock();
      try {
        const current = await this.#loadUnlocked();
        const next = mergeAttestationWrites(current, runId, writes);

        // A killed append may leave one unterminated suffix. It was never a
        // committed journal record, so remove it before extending the log;
        // every newline-terminated record was fingerprint-checked on load.
        if (this.#journalTotalBytes > this.#journalCommittedBytes) {
          const repair = await open(this.#journalPath, "r+");
          try {
            await repair.truncate(this.#journalCommittedBytes);
            await repair.sync();
          } finally {
            await repair.close();
          }
        }

        const unsigned = Object.freeze({
          version: 1 as const,
          expectedRevision: current!.revision,
          resultRevision: next.revision,
          expectedCheckpointFingerprint: current!.checkpointFingerprint,
          runId,
          writes: Object.freeze([...writes]),
        });
        const recordFingerprint = journalRecordFingerprint(unsigned);
        const resultCheckpointFingerprint = journalResultFingerprint(
          current!.checkpointFingerprint,
          recordFingerprint,
        );
        const record: AttestationJournalRecord = Object.freeze({
          ...unsigned,
          resultCheckpointFingerprint,
          recordFingerprint,
        });
        const journal = await open(this.#journalPath, "a", 0o600);
        try {
          await journal.writeFile(JSON.stringify(record) + "\n", "utf8");
          await journal.sync();
        } finally {
          await journal.close();
        }
        const journaled = Object.freeze({
          ...next,
          checkpointFingerprint: resultCheckpointFingerprint,
        });
        await this.#remember(journaled);
        this.#journalCommittedBytes = Number(
          (await stat(this.#journalPath)).size,
        );
        this.#journalTotalBytes = this.#journalCommittedBytes;
        return journaled;
      } finally {
        await unlink(this.#lockPath).catch(() => undefined);
      }
    });
  }

  /** Replace one retryable outcome, guarded by the attempt count. */
  async casReplaceRunOutcome(input: {
    readonly runId: string;
    readonly familyCandidateKey: string;
    readonly expectedAttemptCount: number;
    readonly nextOutcome: RunOutcome;
    readonly memo?: DurableVerifiedMemo;
  }): Promise<StartupCheckpointEnvelope> {
    return this.#cas(undefined, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const run = base.inProgressRun;
      if (run === null || run.runId !== input.runId) {
        throw new Error(
          "universe rebuild checkpoint: no matching in-progress run " +
            input.runId,
        );
      }
      const old = run.outcomesByCandidateKey[input.familyCandidateKey];
      if (
        old === undefined ||
        old.status !== "retryable" ||
        old.attemptCount !== input.expectedAttemptCount
      ) {
        throw new Error(
          "universe rebuild checkpoint: probe CAS conflict for " +
            input.familyCandidateKey,
        );
      }
      const memos: Record<string, DurableVerifiedMemo> = {
        ...base.verifiedMemos,
      };
      if (input.memo !== undefined) {
        assertMemoMatchesVerifiedOutcome(input.memo, input.nextOutcome);
        memos[input.memo.familyCandidateKey] = Object.freeze(input.memo);
      }
      if (input.nextOutcome.status === "verified") {
        const durableMemo = memos[input.familyCandidateKey];
        if (durableMemo === undefined) {
          throw new Error(
            "universe rebuild checkpoint: verified probe outcome has no memo",
          );
        }
        assertMemoMatchesVerifiedOutcome(durableMemo, input.nextOutcome);
      } else {
        if (input.memo !== undefined) {
          throw new Error(
            "universe rebuild checkpoint: non-verified probe carried memo",
          );
        }
        if (input.nextOutcome.status === "terminal-rejected") {
          delete memos[input.familyCandidateKey];
        }
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        verifiedMemos: Object.freeze(memos),
        inProgressRun: Object.freeze({
          ...run,
          outcomesByCandidateKey: Object.freeze({
            ...run.outcomesByCandidateKey,
            [input.familyCandidateKey]: input.nextOutcome,
          }),
        }),
      });
    });
  }

  /**
   * Replace one independently queued retryable.  A successful or terminal
   * probe removes it from the queue; a retryable result replaces it.  When a
   * rolling run inherited the same queue item, update that run outcome in the
   * same CAS so promotion cannot publish a stale retryable view.
   */
  async casReplaceQueuedRetryable(input: {
    readonly runId: string;
    readonly familyCandidateKey: string;
    readonly expectedAttemptCount: number;
    readonly nextOutcome: RunOutcome;
    readonly memo?: DurableVerifiedMemo;
  }): Promise<StartupCheckpointEnvelope> {
    return this.#cas(undefined, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const old = base.retryableAttemptsByCandidateKey[
        input.familyCandidateKey
      ];
      if (
        old === undefined ||
        old.runId !== input.runId ||
        old.attemptCount !== input.expectedAttemptCount
      ) {
        throw new Error(
          "universe rebuild checkpoint: queued probe CAS conflict for " +
            input.familyCandidateKey,
        );
      }
      const memos: Record<string, DurableVerifiedMemo> = {
        ...base.verifiedMemos,
      };
      if (input.memo !== undefined) {
        assertMemoMatchesVerifiedOutcome(input.memo, input.nextOutcome);
        memos[input.memo.familyCandidateKey] = Object.freeze(input.memo);
      }
      if (input.nextOutcome.status === "verified") {
        const durableMemo = memos[input.familyCandidateKey];
        if (durableMemo === undefined) {
          throw new Error(
            "universe rebuild checkpoint: verified queued probe has no memo",
          );
        }
        assertMemoMatchesVerifiedOutcome(durableMemo, input.nextOutcome);
      } else {
        if (input.memo !== undefined) {
          throw new Error(
            "universe rebuild checkpoint: non-verified queued probe carried memo",
          );
        }
        if (input.nextOutcome.status === "terminal-rejected") {
          delete memos[input.familyCandidateKey];
        }
      }
      const retryableQueue: Record<string, DurableRetryableQueueEntry> = {
        ...base.retryableAttemptsByCandidateKey,
      };
      if (input.nextOutcome.status === "retryable") {
        retryableQueue[input.familyCandidateKey] = Object.freeze({
          ...input.nextOutcome,
          runId: old.runId,
          cutoff: Object.freeze({ ...old.cutoff }),
        });
      } else {
        delete retryableQueue[input.familyCandidateKey];
      }
      const run = base.inProgressRun;
      const runOutcome = run?.outcomesByCandidateKey[
        input.familyCandidateKey
      ];
      const updateRun = run !== null &&
        runOutcome?.status === "retryable" &&
        runOutcome.attemptCount === input.expectedAttemptCount;
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        verifiedMemos: Object.freeze(memos),
        retryableAttemptsByCandidateKey: Object.freeze(retryableQueue),
        inProgressRun: updateRun
          ? Object.freeze({
              ...run,
              outcomesByCandidateKey: Object.freeze({
                ...run.outcomesByCandidateKey,
                [input.familyCandidateKey]: input.nextOutcome,
              }),
            })
          : run,
      });
    });
  }

  /** Atomically promote the completed run to the ready generation. */
  async casCommitReadyGeneration(input: {
    readonly expectedRevision: number;
    readonly runId: string;
    readonly ready: ReadyUniverseGeneration;
  }): Promise<StartupCheckpointEnvelope> {
    return this.#cas(input.expectedRevision, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const run = base.inProgressRun;
      if (run === null || run.runId !== input.runId) {
        throw new Error(
          "universe rebuild checkpoint: no matching in-progress run " +
            input.runId,
        );
      }
      assertReadyPromotion(base, run, input.ready);
      const retryableQueue: Record<string, DurableRetryableQueueEntry> = {
        ...base.retryableAttemptsByCandidateKey,
      };
      for (const candidateKey of Object.keys(run.candidatesByKey)) {
        delete retryableQueue[candidateKey];
      }
      for (const outcome of Object.values(run.outcomesByCandidateKey)) {
        if (outcome.status !== "retryable") continue;
        const incumbent = base.retryableAttemptsByCandidateKey[
          outcome.familyCandidateKey
        ];
        retryableQueue[outcome.familyCandidateKey] =
          incumbent !== undefined && queueEntryMatchesOutcome(incumbent, outcome)
            ? incumbent
            : Object.freeze({
                ...outcome,
                runId: run.runId,
                cutoff: Object.freeze({ ...run.cutoff }),
              });
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        // Every candidate is now accounted. Retryables remain durable in the
        // independent queue, while the completed run is no longer "in
        // progress" and the next startup may freeze a new rolling cutoff.
        inProgressRun: null,
        retryableAttemptsByCandidateKey: Object.freeze(retryableQueue),
        readyGeneration: Object.freeze(input.ready),
      });
    });
  }

  /** Create the fixed-cutoff run or return the existing one for it. */
  async beginOrResumeRun(input: {
    readonly expectedRevision: number;
    readonly runId: string;
    readonly cutoff: CanonicalSource;
    readonly fromBlock: number;
    readonly universeHash: string;
    readonly candidateSetHash: string;
    readonly candidateCount: number;
    readonly candidatesByKey: Readonly<Record<string, unknown>>;
    readonly observedThrough: { readonly number: number; readonly hash: string };
    readonly sourceReceipts: readonly DurableSourceReceipt[];
  }): Promise<StartupCheckpointEnvelope> {
    if (Object.keys(input.candidatesByKey).length !== input.candidateCount) {
      throw new Error(
        "universe rebuild checkpoint: candidate partition/count mismatch",
      );
    }
    assertCompleteSourceReceipts(input.sourceReceipts);
    assertSourceReceiptsBindRun(input.sourceReceipts, {
      cutoff: input.cutoff,
      fromBlock: input.fromBlock,
    });
    return this.#cas(input.expectedRevision, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const existing = base.inProgressRun;
      if (existing !== null) {
        if (existing.runId !== input.runId) {
          throw new Error(
            "universe rebuild checkpoint: another run is in progress (" +
              existing.runId + ")",
          );
        }
        if (
          existing.cutoff.number !== input.cutoff.number ||
          existing.cutoff.hash.toLowerCase() !== input.cutoff.hash.toLowerCase() ||
          existing.cutoff.generation !== input.cutoff.generation ||
          existing.fromBlock !== input.fromBlock ||
          existing.universeHash !== input.universeHash ||
          existing.candidateSetHash !== input.candidateSetHash ||
          existing.candidateCount !== input.candidateCount ||
          canonicalJson(existing.candidatesByKey) !==
            canonicalJson(input.candidatesByKey) ||
          existing.observedThrough.number !== input.observedThrough.number ||
          existing.observedThrough.hash.toLowerCase() !==
            input.observedThrough.hash.toLowerCase() ||
          canonicalJson(existing.sourceReceipts) !==
            canonicalJson(input.sourceReceipts)
        ) {
          throw new Error(
            "universe rebuild checkpoint: runId resumed with different fixed input",
          );
        }
        return base;
      }
      const inheritedOutcomes = inheritedQueuedRetryables(
        base.retryableAttemptsByCandidateKey,
        input.candidatesByKey,
      );
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        inProgressRun: Object.freeze({
          runId: input.runId,
          cutoff: Object.freeze({ ...input.cutoff }),
          fromBlock: input.fromBlock,
          universeHash: input.universeHash,
          candidateSetHash: input.candidateSetHash,
          candidateCount: input.candidateCount,
          candidatesByKey: Object.freeze({ ...input.candidatesByKey }),
          observedThrough: Object.freeze({ ...input.observedThrough }),
          sourceReceipts: Object.freeze([...input.sourceReceipts]),
          appliedThrough: null,
          outcomesByCandidateKey: Object.freeze(inheritedOutcomes),
        }),
      });
    });
  }
  /**
   * Discovery plan-change reconciliation: replace the SAME fixed run's
   * candidate partition and source receipts after a same-range re-scan with
   * the current catalog. The run's time identity is immutable — runId,
   * cutoff, fromBlock and observedThrough must be byte-identical — and only
   * universeHash/candidateSetHash/candidateCount/candidatesByKey/
   * sourceReceipts/outcomesByCandidateKey may change. Outcomes no longer
   * bound to the new partition are dropped (old outcomes are never
   * verification authority under a new discovery plan); verifiedMemos are
   * carried and every candidate re-enters findReusableMemo.
   */
  async reconcileFixedRunPlan(input: {
    readonly expectedRevision: number;
    readonly runId: string;
    readonly cutoff: CanonicalSource;
    readonly fromBlock: number;
    readonly universeHash: string;
    readonly candidateSetHash: string;
    readonly candidateCount: number;
    readonly candidatesByKey: Readonly<Record<string, unknown>>;
    readonly observedThrough: { readonly number: number; readonly hash: string };
    readonly sourceReceipts: readonly DurableSourceReceipt[];
  }): Promise<StartupCheckpointEnvelope> {
    if (Object.keys(input.candidatesByKey).length !== input.candidateCount) {
      throw new Error(
        "universe rebuild checkpoint: candidate partition/count mismatch",
      );
    }
    return this.#cas(input.expectedRevision, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const run = base.inProgressRun;
      if (run === null) {
        throw new Error("universe rebuild checkpoint: no run to reconcile");
      }
      if (run.runId !== input.runId) {
        throw new Error(
          "universe rebuild checkpoint: reconcile run id mismatch",
        );
      }
      // The run's time identity is checked FIRST: reconcile can never move
      // the cutoff/range, regardless of what the receipts claim.
      if (
        run.cutoff.number !== input.cutoff.number ||
        run.cutoff.hash.toLowerCase() !== input.cutoff.hash.toLowerCase() ||
        run.cutoff.generation !== input.cutoff.generation ||
        run.fromBlock !== input.fromBlock ||
        run.observedThrough.number !== input.observedThrough.number ||
        run.observedThrough.hash.toLowerCase() !==
          input.observedThrough.hash.toLowerCase()
      ) {
        throw new Error(
          "universe rebuild checkpoint: reconcile cannot change the fixed run range",
        );
      }
      assertCompleteSourceReceipts(input.sourceReceipts);
      assertSourceReceiptsBindRun(input.sourceReceipts, {
        cutoff: input.cutoff,
        fromBlock: input.fromBlock,
      });
      // Old outcomes are not verification authority under the new discovery
      // plan: keep only outcomes still bound to the new partition (their
      // verified memos stay and re-enter findReusableMemo; terminal outcomes
      // stay terminal; everything else is re-attested naturally).
      const keptKeys = new Set(Object.keys(input.candidatesByKey));
      const keptOutcomes: Record<string, RunOutcome> = {};
      for (const [key, outcome] of Object.entries(run.outcomesByCandidateKey)) {
        if (keptKeys.has(key)) keptOutcomes[key] = outcome;
      }
      for (const [key, outcome] of Object.entries(inheritedQueuedRetryables(
        base.retryableAttemptsByCandidateKey,
        input.candidatesByKey,
      ))) {
        if (keptOutcomes[key] === undefined) keptOutcomes[key] = outcome;
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        inProgressRun: Object.freeze({
          ...run,
          universeHash: input.universeHash,
          candidateSetHash: input.candidateSetHash,
          candidateCount: input.candidateCount,
          candidatesByKey: Object.freeze({ ...input.candidatesByKey }),
          sourceReceipts: Object.freeze([...input.sourceReceipts]),
          outcomesByCandidateKey: Object.freeze(keptOutcomes),
        }),
      });
    });
  }

  /**
   * One-time, atomic migration from deployed memos that predate permanent
   * candidate retention. The caller reconstructs the snapshot; this store
   * proves the old fingerprint, permits no other field drift, proves the new
   * snapshot-bound fingerprint, and updates any matching verified run outcome
   * in the same CAS.
   */
  async casUpgradeLegacyVerifiedMemos(input: {
    readonly expectedRevision: number;
    readonly upgrades: Readonly<Record<string, DurableVerifiedMemo>>;
  }): Promise<StartupCheckpointEnvelope> {
    return this.#cas(input.expectedRevision, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      const legacyEntries = Object.entries(base.verifiedMemos).filter(
        ([, memo]) => !hasDurableCandidateSnapshot(memo),
      );
      const legacyKeys = legacyEntries.map(([key]) => key).sort();
      const upgradeKeys = Object.keys(input.upgrades).sort();
      if (
        legacyKeys.length !== upgradeKeys.length ||
        legacyKeys.some((key, index) => key !== upgradeKeys[index])
      ) {
        throw new Error(
          "universe rebuild checkpoint: legacy memo upgrade set mismatch",
        );
      }
      if (legacyKeys.length === 0) return base;

      const memos: Record<string, DurableVerifiedMemo> = {
        ...base.verifiedMemos,
      };
      const outcomes = base.inProgressRun === null
        ? null
        : { ...base.inProgressRun.outcomesByCandidateKey };
      for (const [candidateKey, incumbent] of legacyEntries) {
        const legacy = incumbent as unknown as LegacyDurableVerifiedMemo;
        assertDurableVerifiedMemoFingerprint(legacy);
        const upgraded = input.upgrades[candidateKey];
        if (
          upgraded === undefined ||
          upgraded.familyCandidateKey !== candidateKey ||
          !hasDurableCandidateSnapshot(upgraded)
        ) {
          throw new Error(
            "universe rebuild checkpoint: invalid upgraded memo " + candidateKey,
          );
        }
        const oldStable = { ...legacy } as Record<string, unknown>;
        const newStable = { ...upgraded } as Record<string, unknown>;
        delete oldStable.memoFingerprint;
        delete newStable.memoFingerprint;
        delete newStable.candidateSnapshot;
        if (canonicalJson(oldStable) !== canonicalJson(newStable)) {
          throw new Error(
            "universe rebuild checkpoint: legacy memo upgrade changed authority " +
              candidateKey,
          );
        }
        assertDurableVerifiedMemoFingerprint(upgraded);
        memos[candidateKey] = Object.freeze(upgraded);

        const outcome = outcomes?.[candidateKey];
        if (outcome?.status === "verified") {
          if (outcome.memoFingerprint !== legacy.memoFingerprint) {
            throw new Error(
              "universe rebuild checkpoint: legacy memo outcome mismatch " +
                candidateKey,
            );
          }
          outcomes![candidateKey] = Object.freeze({
            ...outcome,
            memoFingerprint: upgraded.memoFingerprint,
          });
        }
      }
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        verifiedMemos: Object.freeze(memos),
        inProgressRun: base.inProgressRun === null
          ? null
          : Object.freeze({
              ...base.inProgressRun,
              outcomesByCandidateKey: Object.freeze(outcomes!),
            }),
      });
    });
  }


  /** Add/refresh one durable verified memo. */
  async casUpsertMemo(
    memo: DurableVerifiedMemo,
  ): Promise<StartupCheckpointEnvelope> {
    return this.#cas(undefined, (current) => {
      const base = current ?? UniverseRebuildCheckpointStore.emptyEnvelope();
      return Object.freeze({
        ...base,
        revision: base.revision + 1,
        verifiedMemos: Object.freeze({
          ...base.verifiedMemos,
          [memo.familyCandidateKey]: Object.freeze(memo),
        }),
      });
    });
  }

  /** Seal a fresh envelope for a brand-new checkpoint file. */
  static emptyEnvelope(): StartupCheckpointEnvelope {
    const base = Object.freeze({
      revision: 0,
      verifiedMemos: Object.freeze({}),
      inProgressRun: null,
      retryableAttemptsByCandidateKey: Object.freeze({}),
      readyGeneration: null,
    });
    return Object.freeze({
      ...base,
      revision: 1,
      checkpointFingerprint: envelopeFingerprint({
        ...base,
        revision: 1,
      }),
    });
  }
}

/**
 * Serial durable outcome writer (audit §4): workers hand completed outcomes
 * here; batches flush every N outcomes or after a max interval, and a
 * signal hook flushes pending outcomes before exit. A crash loses at most
 * the last batch; the store CAS never advances the ready generation.
 */
export class AttestationCheckpointWriter {
  readonly #store: UniverseRebuildCheckpointStore;
  readonly #runId: string;
  readonly #batchSize: number;
  readonly #maxIntervalMs: number;
  #pending: AttestationCheckpointWrite[] = [];
  #flushing: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: {
    readonly store: UniverseRebuildCheckpointStore;
    readonly runId: string;
    readonly batchSize?: number;
    readonly maxIntervalMs?: number;
  }) {
    this.#store = input.store;
    this.#runId = input.runId;
    this.#batchSize = input.batchSize ?? 25;
    this.#maxIntervalMs = input.maxIntervalMs ?? 5_000;
  }

  record(outcome: RunOutcome, memo?: DurableVerifiedMemo): void {
    this.#pending.push(Object.freeze({
      outcome,
      ...(memo === undefined ? {} : { memo }),
    }));
    if (this.#pending.length >= this.#batchSize) {
      void this.flush();
      return;
    }
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.flush();
      }, this.#maxIntervalMs);
      if (typeof this.#timer.unref === "function") this.#timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.#flushing !== null) return this.#flushing;
    if (this.#pending.length === 0) return;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // Drain until empty: records can arrive while the first CAS is in
    // flight, and a caller awaiting flush() must not finalize a run while a
    // second batch is still only in memory.
    this.#flushing = (async (): Promise<void> => {
      while (this.#pending.length > 0) {
        const batch = this.#pending.splice(0);
        await this.#store.casMergeAttestationWrites(this.#runId, batch);
      }
    })()
      .finally(() => {
        this.#flushing = null;
      });
    return this.#flushing;
  }

  /** Install SIGTERM/SIGINT flush (best-effort; kill -9 loses one batch). */
  installSignalFlush(input?: { readonly terminateAfterFlush?: boolean }): () => void {
    let terminating = false;
    const handle = (signal: "SIGTERM" | "SIGINT"): void => {
      if (terminating) return;
      if (input?.terminateAfterFlush !== true) {
        void this.flush();
        return;
      }
      terminating = true;
      remove();
      void this.flush().finally(() => {
        // Re-deliver after removing our listeners so the OS/default signal
        // semantics stop the startup process only after the durable flush.
        process.kill(process.pid, signal);
      });
    };
    const onTerm = (): void => handle("SIGTERM");
    const onInt = (): void => handle("SIGINT");
    const remove = (): void => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    };
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    return () => {
      remove();
    };
  }
}

function assertMemoMatchesVerifiedOutcome(
  memo: DurableVerifiedMemo,
  outcome: RunOutcome,
): asserts outcome is Extract<RunOutcome, { readonly status: "verified" }> {
  if (
    outcome.status !== "verified" ||
    memo.familyCandidateKey !== outcome.familyCandidateKey ||
    memo.familyInstanceKey !== outcome.familyInstanceKey ||
    memo.memoFingerprint !== outcome.memoFingerprint
  ) {
    throw new Error(
      "universe rebuild checkpoint: memo/outcome atomic pair mismatch",
    );
  }
}

function assertReadyPromotion(
  envelope: StartupCheckpointEnvelope,
  run: InProgressUniverseRun,
  ready: ReadyUniverseGeneration,
): void {
  const candidateKeys = Object.keys(run.candidatesByKey).sort();
  const outcomeEntries = Object.entries(run.outcomesByCandidateKey)
    .sort(([left], [right]) => left.localeCompare(right));
  const outcomes = outcomeEntries.map(([, outcome]) => outcome);
  if (
    candidateKeys.length !== run.candidateCount ||
    // Ready means the candidate partition is fully accounted. Retryable is a
    // real outcome (and stays out of Graph); a missing outcome is still
    // unaccounted and must keep the run in progress.
    outcomes.length !== run.candidateCount ||
    outcomeEntries.some(([key, outcome]) =>
      !candidateKeys.includes(key) ||
      outcome.familyCandidateKey !== key ||
      (outcome.status !== "verified" &&
        outcome.status !== "terminal-rejected" &&
        outcome.status !== "retryable")
    )
  ) {
    throw new Error(
      "universe rebuild checkpoint: ready promotion requires a valid candidate partition",
    );
  }
  const verified = outcomes.filter((outcome): outcome is Extract<
    RunOutcome,
    { readonly status: "verified" }
  > => outcome.status === "verified");
  const terminalRejected = outcomes.filter((outcome) =>
    outcome.status === "terminal-rejected"
  ).length;
  const retryable = outcomes.filter((outcome) =>
    outcome.status === "retryable"
  ).length;
  const accountingMatches = canonicalJson(ready.candidateAccounting) ===
    canonicalJson({
      total: run.candidateCount,
      verified: verified.length,
      terminalRejected,
      retryable,
      remainingUnaccounted: 0,
    });
  const expectedInstances = verified.map((outcome) => {
    const memo = envelope.verifiedMemos[outcome.familyCandidateKey];
    if (memo === undefined) {
      throw new Error(
        "universe rebuild checkpoint: ready promotion lost verified memo",
      );
    }
    assertMemoMatchesVerifiedOutcome(memo, outcome);
    return memo.familyInstanceKey;
  }).sort();
  const activeInstances = [...ready.activeInstanceKeys].sort();
  const sameInstances = expectedInstances.length === activeInstances.length &&
    expectedInstances.every((value, index) => value === activeInstances[index]) &&
    new Set(expectedInstances).size === expectedInstances.length &&
    new Set(activeInstances).size === activeInstances.length;
  const sameCutoff = ready.cutoff.number === run.cutoff.number &&
    ready.cutoff.hash.toLowerCase() === run.cutoff.hash.toLowerCase() &&
    ready.cutoff.generation === run.cutoff.generation;
  const observedMatches = ready.observedThrough.number ===
      run.observedThrough.number &&
    ready.observedThrough.hash.toLowerCase() ===
      run.observedThrough.hash.toLowerCase();
  const appliedAtCutoff = ready.appliedThrough.number === run.cutoff.number &&
    ready.appliedThrough.hash.toLowerCase() === run.cutoff.hash.toLowerCase();
  const graphRootMatches = ready.graphHash === createHash("sha256")
    .update("graph-v2:" + canonicalJson(ready.graphSnapshot))
    .digest("hex");
  const catalogRootMatches = ready.catalogHash === createHash("sha256")
    .update("catalog-v1:" + canonicalJson(ready.catalogSnapshot))
    .digest("hex");
  const publicationRootMatches = ready.publicationSetHash ===
    createHash("sha256")
      .update("publications-v2:" + canonicalJson(ready.catalogSnapshot))
      .digest("hex");
  const sourceReceipts = run.sourceReceipts;
  assertCompleteSourceReceipts(sourceReceipts);
  assertSourceReceiptsBindRun(sourceReceipts, run);
  const requiredCoverageKeys = new Set(sourceReceipts.flatMap((receipt) =>
    receipt.coverageKeys
  ));
  const coverageKeys = new Set(ready.sourceCoverage.map((coverage) =>
    coverage.familyId + "|" + coverage.sourceId
  ));
  const exactCoverageSet = requiredCoverageKeys.size === coverageKeys.size &&
    [...requiredCoverageKeys].every((key) => coverageKeys.has(key));
  if (
    !sameCutoff || !observedMatches || !appliedAtCutoff || !sameInstances ||
    !accountingMatches ||
    !graphRootMatches || !catalogRootMatches || !publicationRootMatches ||
    ready.universeRange.fromBlock !== run.fromBlock ||
    ready.universeRange.toBlock !== run.cutoff.number ||
    ready.universeHash !== run.universeHash ||
    ready.sourceCoverage.length === 0 || !exactCoverageSet ||
    coverageKeys.size !== ready.sourceCoverage.length ||
    ready.sourceCoverage.some((coverage) =>
      coverage.completeThroughBlock !== run.cutoff.number ||
      coverage.completeThroughHash?.toLowerCase() !==
        run.cutoff.hash.toLowerCase()
    )
  ) {
    throw new Error(
      "universe rebuild checkpoint: ready generation is not bound to completed run",
    );
  }
}

function assertCompleteSourceReceipts(
  receipts: readonly DurableSourceReceipt[],
): void {
  if (receipts.length === 0) {
    throw new Error(
      "universe rebuild checkpoint: source completion receipts are absent",
    );
  }
  const sourceKeys = new Set<string>();
  const coverageKeys = new Set<string>();
  for (const receipt of receipts) {
    if (
      !/^[0-9a-f]{64}$/.test(receipt.sourceKey) ||
      !/^[0-9a-f]{64}$/.test(receipt.queryFingerprint) ||
      !/^[0-9a-f]{64}$/.test(receipt.observationSetHash) ||
      receipt.providerIdentity.length === 0 ||
      !Number.isSafeInteger(receipt.fromBlock) ||
      !Number.isSafeInteger(receipt.toBlock) ||
      receipt.fromBlock < 0 ||
      receipt.toBlock < receipt.fromBlock ||
      receipt.cutoffNumber !== receipt.toBlock ||
      receipt.cutoffHash.toLowerCase() !==
        receipt.observedThrough.hash.toLowerCase() ||
      receipt.observedThrough.number !== receipt.cutoffNumber ||
      receipt.appliedThrough.number !== receipt.cutoffNumber ||
      receipt.appliedThrough.hash.toLowerCase() !==
        receipt.cutoffHash.toLowerCase() ||
      receipt.status !== "complete" ||
      receipt.retryableCount !== 0 ||
      receipt.coverageKeys.length === 0 ||
      receipt.completedChunks.length === 0 ||
      sourceKeys.has(receipt.sourceKey)
    ) {
      throw new Error(
        "universe rebuild checkpoint: source completion receipt is invalid",
      );
    }
    sourceKeys.add(receipt.sourceKey);
    let expectedFrom = receipt.fromBlock;
    for (const chunk of receipt.completedChunks) {
      if (
        chunk.fromBlock !== expectedFrom ||
        chunk.toBlock < chunk.fromBlock ||
        chunk.toBlock > receipt.toBlock ||
        !Number.isSafeInteger(chunk.resultCount) ||
        chunk.resultCount < 0 ||
        !/^[0-9a-f]{64}$/.test(chunk.resultHash)
      ) {
        throw new Error(
          "universe rebuild checkpoint: source chunk partition is invalid",
        );
      }
      expectedFrom = chunk.toBlock + 1;
    }
    if (expectedFrom !== receipt.toBlock + 1) {
      throw new Error(
        "universe rebuild checkpoint: source chunks do not cover exact range",
      );
    }
    const localCoverage = new Set(receipt.coverageKeys);
    if (localCoverage.size !== receipt.coverageKeys.length) {
      throw new Error(
        "universe rebuild checkpoint: source receipt repeats coverage key",
      );
    }
    for (const key of localCoverage) {
      if (coverageKeys.has(key) || !key.includes("|")) {
        throw new Error(
          "universe rebuild checkpoint: source coverage exact set is invalid",
        );
      }
      coverageKeys.add(key);
    }
  }
}

function assertSourceReceiptsBindRun(
  receipts: readonly DurableSourceReceipt[],
  run: {
    readonly cutoff: CanonicalSource;
    readonly fromBlock: number;
  },
): void {
  if (receipts.some((receipt) =>
    receipt.fromBlock !== run.fromBlock ||
    receipt.toBlock !== run.cutoff.number ||
    receipt.cutoffNumber !== run.cutoff.number ||
    receipt.cutoffHash.toLowerCase() !== run.cutoff.hash.toLowerCase() ||
    receipt.observedThrough.number !== run.cutoff.number ||
    receipt.observedThrough.hash.toLowerCase() !==
      run.cutoff.hash.toLowerCase() ||
    receipt.appliedThrough.number !== run.cutoff.number ||
    receipt.appliedThrough.hash.toLowerCase() !==
      run.cutoff.hash.toLowerCase()
  )) {
    throw new Error(
      "universe rebuild checkpoint: source receipt escaped fixed run",
    );
  }
}
