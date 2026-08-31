import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  createCandidateSet,
  createCandidateTerminalReceipt,
  createEligibleHeadRecord,
  createHeadOrphanReplacementLineage,
  createHeadTerminalReceipt,
  createPerformanceMetricSample,
  createPerformanceWindowReceipt,
  derivePerformanceGenerationSegments,
  decodeHardwareProfileObservationV1,
  decodePerformanceAdmissionOrphanReplacementLineage,
  decodePartitionedPerformanceFactBundle,
  decodePerformanceWindowCommitment,
  decodeProductionPerformanceProfile,
  hashCandidateBearingHeadSetRoot,
  hashCandidatePathTimingSampleRoot,
  hashCpuMemoryEventLoopRoot,
  hashFullHeadTimingSampleRoot,
  hashMetricRecomputationRoot,
  hashOrderedCandidateTerminalReceiptRoot,
  hashOrderedEligibleHeadRecordsRoot,
  hashOrderedHeadTerminalReceiptRoot,
  hashOrphanReplacementLineageRoot,
  hashPerformanceSemanticReceiptSetRoot,
  hashPerformanceGenerationSegmentRoot,
  hashPerformanceSixStepCompletionLineage,
  hashPerformanceWindowCommitment,
  hashProcessLogAnchor,
  hashQueueTelemetryRoot,
  hashResourceSampleRoot,
  hashTimingSampleRoot,
  hashWorkerRestartRoot,
  PERFORMANCE_ELIGIBILITY_RULE_HASH,
  performanceLaneCandidateRefV1,
  type CandidateTerminalReceiptV1,
  type PermitAccountingV1,
  type PerformanceMetricSampleV1,
  type PerformanceFactBundleV1,
  type QueueTelemetryV1,
  type ResourceSampleV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceAdmissionOrphanReplacementLineageV1,
  type ProductionPerformanceProfileV1,
} from "../../../specs/performance/src/index.ts";
import { routeAccountingRootV1 } from "../../search-pipeline/src/index.ts";
import {
  validateSchedulerPerformanceRangeFactValue,
  validateSchedulerWorkCompletionFactValue,
  type SchedulerPerformanceRangeFactV1,
  type SchedulerWorkCompletionFactV1,
} from "../../scheduler/src/index.ts";
import {
  validateProcessResourceObservationValue,
  type ProcessResourceObservationV1,
} from "../../process-resource-observer/src/index.ts";
import { decodeTerminalPhaseInvalidFactV1 } from "../../final-durable-window/src/index.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const EVENT_KIND = "aloha.searcher-production-evidence-event" as const;

export const PRODUCTION_EVIDENCE_NAMESPACES = Object.freeze({
  eligibleHeads: "searcher-production-evidence/eligible-heads/v1",
  headCoverage: "searcher-production-evidence/head-coverage/v1",
  routeDenominators: "searcher-production-evidence/route-denominators/v1",
  candidateSets: "searcher-production-evidence/candidate-sets/v1",
  performance: "searcher-production-evidence/performance/v1",
  producerTerminals: "searcher-production-evidence/producer-terminals/v1",
  /** Terminal-phase outcomes are validated by their own acceptance owner.
   * This observer checks their append-log framing but excludes their bytes
   * from the fixed 100-head F5 denominator and event root. */
  terminalPhase: "searcher-production-evidence/terminal-phase/v1",
} as const);

type EvidenceNamespace = typeof PRODUCTION_EVIDENCE_NAMESPACES[keyof typeof PRODUCTION_EVIDENCE_NAMESPACES];
type EventType =
  | "performance-window-basis"
  | "performance-window-commitment"
  | "eligible-head"
  | "orphan-replacement"
  | "head-coverage"
  | "route-denominator"
  | "candidate-set"
  | "performance-facts-incomplete"
  | "performance-facts-complete"
  | "producer-terminal"
  | "terminal-phase-invalid";

interface ReadonlySqliteStatement {
  all(...parameters: readonly (string | number | bigint | Uint8Array | null)[]): readonly unknown[];
}

interface ReadonlySqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): ReadonlySqliteStatement;
  close(): void;
}

function openReadonlySqliteDatabase(filename: string): ReadonlySqliteDatabase {
  return new DatabaseSync(filename, { readOnly: true }) as unknown as ReadonlySqliteDatabase;
}

export interface RawAppendRowV1 {
  readonly namespace: EvidenceNamespace;
  readonly sequence: string;
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly bytes: Uint8Array;
  readonly byteLength: string;
  readonly offsetStart: string;
  readonly offsetEnd: string;
}

interface ReleaseIdentityV1 {
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
}

interface ServingIdentityV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly sourceCoverageRoot: Hash;
}

type LaneV1 = "blockscan" | "backrun";

interface ObservedCoarseTimingV1 {
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: ObservedCurrentSourceLogicalFactsV1["source"];
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly admissionPolicyHash: Hash;
  readonly durationUs: string;
}

interface ObservedCurrentSourcePhysicalFactsV1 {
  readonly source: ObservedCurrentSourceLogicalFactsV1["source"];
  readonly elapsedUs: string;
  readonly logicalScopeFacts: readonly ObservedCurrentSourceLogicalFactsV1[];
  readonly logicalScopeFactsRoot: Hash;
}

interface ObservedCurrentSourceLogicalFactsV1 {
  readonly kind: "aloha.current-source-rpc.logical-scope-facts-v1";
  readonly lane: LaneV1;
  readonly correlationId: Hash;
  readonly source: Readonly<{
    readonly chainId: string;
    readonly number: string;
    readonly hash: Hash;
    readonly stateRoot: Hash;
  }>;
  readonly logicalReads: number;
  readonly settledHits: number;
  readonly inFlightJoins: number;
  readonly consumerAborts: number;
  readonly consumerDeadlines: number;
}

interface ObservedLaneTerminalV1 {
  readonly kind: "coverage" | "failure";
  readonly lane: LaneV1;
  readonly correlationId: Hash;
  readonly coverageRoot?: Hash;
}

interface ObservedCandidateTerminalV1 {
  readonly lane: LaneV1;
  readonly headHash: Hash;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly admissionPolicyHash: Hash;
  readonly candidateId: Hash;
  readonly performanceCandidateRef: Hash;
  readonly disposition: "selected" | "pruned" | "notProbed" | "failed";
  readonly terminalKind: "not-run" | "policyRejected" | "passed" | "retryable" | "invalidProgram" | "chainProvenRejected";
  readonly performanceOutcome: "verified" | "chain-proven-rejected" | "simulation-reverted" | "policy-rejected" | "retryable" | "invalid-program";
  readonly routeHash: Hash | null;
  readonly reasonCode: string | null;
  readonly evidenceHash: Hash | null;
  readonly policyTerminal: Readonly<Record<string, unknown>> | null;
  readonly terminalLineageHash: Hash | null;
  readonly sixStepEvidenceRoot: Hash | null;
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly timingUs: string;
  readonly timingRoot: Hash;
  readonly observationRoot: Hash;
}

interface ObservedCandidateLaneDenominatorV1 {
  readonly lane: LaneV1;
  readonly correlationId: Hash;
  readonly coverageRoot: Hash;
  readonly accountingRoot: Hash;
  readonly observationRoots: readonly Hash[];
  readonly observationSetRoot: Hash;
}

interface ObservedRouteAccountingEntryV1 {
  readonly candidateId: Hash;
  readonly legs: readonly Readonly<{
    readonly edgeId: Hash;
    readonly transitionRef: Hash;
    readonly inputAssetRef: Hash;
    readonly inputPortRef: Hash;
    readonly outputAssetRef: Hash;
    readonly outputPortRef: Hash;
  }>[];
  readonly disposition: ObservedCandidateTerminalV1["disposition"];
  readonly terminalKind: ObservedCandidateTerminalV1["terminalKind"];
  readonly routeHash: Hash | null;
  readonly reasonCode: string | null;
  readonly evidenceHash: Hash | null;
  readonly policyTerminal: Readonly<Record<string, unknown>> | null;
}

interface ObservedRouteAccountingV1 {
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly admissionPolicyHash: Hash;
  readonly enumerationTruncated: boolean;
  readonly observedUniqueCountLowerBound: string;
  readonly total: number;
  readonly selected: number;
  readonly pruned: number;
  readonly notProbed: number;
  readonly failed: number;
  readonly entries: readonly ObservedRouteAccountingEntryV1[];
  readonly root: Hash;
}

/** Independently validates the evidence transition from the search-pipeline
 * accounting terminal to the later Producer candidate observation. A passed
 * accounting entry intentionally has no evidence yet; its terminal lineage
 * and Six-Step evidence are issued only by the post-accounting observation. */
export function validateRawCandidateEvidenceJoinV1(
  entry: Pick<ObservedRouteAccountingEntryV1, "terminalKind" | "evidenceHash" | "reasonCode">,
  observation: Pick<ObservedCandidateTerminalV1, "terminalKind" | "evidenceHash" | "terminalLineageHash" | "sixStepEvidenceRoot">,
): void {
  if (entry.terminalKind !== observation.terminalKind) {
    throw new TypeError("raw candidate denominator terminal kind splice");
  }
  if (entry.terminalKind === "passed") {
    if (entry.reasonCode !== null
      || entry.evidenceHash !== null
      || observation.evidenceHash === null
      || observation.evidenceHash !== observation.terminalLineageHash
      || observation.sixStepEvidenceRoot === null) {
      throw new TypeError("raw passed candidate lineage evidence splice");
    }
    return;
  }
  if (entry.evidenceHash !== observation.evidenceHash
    || observation.terminalLineageHash !== null
    || observation.sixStepEvidenceRoot !== null) {
    throw new TypeError("raw non-passed candidate evidence splice");
  }
}

interface ObservedAccountedRouteDenominatorPayloadV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly lane: LaneV1;
  readonly correlationId: Hash;
  readonly coverageRoot: Hash;
  readonly denominatorKind: "accounted";
  readonly plannerCandidateIdentity: Readonly<{
    readonly planningProblemHash: Hash;
    readonly objectiveRef: Hash;
    readonly entryAssetRef: Hash;
    readonly returnAssetRef: Hash;
    readonly triggerRef: Hash;
    readonly affectedEdgeIdsRoot: Hash;
  }>;
  readonly accounting: ObservedRouteAccountingV1;
}

interface ObservedNoInputRouteDenominatorPayloadV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly lane: "backrun";
  readonly correlationId: Hash;
  readonly coverageRoot: Hash;
  readonly denominatorKind: "no-input";
  readonly pendingSnapshot: Readonly<{
    readonly pendingNumber: string;
    readonly parentHash: Hash;
    readonly orderedTransactionHashes: readonly Hash[];
    readonly orderedTransactionHashesRoot: Hash;
    readonly transactionCount: string;
    readonly snapshotHash: Hash;
  }>;
  readonly absenceEvidenceHash: Hash;
  readonly terminalLineageHash: Hash;
  readonly currentSource: ObservedCurrentSourceLogicalFactsV1;
}

type ObservedRouteDenominatorPayloadV1 =
  | ObservedAccountedRouteDenominatorPayloadV1
  | ObservedNoInputRouteDenominatorPayloadV1;

interface ObservedCandidateSetPayloadV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly candidateRefs: readonly Hash[];
  readonly observations: readonly ObservedCandidateTerminalV1[];
  readonly laneDenominators: readonly ObservedCandidateLaneDenominatorV1[];
  readonly candidateTerminalObservationSetRoot: Hash;
}

interface ObservedCoveragePayloadV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly currentSourceLogicalFacts: readonly ObservedCurrentSourceLogicalFactsV1[];
  readonly currentSourcePhysicalFacts: ObservedCurrentSourcePhysicalFactsV1 | null;
  readonly coarseTimingFacts: readonly ObservedCoarseTimingV1[];
  readonly laneTerminalFacts: readonly ObservedLaneTerminalV1[];
  readonly complete: boolean;
}

interface ObservedProducerSchedulerJoinV1 {
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly unsignedDryRunCandidateId: Hash;
  readonly unsignedDryRunLineageHash: Hash;
}

interface ObservedRuntimePerformanceFactsV1 {
  readonly schedulerRange: SchedulerPerformanceRangeFactV1;
  readonly schedulerCompletions: readonly SchedulerWorkCompletionFactV1[];
  readonly selectedSchedulerCompletion: SchedulerWorkCompletionFactV1 | null;
  readonly resource: ProcessResourceObservationV1;
  readonly producerSchedulerJoin: ObservedProducerSchedulerJoinV1 | null;
}

interface ObservedSixStepFactsV1 {
  readonly stage12: Readonly<Record<string, unknown>>;
  readonly stage36: Readonly<Record<string, unknown>>;
  readonly stage12Root: Hash;
  readonly stage36Root: Hash;
  readonly lineageRoot: Hash;
  readonly plannerExactProgramDurationUs: string;
}

interface ObservedCompletePerformancePayloadV1 {
  readonly admissionId: Hash;
  readonly terminalBindingRoot: Hash;
  readonly terminalId: Hash;
  readonly terminalMonotonicNs: string;
  readonly headHash: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidateSetRoot: Hash;
  readonly candidateCount: string;
  readonly runtimeFacts: ObservedRuntimePerformanceFactsV1;
  readonly sixStepFacts: ObservedSixStepFactsV1 | null;
}

interface ObservedProducerTerminalPayloadV1 {
  readonly terminalBindingRoot: Hash;
  readonly terminalId: Hash;
  readonly ordinal: string;
  readonly head: ObservedEligiblePayloadV1["head"];
  readonly revision: string;
  readonly status: "completed" | "failed" | "cancelled" | "dropped" | "rejected";
  readonly generationId: string | null;
  readonly graphRoot: Hash | null;
  readonly headFactsRoot: Hash | null;
}

interface ObservedEligiblePayloadV1 {
  readonly admissionId: Hash;
  readonly windowId: Hash | null;
  readonly ordinal: string;
  readonly head: Readonly<{
    readonly chainId: string;
    readonly number: string;
    readonly hash: Hash;
    readonly parentHash: Hash;
    readonly stateRoot: Hash;
  }>;
  readonly revision: string;
  readonly acceptedMonotonicNs: string;
  readonly lineage: PerformanceAdmissionOrphanReplacementLineageV1 | null;
}

export interface ObservedProductionEventV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof EVENT_KIND;
  readonly eventId: Hash;
  readonly eventType: EventType;
  readonly sequence: string;
  readonly namespace: EvidenceNamespace;
  readonly release: ReleaseIdentityV1;
  readonly runtimeAnchor: Readonly<Record<string, unknown>>;
  readonly serving: ServingIdentityV1 | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type RawPerformanceObservationStatusV1 = "raw-complete" | "incomplete" | "invalid";

export interface RawPerformanceObservationV1 {
  readonly kind: "aloha.raw-production-performance-observation-v1";
  readonly status: RawPerformanceObservationStatusV1;
  readonly reasons: readonly string[];
  readonly databaseSha256Before: Hash;
  readonly databaseSha256After: Hash;
  readonly storageSetRootBefore: Hash;
  readonly storageSetRootAfter: Hash;
  readonly sqliteSchemaRoot: Hash;
  readonly rawRowRoot: Hash;
  readonly eventRoot: Hash;
  readonly terminalPhaseRowCount: string;
  readonly terminalPhaseRowRoot: Hash;
  readonly sixStepWindowSelection: RawSixStepWindowSelectionV1 | null;
  readonly release: ReleaseIdentityV1 | null;
  readonly servingPartitions: readonly ServingIdentityV1[];
  readonly profile: ProductionPerformanceProfileV1 | null;
  readonly commitment: PerformanceWindowCommitmentV1 | null;
  readonly events: readonly ObservedProductionEventV1[];
  readonly bundle: PerformanceFactBundleV1 | null;
}

export interface RawSixStepWindowSelectionV1 {
  readonly finalDurableWindowId: Hash;
  readonly selectionPolicyDigest: Hash;
  readonly eligibleSuccessCount: string;
  readonly eligibleSuccessRoot: Hash;
  readonly selectedIndex: "0" | null;
  readonly selectedProducerTerminalId: Hash | null;
  readonly selectedPerformanceEventId: Hash | null;
  readonly selectedProducerTerminalEventId: Hash | null;
  readonly selectionRoot: Hash;
}

interface ObservedSqliteStorageSetV1 {
  readonly mainSha256: Hash;
  readonly root: Hash;
}

function observeSqliteStorageSet(databasePath: string): ObservedSqliteStorageSetV1 {
  const paths = [
    { role: "main" as const, path: databasePath, required: true },
    { role: "wal" as const, path: `${databasePath}-wal`, required: false },
  ];
  const files = paths.flatMap(file => {
    if (!existsSync(file.path)) {
      if (file.required) throw new TypeError(`production performance SQLite ${file.role} file is missing`);
      return [];
    }
    const bytes = readFileSync(file.path);
    return [Object.freeze({
      role: file.role,
      path: file.path,
      byteLength: bytes.byteLength.toString(),
      sha256: sha256Hex(bytes),
    })];
  });
  const main = files.find(file => file.role === "main");
  if (main === undefined) throw new TypeError("production performance SQLite main file is missing");
  return Object.freeze({
    mainSha256: main.sha256,
    root: hashDomain("aloha/raw-production-performance-sqlite-storage-set/v1", files),
  });
}

const EXPECTED_APPEND_TABLE_SQL = normalizeSql(`
  CREATE TABLE durable_append_log (
    namespace TEXT NOT NULL CHECK (length(namespace) > 0),
    sequence TEXT NOT NULL CHECK (sequence = '0' OR (length(sequence) > 0 AND sequence NOT LIKE '0%' AND sequence NOT GLOB '*[^0-9]*')),
    event_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL,
    byte_length TEXT NOT NULL CHECK (byte_length = '0' OR (length(byte_length) > 0 AND byte_length NOT LIKE '0%' AND byte_length NOT GLOB '*[^0-9]*')),
    offset_start TEXT NOT NULL CHECK (offset_start = '0' OR (length(offset_start) > 0 AND offset_start NOT LIKE '0%' AND offset_start NOT GLOB '*[^0-9]*')),
    offset_end TEXT NOT NULL CHECK (offset_end = '0' OR (length(offset_end) > 0 AND offset_end NOT LIKE '0%' AND offset_end NOT GLOB '*[^0-9]*')),
    PRIMARY KEY(namespace, sequence),
    UNIQUE(namespace, event_id)
  )
`);

const EXPECTED_CONTRACT_TABLE_SQL = normalizeSql(`
  CREATE TABLE durable_append_log_schema_contract (
    contract_id INTEGER PRIMARY KEY CHECK (contract_id = 1),
    schema_version TEXT NOT NULL,
    schema_digest TEXT NOT NULL,
    core_schema_digest TEXT NOT NULL,
    core_instance_nonce TEXT NOT NULL
  )
`);

const EXPECTED_NO_UPDATE_SQL = normalizeSql(`
  CREATE TRIGGER durable_append_log_no_update
  BEFORE UPDATE ON durable_append_log
  BEGIN
    SELECT RAISE(ABORT, 'durable append-log is append-only');
  END
`);

const EXPECTED_NO_DELETE_SQL = normalizeSql(`
  CREATE TRIGGER durable_append_log_no_delete
  BEFORE DELETE ON durable_append_log
  BEGIN
    SELECT RAISE(ABORT, 'durable append-log is append-only');
  END
`);

const EXPECTED_APPEND_SCHEMA_DIGEST = hashDomain(
  "aloha/durable-append-log-sqlite-schema/v1",
  {
    tables: [
      {
        name: "durable_append_log",
        sql: EXPECTED_APPEND_TABLE_SQL,
        columns: [
          { name: "namespace", type: "TEXT", notNull: 1, primaryKey: 1, defaultValue: null },
          { name: "sequence", type: "TEXT", notNull: 1, primaryKey: 2, defaultValue: null },
          { name: "event_id", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "content_sha256", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "bytes", type: "BLOB", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "byte_length", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "offset_start", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "offset_end", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
        ],
        indexes: [
          { unique: 1, origin: "u", partial: 0, columns: ["namespace", "event_id"] },
          { unique: 1, origin: "pk", partial: 0, columns: ["namespace", "sequence"] },
        ],
      },
      {
        name: "durable_append_log_schema_contract",
        sql: EXPECTED_CONTRACT_TABLE_SQL,
        columns: [
          { name: "contract_id", type: "INTEGER", notNull: 0, primaryKey: 1, defaultValue: null },
          { name: "schema_version", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "schema_digest", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "core_schema_digest", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
          { name: "core_instance_nonce", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
        ],
        indexes: [],
      },
    ],
    triggers: [
      { name: "durable_append_log_no_delete", tableName: "durable_append_log", sql: EXPECTED_NO_DELETE_SQL },
      { name: "durable_append_log_no_update", tableName: "durable_append_log", sql: EXPECTED_NO_UPDATE_SQL },
    ],
  },
);

const EVENT_NAMESPACE: Readonly<Record<EventType, EvidenceNamespace>> = Object.freeze({
  "performance-window-basis": PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads,
  "performance-window-commitment": PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads,
  "eligible-head": PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads,
  "orphan-replacement": PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads,
  "head-coverage": PRODUCTION_EVIDENCE_NAMESPACES.headCoverage,
  "route-denominator": PRODUCTION_EVIDENCE_NAMESPACES.routeDenominators,
  "candidate-set": PRODUCTION_EVIDENCE_NAMESPACES.candidateSets,
  "performance-facts-incomplete": PRODUCTION_EVIDENCE_NAMESPACES.performance,
  "performance-facts-complete": PRODUCTION_EVIDENCE_NAMESPACES.performance,
  "producer-terminal": PRODUCTION_EVIDENCE_NAMESPACES.producerTerminals,
  "terminal-phase-invalid": PRODUCTION_EVIDENCE_NAMESPACES.terminalPhase,
});

function normalizeSql(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/;$/, "").trim();
}

function nonZeroHash(value: unknown, path: string): Hash {
  const decoded = assertHash(value, path);
  if (decoded === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return decoded;
}

function canonicalBytes(value: unknown, path: string): Uint8Array {
  try {
    return encodeCanonicalBytes(value);
  } catch {
    throw new TypeError(`${path} is not canonical data`);
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const a = canonicalBytes(left, "left");
  const b = canonicalBytes(right, "right");
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

function nullableHash(value: unknown, path: string): Hash | null {
  return value === null ? null : nonZeroHash(value, path);
}

function lane(value: unknown, path: string): LaneV1 {
  if (value !== "blockscan" && value !== "backrun") throw new TypeError(`${path} is invalid`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function sortedUniqueHashes(value: unknown, path: string): readonly Hash[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const hashes = value.map((item, index) => nonZeroHash(item, `${path}[${index}]`));
  const sorted = [...hashes].sort();
  if (!sameCanonical(hashes, sorted)) throw new TypeError(`${path} must be sorted`);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1] === sorted[index]) throw new TypeError(`${path} contains a duplicate`);
  }
  return Object.freeze(sorted);
}

function exactPolicyTerminal(value: unknown, path: string): Readonly<Record<string, unknown>> {
  assertPlainObject(value, path);
  const record = value as Record<string, unknown>;
  if (record.kind === "aloha.route-policy-rejection-v1") {
    assertExactKeys(value, [
      "kind", "policyKind", "admissionPolicyHash", "planningProblemHash", "enumerationRoot",
      "candidateId", "candidateOrderKey", "routeHash", "receiptHash",
    ], path);
    if (record.policyKind !== "rankable-top-k" && record.policyKind !== "bounded-unranked-budget") {
      throw new TypeError(`${path} kind is invalid`);
    }
    const body = Object.freeze({
      kind: "aloha.route-policy-rejection-v1" as const,
      policyKind: record.policyKind,
      admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
      planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
      enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
      candidateId: nonZeroHash(record.candidateId, `${path}.candidateId`),
      candidateOrderKey: nonZeroHash(record.candidateOrderKey, `${path}.candidateOrderKey`),
      routeHash: nonZeroHash(record.routeHash, `${path}.routeHash`),
    });
    const receiptHash = nonZeroHash(record.receiptHash, `${path}.receiptHash`);
    if (receiptHash !== hashDomain("aloha/route-policy-rejection-receipt/v1", body)) {
      throw new TypeError(`${path}.receiptHash mismatch`);
    }
    return Object.freeze({ ...body, receiptHash });
  }
  assertExactKeys(value, [
    "kind", "policyKind", "admissionPolicyHash", "planningProblemHash", "enumerationRoot",
    "winnerCandidateId", "winnerTerminalLineageHash", "candidateId", "routeHash", "decisionMonotonicNs", "receiptHash",
  ], path);
  if (record.kind !== "aloha.route-post-success-policy-terminal-v1" || record.policyKind !== "post-success-first-eligible") {
    throw new TypeError(`${path} kind is invalid`);
  }
  const body = Object.freeze({
    kind: "aloha.route-post-success-policy-terminal-v1" as const,
    policyKind: "post-success-first-eligible" as const,
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    winnerCandidateId: nonZeroHash(record.winnerCandidateId, `${path}.winnerCandidateId`),
    winnerTerminalLineageHash: nonZeroHash(record.winnerTerminalLineageHash, `${path}.winnerTerminalLineageHash`),
    candidateId: nonZeroHash(record.candidateId, `${path}.candidateId`),
    routeHash: nonZeroHash(record.routeHash, `${path}.routeHash`),
    decisionMonotonicNs: assertDecimalString(record.decisionMonotonicNs, `${path}.decisionMonotonicNs`),
  });
  const receiptHash = nonZeroHash(record.receiptHash, `${path}.receiptHash`);
  if (receiptHash !== hashDomain("aloha/route-post-success-policy-terminal-receipt/v1", body)) {
    throw new TypeError(`${path}.receiptHash mismatch`);
  }
  return Object.freeze({ ...body, receiptHash });
}

function exactRouteAccounting(value: unknown, path: string): ObservedRouteAccountingV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "planningProblemHash", "enumerationRoot", "admissionPolicyHash", "enumerationTruncated",
    "observedUniqueCountLowerBound", "total", "selected", "pruned", "notProbed", "failed", "entries", "root",
  ], path);
  const record = value as Record<string, unknown>;
  if (typeof record.enumerationTruncated !== "boolean") throw new TypeError(`${path}.enumerationTruncated is invalid`);
  const observedUniqueCountLowerBound = assertDecimalString(record.observedUniqueCountLowerBound, `${path}.observedUniqueCountLowerBound`);
  if (!Array.isArray(record.entries)) throw new TypeError(`${path}.entries must be an array`);
  const entries = Object.freeze(record.entries.map((entry, index): ObservedRouteAccountingEntryV1 => {
    const entryPath = `${path}.entries[${index}]`;
    assertPlainObject(entry, entryPath);
    assertExactKeys(entry, ["candidateId", "legs", "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal"], entryPath);
    const item = entry as Record<string, unknown>;
    if (!Array.isArray(item.legs) || item.legs.length < 2) throw new TypeError(`${entryPath}.legs is invalid`);
    const legs = Object.freeze(item.legs.map((leg, legIndex) => {
      const legPath = `${entryPath}.legs[${legIndex}]`;
      assertPlainObject(leg, legPath);
      assertExactKeys(leg, ["edgeId", "transitionRef", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef"], legPath);
      const value = leg as Record<string, unknown>;
      return Object.freeze({
        edgeId: nonZeroHash(value.edgeId, `${legPath}.edgeId`),
        transitionRef: nonZeroHash(value.transitionRef, `${legPath}.transitionRef`),
        inputAssetRef: nonZeroHash(value.inputAssetRef, `${legPath}.inputAssetRef`),
        inputPortRef: nonZeroHash(value.inputPortRef, `${legPath}.inputPortRef`),
        outputAssetRef: nonZeroHash(value.outputAssetRef, `${legPath}.outputAssetRef`),
        outputPortRef: nonZeroHash(value.outputPortRef, `${legPath}.outputPortRef`),
      });
    }));
    if (item.disposition !== "selected" && item.disposition !== "pruned" && item.disposition !== "notProbed" && item.disposition !== "failed") {
      throw new TypeError(`${entryPath}.disposition is invalid`);
    }
    if (item.terminalKind !== "not-run" && item.terminalKind !== "policyRejected" && item.terminalKind !== "passed"
      && item.terminalKind !== "retryable" && item.terminalKind !== "invalidProgram" && item.terminalKind !== "chainProvenRejected") {
      throw new TypeError(`${entryPath}.terminalKind is invalid`);
    }
    const policyTerminal = item.policyTerminal === null ? null : exactPolicyTerminal(item.policyTerminal, `${entryPath}.policyTerminal`);
    const normalized: ObservedRouteAccountingEntryV1 = Object.freeze({
      candidateId: nonZeroHash(item.candidateId, `${entryPath}.candidateId`),
      legs,
      disposition: item.disposition,
      terminalKind: item.terminalKind,
      routeHash: nullableHash(item.routeHash, `${entryPath}.routeHash`),
      reasonCode: item.reasonCode === null ? null : assertNonEmptyString(item.reasonCode, `${entryPath}.reasonCode`),
      evidenceHash: nullableHash(item.evidenceHash, `${entryPath}.evidenceHash`),
      policyTerminal,
    });
    if ((normalized.terminalKind === "policyRejected") !== (policyTerminal !== null)
      || (policyTerminal !== null && (policyTerminal.candidateId !== normalized.candidateId || policyTerminal.routeHash !== normalized.routeHash))) {
      throw new TypeError(`${entryPath} policy terminal mismatch`);
    }
    return normalized;
  }));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.candidateId >= entries[index]!.candidateId) throw new TypeError(`${path}.entries order mismatch`);
  }
  const counts = {
    total: nonNegativeSafeInteger(record.total, `${path}.total`),
    selected: nonNegativeSafeInteger(record.selected, `${path}.selected`),
    pruned: nonNegativeSafeInteger(record.pruned, `${path}.pruned`),
    notProbed: nonNegativeSafeInteger(record.notProbed, `${path}.notProbed`),
    failed: nonNegativeSafeInteger(record.failed, `${path}.failed`),
  };
  if (counts.total !== entries.length
    || counts.selected !== entries.filter(entry => entry.disposition === "selected").length
    || counts.pruned !== entries.filter(entry => entry.disposition === "pruned").length
    || counts.notProbed !== entries.filter(entry => entry.disposition === "notProbed").length
    || counts.failed !== entries.filter(entry => entry.disposition === "failed").length
    || counts.selected + counts.pruned + counts.notProbed + counts.failed !== counts.total
    || BigInt(observedUniqueCountLowerBound) < BigInt(counts.total)
    || (!record.enumerationTruncated && BigInt(observedUniqueCountLowerBound) !== BigInt(counts.total))) {
    throw new TypeError(`${path} denominator counts mismatch`);
  }
  const payload = Object.freeze({
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    enumerationTruncated: record.enumerationTruncated,
    observedUniqueCountLowerBound,
    ...counts,
    entries,
  });
  const root = nonZeroHash(record.root, `${path}.root`);
  if (root !== routeAccountingRootV1(payload as never)) throw new TypeError(`${path}.root mismatch`);
  return Object.freeze({ ...payload, root });
}

function exactRouteDenominatorPayload(value: Readonly<Record<string, unknown>>, path: string): ObservedRouteDenominatorPayloadV1 {
  const observedLane = lane(value.lane, `${path}.lane`);
  const common = Object.freeze({
    admissionId: nonZeroHash(value.admissionId, `${path}.admissionId`),
    headFactsRoot: nonZeroHash(value.headFactsRoot, `${path}.headFactsRoot`),
    headHash: nonZeroHash(value.headHash, `${path}.headHash`),
    correlationId: nonZeroHash(value.correlationId, `${path}.correlationId`),
    coverageRoot: nonZeroHash(value.coverageRoot, `${path}.coverageRoot`),
  });
  if (value.denominatorKind === "no-input") {
    assertExactKeys(value, [
      "admissionId", "headFactsRoot", "headHash", "lane", "correlationId", "coverageRoot", "denominatorKind",
      "pendingSnapshot", "absenceEvidenceHash", "terminalLineageHash", "currentSource",
    ], path);
    if (observedLane !== "backrun") throw new TypeError(`${path} no-input denominator must be backrun`);
    const pendingSnapshot = exactPendingSnapshot(value.pendingSnapshot, `${path}.pendingSnapshot`);
    if (pendingSnapshot.transactionCount !== "0" || pendingSnapshot.orderedTransactionHashes.length !== 0) {
      throw new TypeError(`${path} no-input denominator snapshot is not empty`);
    }
    const currentSource = exactCurrentSourceLogicalFacts(value.currentSource, `${path}.currentSource`);
    if (currentSource.lane !== "backrun" || currentSource.correlationId !== common.correlationId) {
      throw new TypeError(`${path} no-input current-source identity mismatch`);
    }
    return Object.freeze({
      ...common,
      lane: "backrun" as const,
      denominatorKind: "no-input" as const,
      pendingSnapshot,
      absenceEvidenceHash: nonZeroHash(value.absenceEvidenceHash, `${path}.absenceEvidenceHash`),
      terminalLineageHash: nonZeroHash(value.terminalLineageHash, `${path}.terminalLineageHash`),
      currentSource,
    });
  }
  assertExactKeys(value, ["admissionId", "headFactsRoot", "headHash", "lane", "correlationId", "coverageRoot", "denominatorKind", "plannerCandidateIdentity", "accounting"], path);
  if (value.denominatorKind !== "accounted") throw new TypeError(`${path}.denominatorKind is invalid`);
  assertPlainObject(value.plannerCandidateIdentity, `${path}.plannerCandidateIdentity`);
  assertExactKeys(value.plannerCandidateIdentity, [
    "planningProblemHash", "objectiveRef", "entryAssetRef", "returnAssetRef", "triggerRef", "affectedEdgeIdsRoot",
  ], `${path}.plannerCandidateIdentity`);
  const rawIdentity = value.plannerCandidateIdentity as Record<string, unknown>;
  const plannerCandidateIdentity = Object.freeze({
    planningProblemHash: nonZeroHash(rawIdentity.planningProblemHash, `${path}.plannerCandidateIdentity.planningProblemHash`),
    objectiveRef: nonZeroHash(rawIdentity.objectiveRef, `${path}.plannerCandidateIdentity.objectiveRef`),
    entryAssetRef: nonZeroHash(rawIdentity.entryAssetRef, `${path}.plannerCandidateIdentity.entryAssetRef`),
    returnAssetRef: nonZeroHash(rawIdentity.returnAssetRef, `${path}.plannerCandidateIdentity.returnAssetRef`),
    triggerRef: nonZeroHash(rawIdentity.triggerRef, `${path}.plannerCandidateIdentity.triggerRef`),
    affectedEdgeIdsRoot: nonZeroHash(rawIdentity.affectedEdgeIdsRoot, `${path}.plannerCandidateIdentity.affectedEdgeIdsRoot`),
  });
  const accounting = exactRouteAccounting(value.accounting, `${path}.accounting`);
  if (plannerCandidateIdentity.planningProblemHash !== accounting.planningProblemHash
    || plannerCandidateIdentity.entryAssetRef !== plannerCandidateIdentity.returnAssetRef
    || accounting.entries.some(entry => entry.candidateId !== hashDomain("aloha/planner-route-candidate/v1", {
      planningProblemHash: plannerCandidateIdentity.planningProblemHash,
      objectiveRef: plannerCandidateIdentity.objectiveRef,
      entryAssetRef: plannerCandidateIdentity.entryAssetRef,
      returnAssetRef: plannerCandidateIdentity.returnAssetRef,
      legs: entry.legs,
    }))) {
    throw new TypeError(`${path}.plannerCandidateIdentity mismatch`);
  }
  return Object.freeze({
    ...common,
    lane: observedLane,
    denominatorKind: "accounted" as const,
    plannerCandidateIdentity,
    accounting,
  });
}

function performanceOutcome(
  terminalKind: "not-run" | "policyRejected" | "passed" | "retryable" | "invalidProgram" | "chainProvenRejected",
  reasonCode: unknown,
): ObservedCandidateTerminalV1["performanceOutcome"] {
  switch (terminalKind) {
    case "passed": return "verified";
    case "chainProvenRejected": return reasonCode === "final-sim:simulation-reverted" ? "simulation-reverted" : "chain-proven-rejected";
    case "policyRejected": return "policy-rejected";
    case "retryable":
    case "not-run": return "retryable";
    case "invalidProgram": return "invalid-program";
  }
}

function exactCandidateTerminalObservation(value: unknown, path: string): ObservedCandidateTerminalV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "lane", "headHash", "correlationId", "generationId", "graphRoot", "planningProblemHash",
    "enumerationRoot", "admissionPolicyHash", "candidateId", "performanceCandidateRef", "disposition", "terminalKind", "performanceOutcome",
    "routeHash", "reasonCode", "evidenceHash", "policyTerminal", "terminalLineageHash", "sixStepEvidenceRoot",
    "startedMonotonicNs", "finishedMonotonicNs", "timingUs", "timingRoot", "observationRoot",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.producer-candidate-terminal-observation-v1") throw new TypeError(`${path}.kind is invalid`);
  const observedLane = lane(record.lane, `${path}.lane`);
  if (record.disposition !== "selected" && record.disposition !== "pruned"
    && record.disposition !== "notProbed" && record.disposition !== "failed") {
    throw new TypeError(`${path}.disposition is invalid`);
  }
  if (record.terminalKind !== "not-run" && record.terminalKind !== "policyRejected"
    && record.terminalKind !== "passed" && record.terminalKind !== "retryable"
    && record.terminalKind !== "invalidProgram" && record.terminalKind !== "chainProvenRejected") {
    throw new TypeError(`${path}.terminalKind is invalid`);
  }
  const expectedOutcome = performanceOutcome(record.terminalKind, record.reasonCode);
  if (record.performanceOutcome !== expectedOutcome) throw new TypeError(`${path}.performanceOutcome mismatch`);
  const startedMonotonicNs = assertDecimalString(record.startedMonotonicNs, `${path}.startedMonotonicNs`);
  const finishedMonotonicNs = assertDecimalString(record.finishedMonotonicNs, `${path}.finishedMonotonicNs`);
  const timingUs = assertDecimalString(record.timingUs, `${path}.timingUs`);
  if (BigInt(finishedMonotonicNs) < BigInt(startedMonotonicNs)
    || timingUs !== ((BigInt(finishedMonotonicNs) - BigInt(startedMonotonicNs)) / 1_000n).toString()) {
    throw new TypeError(`${path} monotonic timing mismatch`);
  }
  const policyTerminal = record.policyTerminal === null ? null : exactPolicyTerminal(record.policyTerminal, `${path}.policyTerminal`);
  const timingPayload = Object.freeze({
    kind: "aloha.route-candidate-terminal-timing-facts-v1" as const,
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    candidateId: nonZeroHash(record.candidateId, `${path}.candidateId`),
    disposition: record.disposition,
    terminalKind: record.terminalKind,
    routeHash: nullableHash(record.routeHash, `${path}.routeHash`),
    reasonCode: record.reasonCode === null ? null : assertNonEmptyString(record.reasonCode, `${path}.reasonCode`),
    evidenceHash: nullableHash(record.evidenceHash, `${path}.evidenceHash`),
    policyTerminal,
    terminalLineageHash: nullableHash(record.terminalLineageHash, `${path}.terminalLineageHash`),
    sixStepEvidenceRoot: nullableHash(record.sixStepEvidenceRoot, `${path}.sixStepEvidenceRoot`),
    startedMonotonicNs,
    finishedMonotonicNs,
    timingUs,
  });
  const timingRoot = nonZeroHash(record.timingRoot, `${path}.timingRoot`);
  if (timingRoot !== hashDomain("aloha/route-candidate-terminal-timing-facts/v1", timingPayload)) {
    throw new TypeError(`${path}.timingRoot mismatch`);
  }
  const { kind: _timingKind, ...timingFields } = timingPayload;
  const performanceCandidateRef = nonZeroHash(record.performanceCandidateRef, `${path}.performanceCandidateRef`);
  if (performanceCandidateRef !== performanceLaneCandidateRefV1(observedLane, timingPayload.candidateId)) {
    throw new TypeError(`${path}.performanceCandidateRef mismatch`);
  }
  const payload = Object.freeze({
    kind: "aloha.producer-candidate-terminal-observation-v1" as const,
    lane: observedLane,
    headHash: nonZeroHash(record.headHash, `${path}.headHash`),
    ...timingFields,
    performanceCandidateRef,
    performanceOutcome: expectedOutcome,
    timingRoot,
  });
  if ((payload.terminalKind === "passed") !== (payload.terminalLineageHash !== null && payload.sixStepEvidenceRoot !== null)
    || (payload.terminalKind === "passed" && (payload.disposition !== "selected" || payload.evidenceHash !== payload.terminalLineageHash))
    || (payload.terminalKind === "policyRejected") !== (payload.policyTerminal !== null)
    || (payload.policyTerminal !== null && (payload.policyTerminal.candidateId !== payload.candidateId
      || payload.policyTerminal.routeHash !== payload.routeHash
      || payload.policyTerminal.admissionPolicyHash !== payload.admissionPolicyHash
      || payload.policyTerminal.planningProblemHash !== payload.planningProblemHash
      || payload.policyTerminal.enumerationRoot !== payload.enumerationRoot))
    || (payload.policyTerminal?.kind === "aloha.route-policy-rejection-v1" && payload.disposition !== "notProbed")
    || (payload.policyTerminal?.kind === "aloha.route-post-success-policy-terminal-v1"
      && (payload.disposition !== "selected" || payload.reasonCode !== "post-success:first-eligible" || payload.evidenceHash !== payload.policyTerminal.receiptHash))
    || (payload.terminalKind === "chainProvenRejected" && payload.disposition !== "pruned" && payload.disposition !== "selected")
    || (payload.performanceOutcome === "simulation-reverted"
      && (payload.disposition !== "selected" || payload.reasonCode !== "final-sim:simulation-reverted" || payload.evidenceHash === null))) {
    throw new TypeError(`${path} terminal semantics mismatch`);
  }
  if (payload.terminalKind === "not-run"
    || ((payload.terminalKind === "retryable" || payload.terminalKind === "invalidProgram") && payload.disposition !== "selected")
    || (payload.terminalKind === "chainProvenRejected" && payload.evidenceHash === null)
    || (payload.terminalKind === "chainProvenRejected" && payload.disposition === "selected"
      && (payload.reasonCode === null || !/^(exact|execution-program|final-sim|economics-safety):.+$/.test(payload.reasonCode)))
    || (payload.disposition === "pruned" && payload.terminalKind !== "chainProvenRejected")) {
    throw new TypeError(`${path} terminal/disposition matrix mismatch`);
  }
  const observationRoot = nonZeroHash(record.observationRoot, `${path}.observationRoot`);
  if (observationRoot !== hashDomain("aloha/producer-candidate-terminal-observation/v1", payload)) {
    throw new TypeError(`${path}.observationRoot mismatch`);
  }
  return Object.freeze({
    lane: observedLane,
    headHash: payload.headHash,
    correlationId: payload.correlationId,
    generationId: payload.generationId,
    graphRoot: payload.graphRoot,
    planningProblemHash: payload.planningProblemHash,
    enumerationRoot: payload.enumerationRoot,
    admissionPolicyHash: payload.admissionPolicyHash,
    candidateId: payload.candidateId,
    performanceCandidateRef,
    disposition: payload.disposition,
    terminalKind: payload.terminalKind,
    performanceOutcome: expectedOutcome,
    routeHash: payload.routeHash,
    reasonCode: payload.reasonCode,
    evidenceHash: payload.evidenceHash,
    policyTerminal: payload.policyTerminal,
    terminalLineageHash: payload.terminalLineageHash,
    sixStepEvidenceRoot: payload.sixStepEvidenceRoot,
    startedMonotonicNs: payload.startedMonotonicNs,
    finishedMonotonicNs: payload.finishedMonotonicNs,
    timingUs: payload.timingUs,
    timingRoot,
    observationRoot,
  });
}

function exactRelease(value: unknown, path: string): ReleaseIdentityV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    bindingId: nonZeroHash(record.bindingId, `${path}.bindingId`),
    releaseProvenanceHash: nonZeroHash(record.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    candidateReleaseCommit: gitSha40Schema.decode(record.candidateReleaseCommit, `${path}.candidateReleaseCommit`),
  });
}

function exactServing(value: unknown, path: string): ServingIdentityV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["generationId", "graphRoot", "readyRecordHash", "sourceCoverageRoot"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    readyRecordHash: nonZeroHash(record.readyRecordHash, `${path}.readyRecordHash`),
    sourceCoverageRoot: nonZeroHash(record.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
  });
}

function exactRuntimeAnchor(value: unknown, path: string): Readonly<Record<string, unknown>> {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "bindingId", "releaseProvenanceHash", "manifestHash", "manifestArtifactSha256", "runtimeArtifactRoot",
    "implementationClosureDigest", "candidateReleaseCommit", "entrypointSha256", "nodeExecutableSha256", "bundleModulePath",
    "bundleModuleSha256", "serviceName", "systemdUnit", "bootId", "invocationId", "logDevice", "logInode", "pid",
    "processStartTicks", "dryRun",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.searcher-runtime-anchor-v1" || record.dryRun !== true) throw new TypeError(`${path} kind/dryRun mismatch`);
  for (const key of [
    "bindingId", "releaseProvenanceHash", "manifestHash", "manifestArtifactSha256", "runtimeArtifactRoot",
    "implementationClosureDigest", "entrypointSha256", "nodeExecutableSha256", "bundleModuleSha256",
  ] as const) nonZeroHash(record[key], `${path}.${key}`);
  gitSha40Schema.decode(record.candidateReleaseCommit, `${path}.candidateReleaseCommit`);
  for (const key of ["serviceName", "systemdUnit", "bootId", "invocationId"] as const) assertNonEmptyString(record[key], `${path}.${key}`);
  for (const key of ["logDevice", "logInode", "pid", "processStartTicks"] as const) assertDecimalString(record[key], `${path}.${key}`);
  const bundleModulePath = assertNonEmptyString(record.bundleModulePath, `${path}.bundleModulePath`);
  if (!bundleModulePath.startsWith("/")) throw new TypeError(`${path}.bundleModulePath must be absolute`);
  return Object.freeze(record);
}

const MATERIAL_CHUNK_KIND = "aloha/searcher-production-evidence-material-chunk/v1";
const MATERIAL_INDEX_NAMESPACE = "searcher-production-evidence-material/v1";
function rawMaterialOrderedRoot(domain: string, values: readonly Hash[]): Hash {
  return hashCanonicalPartition(domain, values, 128);
}

function rawMaterialCount(value: string, path: string): number {
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`${path} exceeds the safe material bound`);
  return Number(count);
}

function rawSingleRow(database: ReadonlySqliteDatabase, sql: string, parameter: string): Record<string, unknown> | null {
  const rows = database.prepare(sql).all(parameter);
  if (rows.length > 1) throw new TypeError("production evidence material lookup is non-unique");
  const row = rows[0];
  if (row === undefined) return null;
  if (row === null || typeof row !== "object") throw new TypeError("production evidence material row is malformed");
  return row as Record<string, unknown>;
}

function rawMaterialize(
  database: ReadonlySqliteDatabase,
  rawManifest: unknown,
  expectedKind: "route-accounting-entries" | "candidate-terminal-observations",
  bindingRoot: Hash,
  entryRoot: (entry: Record<string, unknown>, ordinal: number) => Hash,
): readonly Record<string, unknown>[] {
  const path = `rawProductionEvidence.material.${expectedKind}`;
  assertPlainObject(rawManifest, path);
  assertExactKeys(rawManifest, [
    "schemaVersion", "kind", "materialKind", "bindingRoot", "entryCount", "chunkCount",
    "firstChunkHash", "entrySequenceRoot",
  ], path);
  const manifest = rawManifest as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || manifest.kind !== "aloha.searcher-production-evidence-material-manifest-v1"
    || manifest.materialKind !== expectedKind || nonZeroHash(manifest.bindingRoot, `${path}.bindingRoot`) !== bindingRoot) {
    throw new TypeError(`${path} schema/kind/binding mismatch`);
  }
  const entryCount = assertDecimalString(manifest.entryCount, `${path}.entryCount`);
  const chunkCount = assertDecimalString(manifest.chunkCount, `${path}.chunkCount`);
  const firstChunkHash = manifest.firstChunkHash === null ? null : nonZeroHash(manifest.firstChunkHash, `${path}.firstChunkHash`);
  const entrySequenceRoot = nonZeroHash(manifest.entrySequenceRoot, `${path}.entrySequenceRoot`);
  if ((entryCount === "0") !== (chunkCount === "0") || (chunkCount === "0") !== (firstChunkHash === null)) {
    throw new TypeError(`${path} manifest identity/count mismatch`);
  }
  const indexRows = database.prepare("SELECT content_hash FROM durable_index WHERE namespace=? AND object_key=?").all(MATERIAL_INDEX_NAMESPACE, bindingRoot);
  if (indexRows.length > 1) throw new TypeError(`${path} durable index is non-unique`);
  const indexedHash = indexRows.length === 0 ? null : nonZeroHash((indexRows[0] as Record<string, unknown>).content_hash, `${path}.index.contentHash`);
  if (indexedHash !== firstChunkHash) throw new TypeError(`${path} durable index mismatch`);
  const entries: Record<string, unknown>[] = [];
  const roots: Hash[] = [];
  const chunkHashes: Hash[] = [];
  let hash = firstChunkHash;
  while (hash !== null) {
    if (chunkHashes.includes(hash) || chunkHashes.length >= rawMaterialCount(chunkCount, `${path}.chunkCount`)) throw new TypeError(`${path} duplicate/cyclic/excess chunk`);
    const row = rawSingleRow(database, "SELECT hash,payload_hash,kind,bytes,references_json FROM durable_content WHERE hash=?", hash);
    if (row === null || row.kind !== MATERIAL_CHUNK_KIND || !(row.bytes instanceof Uint8Array) || typeof row.references_json !== "string") {
      throw new TypeError(`${path} chunk is missing or malformed`);
    }
    const bytes = Uint8Array.from(row.bytes);
    const payloadHash = nonZeroHash(row.payload_hash, `${path}.chunks[${chunkHashes.length}].payloadHash`);
    if (payloadHash !== sha256Hex(bytes)) throw new TypeError(`${path} chunk payload hash mismatch`);
    const parsedReferences = JSON.parse(row.references_json) as unknown;
    if (!Array.isArray(parsedReferences)) throw new TypeError(`${path} chunk references are malformed`);
    const references = parsedReferences.map((value, index) => nonZeroHash(value, `${path}.references[${index}]`)).sort();
    if (new Set(references).size !== references.length
      || hash !== hashDomain("aloha/durable-content-envelope/v1", { kind: MATERIAL_CHUNK_KIND, payloadHash, references })) {
      throw new TypeError(`${path} content envelope mismatch`);
    }
    const decoded = decodeCanonicalBytes(bytes);
    assertPlainObject(decoded, `${path}.chunks[${chunkHashes.length}]`);
    assertExactKeys(decoded, ["schemaVersion", "kind", "entries", "nextChunkHash"], `${path}.chunks[${chunkHashes.length}]`);
    const chunk = decoded as Record<string, unknown>;
    if (chunk.schemaVersion !== 1 || chunk.kind !== "aloha.searcher-production-evidence-material-chunk-v1"
      || !Array.isArray(chunk.entries) || chunk.entries.length === 0) throw new TypeError(`${path} chunk order/binding mismatch`);
    const nextChunkHash = chunk.nextChunkHash === null ? null : nonZeroHash(chunk.nextChunkHash, `${path}.nextChunkHash`);
    if (references.length !== (nextChunkHash === null ? 0 : 1) || (nextChunkHash !== null && references[0] !== nextChunkHash)) throw new TypeError(`${path} chunk reference mismatch`);
    for (let index = 0; index < chunk.entries.length; index += 1) {
      const entry = chunk.entries[index];
      assertPlainObject(entry, `${path}.entries[${entries.length}]`);
      const root = entryRoot(entry as Record<string, unknown>, entries.length);
      entries.push(entry as Record<string, unknown>);
      roots.push(root);
    }
    chunkHashes.push(hash);
    hash = nextChunkHash;
  }
  if (entries.length !== rawMaterialCount(entryCount, `${path}.entryCount`)
    || chunkHashes.length !== rawMaterialCount(chunkCount, `${path}.chunkCount`)
    || entrySequenceRoot !== rawMaterialOrderedRoot(`aloha/searcher-production-evidence-material/${expectedKind}/entries/v1`, roots)) {
    throw new TypeError(`${path} material closure mismatch`);
  }
  return Object.freeze(entries);
}

function rawMaterializedPayload(database: ReadonlySqliteDatabase, eventType: EventType, rawPayload: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (eventType === "route-denominator" && rawPayload.denominatorKind === "accounted") {
    assertPlainObject(rawPayload.accounting, "rawProductionEvidence.route.accounting");
    const accounting = rawPayload.accounting as Record<string, unknown>;
    const { material, ...withoutMaterial } = rawPayload;
    const bindingRoot = hashDomain("aloha/searcher-production-evidence-accounted-route-material-binding/v1", withoutMaterial as CanonicalJson);
    const entries = rawMaterialize(database, material, "route-accounting-entries", bindingRoot,
      (entry, ordinal) => hashDomain("aloha/route-accounting-entry/v1", { ordinal: String(ordinal), entry }));
    const { entryCount, entrySequenceRoot, ...accountingBody } = accounting;
    if (entryCount !== String(entries.length)
      || entrySequenceRoot !== rawMaterialOrderedRoot("aloha/searcher-production-evidence-material/route-accounting-entries/entries/v1", entries.map((entry, ordinal) => hashDomain("aloha/route-accounting-entry/v1", { ordinal: String(ordinal), entry })))) {
      throw new TypeError("raw route accounting material summary mismatch");
    }
    return Object.freeze({ ...withoutMaterial, accounting: Object.freeze({ ...accountingBody, entries }) });
  }
  if (eventType === "candidate-set") {
    const { material, ...wireWithoutMaterial } = rawPayload;
    const bindingRoot = hashDomain("aloha/searcher-production-evidence-candidate-material-binding/v1", wireWithoutMaterial as CanonicalJson);
    const { candidateRefCount, candidateRefsRoot, ...withoutMaterial } = wireWithoutMaterial;
    const observations = rawMaterialize(database, material, "candidate-terminal-observations", bindingRoot,
      entry => nonZeroHash(entry.observationRoot, "raw candidate observation root"));
    const candidateRefs = observations.map(entry => nonZeroHash(entry.performanceCandidateRef, "raw candidate performance ref")).sort();
    if (candidateRefCount !== String(candidateRefs.length)
      || candidateRefsRoot !== rawMaterialOrderedRoot("aloha/searcher-production-evidence-candidate-refs/v1", candidateRefs)) {
      throw new TypeError("raw candidate refs material closure mismatch");
    }
    if (!Array.isArray(withoutMaterial.laneDenominators)) throw new TypeError("raw candidate lane denominators are missing");
    const laneDenominators = withoutMaterial.laneDenominators.map((raw, index) => {
      assertPlainObject(raw, `raw candidate laneDenominators[${index}]`);
      const summary = raw as Record<string, unknown>;
      const observationRoots = observations.filter(observation => observation.lane === summary.lane).map(observation => nonZeroHash(observation.observationRoot, "raw candidate observation root"));
      return Object.freeze({ ...summary, observationRoots });
    });
    return Object.freeze({ ...withoutMaterial, candidateRefs, candidateTerminalObservations: observations, laneDenominators: Object.freeze(laneDenominators) });
  }
  return Object.freeze(rawPayload);
}

function exactEvent(row: RawAppendRowV1, database: ReadonlySqliteDatabase): ObservedProductionEventV1 {
  const decoded = decodeCanonicalBytes(row.bytes);
  const path = `rawProductionEvidence.${row.namespace}/${row.sequence}`;
  assertPlainObject(decoded, path);
  assertExactKeys(decoded, ["schemaVersion", "kind", "eventId", "eventType", "sequence", "namespace", "release", "runtimeAnchor", "serving", "payload"], path);
  const record = decoded as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== EVENT_KIND || typeof record.eventType !== "string" || !(record.eventType in EVENT_NAMESPACE)) {
    throw new TypeError(`${path} event schema/kind/type mismatch`);
  }
  const eventType = record.eventType as EventType;
  const namespace = EVENT_NAMESPACE[eventType];
  if (record.namespace !== namespace || row.namespace !== namespace || record.sequence !== row.sequence) throw new TypeError(`${path} namespace/sequence mismatch`);
  const release = exactRelease(record.release, `${path}.release`);
  const runtimeAnchor = exactRuntimeAnchor(record.runtimeAnchor, `${path}.runtimeAnchor`);
  const serving = record.serving === null ? null : exactServing(record.serving, `${path}.serving`);
  const generationNeutral = eventType === "performance-window-basis" || eventType === "performance-window-commitment"
    || eventType === "eligible-head" || eventType === "orphan-replacement";
  const servingRequired = eventType === "head-coverage" || eventType === "route-denominator" || eventType === "candidate-set" || eventType === "performance-facts-complete";
  if ((generationNeutral && serving !== null) || (servingRequired && serving === null)) throw new TypeError(`${path} serving binding phase mismatch`);
  if (runtimeAnchor.bindingId !== release.bindingId
    || runtimeAnchor.releaseProvenanceHash !== release.releaseProvenanceHash
    || runtimeAnchor.candidateReleaseCommit !== release.candidateReleaseCommit) throw new TypeError(`${path} runtime release mismatch`);
  assertPlainObject(record.payload, `${path}.payload`);
  const eventId = nonZeroHash(record.eventId, `${path}.eventId`);
  const withoutId = { ...record };
  delete withoutId.eventId;
  if (eventId !== hashDomain("aloha/searcher-production-evidence-event/v1", withoutId)) throw new TypeError(`${path}.eventId mismatch`);
  if (eventId !== row.eventId) throw new TypeError(`${path} row/event identity mismatch`);
  const payload = eventType === "terminal-phase-invalid"
    ? decodeTerminalPhaseInvalidFactV1(record.payload) as unknown as Readonly<Record<string, unknown>>
    : rawMaterializedPayload(database, eventType, record.payload as Record<string, unknown>);
  return Object.freeze({
    schemaVersion: 1,
    kind: EVENT_KIND,
    eventId,
    eventType,
    sequence: row.sequence,
    namespace,
    release,
    runtimeAnchor,
    serving,
    payload,
  });
}

function exactCanonicalHead(value: unknown, path: string): ObservedEligiblePayloadV1["head"] {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "parentHash", "stateRoot"], path);
  const rawHead = value as Record<string, unknown>;
  return Object.freeze({
    chainId: assertDecimalString(rawHead.chainId, `${path}.chainId`),
    number: assertDecimalString(rawHead.number, `${path}.number`),
    hash: nonZeroHash(rawHead.hash, `${path}.hash`),
    parentHash: nonZeroHash(rawHead.parentHash, `${path}.parentHash`),
    stateRoot: nonZeroHash(rawHead.stateRoot, `${path}.stateRoot`),
  });
}

function exactEligiblePayload(event: ObservedProductionEventV1, path: string): ObservedEligiblePayloadV1 {
  const value = event.payload;
  assertExactKeys(
    value,
    event.eventType === "eligible-head"
      ? ["admissionId", "windowId", "ordinal", "head", "revision", "acceptedMonotonicNs"]
      : ["admissionId", "windowId", "ordinal", "head", "revision", "acceptedMonotonicNs", "lineage"],
    path,
  );
  const payload = Object.freeze({
    admissionId: nonZeroHash(value.admissionId, `${path}.admissionId`),
    windowId: value.windowId === null ? null : nonZeroHash(value.windowId, `${path}.windowId`),
    ordinal: assertDecimalString(value.ordinal, `${path}.ordinal`),
    head: exactCanonicalHead(value.head, `${path}.head`),
    revision: assertDecimalString(value.revision, `${path}.revision`),
    acceptedMonotonicNs: assertDecimalString(value.acceptedMonotonicNs, `${path}.acceptedMonotonicNs`),
  });
  const expected = hashDomain("aloha/searcher-production-evidence-admission/v1", {
    release: event.release,
    runtimeAnchor: event.runtimeAnchor,
    windowId: payload.windowId,
    ordinal: payload.ordinal,
    head: payload.head,
    revision: payload.revision,
    acceptedMonotonicNs: payload.acceptedMonotonicNs,
  });
  if (payload.admissionId !== expected) throw new TypeError(`${path}.admissionId mismatch`);
  if (event.eventType === "eligible-head") {
    if (payload.revision !== "0") throw new TypeError(`${path}.revision requires an orphan-replacement event`);
    return Object.freeze({ ...payload, lineage: null });
  }
  if (event.eventType !== "orphan-replacement" || payload.windowId === null) {
    throw new TypeError(`${path} is not a replacement admission`);
  }
  const lineage = decodePerformanceAdmissionOrphanReplacementLineage(value.lineage as object);
  if (lineage.windowId !== payload.windowId
    || lineage.ordinal !== payload.ordinal
    || lineage.replacementAdmissionId !== payload.admissionId
    || !sameCanonical(lineage.replacementCanonicalHead, payload.head)
    || lineage.replacementRevision !== payload.revision
    || lineage.replacementAcceptedMonotonicNs !== payload.acceptedMonotonicNs) {
    throw new TypeError(`${path}.lineage does not bind the replacement admission`);
  }
  return Object.freeze({ ...payload, lineage });
}

function exactCoarseTiming(value: unknown, path: string): ObservedCoarseTimingV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "correlationId", "generationId", "graphRoot", "source", "planningProblemHash", "enumerationRoot",
    "admissionPolicyHash", "startedMonotonicNs", "finishedMonotonicNs", "durationUs", "timingRoot",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.route-coarse-timing-facts-v1") throw new TypeError(`${path}.kind is invalid`);
  assertPlainObject(record.source, `${path}.source`);
  assertExactKeys(record.source, ["chainId", "number", "hash", "stateRoot"], `${path}.source`);
  const source = record.source as Record<string, unknown>;
  const startedMonotonicNs = assertDecimalString(record.startedMonotonicNs, `${path}.startedMonotonicNs`);
  const finishedMonotonicNs = assertDecimalString(record.finishedMonotonicNs, `${path}.finishedMonotonicNs`);
  const durationUs = assertDecimalString(record.durationUs, `${path}.durationUs`);
  if (BigInt(finishedMonotonicNs) < BigInt(startedMonotonicNs)
    || durationUs !== ((BigInt(finishedMonotonicNs) - BigInt(startedMonotonicNs)) / 1_000n).toString()) {
    throw new TypeError(`${path} monotonic timing mismatch`);
  }
  const payload = Object.freeze({
    kind: "aloha.route-coarse-timing-facts-v1" as const,
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    source: Object.freeze({
      chainId: assertDecimalString(source.chainId, `${path}.source.chainId`),
      number: assertDecimalString(source.number, `${path}.source.number`),
      hash: nonZeroHash(source.hash, `${path}.source.hash`),
      stateRoot: nonZeroHash(source.stateRoot, `${path}.source.stateRoot`),
    }),
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    startedMonotonicNs,
    finishedMonotonicNs,
    durationUs,
  });
  if (nonZeroHash(record.timingRoot, `${path}.timingRoot`) !== hashDomain("aloha/route-coarse-timing-facts/v1", payload)) {
    throw new TypeError(`${path}.timingRoot mismatch`);
  }
  return Object.freeze({
    correlationId: payload.correlationId,
    generationId: payload.generationId,
    graphRoot: payload.graphRoot,
    source: payload.source,
    planningProblemHash: payload.planningProblemHash,
    enumerationRoot: payload.enumerationRoot,
    admissionPolicyHash: payload.admissionPolicyHash,
    durationUs: payload.durationUs,
  });
}

function exactCurrentSourceLogicalFacts(value: unknown, path: string): ObservedCurrentSourceLogicalFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "lane", "correlationId", "source", "logicalReads", "settledHits", "inFlightJoins",
    "consumerAborts", "consumerDeadlines",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.current-source-rpc.logical-scope-facts-v1") throw new TypeError(`${path}.kind is invalid`);
  assertPlainObject(record.source, `${path}.source`);
  assertExactKeys(record.source, ["chainId", "number", "hash", "stateRoot"], `${path}.source`);
  const source = record.source as Record<string, unknown>;
  return Object.freeze({
    kind: "aloha.current-source-rpc.logical-scope-facts-v1" as const,
    lane: lane(record.lane, `${path}.lane`),
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    source: Object.freeze({
      chainId: assertDecimalString(source.chainId, `${path}.source.chainId`),
      number: assertDecimalString(source.number, `${path}.source.number`),
      hash: nonZeroHash(source.hash, `${path}.source.hash`),
      stateRoot: nonZeroHash(source.stateRoot, `${path}.source.stateRoot`),
    }),
    logicalReads: nonNegativeSafeInteger(record.logicalReads, `${path}.logicalReads`),
    settledHits: nonNegativeSafeInteger(record.settledHits, `${path}.settledHits`),
    inFlightJoins: nonNegativeSafeInteger(record.inFlightJoins, `${path}.inFlightJoins`),
    consumerAborts: nonNegativeSafeInteger(record.consumerAborts, `${path}.consumerAborts`),
    consumerDeadlines: nonNegativeSafeInteger(record.consumerDeadlines, `${path}.consumerDeadlines`),
  });
}

function exactPendingSnapshot(value: unknown, path: string): ObservedNoInputRouteDenominatorPayloadV1["pendingSnapshot"] {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "pendingNumber", "parentHash", "orderedTransactionHashes",
    "orderedTransactionHashesRoot", "transactionCount", "snapshotHash",
  ], path);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.orderedTransactionHashes)) throw new TypeError(`${path}.orderedTransactionHashes must be an array`);
  const orderedTransactionHashes = Object.freeze(record.orderedTransactionHashes.map((item, index) => nonZeroHash(item, `${path}.orderedTransactionHashes[${index}]`)));
  const transactionCount = assertDecimalString(record.transactionCount, `${path}.transactionCount`);
  const orderedTransactionHashesRoot = nonZeroHash(record.orderedTransactionHashesRoot, `${path}.orderedTransactionHashesRoot`);
  if (transactionCount !== orderedTransactionHashes.length.toString()
    || orderedTransactionHashesRoot !== hashDomain("aloha/public-pending-transaction-set/v1", orderedTransactionHashes)) {
    throw new TypeError(`${path} transaction denominator mismatch`);
  }
  return Object.freeze({
    pendingNumber: assertDecimalString(record.pendingNumber, `${path}.pendingNumber`),
    parentHash: nonZeroHash(record.parentHash, `${path}.parentHash`),
    orderedTransactionHashes,
    orderedTransactionHashesRoot,
    transactionCount,
    snapshotHash: nonZeroHash(record.snapshotHash, `${path}.snapshotHash`),
  });
}

function exactCurrentSourcePhysicalFacts(value: unknown, path: string): ObservedCurrentSourcePhysicalFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "source", "openedMonotonicNs", "closedMonotonicNs", "elapsedUs", "logicalScopeFacts", "logicalScopeFactsRoot",
    "physicalBuilds", "buildFailures", "invalidResults", "physicalAborts", "settledEntries", "inFlightEntries", "consumers",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.current-source-rpc.physical-facts-v1") throw new TypeError(`${path}.kind is invalid`);
  assertPlainObject(record.source, `${path}.source`);
  assertExactKeys(record.source, ["chainId", "number", "hash", "stateRoot"], `${path}.source`);
  const source = record.source as Record<string, unknown>;
  assertDecimalString(source.chainId, `${path}.source.chainId`);
  assertDecimalString(source.number, `${path}.source.number`);
  nonZeroHash(source.hash, `${path}.source.hash`);
  nonZeroHash(source.stateRoot, `${path}.source.stateRoot`);
  const opened = assertDecimalString(record.openedMonotonicNs, `${path}.openedMonotonicNs`);
  const closed = assertDecimalString(record.closedMonotonicNs, `${path}.closedMonotonicNs`);
  const elapsedUs = assertDecimalString(record.elapsedUs, `${path}.elapsedUs`);
  if (BigInt(closed) < BigInt(opened) || elapsedUs !== ((BigInt(closed) - BigInt(opened)) / 1_000n).toString()) {
    throw new TypeError(`${path} monotonic timing mismatch`);
  }
  if (!Array.isArray(record.logicalScopeFacts) || record.logicalScopeFacts.length !== 2) {
    throw new TypeError(`${path}.logicalScopeFacts must contain both lanes`);
  }
  const logicalScopeFacts = record.logicalScopeFacts.map((item, index) => exactCurrentSourceLogicalFacts(item, `${path}.logicalScopeFacts[${index}]`));
  if (logicalScopeFacts[0]?.lane !== "blockscan" || logicalScopeFacts[1]?.lane !== "backrun") {
    throw new TypeError(`${path}.logicalScopeFacts lane order mismatch`);
  }
  const physicalSource = Object.freeze({
    chainId: assertDecimalString(source.chainId, `${path}.source.chainId`),
    number: assertDecimalString(source.number, `${path}.source.number`),
    hash: nonZeroHash(source.hash, `${path}.source.hash`),
    stateRoot: nonZeroHash(source.stateRoot, `${path}.source.stateRoot`),
  });
  if (logicalScopeFacts.some(fact => !sameCanonical(fact.source, physicalSource))) {
    throw new TypeError(`${path}.logicalScopeFacts source mismatch`);
  }
  const logicalScopeFactsRoot = nonZeroHash(record.logicalScopeFactsRoot, `${path}.logicalScopeFactsRoot`);
  if (logicalScopeFactsRoot !== hashDomain("aloha/current-source-rpc/logical-scope-facts-root/v1", logicalScopeFacts)) {
    throw new TypeError(`${path}.logicalScopeFactsRoot mismatch`);
  }
  for (const key of ["physicalBuilds", "buildFailures", "invalidResults", "physicalAborts", "settledEntries", "inFlightEntries", "consumers"] as const) {
    nonNegativeSafeInteger(record[key], `${path}.${key}`);
  }
  if (record.inFlightEntries !== 0 || record.consumers !== 0) throw new TypeError(`${path} is not sealed`);
  return Object.freeze({
    source: physicalSource,
    elapsedUs,
    logicalScopeFacts: Object.freeze(logicalScopeFacts),
    logicalScopeFactsRoot,
  });
}

function exactCoveragePayload(value: Readonly<Record<string, unknown>>, path: string): ObservedCoveragePayloadV1 {
  assertExactKeys(value, [
    "admissionId", "headFactsRoot", "headHash", "sourceCoverageRoot", "currentSourceLogicalFacts",
    "currentSourcePhysicalFacts", "currentSourcePhysicalFactsRoot", "coarseTimingFacts", "coarseTimingFactsRoot",
    "laneTerminalFacts", "laneTerminalFactsRoot", "complete",
  ], path);
  if (!Array.isArray(value.currentSourceLogicalFacts) || value.currentSourceLogicalFacts.length > 2) {
    throw new TypeError(`${path}.currentSourceLogicalFacts is invalid`);
  }
  const currentSourceLogicalFacts = Object.freeze(value.currentSourceLogicalFacts.map(
    (facts, index) => exactCurrentSourceLogicalFacts(facts, `${path}.currentSourceLogicalFacts[${index}]`),
  ));
  if (currentSourceLogicalFacts.length === 2
    && (currentSourceLogicalFacts[0]?.lane !== "blockscan" || currentSourceLogicalFacts[1]?.lane !== "backrun")) {
    throw new TypeError(`${path}.currentSourceLogicalFacts ordering is invalid`);
  }
  if ((value.currentSourcePhysicalFacts === null) !== (value.currentSourcePhysicalFactsRoot === null)) {
    throw new TypeError(`${path} current-source physical facts/root nullability mismatch`);
  }
  const currentSourcePhysicalFacts = value.currentSourcePhysicalFacts === null
    ? null
    : exactCurrentSourcePhysicalFacts(value.currentSourcePhysicalFacts, `${path}.currentSourcePhysicalFacts`);
  if (currentSourcePhysicalFacts !== null
    && nonZeroHash(value.currentSourcePhysicalFactsRoot, `${path}.currentSourcePhysicalFactsRoot`)
      !== hashDomain("aloha/current-source-rpc-physical-facts/v1", value.currentSourcePhysicalFacts)) {
      throw new TypeError(`${path}.currentSourcePhysicalFactsRoot mismatch`);
  }
  if (currentSourcePhysicalFacts !== null
    && currentSourcePhysicalFacts.logicalScopeFactsRoot !== hashDomain(
      "aloha/current-source-rpc/logical-scope-facts-root/v1",
      currentSourceLogicalFacts,
    )) {
    throw new TypeError(`${path} top-level/physical current-source logical facts mismatch`);
  }
  if (!Array.isArray(value.coarseTimingFacts)) throw new TypeError(`${path}.coarseTimingFacts must be an array`);
  const coarseTimingFacts = Object.freeze(value.coarseTimingFacts.map((facts, index) => exactCoarseTiming(facts, `${path}.coarseTimingFacts[${index}]`)));
  if (nonZeroHash(value.coarseTimingFactsRoot, `${path}.coarseTimingFactsRoot`)
    !== hashDomain("aloha/route-coarse-timing-facts-set/v1", value.coarseTimingFacts)) {
    throw new TypeError(`${path}.coarseTimingFactsRoot mismatch`);
  }
  if (!Array.isArray(value.laneTerminalFacts)) throw new TypeError(`${path}.laneTerminalFacts must be an array`);
  const laneTerminalFacts = Object.freeze(value.laneTerminalFacts.map((item, index): ObservedLaneTerminalV1 => {
    const itemPath = `${path}.laneTerminalFacts[${index}]`;
    assertPlainObject(item, itemPath);
    const record = item as Record<string, unknown>;
    if (record.kind === "coverage") {
      assertExactKeys(record, ["kind", "lane", "correlationId", "coverageRoot"], itemPath);
      return Object.freeze({
        kind: "coverage" as const,
        lane: lane(record.lane, `${itemPath}.lane`),
        correlationId: nonZeroHash(record.correlationId, `${itemPath}.correlationId`),
        coverageRoot: nonZeroHash(record.coverageRoot, `${itemPath}.coverageRoot`),
      });
    }
    if (record.kind === "failure") {
      assertExactKeys(record, ["kind", "lane", "correlationId", "outcome", "reasonCode"], itemPath);
      if (record.outcome !== "retryable" && record.outcome !== "failed" && record.outcome !== "cancelled") {
        throw new TypeError(`${itemPath}.outcome is invalid`);
      }
      assertNonEmptyString(record.reasonCode, `${itemPath}.reasonCode`);
      return Object.freeze({
        kind: "failure" as const,
        lane: lane(record.lane, `${itemPath}.lane`),
        correlationId: nonZeroHash(record.correlationId, `${itemPath}.correlationId`),
      });
    }
    throw new TypeError(`${itemPath}.kind is invalid`);
  }));
  if (nonZeroHash(value.laneTerminalFactsRoot, `${path}.laneTerminalFactsRoot`)
    !== hashDomain("aloha/searcher-production-evidence-lane-terminal-facts-root/v1", value.laneTerminalFacts)) {
    throw new TypeError(`${path}.laneTerminalFactsRoot mismatch`);
  }
  if (new Set(laneTerminalFacts.map(item => item.lane)).size !== laneTerminalFacts.length) {
    throw new TypeError(`${path}.laneTerminalFacts contains a duplicate lane`);
  }
  if (laneTerminalFacts.length !== currentSourceLogicalFacts.length
    || laneTerminalFacts.some((fact, index) => fact.lane !== currentSourceLogicalFacts[index]?.lane
      || fact.correlationId !== currentSourceLogicalFacts[index]?.correlationId)) {
    throw new TypeError(`${path} lane/current-source coverage binding mismatch`);
  }
  if (typeof value.complete !== "boolean"
    || (value.complete && (currentSourcePhysicalFacts === null || laneTerminalFacts.some(item => item.kind !== "coverage")))) {
    throw new TypeError(`${path}.complete is invalid`);
  }
  return Object.freeze({
    admissionId: nonZeroHash(value.admissionId, `${path}.admissionId`),
    headFactsRoot: nonZeroHash(value.headFactsRoot, `${path}.headFactsRoot`),
    headHash: nonZeroHash(value.headHash, `${path}.headHash`),
    sourceCoverageRoot: nonZeroHash(value.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
    currentSourceLogicalFacts,
    currentSourcePhysicalFacts,
    coarseTimingFacts,
    laneTerminalFacts,
    complete: value.complete,
  });
}

function exactCandidateSetPayload(value: Readonly<Record<string, unknown>>, path: string): ObservedCandidateSetPayloadV1 {
  assertExactKeys(value, [
    "admissionId", "headFactsRoot", "headHash", "candidateRefs", "candidateTerminalObservations",
    "laneDenominators", "candidateTerminalObservationSetRoot",
  ], path);
  const candidateRefs = sortedUniqueHashes(value.candidateRefs, `${path}.candidateRefs`);
  if (!Array.isArray(value.candidateTerminalObservations)) throw new TypeError(`${path}.candidateTerminalObservations must be an array`);
  const observations = Object.freeze(value.candidateTerminalObservations.map((item, index) => exactCandidateTerminalObservation(item, `${path}.candidateTerminalObservations[${index}]`)));
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    const previousLane = previous.lane === "blockscan" ? 0 : 1;
    const currentLane = current.lane === "blockscan" ? 0 : 1;
    if (previousLane > currentLane || (previous.lane === current.lane && previous.candidateId >= current.candidateId)) {
      throw new TypeError(`${path}.candidateTerminalObservations order/identity mismatch`);
    }
  }
  for (const observation of observations) {
    if (observation.policyTerminal?.kind !== "aloha.route-post-success-policy-terminal-v1") continue;
    const winner = observations.find(candidate => candidate.lane === observation.lane
      && candidate.candidateId === observation.policyTerminal!.winnerCandidateId);
    if (winner?.terminalKind !== "passed"
      || winner.terminalLineageHash !== observation.policyTerminal.winnerTerminalLineageHash
      || observation.policyTerminal.decisionMonotonicNs !== observation.finishedMonotonicNs
      || winner.candidateId === observation.candidateId) {
      throw new TypeError(`${path}.post-success policy winner lineage mismatch`);
    }
  }
  const observedCandidateRefs = sortedUniqueHashes(observations.map(item => item.performanceCandidateRef).sort(), `${path}.observedCandidateRefs`);
  if (!sameCanonical(candidateRefs, observedCandidateRefs)) throw new TypeError(`${path}.candidateRefs denominator mismatch`);
  if (!Array.isArray(value.laneDenominators)) throw new TypeError(`${path}.laneDenominators must be an array`);
  const laneDenominators = Object.freeze(value.laneDenominators.map((item, index): ObservedCandidateLaneDenominatorV1 => {
    const itemPath = `${path}.laneDenominators[${index}]`;
    assertPlainObject(item, itemPath);
    assertExactKeys(item, ["lane", "correlationId", "coverageRoot", "accountingRoot", "candidateCount", "observationRoots", "observationSetRoot"], itemPath);
    const record = item as Record<string, unknown>;
    const itemLane = lane(record.lane, `${itemPath}.lane`);
    const laneObservations = observations.filter(observation => observation.lane === itemLane);
    if (!Array.isArray(record.observationRoots)) throw new TypeError(`${itemPath}.observationRoots must be an array`);
    const observationRoots = Object.freeze(record.observationRoots.map((root, rootIndex) => nonZeroHash(root, `${itemPath}.observationRoots[${rootIndex}]`)));
    if (!sameCanonical(observationRoots, laneObservations.map(observation => observation.observationRoot))) {
      throw new TypeError(`${itemPath}.observationRoots mismatch`);
    }
    if (assertDecimalString(record.candidateCount, `${itemPath}.candidateCount`) !== laneObservations.length.toString()) {
      throw new TypeError(`${itemPath}.candidateCount mismatch`);
    }
    const correlationId = nonZeroHash(record.correlationId, `${itemPath}.correlationId`);
    const accountingRoot = nonZeroHash(record.accountingRoot, `${itemPath}.accountingRoot`);
    const observationSetRoot = nonZeroHash(record.observationSetRoot, `${itemPath}.observationSetRoot`);
    if (laneObservations.some(observation => observation.correlationId !== correlationId)
      || observationSetRoot !== hashDomain("aloha/producer-lane-candidate-terminal-observation-set/v1", {
        lane: itemLane,
        correlationId,
        accountingRoot,
        observationRoots,
      })) {
      throw new TypeError(`${itemPath}.observationSetRoot mismatch`);
    }
    return Object.freeze({
      lane: itemLane,
      correlationId,
      coverageRoot: nonZeroHash(record.coverageRoot, `${itemPath}.coverageRoot`),
      accountingRoot,
      observationRoots,
      observationSetRoot,
    });
  }));
  for (let index = 1; index < laneDenominators.length; index += 1) {
    if (laneDenominators[index - 1]!.lane !== "blockscan" || laneDenominators[index]!.lane !== "backrun") {
      throw new TypeError(`${path}.laneDenominators order mismatch`);
    }
  }
  if (new Set(laneDenominators.map(item => item.lane)).size !== laneDenominators.length
    || laneDenominators.flatMap(item => item.observationRoots).length !== observations.length) {
    throw new TypeError(`${path}.laneDenominators are incomplete`);
  }
  const candidateTerminalObservationSetRoot = nonZeroHash(value.candidateTerminalObservationSetRoot, `${path}.candidateTerminalObservationSetRoot`);
  if (candidateTerminalObservationSetRoot !== hashDomain(
    "aloha/performance-candidate-terminal-observation-set-root/v1",
    laneDenominators.map(item => item.observationSetRoot),
  )) {
    throw new TypeError(`${path}.candidateTerminalObservationSetRoot mismatch`);
  }
  const headHash = nonZeroHash(value.headHash, `${path}.headHash`);
  if (observations.some(item => item.headHash !== headHash)) throw new TypeError(`${path}.candidateTerminalObservations head mismatch`);
  return Object.freeze({
    admissionId: nonZeroHash(value.admissionId, `${path}.admissionId`),
    headFactsRoot: nonZeroHash(value.headFactsRoot, `${path}.headFactsRoot`),
    headHash,
    candidateRefs,
    observations,
    laneDenominators,
    candidateTerminalObservationSetRoot,
  });
}

function sameSchedulerRuntime(
  left: SchedulerPerformanceRangeFactV1["runtime"],
  right: SchedulerWorkCompletionFactV1["runtime"],
): boolean {
  return left.schedulerRuntimeId === right.schedulerRuntimeId
    && left.qualifiedExecutorRegistryRoot === right.qualifiedExecutorRegistryRoot
    && left.executorAuthorityRoot === right.executorAuthorityRoot
    && left.workerEpoch === right.workerEpoch
    && left.executorSession === right.executorSession
    && left.authorityVersion === right.authorityVersion;
}

function exactProducerSchedulerJoin(value: unknown, path: string): ObservedProducerSchedulerJoinV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "correlationId", "generationId", "source", "programHash", "finalSimulationReceiptHash",
    "unsignedDryRunCandidateId", "unsignedDryRunLineageHash",
  ], path);
  const record = value as Record<string, unknown>;
  assertPlainObject(record.source, `${path}.source`);
  assertExactKeys(record.source, ["chainId", "number", "hash", "stateRoot"], `${path}.source`);
  const source = record.source as Record<string, unknown>;
  assertDecimalString(source.chainId, `${path}.source.chainId`);
  assertDecimalString(source.number, `${path}.source.number`);
  nonZeroHash(source.hash, `${path}.source.hash`);
  nonZeroHash(source.stateRoot, `${path}.source.stateRoot`);
  nonZeroHash(record.programHash, `${path}.programHash`);
  nonZeroHash(record.finalSimulationReceiptHash, `${path}.finalSimulationReceiptHash`);
  return Object.freeze({
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    source: Object.freeze({
      chainId: assertDecimalString(source.chainId, `${path}.source.chainId`),
      number: assertDecimalString(source.number, `${path}.source.number`),
      hash: nonZeroHash(source.hash, `${path}.source.hash`),
      stateRoot: nonZeroHash(source.stateRoot, `${path}.source.stateRoot`),
    }),
    programHash: nonZeroHash(record.programHash, `${path}.programHash`),
    finalSimulationReceiptHash: nonZeroHash(record.finalSimulationReceiptHash, `${path}.finalSimulationReceiptHash`),
    unsignedDryRunCandidateId: nonZeroHash(record.unsignedDryRunCandidateId, `${path}.unsignedDryRunCandidateId`),
    unsignedDryRunLineageHash: nonZeroHash(record.unsignedDryRunLineageHash, `${path}.unsignedDryRunLineageHash`),
  });
}

function exactRuntimePerformanceFacts(value: unknown, path: string): ObservedRuntimePerformanceFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["schedulerRange", "schedulerCompletions", "selectedSchedulerCompletion", "resource", "producerSchedulerJoin"], path);
  const record = value as Record<string, unknown>;
  const schedulerRange = validateSchedulerPerformanceRangeFactValue(record.schedulerRange);
  if (!Array.isArray(record.schedulerCompletions)) throw new TypeError(`${path}.schedulerCompletions must be an array`);
  const schedulerCompletions = Object.freeze(record.schedulerCompletions.map((item, index) => {
    const completion = validateSchedulerWorkCompletionFactValue(item);
    if (!sameSchedulerRuntime(schedulerRange.runtime, completion.runtime)
      || completion.sequence !== (BigInt(schedulerRange.startSequence) + BigInt(index)).toString()) {
      throw new TypeError(`${path}.schedulerCompletions[${index}] range mismatch`);
    }
    return completion;
  }));
  if (schedulerCompletions.length.toString() !== schedulerRange.completionCount
    || schedulerRange.endSequence !== (BigInt(schedulerRange.startSequence) + BigInt(schedulerCompletions.length)).toString()
    || schedulerRange.orderedCompletionRoot !== hashDomain(
      "aloha/scheduler-performance-range-completions/v1",
      schedulerCompletions.map(item => item.completionId),
    )) {
    throw new TypeError(`${path}.schedulerRange completion set mismatch`);
  }
  const selectedSchedulerCompletion = record.selectedSchedulerCompletion === null
    ? null
    : validateSchedulerWorkCompletionFactValue(record.selectedSchedulerCompletion);
  const producerSchedulerJoin = record.producerSchedulerJoin === null
    ? null
    : exactProducerSchedulerJoin(record.producerSchedulerJoin, `${path}.producerSchedulerJoin`);
  if ((selectedSchedulerCompletion === null) !== (producerSchedulerJoin === null)) {
    throw new TypeError(`${path} selected scheduler/join nullability mismatch`);
  }
  if (selectedSchedulerCompletion !== null) {
    if (!sameSchedulerRuntime(schedulerRange.runtime, selectedSchedulerCompletion.runtime)
      || selectedSchedulerCompletion.outcome !== "completed"
      || selectedSchedulerCompletion.work.phase !== "final-sim"
      || selectedSchedulerCompletion.work.workClassRef !== "qualified-revm-final-simulation-v1"
      || selectedSchedulerCompletion.work.lane !== "final-sim"
      || selectedSchedulerCompletion.work.resource !== "final-sim"
      || !schedulerCompletions.some(item => item.completionId === selectedSchedulerCompletion.completionId)) {
      throw new TypeError(`${path}.selectedSchedulerCompletion mismatch`);
    }
  }
  return Object.freeze({
    schedulerRange,
    schedulerCompletions,
    selectedSchedulerCompletion,
    resource: validateProcessResourceObservationValue(record.resource),
    producerSchedulerJoin,
  });
}

function exactStageDurationUs(value: unknown, path: string): string {
  assertPlainObject(value, path);
  assertExactKeys(value, ["startedMonotonicNs", "finishedMonotonicNs", "durationUs"], path);
  const record = value as Record<string, unknown>;
  const started = assertDecimalString(record.startedMonotonicNs, `${path}.startedMonotonicNs`);
  const finished = assertDecimalString(record.finishedMonotonicNs, `${path}.finishedMonotonicNs`);
  const duration = assertDecimalString(record.durationUs, `${path}.durationUs`);
  if (BigInt(finished) < BigInt(started) || duration !== ((BigInt(finished) - BigInt(started)) / 1_000n).toString()) {
    throw new TypeError(`${path} duration mismatch`);
  }
  return duration;
}

export function decodeObservedSixStepFactsV1(value: unknown, path = "observedSixStepFacts"): ObservedSixStepFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["stage12", "stage36", "stage12Root", "stage36Root", "lineageRoot"], path);
  const record = value as Record<string, unknown>;
  assertPlainObject(record.stage12, `${path}.stage12`);
  const stage12 = record.stage12 as Record<string, unknown>;
  assertExactKeys(stage12, ["binding", "selectedParents", "stage3EventId", "stage3ArtifactSetRoot"], `${path}.stage12`);
  assertPlainObject(stage12.binding, `${path}.stage12.binding`);
  assertExactKeys(stage12.binding, ["readyRecordHash", "generationId", "cutoff", "definitionCatalogRoot", "sourceCoverageRoot", "candidatePartitionRoot", "exactOutcomePartitionRoot", "verifiedMemoSetRoot", "instanceCatalogRoot", "graphRoot", "releaseProvenanceHash", "promotionRevision"], `${path}.stage12.binding`);
  const binding = stage12.binding as Record<string, unknown>;
  nonZeroHash(binding.readyRecordHash, `${path}.stage12.binding.readyRecordHash`);
  assertNonEmptyString(binding.generationId, `${path}.stage12.binding.generationId`);
  for (const key of ["definitionCatalogRoot", "sourceCoverageRoot", "candidatePartitionRoot", "exactOutcomePartitionRoot", "verifiedMemoSetRoot", "instanceCatalogRoot", "graphRoot", "releaseProvenanceHash"] as const) {
    nonZeroHash(binding[key], `${path}.stage12.binding.${key}`);
  }
  assertDecimalString(binding.promotionRevision, `${path}.stage12.binding.promotionRevision`);
  assertPlainObject(binding.cutoff, `${path}.stage12.binding.cutoff`);
  assertExactKeys(binding.cutoff, ["chainId", "number", "hash", "stateRoot"], `${path}.stage12.binding.cutoff`);
  const cutoff = binding.cutoff as Record<string, unknown>;
  assertDecimalString(cutoff.chainId, `${path}.stage12.binding.cutoff.chainId`);
  assertDecimalString(cutoff.number, `${path}.stage12.binding.cutoff.number`);
  nonZeroHash(cutoff.hash, `${path}.stage12.binding.cutoff.hash`);
  nonZeroHash(cutoff.stateRoot, `${path}.stage12.binding.cutoff.stateRoot`);
  if (!Array.isArray(stage12.selectedParents) || stage12.selectedParents.length < 2) throw new TypeError(`${path}.stage12.selectedParents is invalid`);
  nonZeroHash(stage12.stage3EventId, `${path}.stage12.stage3EventId`);
  const stage3ArtifactSetRoot = nonZeroHash(stage12.stage3ArtifactSetRoot, `${path}.stage12.stage3ArtifactSetRoot`);
  assertPlainObject(record.stage36, `${path}.stage36`);
  const stage36 = record.stage36 as Record<string, unknown>;
  if (!Array.isArray(stage36.selectedGraphLegs) || stage36.selectedGraphLegs.length !== stage12.selectedParents.length) {
    throw new TypeError(`${path} Stage1/2 selected parent denominator mismatch`);
  }
  assertPlainObject(stage36.resolved, `${path}.stage36.resolved`);
  const resolved = stage36.resolved as Record<string, unknown>;
  if (!Array.isArray(resolved.productionArtifactSetRoots) || resolved.productionArtifactSetRoots.length !== 4
    || nonZeroHash(resolved.productionArtifactSetRoots[0], `${path}.stage36.resolved.productionArtifactSetRoots[0]`) !== stage3ArtifactSetRoot) {
    throw new TypeError(`${path} Stage3 artifact root mismatch`);
  }
  const parentEdgeIds = new Set<Hash>();
  for (const [index, rawParent] of stage12.selectedParents.entries()) {
    const parentPath = `${path}.stage12.selectedParents[${index}]`;
    assertPlainObject(rawParent, parentPath);
    assertExactKeys(rawParent, ["edgeId", "selectedLegRoot", "stage1EventId", "stage1ArtifactSetRoot", "stage2EventId", "stage2ArtifactSetRoot", "instancePublicationRoot", "edgeContentRoot"], parentPath);
    const parent = rawParent as Record<string, unknown>;
    const edgeId = nonZeroHash(parent.edgeId, `${parentPath}.edgeId`);
    if (parentEdgeIds.has(edgeId)) throw new TypeError(`${path}.stage12.selectedParents contains duplicate edges`);
    parentEdgeIds.add(edgeId);
    const leg = stage36.selectedGraphLegs[index];
    assertPlainObject(leg, `${path}.stage36.selectedGraphLegs[${index}]`);
    assertExactKeys(leg, ["edgeId", "owningFamilyId", "owningFamilyDefinitionHash", "owningInstanceKey", "instancePublicationHash", "staticProjectionHash", "projectionHash"], `${path}.stage36.selectedGraphLegs[${index}]`);
    const legRecord = leg as Record<string, unknown>;
    nonZeroHash(legRecord.edgeId, `${path}.stage36.selectedGraphLegs[${index}].edgeId`);
    assertNonEmptyString(legRecord.owningFamilyId, `${path}.stage36.selectedGraphLegs[${index}].owningFamilyId`);
    nonZeroHash(legRecord.owningFamilyDefinitionHash, `${path}.stage36.selectedGraphLegs[${index}].owningFamilyDefinitionHash`);
    assertNonEmptyString(legRecord.owningInstanceKey, `${path}.stage36.selectedGraphLegs[${index}].owningInstanceKey`);
    nonZeroHash(legRecord.instancePublicationHash, `${path}.stage36.selectedGraphLegs[${index}].instancePublicationHash`);
    nonZeroHash(legRecord.staticProjectionHash, `${path}.stage36.selectedGraphLegs[${index}].staticProjectionHash`);
    nonZeroHash(legRecord.projectionHash, `${path}.stage36.selectedGraphLegs[${index}].projectionHash`);
    if (legRecord.edgeId !== edgeId
      || nonZeroHash(parent.selectedLegRoot, `${parentPath}.selectedLegRoot`) !== hashDomain("aloha/searcher-production-evidence-selected-graph-leg/v1", leg as CanonicalJson)) {
      throw new TypeError(`${path} Stage1/2 selected parent leg mismatch`);
    }
    for (const key of ["stage1EventId", "stage1ArtifactSetRoot", "stage2EventId", "stage2ArtifactSetRoot", "instancePublicationRoot", "edgeContentRoot"] as const) {
      nonZeroHash(parent[key], `${parentPath}.${key}`);
    }
  }
  assertPlainObject(resolved.timings, `${path}.stage36.resolved.timings`);
  const timings = resolved.timings as Record<string, unknown>;
  assertExactKeys(timings, ["planner", "exact", "executionProgram", "finalSimulation"], `${path}.stage36.resolved.timings`);
  const planner = exactStageDurationUs(timings.planner, `${path}.stage36.resolved.timings.planner`);
  const exact = exactStageDurationUs(timings.exact, `${path}.stage36.resolved.timings.exact`);
  const execution = exactStageDurationUs(timings.executionProgram, `${path}.stage36.resolved.timings.executionProgram`);
  exactStageDurationUs(timings.finalSimulation, `${path}.stage36.resolved.timings.finalSimulation`);
  const stage12Root = nonZeroHash(record.stage12Root, `${path}.stage12Root`);
  const stage36Root = nonZeroHash(record.stage36Root, `${path}.stage36Root`);
  const lineageRoot = nonZeroHash(record.lineageRoot, `${path}.lineageRoot`);
  if (stage12Root !== hashDomain("aloha/searcher-production-evidence-stage12/v1", record.stage12)
    || stage36Root !== nonZeroHash(stage36.traceRoot, `${path}.stage36.traceRoot`)
    || lineageRoot !== hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", { stage12Root, stage36Root })) {
    throw new TypeError(`${path} root mismatch`);
  }
  const stage36Payload = { ...stage36 };
  delete stage36Payload.traceRoot;
  if (stage36Root !== hashDomain("aloha/search-terminal-six-step-trace/v1", stage36Payload)) {
    throw new TypeError(`${path}.stage36Root content mismatch`);
  }
  return Object.freeze({
    stage12: Object.freeze(stage12),
    stage36: Object.freeze(record.stage36 as Record<string, unknown>),
    stage12Root,
    stage36Root,
    lineageRoot,
    plannerExactProgramDurationUs: (BigInt(planner) + BigInt(exact) + BigInt(execution)).toString(),
  });
}

function exactCompletePerformancePayload(value: Readonly<Record<string, unknown>>, path: string): ObservedCompletePerformancePayloadV1 {
  assertExactKeys(value, [
    "admissionId", "terminalBindingRoot", "terminalId", "terminalMonotonicNs", "headHash", "sourceCoverageRoot",
    "candidateSetRoot", "candidateCount", "runtimeFacts", "sixStepFacts", "factStatus",
  ], path);
  if (value.factStatus !== "complete") throw new TypeError(`${path}.factStatus is invalid`);
  return Object.freeze({
    admissionId: nonZeroHash(value.admissionId, `${path}.admissionId`),
    terminalBindingRoot: nonZeroHash(value.terminalBindingRoot, `${path}.terminalBindingRoot`),
    terminalId: nonZeroHash(value.terminalId, `${path}.terminalId`),
    terminalMonotonicNs: assertDecimalString(value.terminalMonotonicNs, `${path}.terminalMonotonicNs`),
    headHash: nonZeroHash(value.headHash, `${path}.headHash`),
    sourceCoverageRoot: nonZeroHash(value.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
    candidateSetRoot: nonZeroHash(value.candidateSetRoot, `${path}.candidateSetRoot`),
    candidateCount: assertDecimalString(value.candidateCount, `${path}.candidateCount`),
    runtimeFacts: exactRuntimePerformanceFacts(value.runtimeFacts, `${path}.runtimeFacts`),
    sixStepFacts: value.sixStepFacts === null ? null : decodeObservedSixStepFactsV1(value.sixStepFacts, `${path}.sixStepFacts`),
  });
}

function exactProducerTerminalPayload(value: Readonly<Record<string, unknown>>, path: string): ObservedProducerTerminalPayloadV1 {
  assertExactKeys(value, ["terminalBindingRoot", "terminal", "headFactsRoot"], path);
  assertPlainObject(value.terminal, `${path}.terminal`);
  const terminal = value.terminal as Record<string, unknown>;
  assertExactKeys(terminal, [
    "kind", "terminalId", "acceptedId", "sequence", "ordinal", "head", "revision", "status", "reason",
    "generationId", "graphRoot", "laneOutcomes",
  ], `${path}.terminal`);
  if (terminal.kind !== "aloha.producer-terminal-v1"
    || (terminal.status !== "completed" && terminal.status !== "failed" && terminal.status !== "cancelled"
      && terminal.status !== "dropped" && terminal.status !== "rejected")) {
    throw new TypeError(`${path}.terminal kind/status mismatch`);
  }
  assertNonEmptyString(terminal.reason, `${path}.terminal.reason`);
  nonZeroHash(terminal.acceptedId, `${path}.terminal.acceptedId`);
  assertDecimalString(terminal.sequence, `${path}.terminal.sequence`);
  const ordinal = assertDecimalString(terminal.ordinal, `${path}.terminal.ordinal`);
  const head = exactCanonicalHead(terminal.head, `${path}.terminal.head`);
  const revision = assertDecimalString(terminal.revision, `${path}.terminal.revision`);
  if (!Array.isArray(terminal.laneOutcomes)) throw new TypeError(`${path}.terminal.laneOutcomes must be an array`);
  const laneOutcomes = terminal.laneOutcomes.map((item, index) => {
    const itemPath = `${path}.terminal.laneOutcomes[${index}]`;
    assertPlainObject(item, itemPath);
    assertExactKeys(item, ["kind", "outcome", "reasonCode"], itemPath);
    const laneOutcome = item as Record<string, unknown>;
    if ((laneOutcome.kind !== "blockscan" && laneOutcome.kind !== "backrun")
      || (laneOutcome.outcome !== "completed" && laneOutcome.outcome !== "no-input" && laneOutcome.outcome !== "retryable"
        && laneOutcome.outcome !== "failed" && laneOutcome.outcome !== "cancelled")
      || (laneOutcome.reasonCode !== null && typeof laneOutcome.reasonCode !== "string")) {
      throw new TypeError(`${itemPath} is invalid`);
    }
    return Object.freeze({ kind: laneOutcome.kind, outcome: laneOutcome.outcome, reasonCode: laneOutcome.reasonCode });
  });
  const terminalWithoutId = {
    acceptedId: terminal.acceptedId,
    sequence: terminal.sequence,
    ordinal,
    status: terminal.status,
    reason: terminal.reason,
    head,
    revision,
    generationId: terminal.generationId === null ? null : assertNonEmptyString(terminal.generationId, `${path}.terminal.generationId`),
    graphRoot: terminal.graphRoot === null ? null : nonZeroHash(terminal.graphRoot, `${path}.terminal.graphRoot`),
    laneOutcomes,
  };
  const terminalId = nonZeroHash(terminal.terminalId, `${path}.terminal.terminalId`);
  if (terminalId !== hashDomain("aloha/producer-terminal/v1", terminalWithoutId)) throw new TypeError(`${path}.terminalId mismatch`);
  const headFactsRoot = value.headFactsRoot === null ? null : nonZeroHash(value.headFactsRoot, `${path}.headFactsRoot`);
  const terminalBindingRoot = nonZeroHash(value.terminalBindingRoot, `${path}.terminalBindingRoot`);
  if (terminalBindingRoot !== hashDomain("aloha/searcher-production-evidence-terminal-binding/v1", { terminalId, headFactsRoot })) {
    throw new TypeError(`${path}.terminalBindingRoot mismatch`);
  }
  return Object.freeze({
    terminalBindingRoot,
    terminalId,
    ordinal,
    head,
    revision,
    status: terminal.status,
    generationId: terminalWithoutId.generationId,
    graphRoot: terminalWithoutId.graphRoot,
    headFactsRoot,
  });
}

function observeSqliteSchema(database: ReadonlySqliteDatabase): Hash {
  const integrity = database.prepare("PRAGMA integrity_check").all() as readonly { integrity_check?: unknown }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new TypeError("production evidence SQLite integrity check failed");
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name IN ('durable_append_log', 'durable_append_log_schema_contract', 'durable_append_log_no_update', 'durable_append_log_no_delete')
       OR (type='trigger' AND tbl_name='durable_append_log')
    ORDER BY type, name
  `).all() as readonly { type?: unknown; name?: unknown; tbl_name?: unknown; sql?: unknown }[];
  const expected = new Map([
    ["table\u0000durable_append_log", EXPECTED_APPEND_TABLE_SQL],
    ["table\u0000durable_append_log_schema_contract", EXPECTED_CONTRACT_TABLE_SQL],
    ["trigger\u0000durable_append_log_no_delete", EXPECTED_NO_DELETE_SQL],
    ["trigger\u0000durable_append_log_no_update", EXPECTED_NO_UPDATE_SQL],
  ]);
  if (rows.length !== expected.size) throw new TypeError("production evidence append-log SQLite object set mismatch");
  const observed = rows.map((row, index) => {
    if (typeof row.type !== "string" || typeof row.name !== "string" || typeof row.tbl_name !== "string" || typeof row.sql !== "string") {
      throw new TypeError(`production evidence SQLite schema row ${index} is malformed`);
    }
    const key = `${row.type}\u0000${row.name}`;
    if (expected.get(key) !== normalizeSql(row.sql)) throw new TypeError(`production evidence SQLite schema mismatch at ${row.name}`);
    return Object.freeze({ type: row.type, name: row.name, table: row.tbl_name, sql: normalizeSql(row.sql) });
  });
  const contracts = database.prepare(`
    SELECT contract_id, schema_version, schema_digest, core_schema_digest, core_instance_nonce
    FROM durable_append_log_schema_contract
  `).all() as readonly Record<string, unknown>[];
  if (contracts.length !== 1) throw new TypeError("production evidence append-log schema contract cardinality mismatch");
  const contract = contracts[0]!;
  assertExactKeys(contract, ["contract_id", "schema_version", "schema_digest", "core_schema_digest", "core_instance_nonce"], "appendLogSchemaContract");
  if (contract.contract_id !== 1) throw new TypeError("production evidence append-log schema contract id mismatch");
  if (contract.schema_version !== "1") throw new TypeError("production evidence append-log schema version mismatch");
  if (nonZeroHash(contract.schema_digest, "appendLogSchemaContract.schema_digest") !== EXPECTED_APPEND_SCHEMA_DIGEST) {
    throw new TypeError("production evidence append-log schema digest mismatch");
  }
  const coreContracts = database.prepare(`
    SELECT contract_id, schema_version, schema_digest, instance_nonce
    FROM durable_schema_contract
  `).all() as readonly Record<string, unknown>[];
  if (coreContracts.length !== 1) throw new TypeError("production evidence core schema contract cardinality mismatch");
  const coreContract = coreContracts[0]!;
  assertExactKeys(coreContract, ["contract_id", "schema_version", "schema_digest", "instance_nonce"], "coreSchemaContract");
  if (coreContract.contract_id !== 1 || coreContract.schema_version !== "2") {
    throw new TypeError("production evidence core schema contract identity mismatch");
  }
  const coreSchemaDigest = nonZeroHash(coreContract.schema_digest, "coreSchemaContract.schema_digest");
  const coreInstanceNonce = assertNonEmptyString(coreContract.instance_nonce, "coreSchemaContract.instance_nonce");
  if (contract.core_schema_digest !== coreSchemaDigest || contract.core_instance_nonce !== coreInstanceNonce) {
    throw new TypeError("production evidence append/core schema contract join mismatch");
  }
  return hashDomain("aloha/raw-production-performance-sqlite-schema/v1", {
    objects: observed,
    appendContract: contract,
    coreContract,
  });
}

function readRows(database: ReadonlySqliteDatabase): Readonly<{
  readonly performanceRows: readonly RawAppendRowV1[];
  readonly terminalPhaseRows: readonly RawAppendRowV1[];
}> {
  const namespaces = Object.values(PRODUCTION_EVIDENCE_NAMESPACES);
  const rows = database.prepare(`
    SELECT namespace, sequence, event_id, content_sha256, bytes, byte_length, offset_start, offset_end
    FROM durable_append_log
    WHERE namespace IN (${namespaces.map(() => "?").join(", ")})
  `).all(...namespaces) as readonly Record<string, unknown>[];
  const allowed = new Set<string>(namespaces);
  const grouped = new Map<EvidenceNamespace, RawAppendRowV1[]>();
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["namespace", "sequence", "event_id", "content_sha256", "bytes", "byte_length", "offset_start", "offset_end"], `appendRow[${index}]`);
    if (typeof row.namespace !== "string" || !allowed.has(row.namespace)) throw new TypeError(`appendRow[${index}].namespace is not a production evidence namespace`);
    const namespace = row.namespace as EvidenceNamespace;
    const sequence = assertDecimalString(row.sequence, `appendRow[${index}].sequence`);
    const eventId = nonZeroHash(row.event_id, `appendRow[${index}].event_id`);
    const contentSha256 = nonZeroHash(row.content_sha256, `appendRow[${index}].content_sha256`);
    if (!(row.bytes instanceof Uint8Array)) throw new TypeError(`appendRow[${index}].bytes is not a BLOB`);
    const bytes = new Uint8Array(row.bytes);
    const byteLength = assertDecimalString(row.byte_length, `appendRow[${index}].byte_length`);
    const offsetStart = assertDecimalString(row.offset_start, `appendRow[${index}].offset_start`);
    const offsetEnd = assertDecimalString(row.offset_end, `appendRow[${index}].offset_end`);
    if (byteLength !== bytes.byteLength.toString() || contentSha256 !== sha256Hex(bytes)) throw new TypeError(`appendRow[${index}] content identity mismatch`);
    const normalized = Object.freeze({ namespace, sequence, eventId, contentSha256, bytes, byteLength, offsetStart, offsetEnd });
    grouped.set(namespace, [...(grouped.get(namespace) ?? []), normalized]);
  }
  const result: RawAppendRowV1[] = [];
  const terminalPhaseRows: RawAppendRowV1[] = [];
  for (const [namespace, values] of grouped) {
    values.sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : BigInt(left.sequence) > BigInt(right.sequence) ? 1 : 0);
    let nextOffset = 0n;
    for (const [index, row] of values.entries()) {
      if (BigInt(row.sequence) !== BigInt(index) || BigInt(row.offsetStart) !== nextOffset || BigInt(row.offsetEnd) !== nextOffset + BigInt(row.byteLength)) {
        throw new TypeError(`append-log sequence/offset mismatch at ${namespace}/${row.sequence}`);
      }
      nextOffset = BigInt(row.offsetEnd);
      if (namespace === PRODUCTION_EVIDENCE_NAMESPACES.terminalPhase) {
        exactEvent(row, database);
        terminalPhaseRows.push(row);
      }
      else result.push(row);
    }
  }
  return Object.freeze({
    performanceRows: Object.freeze(result.sort((left, right) => left.namespace.localeCompare(right.namespace) || (BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1))),
    terminalPhaseRows: Object.freeze(terminalPhaseRows),
  });
}

function exactBasis(event: ObservedProductionEventV1): { readonly profile: ProductionPerformanceProfileV1; readonly payload: Readonly<Record<string, unknown>> } {
  const value = event.payload;
  assertExactKeys(value, ["basisId", "windowStartAnchor", "eligibilityRuleHash", "profile", "providerRoot", "hardwareProfile", "processLogAnchor", "releaseBindingId", "releaseProvenanceHash", "runtimeAnchorHash", "targetCount", "committedMonotonicNs"], "performanceBasis");
  if (value.targetCount !== "100") throw new TypeError("performance basis target count mismatch");
  const profile = decodeProductionPerformanceProfile(value.profile as object);
  decodeHardwareProfileObservationV1(value.hardwareProfile as object);
  const basisId = nonZeroHash(value.basisId, "performanceBasis.basisId");
  if (value.releaseBindingId !== event.release.bindingId
    || value.releaseProvenanceHash !== event.release.releaseProvenanceHash
    || value.runtimeAnchorHash !== hashDomain("aloha/performance-runtime-anchor/v1", event.runtimeAnchor)) {
    throw new TypeError("performance basis release/runtime binding mismatch");
  }
  const payload = { ...value };
  delete payload.basisId;
  if (basisId !== hashDomain("aloha/searcher-production-evidence-performance-window-basis/v1", payload)) throw new TypeError("performance basis identity mismatch");
  return Object.freeze({ profile, payload: value });
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

interface ObservedPerformanceTerminalIdentityV1 {
  readonly admissionId: Hash;
  readonly terminalBindingRoot: Hash;
  readonly terminalId: Hash;
  readonly terminalMonotonicNs: string;
  readonly headHash: Hash;
}

interface ActiveAdmissionProjectionV1 {
  readonly events: readonly ObservedProductionEventV1[];
  readonly payloads: readonly ObservedEligiblePayloadV1[];
  readonly lineages: readonly PerformanceAdmissionOrphanReplacementLineageV1[];
}

function exactPerformanceTerminalIdentity(
  event: ObservedProductionEventV1,
  path: string,
): ObservedPerformanceTerminalIdentityV1 {
  const value = event.payload;
  assertExactKeys(
    value,
    event.eventType === "performance-facts-complete"
      ? [
          "admissionId", "terminalBindingRoot", "terminalId", "terminalMonotonicNs", "headHash",
          "sourceCoverageRoot", "candidateSetRoot", "candidateCount", "runtimeFacts", "sixStepFacts", "factStatus",
        ]
      : [
          "admissionId", "terminalBindingRoot", "terminalId", "terminalMonotonicNs", "headHash",
          "sourceCoverageRoot", "candidateSetRoot", "candidateCount", "runtimeFacts", "sixStepFacts", "factStatus",
          "missingFactReasons",
        ],
    path,
  );
  if (event.eventType === "performance-facts-complete") {
    const complete = exactCompletePerformancePayload(value, path);
    return Object.freeze({
      admissionId: complete.admissionId,
      terminalBindingRoot: complete.terminalBindingRoot,
      terminalId: complete.terminalId,
      terminalMonotonicNs: complete.terminalMonotonicNs,
      headHash: complete.headHash,
    });
  }
  if (event.eventType !== "performance-facts-incomplete" || value.factStatus !== "incomplete"
    || !Array.isArray(value.missingFactReasons) || value.missingFactReasons.length === 0
    || value.missingFactReasons.some(reason => typeof reason !== "string")) {
    throw new TypeError(`${path} incomplete performance terminal is malformed`);
  }
  return Object.freeze({
    admissionId: nonZeroHash(value.admissionId, `${path}.admissionId`),
    terminalBindingRoot: nonZeroHash(value.terminalBindingRoot, `${path}.terminalBindingRoot`),
    terminalId: nonZeroHash(value.terminalId, `${path}.terminalId`),
    terminalMonotonicNs: assertDecimalString(value.terminalMonotonicNs, `${path}.terminalMonotonicNs`),
    headHash: nonZeroHash(value.headHash, `${path}.headHash`),
  });
}

function activeAdmissionProjection(events: readonly ObservedProductionEventV1[]): ActiveAdmissionProjectionV1 {
  const admissions = events
    .filter(event => event.eventType === "eligible-head" || event.eventType === "orphan-replacement")
    .sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1);
  const performanceByAdmission = new Map<Hash, { readonly event: ObservedProductionEventV1; readonly identity: ObservedPerformanceTerminalIdentityV1 }>();
  for (const [index, event] of events
    .filter(candidate => candidate.eventType === "performance-facts-complete" || candidate.eventType === "performance-facts-incomplete")
    .entries()) {
    const identity = exactPerformanceTerminalIdentity(event, `performanceTerminal[${index}]`);
    if (performanceByAdmission.has(identity.admissionId)) throw new TypeError("admission has duplicate performance terminals");
    performanceByAdmission.set(identity.admissionId, Object.freeze({ event, identity }));
  }
  const producerByTerminal = new Map<Hash, { readonly event: ObservedProductionEventV1; readonly payload: ObservedProducerTerminalPayloadV1 }>();
  for (const [index, event] of events.filter(candidate => candidate.eventType === "producer-terminal").entries()) {
    const payload = exactProducerTerminalPayload(event.payload, `producerTerminal[${index}]`);
    if (producerByTerminal.has(payload.terminalId)) throw new TypeError("duplicate producer terminal");
    producerByTerminal.set(payload.terminalId, Object.freeze({ event, payload }));
  }
  const allByAdmission = new Map<Hash, { readonly event: ObservedProductionEventV1; readonly payload: ObservedEligiblePayloadV1 }>();
  const activeByOrdinal = new Map<string, { readonly event: ObservedProductionEventV1; readonly payload: ObservedEligiblePayloadV1 }>();
  const lineages: PerformanceAdmissionOrphanReplacementLineageV1[] = [];
  for (const [index, event] of admissions.entries()) {
    const payload = exactEligiblePayload(event, `admission[${index}]`);
    if (allByAdmission.has(payload.admissionId)) throw new TypeError("duplicate eligible admission");
    if (event.eventType === "eligible-head") {
      const expectedOrdinal = (activeByOrdinal.size + 1).toString();
      if (payload.ordinal !== expectedOrdinal || BigInt(payload.ordinal) > 100n) {
        throw new TypeError("fresh eligible admission ordinal is not the next denominator ordinal");
      }
      activeByOrdinal.set(payload.ordinal, Object.freeze({ event, payload }));
    } else {
      const lineage = payload.lineage!;
      const lastOrdinal = activeByOrdinal.size.toString();
      const orphan = activeByOrdinal.get(payload.ordinal);
      if (payload.ordinal !== lastOrdinal || orphan === undefined
        || orphan.payload.admissionId !== lineage.orphanAdmissionId
        || orphan.event.eventId !== lineage.orphanEligibleEventId
        || orphan.payload.ordinal !== lineage.ordinal
        || orphan.payload.revision !== lineage.orphanRevision
        || orphan.payload.acceptedMonotonicNs !== lineage.orphanAcceptedMonotonicNs
        || !sameCanonical(orphan.payload.head, lineage.orphanCanonicalHead)) {
        throw new TypeError("replacement lineage does not reopen the active latest ordinal");
      }
      const performance = performanceByAdmission.get(lineage.orphanAdmissionId);
      const producer = producerByTerminal.get(lineage.orphanProducerTerminalId);
      if (performance === undefined || producer === undefined
        || performance.identity.terminalId !== lineage.orphanProducerTerminalId
        || performance.identity.terminalMonotonicNs !== lineage.orphanTerminalMonotonicNs
        || performance.identity.headHash !== lineage.orphanCanonicalHead.hash
        || performance.identity.terminalBindingRoot !== producer.payload.terminalBindingRoot
        || producer.event.eventId !== lineage.orphanProducerTerminalEventId
        || producer.payload.ordinal !== lineage.ordinal
        || producer.payload.revision !== lineage.orphanRevision
        || !sameCanonical(producer.payload.head, lineage.orphanCanonicalHead)) {
        throw new TypeError("replacement lineage lacks the exact durable orphan terminal join");
      }
      activeByOrdinal.set(payload.ordinal, Object.freeze({ event, payload }));
      lineages.push(lineage);
    }
    allByAdmission.set(payload.admissionId, Object.freeze({ event, payload }));
  }
  const active = [...activeByOrdinal.values()].sort((left, right) => BigInt(left.payload.ordinal) < BigInt(right.payload.ordinal) ? -1 : 1);
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1]!.payload;
    const current = active[index]!.payload;
    if (current.head.chainId !== previous.head.chainId
      || BigInt(current.head.number) !== BigInt(previous.head.number) + 1n
      || current.head.parentHash !== previous.head.hash
      || BigInt(current.acceptedMonotonicNs) <= BigInt(previous.acceptedMonotonicNs)) {
      throw new TypeError("active eligible head canonical/monotonic continuity mismatch");
    }
  }
  return Object.freeze({
    events: Object.freeze(active.map(value => value.event)),
    payloads: Object.freeze(active.map(value => value.payload)),
    lineages: Object.freeze(lineages),
  });
}

function joinEvents(events: readonly ObservedProductionEventV1[]): {
  readonly status: Exclude<RawPerformanceObservationStatusV1, "invalid">;
  readonly reasons: readonly string[];
  readonly release: ReleaseIdentityV1 | null;
  readonly servingPartitions: readonly ServingIdentityV1[];
  readonly profile: ProductionPerformanceProfileV1 | null;
  readonly commitment: PerformanceWindowCommitmentV1 | null;
} {
  const reasons: string[] = [];
  if (events.length === 0) return { status: "incomplete", reasons: ["raw-events-missing"], release: null, servingPartitions: [], profile: null, commitment: null };
  const first = events[0]!;
  for (const event of events) {
    if (!sameCanonical(event.release, first.release) || !sameCanonical(event.runtimeAnchor, first.runtimeAnchor)) {
      throw new TypeError("production evidence spans multiple release/runtime partitions");
    }
  }
  const basisEvents = events.filter(event => event.eventType === "performance-window-basis");
  const commitmentEvents = events.filter(event => event.eventType === "performance-window-commitment");
  let profile: ProductionPerformanceProfileV1 | null = null;
  let commitment: PerformanceWindowCommitmentV1 | null = null;
  if (basisEvents.length !== 1) addReason(reasons, "performance-window-basis-cardinality");
  if (commitmentEvents.length !== 1) addReason(reasons, "performance-window-commitment-cardinality");
  if (basisEvents.length === 1) profile = exactBasis(basisEvents[0]!).profile;
  if (commitmentEvents.length === 1) commitment = decodePerformanceWindowCommitment(commitmentEvents[0]!.payload);
  if (basisEvents.length === 1 && commitmentEvents.length === 1) {
    if (BigInt(commitmentEvents[0]!.sequence) !== BigInt(basisEvents[0]!.sequence) + 1n) throw new TypeError("performance commitment does not immediately follow its basis");
    const basis = basisEvents[0]!.payload;
    if (commitment!.performanceProfileHash !== profile!.profileHash
      || commitment!.releaseBindingId !== first.release.bindingId
      || commitment!.releaseProvenanceHash !== first.release.releaseProvenanceHash
      || commitment!.runtimeAnchorHash !== hashDomain("aloha/performance-runtime-anchor/v1", first.runtimeAnchor)
      || commitment!.providerRoot !== basis.providerRoot
      || commitment!.hardwareProfileRoot !== (basis.hardwareProfile as Record<string, unknown>).profileRoot
      || commitment!.committedMonotonicNs !== basis.committedMonotonicNs) throw new TypeError("performance commitment/basis join mismatch");
  }
  const eligible = events.filter(event => event.eventType === "eligible-head" || event.eventType === "orphan-replacement");
  const activeProjection = activeAdmissionProjection(events);
  if (activeProjection.events.length > 100) throw new TypeError("active eligible head denominator exceeds exact 100");
  if (activeProjection.events.length !== 100) addReason(reasons, "eligible-head-count-not-100");
  const activeAdmissionIds = new Set(activeProjection.payloads.map(payload => payload.admissionId));
  const byAdmission = new Map<Hash, ObservedProductionEventV1>();
  const eligiblePayloads = new Map<Hash, ObservedEligiblePayloadV1>();
  for (const [index, event] of eligible.entries()) {
    const payload = exactEligiblePayload(event, `eligible[${index}]`);
    const admissionId = payload.admissionId;
    if (byAdmission.has(admissionId)) throw new TypeError("duplicate eligible admission");
    if (commitment !== null && payload.windowId !== commitment.windowId) throw new TypeError("eligible head window mismatch");
    byAdmission.set(admissionId, event);
    eligiblePayloads.set(admissionId, payload);
  }
  const orderedEligible = activeProjection.events;
  if (commitment !== null && eligible.length > 0) {
    const firstAdmissionEvent = [...eligible].sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1)[0]!;
    const first = eligiblePayloads.get(firstAdmissionEvent.payload.admissionId as Hash)!;
    if (commitment.eligibilityRuleHash !== PERFORMANCE_ELIGIBILITY_RULE_HASH
      || first.head.chainId !== commitment.windowStartAnchor.chainId
      || first.head.number !== commitment.windowStartAnchor.number
      || first.head.hash !== commitment.windowStartAnchor.hash
      || first.head.parentHash !== commitment.windowStartAnchor.parentHash
      || first.head.stateRoot !== commitment.windowStartAnchor.stateRoot
      || BigInt(first.acceptedMonotonicNs) <= BigInt(commitment.committedMonotonicNs)) {
      throw new TypeError("first eligible head does not match the committed window anchor");
    }
  }
  const routeDenominators = new Map<Hash, Map<LaneV1, Readonly<{
    readonly event: ObservedProductionEventV1;
    readonly payload: ObservedRouteDenominatorPayloadV1;
  }>>>();
  for (const [index, event] of events.filter(candidate => candidate.eventType === "route-denominator").entries()) {
    const payload = exactRouteDenominatorPayload(event.payload, `routeDenominator[${index}]`);
    if (!byAdmission.has(payload.admissionId)) throw new TypeError("route-denominator is orphaned from eligible head");
    const lanes = routeDenominators.get(payload.admissionId) ?? new Map();
    if (lanes.has(payload.lane)) throw new TypeError("duplicate route-denominator lane for admission");
    lanes.set(payload.lane, Object.freeze({ event, payload }));
    routeDenominators.set(payload.admissionId, lanes);
  }
  const kinds = ["head-coverage", "candidate-set", "performance-facts-incomplete", "performance-facts-complete"] as const;
  const joined = new Map<Hash, Partial<Record<(typeof kinds)[number], ObservedProductionEventV1>>>();
  for (const event of events) {
    if (!kinds.includes(event.eventType as (typeof kinds)[number])) continue;
    const admissionId = nonZeroHash(event.payload.admissionId, `${event.eventType}.admissionId`);
    if (!byAdmission.has(admissionId)) throw new TypeError(`${event.eventType} is orphaned from eligible head`);
    const row = joined.get(admissionId) ?? {};
    const key = event.eventType as (typeof kinds)[number];
    if (row[key] !== undefined) throw new TypeError(`duplicate ${key} for admission`);
    row[key] = event;
    joined.set(admissionId, row);
  }
  for (const [admissionId, eligibleEvent] of byAdmission) {
    const row = joined.get(admissionId);
    const active = activeAdmissionIds.has(admissionId);
    if (active && row?.["head-coverage"] === undefined) addReason(reasons, "head-coverage-missing");
    if (active && row?.["candidate-set"] === undefined) addReason(reasons, "candidate-set-missing");
    const performance = row?.["performance-facts-complete"] ?? row?.["performance-facts-incomplete"];
    if (active && performance === undefined) addReason(reasons, "performance-terminal-missing");
    if (row?.["performance-facts-complete"] !== undefined && row?.["performance-facts-incomplete"] !== undefined) throw new TypeError("admission has two performance terminals");
    const eligiblePayload = eligiblePayloads.get(admissionId)!;
    const eligibleHead = eligiblePayload.head;
    const coverage = row?.["head-coverage"] === undefined
      ? null
      : exactCoveragePayload(row["head-coverage"]!.payload, `head[${admissionId}].coverage`);
    const candidates = row?.["candidate-set"] === undefined
      ? null
      : exactCandidateSetPayload(row["candidate-set"]!.payload, `head[${admissionId}].candidates`);
    const denominatorLanes = routeDenominators.get(admissionId) ?? new Map<LaneV1, Readonly<{
      readonly event: ObservedProductionEventV1;
      readonly payload: ObservedRouteDenominatorPayloadV1;
    }>>();
    if (coverage !== null && coverage.headHash !== eligibleHead.hash) throw new TypeError("coverage/head splice");
    if (candidates !== null && candidates.headHash !== eligibleHead.hash) throw new TypeError("candidate/head splice");
    const serving = row?.["head-coverage"]?.serving ?? null;
    if (coverage !== null && serving === null) throw new TypeError("coverage serving binding is missing");
    for (const joinedEvent of [row?.["candidate-set"], row?.["performance-facts-complete"], ...[...denominatorLanes.values()].map(value => value.event)]) {
      if (joinedEvent !== undefined && (serving === null || !sameCanonical(joinedEvent.serving, serving))) {
        throw new TypeError("admission facts span serving partitions");
      }
    }
    const incomplete = row?.["performance-facts-incomplete"];
    if (incomplete !== undefined && incomplete.serving !== null && (serving === null || !sameCanonical(incomplete.serving, serving))) {
      throw new TypeError("incomplete performance facts span serving partitions");
    }
    if (incomplete?.serving === null && (row?.["head-coverage"] !== undefined || row?.["candidate-set"] !== undefined || denominatorLanes.size > 0)) {
      throw new TypeError("generation-neutral incomplete performance terminal cannot claim bound facts");
    }
    if (coverage !== null && candidates !== null) {
      if (coverage.admissionId !== candidates.admissionId
        || coverage.headFactsRoot !== candidates.headFactsRoot
        || coverage.headHash !== candidates.headHash) {
        throw new TypeError("coverage/candidate head-facts splice");
      }
      const admissionDenominators = (["blockscan", "backrun"] as const).flatMap(observedLane => denominatorLanes.get(observedLane)?.payload ?? []);
      const coverageLaneUniverse = coverage.laneTerminalFacts.filter(item => item.kind === "coverage");
      if (admissionDenominators.length !== coverageLaneUniverse.length
        || coverageLaneUniverse.some(terminal => !admissionDenominators.some(denominator => denominator.lane === terminal.lane
          && denominator.correlationId === terminal.correlationId
          && denominator.coverageRoot === terminal.coverageRoot))
        || (coverage.complete && (admissionDenominators.length !== 2
          || admissionDenominators[0]?.lane !== "blockscan"
          || admissionDenominators[1]?.lane !== "backrun"))) {
        throw new TypeError("route-denominator lane set mismatch");
      }
      const accountedDenominators = admissionDenominators.filter(
        (denominator): denominator is ObservedAccountedRouteDenominatorPayloadV1 => denominator.denominatorKind === "accounted",
      );
      if (accountedDenominators.length !== candidates.laneDenominators.length
        || accountedDenominators.length !== coverage.coarseTimingFacts.length
        || coverage.coarseTimingFacts.some(coarse => !accountedDenominators.some(denominator => denominator.correlationId === coarse.correlationId
          && denominator.accounting.planningProblemHash === coarse.planningProblemHash
          && denominator.accounting.enumerationRoot === coarse.enumerationRoot
          && denominator.accounting.admissionPolicyHash === coarse.admissionPolicyHash))) {
        throw new TypeError("accounted route-denominator subset mismatch");
      }
      for (const denominator of candidates.laneDenominators) {
        const terminal = coverage.laneTerminalFacts.find(item => item.lane === denominator.lane);
        const coarse = coverage.coarseTimingFacts.find(item => item.correlationId === denominator.correlationId);
        const laneObservations = candidates.observations.filter(item => item.lane === denominator.lane);
        const upstream = accountedDenominators.find(item => item.lane === denominator.lane);
        for (const [index, entry] of (upstream?.accounting.entries ?? []).entries()) {
          const observation = laneObservations[index];
          if (observation !== undefined) validateRawCandidateEvidenceJoinV1(entry, observation);
        }
        if (terminal?.kind !== "coverage"
          || upstream === undefined
          || upstream.admissionId !== candidates.admissionId
          || upstream.headFactsRoot !== candidates.headFactsRoot
          || upstream.headHash !== candidates.headHash
          || upstream.correlationId !== denominator.correlationId
          || upstream.coverageRoot !== denominator.coverageRoot
          || upstream.accounting.root !== denominator.accountingRoot
          || upstream.accounting.planningProblemHash !== coarse?.planningProblemHash
          || upstream.accounting.enumerationRoot !== coarse?.enumerationRoot
          || upstream.accounting.admissionPolicyHash !== coarse?.admissionPolicyHash
          || upstream.accounting.entries.length !== laneObservations.length
          || upstream.accounting.entries.some((entry, index) => entry.candidateId !== laneObservations[index]?.candidateId
            || entry.disposition !== laneObservations[index]?.disposition
            || entry.routeHash !== laneObservations[index]?.routeHash
            || entry.reasonCode !== laneObservations[index]?.reasonCode
            || !sameCanonical(entry.policyTerminal, laneObservations[index]?.policyTerminal))
          || terminal.correlationId !== denominator.correlationId
          || terminal.coverageRoot !== denominator.coverageRoot
          || coarse === undefined
          || serving === null
          || coarse.generationId !== serving.generationId
          || coarse.graphRoot !== serving.graphRoot
          || laneObservations.some(item => item.correlationId !== coarse.correlationId
            || item.generationId !== coarse.generationId
            || item.graphRoot !== coarse.graphRoot
            || item.planningProblemHash !== coarse.planningProblemHash
            || item.enumerationRoot !== coarse.enumerationRoot
            || item.admissionPolicyHash !== coarse.admissionPolicyHash)) {
          throw new TypeError("candidate observation lane/accounting splice");
        }
      }
      for (const denominator of admissionDenominators.filter(
        (item): item is ObservedNoInputRouteDenominatorPayloadV1 => item.denominatorKind === "no-input",
      )) {
        const terminal = coverageLaneUniverse.find(item => item.lane === denominator.lane);
        const expectedSnapshotHash = hashDomain("aloha/public-pending-snapshot/v1", {
          head: eligiblePayload.head,
          pendingNumber: denominator.pendingSnapshot.pendingNumber,
          parentHash: denominator.pendingSnapshot.parentHash,
          orderedTransactionHashes: denominator.pendingSnapshot.orderedTransactionHashes,
          orderedTransactionHashesRoot: denominator.pendingSnapshot.orderedTransactionHashesRoot,
          transactionCount: denominator.pendingSnapshot.transactionCount,
        });
        const expectedAbsenceEvidenceHash = hashDomain("aloha/public-pending-absence-evidence/v1", {
          head: eligiblePayload.head,
          snapshotHash: denominator.pendingSnapshot.snapshotHash,
        });
        const expectedTerminalLineageHash = serving === null ? null : hashDomain("aloha/searcher-lane-no-input/v1", {
          kind: "no-input",
          lane: "backrun",
          headHash: eligiblePayload.head.hash,
          generationId: serving.generationId,
          graphRoot: serving.graphRoot,
          correlationId: denominator.correlationId,
          pendingSnapshotHash: denominator.pendingSnapshot.snapshotHash,
          absenceEvidenceHash: denominator.absenceEvidenceHash,
          reasonCode: "pending-set-observed-empty",
        });
        const currentSource = coverage.currentSourceLogicalFacts.find(item => item.lane === denominator.lane);
        if (terminal?.kind !== "coverage"
          || denominator.headFactsRoot !== candidates.headFactsRoot
          || denominator.headHash !== candidates.headHash
          || denominator.pendingSnapshot.snapshotHash !== expectedSnapshotHash
          || denominator.absenceEvidenceHash !== expectedAbsenceEvidenceHash
          || denominator.terminalLineageHash !== expectedTerminalLineageHash
          || currentSource === undefined
          || !sameCanonical(denominator.currentSource, currentSource)) {
          throw new TypeError("no-input route-denominator splice");
        }
      }
      const upstreamCandidateRefs = sortedUniqueHashes(
        accountedDenominators.flatMap(payload => payload.accounting.entries.map(entry => performanceLaneCandidateRefV1(payload.lane, entry.candidateId))).sort(),
        `head[${admissionId}].routeDenominatorCandidateRefs`,
      );
      if (!sameCanonical(upstreamCandidateRefs, candidates.candidateRefs)) {
        throw new TypeError("route-denominator/candidate-set exact denominator mismatch");
      }
    }
    if (performance !== undefined && performance.payload.headHash !== (eligibleEvent.payload.head as Record<string, unknown>).hash) throw new TypeError("performance/head splice");
    if (active && row?.["performance-facts-incomplete"] !== undefined) addReason(reasons, "producer-performance-facts-incomplete");
  }
  const terminalEvents = events.filter(event => event.eventType === "producer-terminal");
  const terminalIds = new Set<Hash>();
  const terminalAdmissions = new Set<Hash>();
  const performanceAdmissionByTerminal = new Map<Hash, Hash>();
  const performanceEventByTerminal = new Map<Hash, ObservedProductionEventV1>();
  for (const [index, event] of events
    .filter(candidate => candidate.eventType === "performance-facts-complete" || candidate.eventType === "performance-facts-incomplete")
    .entries()) {
    const identity = exactPerformanceTerminalIdentity(event, `joined.performanceTerminal[${index}]`);
    if (performanceAdmissionByTerminal.has(identity.terminalId)) throw new TypeError("performance terminal is shared by admissions");
    performanceAdmissionByTerminal.set(identity.terminalId, identity.admissionId);
    performanceEventByTerminal.set(identity.terminalId, event);
  }
  for (const event of terminalEvents) {
    const terminal = exactProducerTerminalPayload(event.payload, "producerTerminal");
    const terminalId = terminal.terminalId;
    if (terminalIds.has(terminalId)) throw new TypeError("duplicate producer terminal");
    terminalIds.add(terminalId);
    const admissionId = performanceAdmissionByTerminal.get(terminalId);
    if (admissionId === undefined) throw new TypeError("Producer terminal is orphaned from a performance terminal");
    if (terminalAdmissions.has(admissionId)) throw new TypeError("admission has duplicate Producer terminals");
    const performanceEvent = performanceEventByTerminal.get(terminalId)!;
    const admissionServing = joined.get(admissionId)?.["head-coverage"]?.serving;
    if (performanceEvent.eventType === "performance-facts-complete") {
      if (admissionServing === null || admissionServing === undefined || !sameCanonical(event.serving, admissionServing)) {
        throw new TypeError("Producer terminal serving partition mismatch");
      }
    } else if (performanceEvent.serving === null) {
      if (event.serving !== null || terminal.generationId !== null || terminal.graphRoot !== null
        || joined.get(admissionId)?.["head-coverage"] !== undefined || joined.get(admissionId)?.["candidate-set"] !== undefined) {
        throw new TypeError("generation-neutral incomplete Producer terminal claims serving facts");
      }
    } else if (!sameCanonical(event.serving, performanceEvent.serving)
      || terminal.generationId !== performanceEvent.serving.generationId
      || terminal.graphRoot !== performanceEvent.serving.graphRoot) {
      throw new TypeError("incomplete Producer terminal serving partition mismatch");
    }
    terminalAdmissions.add(admissionId);
  }
  if (activeProjection.payloads.some(payload => !terminalAdmissions.has(payload.admissionId))) {
    addReason(reasons, "producer-terminal-count-mismatch");
  }
  if (eligible.length > 0 && commitmentEvents.length === 1) {
    const ordered = [...eligible].sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1);
    if (BigInt(ordered[0]!.sequence) !== BigInt(commitmentEvents[0]!.sequence) + 1n) throw new TypeError("first eligible head does not immediately follow commitment");
    for (let index = 1; index < ordered.length; index += 1) if (BigInt(ordered[index]!.sequence) !== BigInt(ordered[index - 1]!.sequence) + 1n) throw new TypeError("eligible head sequence is not contiguous");
  }
  return Object.freeze({
    status: reasons.length === 0 ? "raw-complete" : "incomplete",
    reasons: Object.freeze(reasons.sort()),
    release: first.release,
    servingPartitions: Object.freeze(events.flatMap(event => event.serving === null ? [] : [event.serving]).filter((serving, index, values) => values.findIndex(candidate => sameCanonical(candidate, serving)) === index)),
    profile,
    commitment,
  });
}

function maximumDecimal(values: readonly string[]): string {
  return values.reduce((maximum, value) => BigInt(value) > BigInt(maximum) ? value : maximum, "0");
}

function minimumDecimal(values: readonly string[]): string {
  if (values.length === 0) return "0";
  return values.reduce((minimum, value) => BigInt(value) < BigInt(minimum) ? value : minimum);
}

function exactQueueTelemetry(range: SchedulerPerformanceRangeFactV1): readonly QueueTelemetryV1[] {
  const lanes = new Set(["producer-critical", "producer-bulk", "startup-RPC-fast", "startup-REVM-heavy", "background-next-generation", "final-sim"]);
  const resources = new Set(["rpc", "revm-heavy", "final-sim"]);
  return Object.freeze(range.queueTelemetry.map((item, index) => {
    if (!lanes.has(item.lane) || !resources.has(item.resource)) {
      throw new TypeError(`runtimeFacts.schedulerRange.queueTelemetry[${index}] lane/resource is not a performance fact`);
    }
    return Object.freeze({ ...item }) as QueueTelemetryV1;
  }));
}

function exactPermitAccounting(range: SchedulerPerformanceRangeFactV1): readonly PermitAccountingV1[] {
  const lanes = new Set(["producer-critical", "producer-bulk", "startup-RPC-fast", "startup-REVM-heavy", "background-next-generation", "final-sim"]);
  const resources = new Set(["rpc", "revm-heavy", "final-sim"]);
  return Object.freeze(range.permitAccounting.map((item, index) => {
    if (!lanes.has(item.lane) || !resources.has(item.resource)) {
      throw new TypeError(`runtimeFacts.schedulerRange.permitAccounting[${index}] lane/resource is not a performance fact`);
    }
    return Object.freeze({ ...item }) as PermitAccountingV1;
  }));
}

function exactResourceSamples(range: SchedulerPerformanceRangeFactV1): readonly ResourceSampleV1[] {
  const resources = new Set(["rpc", "revm-heavy", "final-sim"]);
  return Object.freeze(range.resourceSamples.map((item, index) => {
    if (!resources.has(item.resource)) {
      throw new TypeError(`runtimeFacts.schedulerRange.resourceSamples[${index}] resource is not a performance fact`);
    }
    return Object.freeze({ ...item }) as ResourceSampleV1;
  }));
}

function projectPerformanceBundle(
  events: readonly ObservedProductionEventV1[],
  rows: readonly RawAppendRowV1[],
  profile: ProductionPerformanceProfileV1,
  commitment: PerformanceWindowCommitmentV1,
): PerformanceFactBundleV1 {
  const activeProjection = activeAdmissionProjection(events);
  const eligibleEvents = activeProjection.events;
  if (eligibleEvents.length !== 100) throw new TypeError("performance bundle requires exact 100 eligible heads");
  const byAdmission = new Map<Hash, Partial<Record<"coverage" | "candidates" | "performance", ObservedProductionEventV1>>>();
  const routeDenominatorsByAdmission = new Map<Hash, Map<LaneV1, ObservedProductionEventV1>>();
  for (const event of events) {
    if (event.eventType === "route-denominator") {
      const payload = exactRouteDenominatorPayload(event.payload, "bundle.routeDenominator");
      const lanes = routeDenominatorsByAdmission.get(payload.admissionId) ?? new Map<LaneV1, ObservedProductionEventV1>();
      if (lanes.has(payload.lane)) throw new TypeError("performance bundle duplicate route denominator lane");
      lanes.set(payload.lane, event);
      routeDenominatorsByAdmission.set(payload.admissionId, lanes);
      continue;
    }
    const key = event.eventType === "head-coverage" ? "coverage"
      : event.eventType === "candidate-set" ? "candidates"
      : event.eventType === "performance-facts-complete" ? "performance"
      : null;
    if (key === null) continue;
    const admissionId = nonZeroHash(event.payload.admissionId, `bundle.${event.eventType}.admissionId`);
    const current = byAdmission.get(admissionId) ?? {};
    if (current[key] !== undefined) throw new TypeError(`performance bundle duplicate ${key}`);
    current[key] = event;
    byAdmission.set(admissionId, current);
  }
  const producerTerminals = events
    .filter(event => event.eventType === "producer-terminal")
    .map((event, index) => Object.freeze({ event, payload: exactProducerTerminalPayload(event.payload, `bundle.producerTerminal[${index}]`) }));
  const producerTerminalById = new Map(producerTerminals.map(item => [item.payload.terminalId, item]));
  if (producerTerminalById.size !== producerTerminals.length) throw new TypeError("performance bundle has duplicate Producer terminals");
  const rowByEventId = new Map(rows.map(row => [row.eventId, row]));
  const eventById = new Map(events.map(event => [event.eventId, event]));
  const performanceByTerminalId = new Map<Hash, ObservedProductionEventV1>();
  for (const [index, event] of events
    .filter(candidate => candidate.eventType === "performance-facts-complete" || candidate.eventType === "performance-facts-incomplete")
    .entries()) {
    const identity = exactPerformanceTerminalIdentity(event, `bundle.performanceTerminal[${index}]`);
    if (performanceByTerminalId.has(identity.terminalId)) throw new TypeError("performance bundle has duplicate performance terminal identity");
    performanceByTerminalId.set(identity.terminalId, event);
  }
  const processLogAnchorHash = hashProcessLogAnchor(commitment.processLogAnchor);
  const heads: ReturnType<typeof createEligibleHeadRecord>[] = [];
  const candidateSets: ReturnType<typeof createCandidateSet>[] = [];
  const candidateTerminals: CandidateTerminalReceiptV1[] = [];
  const metrics: PerformanceMetricSampleV1[] = [];
  const terminals: ReturnType<typeof createHeadTerminalReceipt>[] = [];
  const semanticLineages: ReturnType<typeof createHeadOrphanReplacementLineage>[] = [];

  for (const [index, eligibleEvent] of eligibleEvents.entries()) {
    const ordinal = (index + 1).toString();
    const eligible = exactEligiblePayload(eligibleEvent, `bundle.eligible[${index}]`);
    const joined = byAdmission.get(eligible.admissionId);
    if (joined?.coverage === undefined || joined.candidates === undefined || joined.performance === undefined) {
      throw new TypeError(`performance bundle head ${ordinal} lacks complete raw facts`);
    }
    const coverage = exactCoveragePayload(joined.coverage.payload, `bundle.head[${ordinal}].coverage`);
    const candidates = exactCandidateSetPayload(joined.candidates.payload, `bundle.head[${ordinal}].candidates`);
    const routeDenominators = routeDenominatorsByAdmission.get(eligible.admissionId) ?? new Map<LaneV1, ObservedProductionEventV1>();
    const orderedRouteDenominators = (["blockscan", "backrun"] as const)
      .flatMap(lane => routeDenominators.get(lane) ?? []);
    const decodedRouteDenominators = orderedRouteDenominators.map((event, denominatorIndex) => exactRouteDenominatorPayload(
      event.payload,
      `bundle.head[${ordinal}].routeDenominator[${denominatorIndex}]`,
    ));
    const coverageLaneUniverse = coverage.laneTerminalFacts.filter(item => item.kind === "coverage");
    if (orderedRouteDenominators.length !== coverageLaneUniverse.length
      || coverageLaneUniverse.some(terminal => !decodedRouteDenominators.some(denominator => denominator.lane === terminal.lane
        && denominator.correlationId === terminal.correlationId
        && denominator.coverageRoot === terminal.coverageRoot))
      || (coverage.complete && (decodedRouteDenominators.length !== 2
        || decodedRouteDenominators[0]?.lane !== "blockscan"
        || decodedRouteDenominators[1]?.lane !== "backrun"))) {
      throw new TypeError(`performance bundle head ${ordinal} route denominator cardinality mismatch`);
    }
    const performance = exactCompletePerformancePayload(joined.performance.payload, `bundle.head[${ordinal}].performance`);
    const serving = joined.coverage.serving;
    if (serving === null || !sameCanonical(joined.candidates.serving, serving) || !sameCanonical(joined.performance.serving, serving)) {
      throw new TypeError(`performance bundle head ${ordinal} serving partition mismatch`);
    }
    const producerTerminal = producerTerminalById.get(performance.terminalId);
    if (producerTerminal === undefined) throw new TypeError(`performance bundle head ${ordinal} lacks Producer terminal`);
    if (!coverage.complete || coverage.currentSourcePhysicalFacts === null
      || coverage.admissionId !== eligible.admissionId || candidates.admissionId !== eligible.admissionId
      || performance.admissionId !== eligible.admissionId
      || coverage.headHash !== eligible.head.hash || candidates.headHash !== eligible.head.hash || performance.headHash !== eligible.head.hash
      || coverage.headFactsRoot !== candidates.headFactsRoot || producerTerminal.payload.headFactsRoot !== coverage.headFactsRoot
      || performance.sourceCoverageRoot !== coverage.sourceCoverageRoot
      || performance.candidateCount !== candidates.candidateRefs.length.toString()
      || performance.candidateSetRoot !== hashDomain("aloha/performance-candidate-set-root/v1", candidates.candidateRefs)
      || performance.terminalId !== producerTerminal.payload.terminalId
      || performance.terminalBindingRoot !== producerTerminal.payload.terminalBindingRoot
      || producerTerminal.payload.ordinal !== ordinal
      || producerTerminal.payload.revision !== eligible.revision
      || !sameCanonical(producerTerminal.payload.head, eligible.head)
      || producerTerminal.payload.generationId !== serving.generationId
      || producerTerminal.payload.graphRoot !== serving.graphRoot
      || !sameCanonical(producerTerminal.event.serving, serving)) {
      throw new TypeError(`performance bundle head ${ordinal} raw lineage mismatch`);
    }
    const resource = performance.runtimeFacts.resource;
    if (resource.scope.windowId !== commitment.windowId
      || resource.scope.admissionId !== eligible.admissionId
      || resource.scope.ordinal !== ordinal
      || resource.scope.processLogAnchorHash !== processLogAnchorHash
      || resource.scope.generationId !== serving.generationId) {
      throw new TypeError(`performance bundle head ${ordinal} resource scope mismatch`);
    }
    const candidateSet = createCandidateSet({
      windowId: commitment.windowId,
      ordinal,
      candidateIds: candidates.candidateRefs,
    });
    const head = createEligibleHeadRecord({
      windowId: commitment.windowId,
      ordinal,
      canonicalHead: eligible.head,
      acceptedMonotonicNs: eligible.acceptedMonotonicNs,
      processLogAnchorHash,
      generationId: serving.generationId,
      graphRoot: serving.graphRoot,
      readyRecordHash: serving.readyRecordHash,
      providerRoot: commitment.providerRoot,
      hardwareProfileRoot: commitment.hardwareProfileRoot,
      generationSourceCoverageRoot: serving.sourceCoverageRoot,
      sourceCoverageRoot: coverage.sourceCoverageRoot,
      candidateSetRoot: candidateSet.candidateSetRoot,
      candidateCount: candidates.candidateRefs.length.toString(),
      candidateBearing: candidates.candidateRefs.length > 0,
    });
    const terminalReceipts = candidates.observations.map(observation => {
      const sixStepCompleted = observation.terminalKind === "passed";
      if (sixStepCompleted) {
        if (performance.sixStepFacts === null
          || performance.sixStepFacts.stage36Root !== observation.sixStepEvidenceRoot
          || performance.runtimeFacts.producerSchedulerJoin?.correlationId !== observation.correlationId
          || performance.runtimeFacts.producerSchedulerJoin.unsignedDryRunCandidateId !== observation.candidateId
          || performance.runtimeFacts.producerSchedulerJoin.unsignedDryRunLineageHash !== observation.terminalLineageHash) {
          throw new TypeError(`performance bundle head ${ordinal} verified candidate lacks exact six-step lineage`);
        }
      }
      return createCandidateTerminalReceipt({
        windowId: commitment.windowId,
        ordinal,
        headRecordId: head.headRecordId,
        candidateId: observation.performanceCandidateRef,
        outcome: observation.performanceOutcome,
        correlationRoot: observation.correlationId,
        sixStepCompleted,
        sixStepMode: sixStepCompleted ? "unsigned-dry-run" : null,
        sixStepEvidenceRoot: sixStepCompleted ? observation.sixStepEvidenceRoot : null,
        sixStepCompletionRoot: sixStepCompleted ? hashPerformanceSixStepCompletionLineage({
          windowId: commitment.windowId,
          headRecordId: head.headRecordId,
          candidateId: observation.performanceCandidateRef,
          correlationRoot: observation.correlationId,
          mode: "unsigned-dry-run",
          evidenceRoot: observation.sixStepEvidenceRoot!,
        }) : null,
        timingUs: observation.timingUs,
        evidenceRoot: observation.observationRoot,
      } as Omit<CandidateTerminalReceiptV1, "receiptId" | "schemaVersion" | "kind">);
    }).sort((left, right) => left.receiptId.localeCompare(right.receiptId));
    const passed = candidates.observations.filter(observation => observation.terminalKind === "passed");
    if (passed.length > 1
      || (passed.length === 0 && (performance.sixStepFacts !== null
        || performance.runtimeFacts.selectedSchedulerCompletion !== null
        || performance.runtimeFacts.producerSchedulerJoin !== null))
      || (passed.length === 1 && (performance.sixStepFacts === null
        || performance.runtimeFacts.selectedSchedulerCompletion === null
        || performance.runtimeFacts.producerSchedulerJoin === null))) {
      throw new TypeError(`performance bundle head ${ordinal} selected execution cardinality mismatch`);
    }
    const rawLineages = activeProjection.lineages.filter(lineage => lineage.ordinal === ordinal);
    const orphanObservationRoot = rawLineages.length === 0
      ? null
      : hashDomain("aloha/raw-production-performance-orphan-observation-root/v1", rawLineages.map(lineage => ({
          lineageId: lineage.lineageId,
          orphanEligibleEventId: lineage.orphanEligibleEventId,
          orphanProducerTerminalEventId: lineage.orphanProducerTerminalEventId,
        })));
    const lineageRelevantEvents = rawLineages.flatMap(lineage => {
      const orphanEligible = eventById.get(lineage.orphanEligibleEventId);
      const orphanPerformance = performanceByTerminalId.get(lineage.orphanProducerTerminalId);
      const orphanProducer = eventById.get(lineage.orphanProducerTerminalEventId);
      if (orphanEligible === undefined || orphanPerformance === undefined || orphanProducer === undefined) {
        throw new TypeError(`performance bundle head ${ordinal} orphan lineage event is missing`);
      }
      return [orphanEligible, orphanPerformance, orphanProducer];
    });
    const relevantEvents = [
      ...lineageRelevantEvents,
      eligibleEvent,
      joined.coverage,
      ...orderedRouteDenominators,
      joined.candidates,
      joined.performance,
      producerTerminal.event,
    ]
      .filter((event, eventIndex, values) => values.findIndex(candidate => candidate.eventId === event.eventId) === eventIndex);
    const relevantRows = relevantEvents.map(event => rowByEventId.get(event.eventId));
    if (relevantRows.some(row => row === undefined)) throw new TypeError(`performance bundle head ${ordinal} raw row missing`);
    const rawReceiptSetRoot = hashDomain(
      "aloha/raw-production-performance-head-receipt-set/v1",
      relevantEvents.map(event => event.eventId),
    );
    const headDurationUs = (() => {
      const start = BigInt(eligible.acceptedMonotonicNs);
      const end = BigInt(performance.terminalMonotonicNs);
      if (end < start) throw new TypeError(`performance bundle head ${ordinal} duration mismatch`);
      return ((end - start) / 1_000n).toString();
    })();
    const sourceCoarseDurationUs = coverage.currentSourcePhysicalFacts.elapsedUs;
    const coarseDurationUs = maximumDecimal(coverage.coarseTimingFacts.map(item => item.durationUs));
    const candidatePathDurationUs = candidates.observations.length === 0
      ? null
      : maximumDecimal(candidates.observations.map(item => item.timingUs));
    const plannerExactProgramDurationUs = performance.sixStepFacts?.plannerExactProgramDurationUs
      ?? (candidatePathDurationUs ?? "0");
    const finalSimulationCompletions = performance.runtimeFacts.schedulerCompletions.filter(item => item.work.phase === "final-sim");
    const finalSimulationQueueWaitUs = maximumDecimal(finalSimulationCompletions.map(item => item.queueWaitUs ?? "0"));
    const finalSimulationServiceUs = maximumDecimal(finalSimulationCompletions.map(item => item.serviceUs ?? "0"));
    const accounted = BigInt(sourceCoarseDurationUs) + BigInt(coarseDurationUs) + BigInt(candidatePathDurationUs ?? "0");
    const overheadDurationUs = BigInt(headDurationUs) > accounted ? (BigInt(headDurationUs) - accounted).toString() : "0";
    const metric = createPerformanceMetricSample({
      windowId: commitment.windowId,
      ordinal,
      processLogAnchorHash,
      generationId: serving.generationId,
      graphRoot: serving.graphRoot,
      readyRecordHash: serving.readyRecordHash,
      providerRoot: commitment.providerRoot,
      hardwareProfileRoot: commitment.hardwareProfileRoot,
      generationSourceCoverageRoot: serving.sourceCoverageRoot,
      sourceCoverageRoot: coverage.sourceCoverageRoot,
      headStartMonotonicNs: eligible.acceptedMonotonicNs,
      headTerminalMonotonicNs: performance.terminalMonotonicNs,
      headDurationUs,
      candidatePathDurationUs,
      sourceCoarseDurationUs,
      coarseDurationUs,
      plannerExactProgramDurationUs,
      finalSimulationQueueWaitUs,
      finalSimulationServiceUs,
      overheadDurationUs,
      queueTelemetry: exactQueueTelemetry(performance.runtimeFacts.schedulerRange),
      permitAccounting: exactPermitAccounting(performance.runtimeFacts.schedulerRange),
      resourceSamples: exactResourceSamples(performance.runtimeFacts.schedulerRange),
      cpuMemoryEventLoop: resource.cpuMemoryEventLoop,
      workerRestart: resource.workerRestart,
      rawReceiptSetRoot,
    });
    const offsets = relevantRows as readonly RawAppendRowV1[];
    const terminal = createHeadTerminalReceipt({
      windowId: commitment.windowId,
      ordinal,
      canonicalHead: eligible.head,
      supersededOrphanObservationRoot: orphanObservationRoot,
      processLogAnchorHash,
      generationId: serving.generationId,
      graphRoot: serving.graphRoot,
      readyRecordHash: serving.readyRecordHash,
      performanceProfileHash: commitment.performanceProfileHash,
      providerRoot: commitment.providerRoot,
      hardwareProfileRoot: commitment.hardwareProfileRoot,
      generationSourceCoverageRoot: serving.sourceCoverageRoot,
      sourceCoverageRoot: coverage.sourceCoverageRoot,
      candidateSetRoot: candidateSet.candidateSetRoot,
      orderedCandidateTerminalReceiptRoot: hashOrderedCandidateTerminalReceiptRoot(terminalReceipts),
      outcome: candidates.candidateRefs.length === 0 ? "complete-no-candidate" : "complete-candidates-terminal",
      acceptedMonotonicNs: eligible.acceptedMonotonicNs,
      terminalMonotonicNs: performance.terminalMonotonicNs,
      logRangeStartOffset: minimumDecimal(offsets.map(row => row.offsetStart)),
      logRangeEndOffset: maximumDecimal(offsets.map(row => row.offsetEnd)),
      headDurationUs,
      metricSampleId: metric.metricSampleId,
      timingSampleRoot: hashTimingSampleRoot(metric),
      workReceiptRoot: performance.runtimeFacts.schedulerRange.rangeId,
      queueTelemetryRoot: hashQueueTelemetryRoot(metric.queueTelemetry),
      resourceSampleRoot: hashResourceSampleRoot(metric.resourceSamples),
      cpuMemoryEventLoopRoot: hashCpuMemoryEventLoopRoot(metric.cpuMemoryEventLoop),
      workerRestartRoot: hashWorkerRestartRoot(metric.workerRestart),
      rawReceiptSetRoot,
    });
    heads.push(head);
    if (rawLineages.length > 0) {
      const firstLineage = rawLineages[0]!;
      semanticLineages.push(createHeadOrphanReplacementLineage({
        windowId: commitment.windowId,
        ordinal,
        orphanHeadRecordId: hashDomain("aloha/raw-production-performance-orphan-admission-record/v1", {
          admissionId: firstLineage.orphanAdmissionId,
          eligibleEventId: firstLineage.orphanEligibleEventId,
          canonicalHead: firstLineage.orphanCanonicalHead,
          revision: firstLineage.orphanRevision,
          acceptedMonotonicNs: firstLineage.orphanAcceptedMonotonicNs,
        }),
        orphanCanonicalHead: firstLineage.orphanCanonicalHead,
        orphanObservationRoot: orphanObservationRoot!,
        replacementHeadRecordId: head.headRecordId,
        replacementCanonicalHead: eligible.head,
        replacementObservationRoot: hashDomain("aloha/raw-production-performance-replacement-observation-root/v1", {
          activeEligibleEventId: eligibleEvent.eventId,
          admissionLineageIds: rawLineages.map(lineage => lineage.lineageId),
        }),
      }));
    }
    candidateSets.push(candidateSet);
    candidateTerminals.push(...terminalReceipts);
    metrics.push(metric);
    terminals.push(terminal);
  }
  candidateTerminals.sort((left, right) => BigInt(left.ordinal) < BigInt(right.ordinal) ? -1
    : BigInt(left.ordinal) > BigInt(right.ordinal) ? 1
    : left.receiptId.localeCompare(right.receiptId));
  const generationSegments = derivePerformanceGenerationSegments({
    windowId: commitment.windowId,
    heads,
    terminals,
    metrics,
  });
  const semanticRawReceiptSetRoot = hashPerformanceSemanticReceiptSetRoot({
    profile,
    commitment,
    heads,
    lineages: semanticLineages,
    candidateSets,
    candidateTerminals,
    metrics,
    terminals,
    generationSegments,
  });
  const windowEndMonotonicNs = maximumDecimal(terminals.map(item => item.terminalMonotonicNs));
  const windowDurationNs = BigInt(windowEndMonotonicNs) - BigInt(commitment.committedMonotonicNs);
  if (windowDurationNs < 0n) throw new TypeError("performance window duration mismatch");
  const windowReceipt = createPerformanceWindowReceipt({
    windowId: commitment.windowId,
    windowCommitmentHash: hashPerformanceWindowCommitment(commitment),
    orderedEligibleHeadRecordRoot: hashOrderedEligibleHeadRecordsRoot(heads),
    orderedHeadTerminalReceiptRoot: hashOrderedHeadTerminalReceiptRoot(terminals),
    orphanReplacementLineageRoot: hashOrphanReplacementLineageRoot(semanticLineages),
    candidateBearingHeadSetRoot: hashCandidateBearingHeadSetRoot(heads),
    fullHeadTimingSampleRoot: hashFullHeadTimingSampleRoot(metrics),
    candidatePathTimingSampleRoot: hashCandidatePathTimingSampleRoot(metrics),
    metricRecomputationRoot: hashMetricRecomputationRoot(metrics),
    generationSegmentRoot: hashPerformanceGenerationSegmentRoot(generationSegments),
    rawReceiptSetRoot: semanticRawReceiptSetRoot,
    headCount: "100",
    healthyHeadCount: "100",
    excludedHeads: [],
    windowStartMonotonicNs: commitment.committedMonotonicNs,
    windowEndMonotonicNs,
    windowDurationUs: (windowDurationNs / 1_000n).toString(),
  });
  return decodePartitionedPerformanceFactBundle({
    profile,
    commitment,
    heads,
    lineages: semanticLineages,
    candidateSets,
    candidateTerminals,
    metrics,
    terminals,
    generationSegments,
    windowReceipt,
  });
}

const RAW_SIX_STEP_SELECTION_POLICY_DIGEST = hashDomain(
  "aloha/searcher-production-six-step-window-selection-policy/v1",
  Object.freeze({
    denominator: "active-exact-100-performance-window",
    eligibility: "complete-successful-dry-run",
    order: Object.freeze(["ordinal", "lane:blockscan-before-backrun", "candidate-stable-key", "producer-terminal-id"]),
    selection: "first",
  }),
);

function appendBinding(row: RawAppendRowV1) {
  return Object.freeze({
    namespace: row.namespace,
    sequence: row.sequence,
    eventId: row.eventId,
    contentSha256: row.contentSha256,
    byteLength: row.byteLength,
    offsetStart: row.offsetStart,
    offsetEnd: row.offsetEnd,
  });
}

/** Independent raw-row recomputation of the frozen mechanical selector. It
 * does not consume the process-local selection capability or its verdict. */
function observeRawSixStepWindowSelection(
  events: readonly ObservedProductionEventV1[],
  rows: readonly RawAppendRowV1[],
  commitment: PerformanceWindowCommitmentV1,
): RawSixStepWindowSelectionV1 {
  const active = activeAdmissionProjection(events);
  if (active.payloads.length !== 100) throw new TypeError("raw Six-Step selection requires the active exact-100 denominator");
  const rowByEventId = new Map(rows.map(row => [row.eventId, row] as const));
  const candidatesByAdmission = new Map<Hash, ObservedProductionEventV1>();
  const performanceByAdmission = new Map<Hash, ObservedProductionEventV1>();
  const producerByTerminal = new Map<Hash, { readonly event: ObservedProductionEventV1; readonly payload: ObservedProducerTerminalPayloadV1 }>();
  for (const event of events) {
    if (event.eventType === "candidate-set") candidatesByAdmission.set(assertHash(event.payload.admissionId, "rawSelection.candidates.admissionId"), event);
    if (event.eventType === "performance-facts-complete" || event.eventType === "performance-facts-incomplete") {
      performanceByAdmission.set(assertHash(event.payload.admissionId, "rawSelection.performance.admissionId"), event);
    }
    if (event.eventType === "producer-terminal") {
      const payload = exactProducerTerminalPayload(event.payload, "rawSelection.producerTerminal");
      producerByTerminal.set(payload.terminalId, Object.freeze({ event, payload }));
    }
  }
  const eligibleSuccesses: Array<Readonly<{
    readonly ordinal: string;
    readonly lane: LaneV1;
    readonly candidateStableKey: Hash;
    readonly producerTerminalId: Hash;
    readonly performanceEventId: Hash;
    readonly producerTerminalEventId: Hash;
  }>> = [];
  for (const eligible of active.payloads) {
    const candidatesEvent = candidatesByAdmission.get(eligible.admissionId);
    const performanceEvent = performanceByAdmission.get(eligible.admissionId);
    if (candidatesEvent === undefined || performanceEvent === undefined) throw new TypeError("raw Six-Step selection active admission facts are missing");
    const candidates = exactCandidateSetPayload(candidatesEvent.payload, `rawSelection.candidates[${eligible.ordinal}]`);
    const performance = performanceEvent.eventType === "performance-facts-complete"
      ? exactCompletePerformancePayload(performanceEvent.payload, `rawSelection.performance[${eligible.ordinal}]`)
      : null;
    const performanceIdentity = exactPerformanceTerminalIdentity(performanceEvent, `rawSelection.performanceIdentity[${eligible.ordinal}]`);
    const producer = producerByTerminal.get(performanceIdentity.terminalId);
    if (producer === undefined || producer.payload.ordinal !== eligible.ordinal) {
      throw new TypeError("raw Six-Step selection Producer terminal join mismatch");
    }
    const passed = candidates.observations.filter(observation => observation.terminalKind === "passed");
    if (passed.length > 1) throw new TypeError("raw Six-Step selection head has multiple successful candidates");
    if (passed.length === 0) continue;
    const success = passed[0]!;
    if (performance === null || performance.sixStepFacts === null
      || performance.sixStepFacts.stage36Root !== success.sixStepEvidenceRoot) {
      throw new TypeError("raw Six-Step selection successful candidate lacks complete durable lineage");
    }
    eligibleSuccesses.push(Object.freeze({
      ordinal: eligible.ordinal,
      lane: success.lane,
      candidateStableKey: success.candidateId,
      producerTerminalId: producer.payload.terminalId,
      performanceEventId: performanceEvent.eventId,
      producerTerminalEventId: producer.event.eventId,
    }));
  }
  eligibleSuccesses.sort((left, right) => {
    const ordinal = BigInt(left.ordinal) - BigInt(right.ordinal);
    if (ordinal !== 0n) return ordinal < 0n ? -1 : 1;
    if (left.lane !== right.lane) return left.lane === "blockscan" ? -1 : 1;
    const candidate = left.candidateStableKey.localeCompare(right.candidateStableKey);
    return candidate === 0 ? left.producerTerminalId.localeCompare(right.producerTerminalId) : candidate;
  });
  if (new Set(eligibleSuccesses.map(entry => entry.producerTerminalId)).size !== eligibleSuccesses.length) {
    throw new TypeError("raw Six-Step selection has conflicting Producer terminal identities");
  }
  const finalEligible = active.payloads[99]!;
  const finalPerformance = performanceByAdmission.get(finalEligible.admissionId)!;
  const finalIdentity = exactPerformanceTerminalIdentity(finalPerformance, "rawSelection.finalPerformance");
  const finalProducer = producerByTerminal.get(finalIdentity.terminalId);
  const finalPerformanceRow = rowByEventId.get(finalPerformance.eventId);
  const finalProducerRow = finalProducer === undefined ? undefined : rowByEventId.get(finalProducer.event.eventId);
  if (finalProducer === undefined || finalPerformanceRow === undefined || finalProducerRow === undefined) {
    throw new TypeError("raw Six-Step selection final durable window rows are missing");
  }
  if (finalPerformance.serving === null) throw new TypeError("raw Six-Step selection final performance serving is missing");
  const finalWindowDraft = Object.freeze({
    release: finalPerformance.release,
    runtimeAnchor: finalPerformance.runtimeAnchor,
    serving: finalPerformance.serving,
    windowId: commitment.windowId,
    targetCount: "100" as const,
    ordinal: "100" as const,
    head: finalEligible.head,
    revision: finalEligible.revision,
    terminalId: finalProducer.payload.terminalId,
    terminalBindingRoot: finalIdentity.terminalBindingRoot,
    performanceFactStatus: finalPerformance.eventType === "performance-facts-complete" ? "complete" as const : "incomplete" as const,
    performanceAppend: appendBinding(finalPerformanceRow),
    producerTerminalAppend: appendBinding(finalProducerRow),
  });
  const finalDurableWindowId = hashDomain(
    "aloha/final-durable-window/v1",
    finalWindowDraft as unknown as CanonicalJson,
  );
  const eligibleSuccessRoot = hashDomain(
    "aloha/searcher-production-six-step-window-eligible-successes/v1",
    eligibleSuccesses,
  );
  const selected = eligibleSuccesses[0] ?? null;
  const selectionRoot = hashDomain("aloha/searcher-production-six-step-window-selection/v1", {
    finalDurableWindowId,
    windowId: commitment.windowId,
    selectionPolicyDigest: RAW_SIX_STEP_SELECTION_POLICY_DIGEST,
    eligibleSuccessCount: eligibleSuccesses.length.toString(),
    eligibleSuccessRoot,
    orderedEligible: eligibleSuccesses,
    selectedIndex: selected === null ? null : "0",
    selectedProducerTerminalId: selected?.producerTerminalId ?? null,
  });
  return Object.freeze({
    finalDurableWindowId,
    selectionPolicyDigest: RAW_SIX_STEP_SELECTION_POLICY_DIGEST,
    eligibleSuccessCount: eligibleSuccesses.length.toString(),
    eligibleSuccessRoot,
    selectedIndex: selected === null ? null : "0",
    selectedProducerTerminalId: selected?.producerTerminalId ?? null,
    selectedPerformanceEventId: selected?.performanceEventId ?? null,
    selectedProducerTerminalEventId: selected?.producerTerminalEventId ?? null,
    selectionRoot,
  });
}

export function observeProductionPerformanceDatabaseV1(databasePath: string): RawPerformanceObservationV1 {
  if (typeof databasePath !== "string" || !databasePath.startsWith("/")) throw new TypeError("production performance database path must be absolute");
  // Opening the read transaction may perform read-side recovery/truncation of
  // an already checkpointed WAL. Establish the immutable storage baseline
  // immediately after BEGIN and before the first observer query.
  let storageBefore = observeSqliteStorageSet(databasePath);
  let database: ReadonlySqliteDatabase | null = null;
  let transactionActive = false;
  try {
    database = openReadonlySqliteDatabase(databasePath);
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    transactionActive = true;
    const sqliteSchemaRoot = observeSqliteSchema(database);
    // SQLite may finish WAL recovery while the first schema query is opened.
    // From this point onward the observer has a fixed database snapshot and
    // the physical storage set must remain byte-identical.
    storageBefore = observeSqliteStorageSet(databasePath);
    const observedRows = readRows(database);
    const rows = observedRows.performanceRows;
    const events = Object.freeze(rows.map(row => exactEvent(row, database!)));
    const joined = joinEvents(events);
    const bundle = joined.status === "raw-complete" && joined.profile !== null && joined.commitment !== null
      ? projectPerformanceBundle(events, rows, joined.profile, joined.commitment)
      : null;
    const sixStepWindowSelection = joined.status === "raw-complete" && joined.commitment !== null
      ? observeRawSixStepWindowSelection(events, rows, joined.commitment)
      : null;
    database.exec("ROLLBACK");
    transactionActive = false;
    // Observe the storage set while the same read-only connection is still
    // open. Closing the final SQLite connection may remove an already-
    // checkpointed WAL without changing database contents; that lifecycle
    // cleanup is not a concurrent producer write.
    const storageAfter = observeSqliteStorageSet(databasePath);
    if (storageBefore.root !== storageAfter.root) {
      throw new TypeError("production performance SQLite storage set changed during observation");
    }
    database.close();
    database = null;
    const rawRowRoot = hashDomain("aloha/raw-production-performance-row-root/v1", rows.map(row => ({
      namespace: row.namespace,
      sequence: row.sequence,
      eventId: row.eventId,
      contentSha256: row.contentSha256,
      byteLength: row.byteLength,
      offsetStart: row.offsetStart,
      offsetEnd: row.offsetEnd,
    })));
    const eventRoot = hashDomain("aloha/raw-production-performance-event-root/v1", events.map(event => event.eventId));
    const terminalPhaseRowRoot = hashDomain("aloha/raw-production-terminal-phase-row-root/v1", observedRows.terminalPhaseRows.map(row => ({
      namespace: row.namespace,
      sequence: row.sequence,
      eventId: row.eventId,
      contentSha256: row.contentSha256,
      byteLength: row.byteLength,
      offsetStart: row.offsetStart,
      offsetEnd: row.offsetEnd,
    })));
    return Object.freeze({
      kind: "aloha.raw-production-performance-observation-v1" as const,
      status: joined.status,
      reasons: joined.reasons,
      databaseSha256Before: storageBefore.mainSha256,
      databaseSha256After: storageAfter.mainSha256,
      storageSetRootBefore: storageBefore.root,
      storageSetRootAfter: storageAfter.root,
      sqliteSchemaRoot,
      rawRowRoot,
      eventRoot,
      terminalPhaseRowCount: observedRows.terminalPhaseRows.length.toString(),
      terminalPhaseRowRoot,
      sixStepWindowSelection,
      release: joined.release,
      servingPartitions: joined.servingPartitions,
      profile: joined.profile,
      commitment: joined.commitment,
      events,
      bundle,
    });
  } catch (error) {
    try {
      if (transactionActive) database?.exec("ROLLBACK");
    } catch { /* Preserve the observer error. */ }
    let storageAfter: ObservedSqliteStorageSetV1;
    try {
      storageAfter = observeSqliteStorageSet(databasePath);
    } catch {
      storageAfter = storageBefore;
    }
    try { database?.close(); } catch { /* Preserve the observer error. */ }
    return Object.freeze({
      kind: "aloha.raw-production-performance-observation-v1" as const,
      status: "invalid" as const,
      reasons: Object.freeze([error instanceof Error ? error.message : "raw-observer-failed"]),
      databaseSha256Before: storageBefore.mainSha256,
      databaseSha256After: storageAfter.mainSha256,
      storageSetRootBefore: storageBefore.root,
      storageSetRootAfter: storageAfter.root,
      sqliteSchemaRoot: ZERO_HASH,
      rawRowRoot: ZERO_HASH,
      eventRoot: ZERO_HASH,
      terminalPhaseRowCount: "0",
      terminalPhaseRowRoot: ZERO_HASH,
      sixStepWindowSelection: null,
      release: null,
      servingPartitions: Object.freeze([]),
      profile: null,
      commitment: null,
      events: Object.freeze([]),
      bundle: null,
    });
  }
}
