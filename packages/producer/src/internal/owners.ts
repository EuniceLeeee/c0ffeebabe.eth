import type {
  CanonicalHead,
  ProducerBoundTriggerFactsV1,
  ProducerBoundTriggerV1,
  ProducerBackrunIntakeFactsV1,
  ProducerBackrunIntakeV1,
  ProducerIngressTriggerSpecV1,
  ProducerIngressTriggerV1,
  ProducerIngressObservationV1,
  ProducerIngressSourceV1,
  ProducerIngressPortV1,
  ProducerHeadInputV1,
  ProducerHeadFactsCapabilityV1,
  ProducerHeadFactsV1,
  ProducerHeadTerminalCapabilityV1,
  ProducerHeadTerminalEvidenceV1,
  ProducerFinalFullFamilyTerminalSetV1,
  ProducerCurrentSourceHeadPortV1,
  ProducerCurrentSourceLogicalFactsV1,
  ProducerLaneAccountingEntryV1,
  ProducerLaneAccountingLegV1,
  ProducerLaneAccountingV1,
  ProducerLaneFactsV1,
  ProducerNoInputLaneDenominatorV1,
  ProducerLaneFailureObservationV1,
  ProducerCandidateTerminalObservationV1,
  ProducerLaneOutcomeV1,
  ProducerLaneOutcomeKindV1,
  ProducerLaneTerminalKindV1,
  ProducerLaneKindV1,
  ProducerLanePortV1,
  ProducerLaneRunnerV1,
  ProducerLaneRunDraftV1,
  ProducerLaneRunInputV1,
  ProducerPendingSnapshotV1,
  ProducerPerformancePortV1,
  ProducerSessionV1,
  ProducerSessionOwnerV1,
  ProducerTerminalPortV1,
  ProducerTerminalV1,
} from "../index.ts";
import {
  assertIssuedCurrentSourceRpcLogicalScopeFactsV1,
  assertIssuedCurrentSourceRpcPhysicalFactsV1,
} from "../../../current-source-rpc/src/index.ts";
import {
  readIssuedSearchTerminalCapabilityV1,
  readIssuedSearchTerminalCoarseTimingV1,
  readIssuedSearchTerminalCandidateTimingsV1,
  readIssuedSearchTerminalPlannerEnumerationV1,
  readIssuedSearchTerminalSchedulerResourceJoinV1,
  readIssuedSearchTerminalSixStepTraceV1,
  validateUnsignedDryRunReceiptValue,
  type IssuedSearchTerminalV1,
  type SearchSchedulerResourceJoinV1,
  type RouteCoarseTimingFactsV1,
  type RouteCandidateTerminalTimingFactsV1,
  type SearchTerminalSixStepTraceV1,
  type SearchTerminalCapabilityV1,
} from "../../../search-pipeline/src/index.ts";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import { assertIssuedProducerIngressSource } from "./source-brand.ts";
import { performanceLaneCandidateRefV1 } from "../../../../specs/performance/src/index.ts";

const laneIssued = new WeakSet<object>();
const sessionOwnersIssued = new WeakSet<object>();
const performanceIssued = new WeakSet<object>();
const currentSourceHeadPortsIssued = new WeakSet<object>();
const terminalIssued = new WeakSet<object>();
const ingressPortsIssued = new WeakSet<object>();
const ingressTriggerIssued = new WeakMap<object, ProducerIngressTriggerSpecV1>();
const boundTriggerIssued = new WeakMap<object, ProducerBoundTriggerFactsV1>();
const backrunIntakeIssued = new WeakMap<object, ProducerBackrunIntakeFactsV1>();
const laneFactsIssued = new WeakMap<object, ProducerLaneFactsV1>();
const laneNoInputDenominators = new WeakMap<object, ProducerNoInputLaneDenominatorV1>();
const laneFailureObservationsIssued = new WeakMap<object, ProducerLaneFailureObservationV1>();
const laneSearchTerminals = new WeakMap<object, SearchTerminalCapabilityV1>();
const headFactsIssued = new WeakMap<object, ProducerHeadFactsV1>();
const headTerminalIssued = new WeakMap<object, ProducerHeadTerminalEvidenceV1>();

function objectValue(value: unknown, context: string): Record<string, unknown> {
  assertPlainObject(value, context);
  return value as Record<string, unknown>;
}

function sameHead(left: CanonicalHead, right: CanonicalHead): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.parentHash === right.parentHash
    && left.stateRoot === right.stateRoot;
}

function sameSourceView(
  left: { readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string },
  right: { readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string },
): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function normalizedAffectedEdgeIds(value: readonly Hash[]): readonly Hash[] {
  if (!Array.isArray(value)) throw new TypeError("producer trigger affected edges are required");
  const result = value.map((edgeId, index) => assertHash(edgeId, `producerTrigger.affectedEdgeIds[${index}]`));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]! >= result[index]!) {
      throw new TypeError("producer trigger affected edges must be strictly sorted");
    }
  }
  return Object.freeze([...result]);
}

export function issueProducerIngressTriggerV1(
  input: ProducerIngressTriggerSpecV1,
): ProducerIngressTriggerV1 {
  const value = objectValue(input, "producer ingress trigger");
  assertExactKeys(value, ["lane", "head", "triggerRef", "txHash", "correlationId", "affectedEdgeIds", "pendingEvidenceHash"], "producerIngressTrigger");
  if (value.lane !== "blockscan" && value.lane !== "backrun") throw new TypeError("producer trigger lane is invalid");
  const rawHead = value.head;
  assertPlainObject(rawHead, "producerTrigger.head");
  assertExactKeys(rawHead, ["chainId", "number", "hash", "parentHash", "stateRoot"], "producerTrigger.head");
  const headRecord = rawHead as Record<string, unknown>;
  const head: CanonicalHead = Object.freeze({
    chainId: assertNonEmptyString(headRecord.chainId, "producerTrigger.head.chainId"),
    number: assertDecimalString(headRecord.number, "producerTrigger.head.number"),
    hash: assertHash(headRecord.hash, "producerTrigger.head.hash"),
    parentHash: assertHash(headRecord.parentHash, "producerTrigger.head.parentHash"),
    stateRoot: assertHash(headRecord.stateRoot, "producerTrigger.head.stateRoot"),
  });
  const triggerRef = assertHash(value.triggerRef, "producerTrigger.triggerRef");
  const txHash = value.txHash === null ? null : assertHash(value.txHash, "producerTrigger.txHash");
  const pendingEvidenceHash = value.pendingEvidenceHash === null
    ? null
    : assertHash(value.pendingEvidenceHash, "producerTrigger.pendingEvidenceHash");
  if (value.lane === "blockscan" && (txHash !== null || pendingEvidenceHash !== null)) {
    throw new TypeError("blockscan trigger cannot carry transaction evidence");
  }
  if (value.lane === "backrun" && (txHash === null || pendingEvidenceHash === null || triggerRef !== txHash)) {
    throw new TypeError("backrun trigger requires its real transaction hash and pending evidence");
  }
  const normalized: ProducerIngressTriggerSpecV1 = Object.freeze({
    lane: value.lane as ProducerIngressTriggerSpecV1["lane"],
    head,
    triggerRef,
    txHash,
    correlationId: assertHash(value.correlationId, "producerTrigger.correlationId"),
    affectedEdgeIds: normalizedAffectedEdgeIds(value.affectedEdgeIds as readonly Hash[]),
    pendingEvidenceHash,
  });
  const token = Object.freeze(Object.create(null)) as ProducerIngressTriggerV1;
  ingressTriggerIssued.set(token, normalized);
  return token;
}

export function assertIssuedProducerIngressTriggerV1(
  value: unknown,
): asserts value is ProducerIngressTriggerV1 {
  if (value === null || typeof value !== "object" || !ingressTriggerIssued.has(value)) {
    throw new TypeError("producer ingress trigger is not owner-issued");
  }
}

export function readIssuedProducerIngressTriggerV1(
  value: unknown,
): ProducerIngressTriggerSpecV1 {
  assertIssuedProducerIngressTriggerV1(value);
  return ingressTriggerIssued.get(value as object)!;
}

function exactObservedHead(value: unknown, expected: CanonicalHead): CanonicalHead {
  const record = objectValue(value, "producer ingress observed head");
  assertExactKeys(record, ["chainId", "number", "hash", "parentHash", "stateRoot"], "producerIngress.observedHead");
  const head: CanonicalHead = Object.freeze({
    chainId: assertNonEmptyString(record.chainId, "producerIngress.observedHead.chainId"),
    number: assertDecimalString(record.number, "producerIngress.observedHead.number"),
    hash: assertHash(record.hash, "producerIngress.observedHead.hash"),
    parentHash: assertHash(record.parentHash, "producerIngress.observedHead.parentHash"),
    stateRoot: assertHash(record.stateRoot, "producerIngress.observedHead.stateRoot"),
  });
  if (!sameHead(head, expected)) throw new TypeError("producer ingress observer returned a foreign canonical head");
  return head;
}

function observedInput(value: unknown, path: string): Record<string, unknown> {
  const record = objectValue(value, path);
  if (Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return Object.freeze({ ...record });
}

function normalizedPendingSnapshot(
  value: unknown,
  head: CanonicalHead,
  path: string,
): ProducerPendingSnapshotV1 {
  const record = objectValue(value, path);
  assertExactKeys(record, [
    "pendingNumber", "parentHash", "orderedTransactionHashes", "orderedTransactionHashesRoot",
    "transactionCount", "snapshotHash",
  ], path);
  const pendingNumber = assertDecimalString(record.pendingNumber, `${path}.pendingNumber`);
  if (BigInt(pendingNumber) !== BigInt(head.number) + 1n) throw new TypeError(`${path}.pendingNumber is not the exact successor`);
  const parentHash = assertHash(record.parentHash, `${path}.parentHash`);
  if (parentHash !== head.hash) throw new TypeError(`${path}.parentHash does not match the canonical head`);
  if (!Array.isArray(record.orderedTransactionHashes)) throw new TypeError(`${path}.orderedTransactionHashes are required`);
  const orderedTransactionHashes = record.orderedTransactionHashes.map((hash, index) => assertHash(hash, `${path}.orderedTransactionHashes[${index}]`));
  if (new Set(orderedTransactionHashes).size !== orderedTransactionHashes.length) throw new TypeError(`${path}.orderedTransactionHashes are not unique`);
  const orderedTransactionHashesRoot = assertHash(record.orderedTransactionHashesRoot, `${path}.orderedTransactionHashesRoot`);
  const expectedSetRoot = hashDomain("aloha/public-pending-transaction-set/v1", orderedTransactionHashes);
  if (orderedTransactionHashesRoot !== expectedSetRoot) throw new TypeError(`${path}.orderedTransactionHashesRoot mismatch`);
  const transactionCount = assertDecimalString(record.transactionCount, `${path}.transactionCount`);
  if (BigInt(transactionCount) !== BigInt(orderedTransactionHashes.length)) throw new TypeError(`${path}.transactionCount mismatch`);
  const snapshot = {
    pendingNumber,
    parentHash,
    orderedTransactionHashes: Object.freeze([...orderedTransactionHashes]),
    orderedTransactionHashesRoot,
    transactionCount,
  };
  const snapshotHash = assertHash(record.snapshotHash, `${path}.snapshotHash`);
  if (snapshotHash !== hashDomain("aloha/public-pending-snapshot/v1", { head, ...snapshot })) throw new TypeError(`${path}.snapshotHash mismatch`);
  return deepFreeze({ ...snapshot, snapshotHash });
}

function normalizeObservation(value: unknown, expectedHead: CanonicalHead): ProducerIngressObservationV1 {
  const record = objectValue(value, "producer ingress observation");
  assertExactKeys(record, ["head", "blockscan", "backrun"], "producerIngress");
  const observedHead = exactObservedHead(record.head, expectedHead);
  const blockscan = objectValue(record.blockscan, "producerIngress.blockscan");
  const backrun = objectValue(record.backrun, "producerIngress.backrun");
  assertExactKeys(blockscan, ["input"], "producerIngress.blockscan");
  const normalizedBlockscan = Object.freeze({ input: observedInput(blockscan.input, "producerIngress.blockscan.input") });
  const snapshot = backrun.snapshot === null
    ? null
    : normalizedPendingSnapshot(backrun.snapshot, observedHead, "producerIngress.backrun.snapshot");
  let normalizedBackrun: ProducerIngressObservationV1["backrun"];
  if (backrun.kind === "pending-transaction") {
    assertExactKeys(backrun, ["kind", "snapshot", "txHash", "affectedEdgeIds", "pendingEvidenceHash", "input"], "producerIngress.backrun");
    if (snapshot === null || snapshot.transactionCount !== "1") throw new TypeError("pending transaction observation requires a singleton snapshot");
    const txHash = assertHash(backrun.txHash, "producerIngress.backrun.txHash");
    if (snapshot.orderedTransactionHashes[0] !== txHash) throw new TypeError("pending transaction is outside its snapshot");
    const pendingEvidenceHash = assertHash(backrun.pendingEvidenceHash, "producerIngress.backrun.pendingEvidenceHash");
    const inputValue = observedInput(backrun.input, "producerIngress.backrun.input");
    if (pendingEvidenceHash !== hashDomain("aloha/public-pending-transaction-evidence/v2", { head: observedHead, snapshotHash: snapshot.snapshotHash, transaction: inputValue.pendingTransaction })) {
      throw new TypeError("pending transaction evidence hash mismatch");
    }
    normalizedBackrun = Object.freeze({
      kind: "pending-transaction",
      snapshot,
      txHash,
      affectedEdgeIds: normalizedAffectedEdgeIds(backrun.affectedEdgeIds as readonly Hash[]),
      pendingEvidenceHash,
      input: inputValue,
    });
  } else if (backrun.kind === "observed-empty") {
    assertExactKeys(backrun, ["kind", "snapshot", "absenceEvidenceHash"], "producerIngress.backrun");
    if (snapshot === null || snapshot.transactionCount !== "0") throw new TypeError("empty pending observation requires an empty snapshot");
    const absenceEvidenceHash = assertHash(backrun.absenceEvidenceHash, "producerIngress.backrun.absenceEvidenceHash");
    if (absenceEvidenceHash !== hashDomain("aloha/public-pending-absence-evidence/v1", { head: observedHead, snapshotHash: snapshot.snapshotHash })) {
      throw new TypeError("pending absence evidence hash mismatch");
    }
    normalizedBackrun = Object.freeze({ kind: "observed-empty", snapshot, absenceEvidenceHash });
  } else if (backrun.kind === "unavailable") {
    assertExactKeys(backrun, ["kind", "snapshot", "reasonCode", "evidenceHash"], "producerIngress.backrun");
    if (backrun.reasonCode !== "pending-observation-disabled" && backrun.reasonCode !== "pending-block-unavailable" && backrun.reasonCode !== "pending-set-not-single") {
      throw new TypeError("pending unavailable reason is invalid");
    }
    if (backrun.reasonCode === "pending-set-not-single" && (snapshot === null || BigInt(snapshot.transactionCount) <= 1n)) {
      throw new TypeError("pending set coverage failure requires a multi-transaction snapshot");
    }
    if (backrun.reasonCode !== "pending-set-not-single" && snapshot !== null) throw new TypeError("pending unavailable snapshot is unexpected");
    const evidenceHash = assertHash(backrun.evidenceHash, "producerIngress.backrun.evidenceHash");
    const expectedEvidenceHash = hashDomain("aloha/public-pending-unavailable-evidence/v1", {
      head: observedHead,
      reasonCode: backrun.reasonCode,
      snapshotHash: snapshot?.snapshotHash ?? null,
    });
    if (evidenceHash !== expectedEvidenceHash) throw new TypeError("pending unavailable evidence hash mismatch");
    normalizedBackrun = Object.freeze({ kind: "unavailable", snapshot, reasonCode: backrun.reasonCode, evidenceHash });
  } else {
    throw new TypeError("producer ingress backrun observation kind is invalid");
  }
  return Object.freeze({
    head: observedHead,
    blockscan: normalizedBlockscan,
    backrun: normalizedBackrun,
  });
}

function issueBackrunIntake(
  head: CanonicalHead,
  observation: ProducerIngressObservationV1["backrun"],
): ProducerBackrunIntakeV1 {
  let facts: ProducerBackrunIntakeFactsV1;
  if (observation.kind === "pending-transaction") {
    const correlationId = hashDomain("aloha/public-pending-transaction-correlation/v2", {
      head,
      txHash: observation.txHash,
      pendingEvidenceHash: observation.pendingEvidenceHash,
      snapshotHash: observation.snapshot.snapshotHash,
    });
    const trigger = issueProducerIngressTriggerV1({
      lane: "backrun",
      head,
      triggerRef: observation.txHash,
      txHash: observation.txHash,
      correlationId,
      affectedEdgeIds: observation.affectedEdgeIds,
      pendingEvidenceHash: observation.pendingEvidenceHash,
    });
    facts = deepFreeze({
      kind: "pending-transaction",
      head,
      snapshot: observation.snapshot,
      txHash: observation.txHash,
      pendingEvidenceHash: observation.pendingEvidenceHash,
      correlationId,
      affectedEdgeIds: observation.affectedEdgeIds,
      trigger,
      input: Object.freeze({ ...observation.input, correlationId, trigger }),
    });
  } else if (observation.kind === "observed-empty") {
    const correlationId = hashDomain("aloha/public-pending-absence-correlation/v1", {
      head,
      snapshotHash: observation.snapshot.snapshotHash,
      absenceEvidenceHash: observation.absenceEvidenceHash,
    });
    facts = deepFreeze({
      kind: "observed-empty",
      head,
      snapshot: observation.snapshot,
      absenceEvidenceHash: observation.absenceEvidenceHash,
      correlationId,
    });
  } else {
    const correlationId = hashDomain("aloha/public-pending-unavailable-correlation/v1", {
      head,
      reasonCode: observation.reasonCode,
      evidenceHash: observation.evidenceHash,
    });
    facts = deepFreeze({
      kind: "unavailable",
      head,
      snapshot: observation.snapshot,
      reasonCode: observation.reasonCode,
      evidenceHash: observation.evidenceHash,
      correlationId,
    });
  }
  const token = Object.freeze(Object.create(null)) as ProducerBackrunIntakeV1;
  backrunIntakeIssued.set(token, facts);
  return token;
}

export function assertIssuedProducerBackrunIntakeV1(
  value: unknown,
): asserts value is ProducerBackrunIntakeV1 {
  if (value === null || typeof value !== "object" || !backrunIntakeIssued.has(value)) {
    throw new TypeError("producer backrun intake is not owner-issued");
  }
}

export function readIssuedProducerBackrunIntakeV1(
  value: unknown,
): ProducerBackrunIntakeFactsV1 {
  assertIssuedProducerBackrunIntakeV1(value);
  return backrunIntakeIssued.get(value as object)!;
}

/** Build the sole ingress port that can derive opaque lane tokens. */
export function issueProducerIngressPortV1(
  sourceValue: ProducerIngressSourceV1,
): ProducerIngressPortV1 {
  assertIssuedProducerIngressSource(sourceValue);
  const port: ProducerIngressPortV1 = Object.freeze({
    async observe(input: Parameters<ProducerIngressPortV1["observe"]>[0]): Promise<ProducerHeadInputV1 | null> {
      const expectedHead = input.head;
      const observation = await (sourceValue as unknown as { observe(input: Parameters<ProducerIngressPortV1["observe"]>[0]): Promise<ProducerIngressObservationV1 | null> }).observe(input);
      if (observation === null) return null;
      const normalized = normalizeObservation(observation, expectedHead);
      const blockscanTriggerRef = hashDomain("aloha/blockscan-canonical-head-event/v1", normalized.head);
      const blockscanCorrelationId = hashDomain("aloha/blockscan-canonical-head-correlation/v1", {
        head: normalized.head,
        triggerRef: blockscanTriggerRef,
      });
      const blockscanTrigger = issueProducerIngressTriggerV1({
        lane: "blockscan",
        head: normalized.head,
        triggerRef: blockscanTriggerRef,
        txHash: null,
        correlationId: blockscanCorrelationId,
        affectedEdgeIds: Object.freeze([]),
        pendingEvidenceHash: null,
      });
      const blockscanInput = Object.freeze({ ...normalized.blockscan.input, correlationId: blockscanCorrelationId, trigger: blockscanTrigger });
      const backrunInput = issueBackrunIntake(normalized.head, normalized.backrun);
      return Object.freeze({
        head: normalized.head,
        blockscanInput,
        backrunInput,
      });
    },
  });
  ingressPortsIssued.add(port);
  return port;
}

export function assertIssuedProducerIngressPortV1(
  value: unknown,
): asserts value is ProducerIngressPortV1 {
  if (value === null || typeof value !== "object" || !ingressPortsIssued.has(value)) {
    throw new TypeError("producer ingress port is not owner-issued");
  }
}

/**
 * Bind an ingress token to the exact ProducerSession opened by StartupRuntime.
 * This is the only conversion into Strategy trigger facts; callers cannot
 * provide generation, Graph, or affected-edge roots themselves.
 */
export function issueProducerBoundTriggerV1<Session extends ProducerSessionV1>(input: {
  readonly ingress: ProducerIngressTriggerV1;
  readonly laneInput: ProducerLaneRunInputV1<Session>;
}): ProducerBoundTriggerV1 {
  assertIssuedProducerIngressTriggerV1(input.ingress);
  const ingress = ingressTriggerIssued.get(input.ingress as object)!;
  if (input.laneInput.kind !== ingress.lane) throw new TypeError("producer trigger lane mismatch");
  if (!sameHead(input.laneInput.session.head, ingress.head)) throw new TypeError("producer trigger canonical head mismatch");
  if (input.laneInput.generationId !== input.laneInput.session.generationId) throw new TypeError("producer trigger generation mismatch");
  if (input.laneInput.graphRoot !== input.laneInput.session.lease.binding.graphRoot) throw new TypeError("producer trigger Graph mismatch");
  const rawEdges = input.laneInput.session.lease.edges;
  if (!Array.isArray(rawEdges)) throw new TypeError("producer trigger Graph edges are unavailable");
  const graphEdgeIdList = rawEdges.map((edge, index) => {
    if (edge === null || typeof edge !== "object") throw new TypeError(`producer trigger Graph edge ${index} is invalid`);
    return assertHash((edge as { readonly edgeId?: unknown }).edgeId, `producer trigger Graph edge ${index}.edgeId`);
  });
  for (let index = 1; index < graphEdgeIdList.length; index += 1) {
    if (graphEdgeIdList[index - 1]! >= graphEdgeIdList[index]!) throw new TypeError("producer trigger Graph edges are not strictly sorted");
  }
  const graphEdgeIds = new Set(graphEdgeIdList);
  let affectedEdgeIds = ingress.affectedEdgeIds;
  for (const edgeId of affectedEdgeIds) if (!graphEdgeIds.has(edgeId)) throw new TypeError("producer trigger edge is outside Graph");
  if (ingress.lane === "blockscan" && ingress.affectedEdgeIds.length !== 0) throw new TypeError("blockscan trigger cannot narrow Graph");
  if (ingress.lane === "backrun" && ingress.pendingEvidenceHash === null) throw new TypeError("backrun trigger requires pending evidence");
  if (ingress.lane === "backrun" && affectedEdgeIds.length === 0) {
    if (graphEdgeIdList.length === 0) throw new TypeError("backrun trigger requires a non-empty Graph");
    // Pending evidence is real external evidence, but it does not itself
    // know which generated Graph edges may react. Until a Family-owned
    // projection narrows it, the safe scope is the complete immutable Graph.
    affectedEdgeIds = Object.freeze([...graphEdgeIdList]);
  }
  const facts: ProducerBoundTriggerFactsV1 = Object.freeze({
    lane: ingress.lane,
    headHash: input.laneInput.head.hash,
    generationId: input.laneInput.generationId,
    graphRoot: input.laneInput.graphRoot,
    txHash: ingress.txHash,
    correlationId: ingress.correlationId,
    triggerRef: ingress.triggerRef,
    pendingEvidenceHash: ingress.pendingEvidenceHash,
    affectedEdgeIds,
    affectedEdgeIdsRoot: hashDomain("aloha/producer-trigger-affected-edges/v1", affectedEdgeIds),
  });
  const token = Object.freeze(Object.create(null)) as ProducerBoundTriggerV1;
  boundTriggerIssued.set(token, facts);
  return token;
}

export function assertIssuedProducerBoundTriggerV1(
  value: unknown,
): asserts value is ProducerBoundTriggerV1 {
  if (value === null || typeof value !== "object" || !boundTriggerIssued.has(value)) {
    throw new TypeError("producer bound trigger is not owner-issued");
  }
}

export function readIssuedProducerBoundTriggerV1(
  value: unknown,
): ProducerBoundTriggerFactsV1 {
  assertIssuedProducerBoundTriggerV1(value);
  return boundTriggerIssued.get(value as object)!;
}

const PRODUCER_LANE_FACT_KEYS = Object.freeze([
  "kind", "lane", "headHash", "generationId", "graphRoot", "outcome", "terminalKind",
  "triggerRef", "txHash", "correlationId", "pendingEvidenceHash", "pendingSnapshotHash", "affectedEdgeIdsRoot",
  "terminalOutcome", "accounting", "coverageRoot", "candidateIds", "currentSource", "terminalLineageHash", "complete",
] as const);
const PRODUCER_LANE_ACCOUNTING_KEYS = Object.freeze([
  "planningProblemHash", "enumerationRoot", "admissionPolicyHash", "enumerationTruncated", "observedUniqueCountLowerBound",
  "total", "selected", "pruned", "notProbed", "failed", "entries", "root",
] as const);
const PRODUCER_LANE_ACCOUNTING_ENTRY_KEYS = Object.freeze([
  "candidateId", "legs", "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal",
] as const);
const PRODUCER_LANE_ACCOUNTING_LEG_KEYS = Object.freeze([
  "edgeId", "transitionRef", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef",
] as const);
function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function nonZeroHash(value: unknown, path: string): Hash {
  const result = assertHash(value, path);
  if (result === `0x${"0".repeat(64)}`) throw new TypeError(`${path} must be non-zero`);
  return result;
}

function currentSourceLogicalFacts(value: unknown): ProducerCurrentSourceLogicalFactsV1 {
  assertIssuedCurrentSourceRpcLogicalScopeFactsV1(value);
  return value;
}

function normalizeAccountingLeg(value: unknown, index: number): ProducerLaneAccountingLegV1 {
  const record = objectValue(value, `producerLaneFacts.accounting.entries.legs[${index}]`);
  assertExactKeys(record, PRODUCER_LANE_ACCOUNTING_LEG_KEYS, `producerLaneFacts.accounting.entries.legs[${index}]`);
  return Object.freeze({
    edgeId: assertHash(record.edgeId, `producerLaneFacts.accounting.entries.legs[${index}].edgeId`),
    transitionRef: assertHash(record.transitionRef, `producerLaneFacts.accounting.entries.legs[${index}].transitionRef`),
    inputAssetRef: assertHash(record.inputAssetRef, `producerLaneFacts.accounting.entries.legs[${index}].inputAssetRef`),
    inputPortRef: assertHash(record.inputPortRef, `producerLaneFacts.accounting.entries.legs[${index}].inputPortRef`),
    outputAssetRef: assertHash(record.outputAssetRef, `producerLaneFacts.accounting.entries.legs[${index}].outputAssetRef`),
    outputPortRef: assertHash(record.outputPortRef, `producerLaneFacts.accounting.entries.legs[${index}].outputPortRef`),
  });
}

function normalizeAccountingEntry(value: unknown, index: number): ProducerLaneAccountingEntryV1 {
  const record = objectValue(value, `producerLaneFacts.accounting.entries[${index}]`);
  assertExactKeys(record, PRODUCER_LANE_ACCOUNTING_ENTRY_KEYS, `producerLaneFacts.accounting.entries[${index}]`);
  if (!Array.isArray(record.legs) || record.legs.length < 2) throw new TypeError("producer lane accounting route must have at least two legs");
  const disposition = record.disposition;
  if (disposition !== "selected" && disposition !== "pruned" && disposition !== "notProbed" && disposition !== "failed") {
    throw new TypeError(`producerLaneFacts.accounting.entries[${index}].disposition is invalid`);
  }
  const terminalKind = record.terminalKind;
  if (terminalKind !== "not-run" && terminalKind !== "passed" && terminalKind !== "policyRejected" && terminalKind !== "retryable" && terminalKind !== "invalidProgram" && terminalKind !== "chainProvenRejected") {
    throw new TypeError(`producerLaneFacts.accounting.entries[${index}].terminalKind is invalid`);
  }
  const policyTerminal = record.policyTerminal === null ? null : (() => {
    const path = `producerLaneFacts.accounting.entries[${index}].policyTerminal`;
    const policy = objectValue(record.policyTerminal, path);
    if (policy.kind === "aloha.route-policy-rejection-v1") {
      assertExactKeys(policy, ["kind", "policyKind", "admissionPolicyHash", "planningProblemHash", "enumerationRoot", "candidateId", "candidateOrderKey", "routeHash", "receiptHash"], path);
      if (policy.policyKind !== "rankable-top-k" && policy.policyKind !== "bounded-unranked-budget") throw new TypeError("producer lane admission policy terminal kind is invalid");
      const body = {
        kind: "aloha.route-policy-rejection-v1" as const,
        policyKind: policy.policyKind as "rankable-top-k" | "bounded-unranked-budget",
        admissionPolicyHash: assertHash(policy.admissionPolicyHash, `${path}.admissionPolicyHash`),
        planningProblemHash: assertHash(policy.planningProblemHash, `${path}.planningProblemHash`),
        enumerationRoot: assertHash(policy.enumerationRoot, `${path}.enumerationRoot`),
        candidateId: assertHash(policy.candidateId, `${path}.candidateId`),
        candidateOrderKey: assertHash(policy.candidateOrderKey, `${path}.candidateOrderKey`),
        routeHash: assertHash(policy.routeHash, `${path}.routeHash`),
      };
      const receiptHash = assertHash(policy.receiptHash, `${path}.receiptHash`);
      if (receiptHash !== hashDomain("aloha/route-policy-rejection-receipt/v1", body)) throw new TypeError("producer lane admission policy terminal receipt hash mismatch");
      return Object.freeze({ ...body, receiptHash });
    }
    assertExactKeys(policy, ["kind", "policyKind", "admissionPolicyHash", "planningProblemHash", "enumerationRoot", "winnerCandidateId", "winnerTerminalLineageHash", "candidateId", "routeHash", "decisionMonotonicNs", "receiptHash"], path);
    if (policy.kind !== "aloha.route-post-success-policy-terminal-v1" || policy.policyKind !== "post-success-first-eligible") throw new TypeError("producer lane post-success policy terminal kind is invalid");
    const body = {
      kind: "aloha.route-post-success-policy-terminal-v1" as const,
      policyKind: "post-success-first-eligible" as const,
      admissionPolicyHash: assertHash(policy.admissionPolicyHash, `${path}.admissionPolicyHash`),
      planningProblemHash: assertHash(policy.planningProblemHash, `${path}.planningProblemHash`),
      enumerationRoot: assertHash(policy.enumerationRoot, `${path}.enumerationRoot`),
      winnerCandidateId: assertHash(policy.winnerCandidateId, `${path}.winnerCandidateId`),
      winnerTerminalLineageHash: assertHash(policy.winnerTerminalLineageHash, `${path}.winnerTerminalLineageHash`),
      candidateId: assertHash(policy.candidateId, `${path}.candidateId`),
      routeHash: assertHash(policy.routeHash, `${path}.routeHash`),
      decisionMonotonicNs: assertDecimalString(policy.decisionMonotonicNs, `${path}.decisionMonotonicNs`),
    };
    const receiptHash = assertHash(policy.receiptHash, `${path}.receiptHash`);
    if (receiptHash !== hashDomain("aloha/route-post-success-policy-terminal-receipt/v1", body)) throw new TypeError("producer lane post-success policy terminal receipt hash mismatch");
    return Object.freeze({ ...body, receiptHash });
  })();
  const normalized = Object.freeze({
    candidateId: assertHash(record.candidateId, `producerLaneFacts.accounting.entries[${index}].candidateId`),
    legs: Object.freeze(record.legs.map((leg, legIndex) => normalizeAccountingLeg(leg, legIndex))),
    disposition,
    terminalKind,
    routeHash: record.routeHash === null ? null : assertHash(record.routeHash, `producerLaneFacts.accounting.entries[${index}].routeHash`),
    reasonCode: record.reasonCode === null ? null : assertNonEmptyString(record.reasonCode, `producerLaneFacts.accounting.entries[${index}].reasonCode`),
    evidenceHash: record.evidenceHash === null ? null : assertHash(record.evidenceHash, `producerLaneFacts.accounting.entries[${index}].evidenceHash`),
    policyTerminal,
  });
  if ((terminalKind === "policyRejected") !== (policyTerminal !== null)) throw new TypeError("producer lane policy terminal binding mismatch");
  if (policyTerminal !== null && (normalized.candidateId !== policyTerminal.candidateId || normalized.routeHash !== policyTerminal.routeHash || normalized.evidenceHash === null)) {
    throw new TypeError("producer lane policy terminal entry mismatch");
  }
  if (policyTerminal?.kind === "aloha.route-policy-rejection-v1" && normalized.disposition !== "notProbed") {
    throw new TypeError("producer lane admission policy terminal disposition mismatch");
  }
  if (policyTerminal?.kind === "aloha.route-post-success-policy-terminal-v1"
    && (normalized.disposition !== "selected" || normalized.reasonCode !== "post-success:first-eligible" || normalized.evidenceHash !== policyTerminal.receiptHash)) {
    throw new TypeError("producer lane post-success policy terminal disposition mismatch");
  }
  return normalized;
}

function normalizeAccounting(value: unknown): ProducerLaneAccountingV1 {
  const record = objectValue(value, "producerLaneFacts.accounting");
  assertExactKeys(record, PRODUCER_LANE_ACCOUNTING_KEYS, "producerLaneFacts.accounting");
  if (typeof record.enumerationTruncated !== "boolean") throw new TypeError("producer lane accounting truncation flag is invalid");
  const observedUniqueCountLowerBound = assertDecimalString(record.observedUniqueCountLowerBound, "producerLaneFacts.accounting.observedUniqueCountLowerBound");
  if (!Array.isArray(record.entries)) throw new TypeError("producer lane accounting entries are required");
  const entries = record.entries.map((entry, index) => normalizeAccountingEntry(entry, index));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.candidateId >= entries[index]!.candidateId) throw new TypeError("producer lane accounting entries must be strictly sorted");
  }
  const total = nonNegativeInteger(record.total, "producerLaneFacts.accounting.total");
  const selected = nonNegativeInteger(record.selected, "producerLaneFacts.accounting.selected");
  const pruned = nonNegativeInteger(record.pruned, "producerLaneFacts.accounting.pruned");
  const notProbed = nonNegativeInteger(record.notProbed, "producerLaneFacts.accounting.notProbed");
  const failed = nonNegativeInteger(record.failed, "producerLaneFacts.accounting.failed");
  const observedCount = BigInt(observedUniqueCountLowerBound);
  if (observedCount < BigInt(total) || (!record.enumerationTruncated && observedCount !== BigInt(total))) {
    throw new TypeError("producer lane accounting enumeration count mismatch");
  }
  if (total !== entries.length || selected + pruned + notProbed + failed !== total) throw new TypeError("producer lane accounting denominator mismatch");
  const counts = {
    selected: entries.filter(entry => entry.disposition === "selected").length,
    pruned: entries.filter(entry => entry.disposition === "pruned").length,
    notProbed: entries.filter(entry => entry.disposition === "notProbed").length,
    failed: entries.filter(entry => entry.disposition === "failed").length,
  };
  if (counts.selected !== selected || counts.pruned !== pruned || counts.notProbed !== notProbed || counts.failed !== failed) {
    throw new TypeError("producer lane accounting disposition counts mismatch");
  }
  const normalized = {
    planningProblemHash: nonZeroHash(record.planningProblemHash, "producerLaneFacts.accounting.planningProblemHash"),
    enumerationRoot: nonZeroHash(record.enumerationRoot, "producerLaneFacts.accounting.enumerationRoot"),
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, "producerLaneFacts.accounting.admissionPolicyHash"),
    enumerationTruncated: record.enumerationTruncated,
    observedUniqueCountLowerBound,
    total,
    selected,
    pruned,
    notProbed,
    failed,
    entries: Object.freeze(entries),
    root: nonZeroHash(record.root, "producerLaneFacts.accounting.root"),
  } satisfies ProducerLaneAccountingV1;
  for (const entry of normalized.entries) {
    if (entry.policyTerminal !== null && (entry.policyTerminal.admissionPolicyHash !== normalized.admissionPolicyHash || entry.policyTerminal.planningProblemHash !== normalized.planningProblemHash || entry.policyTerminal.enumerationRoot !== normalized.enumerationRoot)) {
      throw new TypeError("producer lane policy terminal accounting lineage mismatch");
    }
    if (entry.policyTerminal?.kind === "aloha.route-post-success-policy-terminal-v1") {
      const policyTerminal = entry.policyTerminal;
      const winner = normalized.entries.find(candidate => candidate.candidateId === policyTerminal.winnerCandidateId);
      if (winner?.terminalKind !== "passed" || policyTerminal.winnerCandidateId === entry.candidateId) {
        throw new TypeError("producer lane post-success policy terminal winner mismatch");
      }
    }
  }
  const expectedRoot = hashDomain("aloha/route-accounting/v1", {
    planningProblemHash: normalized.planningProblemHash,
    enumerationRoot: normalized.enumerationRoot,
    admissionPolicyHash: normalized.admissionPolicyHash,
    enumerationTruncated: normalized.enumerationTruncated,
    observedUniqueCountLowerBound: normalized.observedUniqueCountLowerBound,
    total: normalized.total,
    selected: normalized.selected,
    pruned: normalized.pruned,
    notProbed: normalized.notProbed,
    failed: normalized.failed,
    entries: normalized.entries,
  });
  if (normalized.root !== expectedRoot) throw new TypeError("producer lane accounting root mismatch");
  return deepFreeze(normalized);
}

function exactCandidateIds(value: unknown): readonly Hash[] {
  if (!Array.isArray(value)) throw new TypeError("producer lane candidate ids are required");
  const result = value.map((candidateId, index) => assertHash(candidateId, `producerLaneFacts.candidateIds[${index}]`));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]! >= result[index]!) throw new TypeError("producer lane candidate ids must be strictly sorted");
  }
  return Object.freeze([...result]);
}

function sameHashes(left: readonly Hash[], right: readonly Hash[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasUnresolvedPolicyTerminal(accounting: ProducerLaneAccountingV1): boolean {
  return accounting.entries.some(entry => entry.terminalKind === "policyRejected"
    && entry.policyTerminal?.kind !== "aloha.route-post-success-policy-terminal-v1");
}

function issueProducerLaneFactsV1(input: Omit<ProducerLaneFactsV1, "complete"> & { readonly complete: boolean }): ProducerLaneFactsV1 {
  const record = objectValue(input, "producer lane facts");
  assertExactKeys(record, PRODUCER_LANE_FACT_KEYS, "producerLaneFacts");
  if (record.kind !== "aloha.producer-lane-facts-v1") throw new TypeError("producer lane facts kind is invalid");
  if (record.lane !== "blockscan" && record.lane !== "backrun") throw new TypeError("producer lane facts lane is invalid");
  const outcome = record.outcome;
  if (outcome !== "completed" && outcome !== "no-input" && outcome !== "retryable" && outcome !== "failed" && outcome !== "cancelled") throw new TypeError("producer lane facts outcome is invalid");
  const terminalKind = record.terminalKind;
  if (terminalKind !== "unsigned-dry-run" && terminalKind !== "route-set-terminal" && terminalKind !== "no-input" && terminalKind !== "retryable" && terminalKind !== "invalidProgram" && terminalKind !== "chainProvenRejected") throw new TypeError("producer lane facts terminal kind is invalid");
  if (typeof record.complete !== "boolean") throw new TypeError("producer lane facts completeness flag is invalid");
  const headHash = nonZeroHash(record.headHash, "producerLaneFacts.headHash");
  const generationId = assertNonEmptyString(record.generationId, "producerLaneFacts.generationId");
  const graphRoot = nonZeroHash(record.graphRoot, "producerLaneFacts.graphRoot");
  const triggerRef = nonZeroHash(record.triggerRef, "producerLaneFacts.triggerRef");
  const txHash = record.txHash === null ? null : nonZeroHash(record.txHash, "producerLaneFacts.txHash");
  const correlationId = nonZeroHash(record.correlationId, "producerLaneFacts.correlationId");
  const pendingEvidenceHash = record.pendingEvidenceHash === null ? null : nonZeroHash(record.pendingEvidenceHash, "producerLaneFacts.pendingEvidenceHash");
  const pendingSnapshotHash = record.pendingSnapshotHash === null ? null : nonZeroHash(record.pendingSnapshotHash, "producerLaneFacts.pendingSnapshotHash");
  const affectedEdgeIdsRoot = nonZeroHash(record.affectedEdgeIdsRoot, "producerLaneFacts.affectedEdgeIdsRoot");
  if (record.lane === "blockscan" && (txHash !== null || pendingEvidenceHash !== null || pendingSnapshotHash !== null)) throw new TypeError("blockscan lane facts cannot carry pending evidence");
  if (record.lane === "backrun" && terminalKind !== "no-input" && terminalKind !== "retryable" && (txHash === null || pendingEvidenceHash === null || pendingSnapshotHash === null || triggerRef !== txHash)) {
    throw new TypeError("backrun lane facts require transaction evidence");
  }
  if (record.terminalOutcome === null || typeof record.terminalOutcome !== "object") throw new TypeError("producer lane terminal outcome is required");
  const terminalOutcome = deepFreeze(record.terminalOutcome);
  const terminalRecord = objectValue(terminalOutcome, "producerLaneFacts.terminalOutcome");
  const accounting = record.accounting === null ? null : normalizeAccounting(record.accounting);
  const coverageRoot = nonZeroHash(record.coverageRoot, "producerLaneFacts.coverageRoot");
  const candidateIds = exactCandidateIds(record.candidateIds);
  const currentSource = currentSourceLogicalFacts(record.currentSource);
  const terminalLineageHash = nonZeroHash(record.terminalLineageHash, "producerLaneFacts.terminalLineageHash");
  if (terminalKind === "unsigned-dry-run" || terminalKind === "route-set-terminal") {
    if (terminalRecord.kind !== terminalKind) throw new TypeError("producer lane terminal kind does not match terminal evidence");
    const receipt = objectValue(terminalRecord.receipt, "producerLaneFacts.terminalOutcome.receipt");
    if (receipt.lineageHash !== terminalLineageHash) throw new TypeError("producer lane terminal lineage does not match terminal evidence");
    if (terminalKind === "unsigned-dry-run" && !candidateIds.includes(assertHash(receipt.candidateId, "producerLaneFacts.terminalOutcome.receipt.candidateId"))) {
      throw new TypeError("producer lane terminal candidate does not match candidate set");
    }
    if (terminalKind === "route-set-terminal" && accounting !== null && receipt.accountingRoot !== accounting.root) throw new TypeError("producer lane route-set accounting root mismatch");
  } else if (terminalKind === "no-input") {
    assertExactKeys(terminalRecord, ["kind", "lane", "headHash", "generationId", "graphRoot", "correlationId", "pendingSnapshotHash", "absenceEvidenceHash", "reasonCode", "lineageHash"], "producerLaneFacts.terminalOutcome");
    if (terminalRecord.lane !== "backrun" || terminalRecord.headHash !== headHash || terminalRecord.generationId !== generationId || terminalRecord.graphRoot !== graphRoot
      || terminalRecord.correlationId !== correlationId || terminalRecord.pendingSnapshotHash !== pendingSnapshotHash
      || terminalRecord.absenceEvidenceHash !== pendingEvidenceHash || terminalRecord.reasonCode !== "pending-set-observed-empty"
      || txHash !== null || pendingEvidenceHash === null || pendingSnapshotHash === null || triggerRef !== pendingSnapshotHash) {
      throw new TypeError("producer no-input terminal binding mismatch");
    }
    const expectedNoInputLineage = hashDomain("aloha/searcher-lane-no-input/v1", {
      kind: "no-input",
      lane: "backrun",
      headHash,
      generationId,
      graphRoot,
      correlationId,
      pendingSnapshotHash,
      absenceEvidenceHash: pendingEvidenceHash,
      reasonCode: "pending-set-observed-empty",
    });
    if (terminalRecord.lineageHash !== expectedNoInputLineage || terminalLineageHash !== expectedNoInputLineage) {
      throw new TypeError("producer no-input terminal lineage mismatch");
    }
  } else if (terminalRecord.kind !== terminalKind) {
    throw new TypeError("producer lane stage kind does not match terminal evidence");
  }
  const expectedCoverageRoot = hashDomain("aloha/producer-lane-coverage/v1", {
    lane: record.lane,
    headHash,
    generationId,
    graphRoot,
    triggerRef,
    txHash,
    correlationId,
    pendingEvidenceHash,
    pendingSnapshotHash,
    affectedEdgeIdsRoot,
    accountingRoot: accounting?.root ?? null,
    enumerationRoot: accounting?.enumerationRoot ?? null,
    terminalLineageHash,
    candidateIds,
    currentSource,
  });
  if (coverageRoot !== expectedCoverageRoot) throw new TypeError("producer lane coverage root mismatch");
  const selectedIds = accounting?.entries.filter(entry => entry.disposition === "selected").map(entry => entry.candidateId) ?? [];
  if (!sameHashes(candidateIds, selectedIds)) throw new TypeError("producer lane candidate ids do not match selected accounting entries");
  if (terminalKind === "unsigned-dry-run") {
    if (accounting === null || selectedIds.length === 0) throw new TypeError("unsigned lane fact is not bound to selected candidates");
    const receipt = objectValue(terminalRecord.receipt, "producerLaneFacts.terminalOutcome.receipt");
    const passedIds = accounting.entries.filter(entry => entry.disposition === "selected" && entry.terminalKind === "passed").map(entry => entry.candidateId);
    if (passedIds.length !== 1 || receipt.candidateId !== passedIds[0] || !selectedIds.includes(passedIds[0]!)) {
      throw new TypeError("unsigned lane fact is not bound to its passed candidate");
    }
    const terminalKinds = accounting.entries.map(entry => entry.terminalKind);
    const expectedLaneOutcome = terminalKinds.includes("invalidProgram")
      ? "failed"
      : terminalKinds.includes("retryable") || terminalKinds.includes("not-run") || hasUnresolvedPolicyTerminal(accounting)
        ? "retryable"
        : "completed";
    if (outcome !== expectedLaneOutcome) throw new TypeError("unsigned lane outcome classification mismatch");
  }
  if (terminalKind === "route-set-terminal") {
    if (accounting === null) throw new TypeError("route-set lane fact requires accounting");
    const receipt = objectValue(terminalRecord.receipt, "producerLaneFacts.terminalOutcome.receipt");
    const entryKinds = accounting.entries.map(entry => entry.terminalKind);
    const expectedRouteSetOutcome = entryKinds.includes("invalidProgram")
      ? "invalidProgram"
      : accounting.enumerationTruncated || entryKinds.includes("retryable") || entryKinds.includes("not-run") || hasUnresolvedPolicyTerminal(accounting)
        ? "retryable"
        : accounting.total === 0
          ? "complete-no-candidate"
          : "complete-candidates-terminal";
    if (receipt.outcome !== expectedRouteSetOutcome) throw new TypeError("route-set lane outcome is not derived from candidate terminals");
    const expectedLaneOutcome = expectedRouteSetOutcome === "retryable" ? "retryable" : expectedRouteSetOutcome === "invalidProgram" ? "failed" : "completed";
    if (outcome !== expectedLaneOutcome) throw new TypeError("route-set lane outcome classification mismatch");
  }
  if (terminalKind === "no-input" && (outcome !== "no-input" || accounting !== null || candidateIds.length !== 0)) throw new TypeError("no-input lane fact is not empty");
  if (terminalKind !== "unsigned-dry-run" && terminalKind !== "route-set-terminal" && terminalKind !== "no-input" && accounting !== null) throw new TypeError("failed lane fact cannot claim route accounting");
  const complete = terminalKind === "no-input"
    ? outcome === "no-input" && accounting === null && candidateIds.length === 0
    : outcome === "completed"
      && accounting !== null
      && !accounting.enumerationTruncated
      && (terminalKind === "unsigned-dry-run" || terminalKind === "route-set-terminal");
  if (record.complete !== complete) throw new TypeError("producer lane completeness flag is not supported by its evidence");
  const normalized: ProducerLaneFactsV1 = {
    kind: "aloha.producer-lane-facts-v1",
    lane: record.lane,
    headHash,
    generationId,
    graphRoot,
    triggerRef,
    txHash,
    correlationId,
    pendingEvidenceHash,
    pendingSnapshotHash,
    affectedEdgeIdsRoot,
    outcome,
    terminalKind,
    terminalOutcome,
    accounting,
    coverageRoot,
    candidateIds,
    currentSource,
    terminalLineageHash,
    complete,
  };
  const token = Object.freeze(deepFreeze(normalized)) as ProducerLaneFactsV1;
  laneFactsIssued.set(token, token);
  return token;
}

export function assertIssuedProducerLaneFactsV1(value: unknown): asserts value is ProducerLaneFactsV1 {
  if (value === null || typeof value !== "object" || !laneFactsIssued.has(value)) {
    throw new TypeError("producer lane facts are not owner-issued");
  }
}

export function readIssuedProducerLaneFactsV1(value: unknown): ProducerLaneFactsV1 {
  assertIssuedProducerLaneFactsV1(value);
  return laneFactsIssued.get(value as object)!;
}

export function readIssuedProducerNoInputLaneDenominatorV1(
  value: ProducerLaneFactsV1,
): ProducerNoInputLaneDenominatorV1 | null {
  assertIssuedProducerLaneFactsV1(value);
  return laneNoInputDenominators.get(value) ?? null;
}

function issueProducerLaneFailureObservationV1(
  request: ProducerLaneRunInputV1<ProducerSessionV1>,
  draft: Extract<ProducerLaneRunDraftV1, { readonly kind: "retryable" | "failed" | "cancelled" }>,
): ProducerLaneFailureObservationV1 {
  if (draft.currentSource === null) throw new TypeError("producer lane failure observation requires a closed current-source scope");
  const currentSource = currentSourceLogicalFacts(draft.currentSource);
  if (currentSource.lane !== request.kind
    || !sameSourceView(currentSource.source, request.head)) {
    throw new TypeError("producer lane failure current-source facts do not match the request");
  }
  const observation: ProducerLaneFailureObservationV1 = deepFreeze({
    kind: "aloha.producer-lane-failure-observation-v1" as const,
    lane: request.kind,
    headHash: request.head.hash,
    generationId: assertNonEmptyString(request.generationId, "producerLaneFailureObservation.generationId"),
    graphRoot: assertHash(request.graphRoot, "producerLaneFailureObservation.graphRoot"),
    outcome: draft.kind,
    reasonCode: assertNonEmptyString(draft.reasonCode, "producerLaneFailureObservation.reasonCode"),
    currentSource,
    complete: false as const,
  });
  laneFailureObservationsIssued.set(observation, observation);
  return observation;
}

export function assertIssuedProducerLaneFailureObservationV1(
  value: unknown,
): asserts value is ProducerLaneFailureObservationV1 {
  if (value === null || typeof value !== "object" || !laneFailureObservationsIssued.has(value)) {
    throw new TypeError("producer lane failure observation is not owner-issued");
  }
}

export function readIssuedProducerLaneFailureObservationV1(
  value: unknown,
): ProducerLaneFailureObservationV1 {
  assertIssuedProducerLaneFailureObservationV1(value);
  return laneFailureObservationsIssued.get(value as object)!;
}

/**
 * Production-evidence narrow seam. The producer retains the exact successful
 * search terminal; callers cannot supply a join or recover one from DTO data.
 */
export function readIssuedProducerLaneSchedulerResourceJoinV1(
  value: unknown,
): SearchSchedulerResourceJoinV1 | null {
  assertIssuedProducerLaneFactsV1(value);
  const terminal = laneSearchTerminals.get(value as object);
  return terminal === undefined
    ? null
    : readIssuedSearchTerminalSchedulerResourceJoinV1(terminal);
}

/**
 * Production six-step seam. The trace is retained only beside the exact lane
 * capability that consumed the successful search terminal; no canonical lane
 * DTO, clone, or caller-provided receipt can recover it.
 */
export function readIssuedProducerLaneSixStepTraceV1(
  value: unknown,
): SearchTerminalSixStepTraceV1 | null {
  assertIssuedProducerLaneFactsV1(value);
  const lane = laneFactsIssued.get(value as object)!;
  const terminalCapability = laneSearchTerminals.get(value as object);
  if (terminalCapability === undefined) return null;
  const terminal = readIssuedSearchTerminalCapabilityV1(terminalCapability);
  const terminalSucceeded = terminal.kind === "unsigned-dry-run";
  const laneSucceeded = lane.terminalKind === "unsigned-dry-run";
  if (terminalSucceeded !== laneSucceeded) {
    throw new TypeError("producer lane retained a six-step trace for a non-success terminal");
  }
  if (!terminalSucceeded) return null;
  const trace = readIssuedSearchTerminalSixStepTraceV1(terminalCapability);
  if (trace.resolved.correlationId !== lane.correlationId
    || trace.resolved.routeCandidateId !== terminal.receipt.candidateId
    || trace.resolved.source.chainId !== lane.currentSource.source.chainId
    || trace.resolved.source.number !== lane.currentSource.source.number
    || trace.resolved.source.hash !== lane.currentSource.source.hash
    || trace.resolved.source.stateRoot !== lane.currentSource.source.stateRoot
    || terminal.receipt.generationId !== lane.generationId
    || terminal.receipt.graphRoot !== lane.graphRoot
    || terminal.receipt.lineageHash !== lane.terminalLineageHash
    || !lane.candidateIds.includes(trace.resolved.routeCandidateId)) {
    throw new TypeError("producer lane six-step trace lineage mismatch");
  }
  return trace;
}

/**
 * Internal owner-to-owner seam used by durable production evidence. It
 * returns the exact process-local terminal capability retained beside this
 * lane; a lane DTO, clone, trace, or receipt cannot be upgraded into one.
 * No production public module re-exports this function.
 */
export function readIssuedProducerLaneSearchTerminalCapabilityV1(
  value: unknown,
): SearchTerminalCapabilityV1 | null {
  assertIssuedProducerLaneFactsV1(value);
  const lane = laneFactsIssued.get(value as object)!;
  const terminalCapability = laneSearchTerminals.get(value as object);
  if (terminalCapability === undefined) return null;
  const terminal = readIssuedSearchTerminalCapabilityV1(terminalCapability);
  if ((terminal.kind === "unsigned-dry-run") !== (lane.terminalKind === "unsigned-dry-run")
    || terminal.receipt.correlationId !== lane.correlationId
    || terminal.receipt.generationId !== lane.generationId
    || terminal.receipt.graphRoot !== lane.graphRoot
    || terminal.receipt.lineageHash !== lane.terminalLineageHash) {
    throw new TypeError("producer lane retained search terminal lineage mismatch");
  }
  return terminalCapability;
}

/**
 * Production timing seam. Coarse timing is retained only with the exact
 * search terminal capability consumed by this lane; no terminal DTO or
 * structural lane clone can manufacture it.
 */
export function readIssuedProducerLaneCoarseTimingV1(
  value: unknown,
): RouteCoarseTimingFactsV1 | null {
  assertIssuedProducerLaneFactsV1(value);
  const lane = laneFactsIssued.get(value as object)!;
  const terminalCapability = laneSearchTerminals.get(value as object);
  if (terminalCapability === undefined) return null;
  const timing = readIssuedSearchTerminalCoarseTimingV1(terminalCapability);
  if (timing.correlationId !== lane.correlationId
    || timing.generationId !== lane.generationId
    || timing.graphRoot !== lane.graphRoot
    || timing.source.chainId !== lane.currentSource.source.chainId
    || timing.source.number !== lane.currentSource.source.number
    || timing.source.hash !== lane.currentSource.source.hash
    || timing.source.stateRoot !== lane.currentSource.source.stateRoot
    || lane.accounting === null
    || timing.planningProblemHash !== lane.accounting.planningProblemHash
    || timing.enumerationRoot !== lane.accounting.enumerationRoot
    || timing.admissionPolicyHash !== lane.accounting.admissionPolicyHash) {
    throw new TypeError("producer lane coarse timing lineage mismatch");
  }
  return timing;
}

export function readIssuedProducerLaneCandidateTerminalObservationsV1(
  value: unknown,
): readonly ProducerCandidateTerminalObservationV1[] {
  assertIssuedProducerLaneFactsV1(value);
  const lane = laneFactsIssued.get(value as object)!;
  const terminalCapability = laneSearchTerminals.get(value as object);
  if (terminalCapability === undefined || lane.accounting === null) return Object.freeze([]);
  const timings = readIssuedSearchTerminalCandidateTimingsV1(terminalCapability);
  if (timings.length !== lane.accounting.entries.length) {
    throw new TypeError("producer lane candidate terminal denominator mismatch");
  }
  return Object.freeze(timings.map((timing: RouteCandidateTerminalTimingFactsV1, index) => {
    const entry = lane.accounting!.entries[index];
    if (entry === undefined
      || timing.candidateId !== entry.candidateId
      || timing.correlationId !== lane.correlationId
      || timing.generationId !== lane.generationId
      || timing.graphRoot !== lane.graphRoot
      || timing.planningProblemHash !== lane.accounting!.planningProblemHash
      || timing.enumerationRoot !== lane.accounting!.enumerationRoot
      || timing.admissionPolicyHash !== lane.accounting!.admissionPolicyHash
      || timing.disposition !== entry.disposition
      || timing.terminalKind !== entry.terminalKind
      || timing.routeHash !== entry.routeHash
      || timing.reasonCode !== entry.reasonCode
      || timing.policyTerminal?.receiptHash !== entry.policyTerminal?.receiptHash
      || (timing.terminalKind === "passed" && timing.terminalLineageHash !== lane.terminalLineageHash)) {
      throw new TypeError("producer lane candidate terminal observation lineage mismatch");
    }
    const performanceOutcome = (() => {
      switch (timing.terminalKind) {
        case "passed": return "verified" as const;
        case "chainProvenRejected": return timing.reasonCode === "final-sim:simulation-reverted"
          ? "simulation-reverted" as const
          : "chain-proven-rejected" as const;
        case "policyRejected": return "policy-rejected" as const;
        case "retryable":
        case "not-run": return "retryable" as const;
        case "invalidProgram": return "invalid-program" as const;
        default: return timing.terminalKind satisfies never;
      }
    })();
    const performanceCandidateRef = performanceLaneCandidateRefV1(lane.lane, timing.candidateId);
    const payload = deepFreeze({
      kind: "aloha.producer-candidate-terminal-observation-v1" as const,
      lane: lane.lane,
      headHash: lane.headHash,
      correlationId: timing.correlationId,
      generationId: timing.generationId,
      graphRoot: timing.graphRoot,
      planningProblemHash: timing.planningProblemHash,
      enumerationRoot: timing.enumerationRoot,
      admissionPolicyHash: timing.admissionPolicyHash,
      candidateId: timing.candidateId,
      performanceCandidateRef,
      disposition: timing.disposition,
      terminalKind: timing.terminalKind,
      performanceOutcome,
      routeHash: timing.routeHash,
      reasonCode: timing.reasonCode,
      evidenceHash: timing.evidenceHash,
      policyTerminal: timing.policyTerminal,
      terminalLineageHash: timing.terminalLineageHash,
      sixStepEvidenceRoot: timing.sixStepEvidenceRoot,
      startedMonotonicNs: timing.startedMonotonicNs,
      finishedMonotonicNs: timing.finishedMonotonicNs,
      timingUs: timing.timingUs,
      timingRoot: timing.timingRoot,
    });
    return deepFreeze({
      ...payload,
      observationRoot: hashDomain("aloha/producer-candidate-terminal-observation/v1", payload),
    });
  }));
}

/** Recover the planner-owned full route denominator retained by the exact
 * search terminal.  This is deliberately separate from the producer's
 * selected candidate list and derived accounting DTO. */
export function readIssuedProducerLanePlannerEnumerationV1(
  value: unknown,
): ReturnType<typeof readIssuedSearchTerminalPlannerEnumerationV1> | null {
  assertIssuedProducerLaneFactsV1(value);
  const lane = laneFactsIssued.get(value as object)!;
  const terminalCapability = laneSearchTerminals.get(value as object);
  if (terminalCapability === undefined || lane.accounting === null) return null;
  const enumeration = readIssuedSearchTerminalPlannerEnumerationV1(terminalCapability);
  if (enumeration.planningProblemHash !== lane.accounting.planningProblemHash
    || enumeration.enumerationRoot !== lane.accounting.enumerationRoot
    || enumeration.graphRoot !== lane.graphRoot
    || enumeration.candidates.length !== lane.accounting.entries.length) {
    throw new TypeError("producer lane planner enumeration lineage mismatch");
  }
  return enumeration;
}

function assertTerminalBinding(
  terminal: IssuedSearchTerminalV1,
  request: ProducerLaneRunInputV1<ProducerSessionV1>,
  trigger: ProducerBoundTriggerFactsV1,
): ProducerLaneAccountingV1 {
  const accounting = normalizeAccounting(terminal.kind === "unsigned-dry-run" ? terminal.accounting : terminal.receipt.accounting);
  const receipt = terminal.receipt;
  if (receipt.generationId !== request.generationId || receipt.graphRoot !== request.graphRoot || receipt.correlationId !== trigger.correlationId) {
    throw new TypeError("search terminal generation/Graph/trigger binding mismatch");
  }
  if (!sameSourceView(receipt.source, request.head)) throw new TypeError("search terminal source does not match producer head");
  if (receipt.readyRecordHash !== request.session.lease.binding.readyRecordHash || !sameSourceView(receipt.cutoff, request.session.lease.binding.cutoff)) {
    throw new TypeError("search terminal ready/cutoff binding mismatch");
  }
  if (terminal.kind === "unsigned-dry-run") {
    validateUnsignedDryRunReceiptValue(terminal.receipt);
    if (terminal.accounting.root !== accounting.root) throw new TypeError("unsigned terminal accounting changed after issuance");
  } else {
    assertExactKeys(receipt, [
      "kind", "outcome", "correlationId", "generationId", "readyRecordHash", "cutoff", "graphRoot",
      "objectiveRef", "source", "accounting", "accountingRoot", "signer", "transactionHash", "lineageHash",
    ], "producerLaneFacts.routeSetReceipt");
    if (receipt.kind !== "aloha.route-set-terminal-v1" || receipt.signer !== null || receipt.transactionHash !== null) throw new TypeError("route-set terminal receipt is invalid");
    if (receipt.accountingRoot !== accounting.root || receipt.accounting.root !== accounting.root) throw new TypeError("route-set terminal accounting mismatch");
    const { lineageHash, ...body } = receipt;
    if (lineageHash !== hashDomain("aloha/route-set-terminal-lineage/v1", body)) throw new TypeError("route-set terminal lineage mismatch");
    if (accounting.entries.some(entry => entry.terminalKind === "passed")) throw new TypeError("route-set terminal cannot contain a passed candidate");
  }
  return accounting;
}

function issueTerminalLaneFacts(
  request: ProducerLaneRunInputV1<ProducerSessionV1>,
  draft: Extract<ProducerLaneRunDraftV1, { readonly kind: "terminal" }>,
): ProducerLaneFactsV1 {
  assertIssuedProducerBoundTriggerV1(draft.trigger);
  const trigger = boundTriggerIssued.get(draft.trigger as object)!;
  if (trigger.lane !== request.kind || trigger.headHash !== request.head.hash || trigger.generationId !== request.generationId || trigger.graphRoot !== request.graphRoot) {
    throw new TypeError("producer terminal draft trigger does not bind lane request");
  }
  if (request.generationId !== request.session.generationId || request.graphRoot !== request.session.lease.binding.graphRoot || !sameHead(request.head, request.session.head)) {
    throw new TypeError("producer terminal draft request does not bind its session");
  }
  const pendingSnapshotHash = draft.pendingSnapshotHash === null ? null : assertHash(draft.pendingSnapshotHash, "producerLaneDraft.pendingSnapshotHash");
  if (request.kind === "blockscan" && pendingSnapshotHash !== null) throw new TypeError("blockscan terminal cannot carry a pending snapshot");
  if (request.kind === "backrun") {
    const intake = readIssuedProducerBackrunIntakeV1(request.input);
    if (intake.kind !== "pending-transaction" || intake.snapshot.snapshotHash !== pendingSnapshotHash
      || trigger.txHash !== intake.txHash || trigger.pendingEvidenceHash !== intake.pendingEvidenceHash
      || trigger.correlationId !== intake.correlationId) {
      throw new TypeError("backrun terminal does not bind its exact pending intake");
    }
  }
  const terminal = readIssuedSearchTerminalCapabilityV1(draft.terminalCapability);
  const accounting = assertTerminalBinding(terminal, request, trigger);
  const candidateIds = Object.freeze(accounting.entries.filter(entry => entry.disposition === "selected").map(entry => entry.candidateId));
  const entryKinds = accounting.entries.map(entry => entry.terminalKind);
  const laneOutcome: ProducerLaneOutcomeKindV1 = terminal.kind === "route-set-terminal"
    ? terminal.receipt.outcome === "retryable"
      ? "retryable"
      : terminal.receipt.outcome === "invalidProgram"
        ? "failed"
        : "completed"
    : entryKinds.includes("invalidProgram")
      ? "failed"
      : entryKinds.includes("retryable") || entryKinds.includes("not-run") || hasUnresolvedPolicyTerminal(accounting)
        ? "retryable"
        : "completed";
  const terminalLineageHash = terminal.receipt.lineageHash;
  const terminalCandidateId = terminal.kind === "unsigned-dry-run" ? terminal.receipt.candidateId : null;
  for (const entry of accounting.entries) {
    if (entry.policyTerminal?.kind === "aloha.route-post-success-policy-terminal-v1"
      && (entry.policyTerminal.winnerCandidateId !== terminalCandidateId
        || entry.policyTerminal.winnerTerminalLineageHash !== terminalLineageHash)) {
      throw new TypeError("post-success policy terminal does not bind the exact winner terminal");
    }
  }
  const currentSource = currentSourceLogicalFacts(draft.currentSource);
  if (currentSource.lane !== request.kind
    || currentSource.correlationId !== trigger.correlationId
    || !sameSourceView(currentSource.source, request.head)) {
    throw new TypeError("producer terminal current-source logical facts do not bind lane trigger/source");
  }
  const coverageRoot = hashDomain("aloha/producer-lane-coverage/v1", {
    lane: request.kind,
    headHash: request.head.hash,
    generationId: request.generationId,
    graphRoot: request.graphRoot,
    triggerRef: trigger.triggerRef,
    txHash: trigger.txHash,
    correlationId: trigger.correlationId,
    pendingEvidenceHash: trigger.pendingEvidenceHash,
    pendingSnapshotHash,
    affectedEdgeIdsRoot: trigger.affectedEdgeIdsRoot,
    accountingRoot: accounting.root,
    enumerationRoot: accounting.enumerationRoot,
    terminalLineageHash,
    candidateIds,
    currentSource,
  });
  const complete = laneOutcome === "completed" && !accounting.enumerationTruncated;
  const laneFacts = issueProducerLaneFactsV1({
    kind: "aloha.producer-lane-facts-v1",
    lane: request.kind,
    headHash: request.head.hash,
    generationId: request.generationId,
    graphRoot: request.graphRoot,
    triggerRef: trigger.triggerRef,
    txHash: trigger.txHash,
    correlationId: trigger.correlationId,
    pendingEvidenceHash: trigger.pendingEvidenceHash,
    pendingSnapshotHash,
    affectedEdgeIdsRoot: trigger.affectedEdgeIdsRoot,
    outcome: laneOutcome,
    terminalKind: terminal.kind,
    terminalOutcome: terminal,
    accounting,
    coverageRoot,
    candidateIds,
    currentSource,
    terminalLineageHash,
    complete,
  });
  laneSearchTerminals.set(laneFacts, draft.terminalCapability as SearchTerminalCapabilityV1);
  return laneFacts;
}

function issueNoInputLaneFacts(
  request: ProducerLaneRunInputV1<ProducerSessionV1>,
  absence: ProducerBackrunIntakeV1,
  currentSourceValue: ProducerCurrentSourceLogicalFactsV1,
): ProducerLaneFactsV1 {
  if (request.kind !== "backrun") throw new TypeError("no-input draft is not bound to the backrun request");
  const intake = readIssuedProducerBackrunIntakeV1(absence);
  if (request.input !== absence) throw new TypeError("no-input draft is not bound to the backrun request");
  if (intake.kind !== "observed-empty" || !sameHead(intake.head, request.head)) throw new TypeError("no-input draft lacks observed absence evidence");
  const currentSource = currentSourceLogicalFacts(currentSourceValue);
  if (currentSource.lane !== "backrun"
    || currentSource.correlationId !== intake.correlationId
    || !sameSourceView(currentSource.source, request.head)) {
    throw new TypeError("no-input current-source logical facts do not bind observed absence");
  }
  const affectedEdgeIdsRoot = hashDomain("aloha/producer-trigger-affected-edges/v1", []);
  const terminalBody = {
    kind: "no-input" as const,
    lane: "backrun" as const,
    headHash: request.head.hash,
    generationId: request.generationId,
    graphRoot: request.graphRoot,
    correlationId: intake.correlationId,
    pendingSnapshotHash: intake.snapshot.snapshotHash,
    absenceEvidenceHash: intake.absenceEvidenceHash,
    reasonCode: "pending-set-observed-empty" as const,
  };
  const terminalLineageHash = hashDomain("aloha/searcher-lane-no-input/v1", terminalBody);
  const coverageRoot = hashDomain("aloha/producer-lane-coverage/v1", {
    lane: "backrun",
    headHash: request.head.hash,
    generationId: request.generationId,
    graphRoot: request.graphRoot,
    triggerRef: intake.snapshot.snapshotHash,
    txHash: null,
    correlationId: intake.correlationId,
    pendingEvidenceHash: intake.absenceEvidenceHash,
    pendingSnapshotHash: intake.snapshot.snapshotHash,
    affectedEdgeIdsRoot,
    accountingRoot: null,
    enumerationRoot: null,
    terminalLineageHash,
    candidateIds: [],
    currentSource,
  });
  const laneFacts = issueProducerLaneFactsV1({
    kind: "aloha.producer-lane-facts-v1",
    lane: "backrun",
    headHash: request.head.hash,
    generationId: request.generationId,
    graphRoot: request.graphRoot,
    triggerRef: intake.snapshot.snapshotHash,
    txHash: null,
    correlationId: intake.correlationId,
    pendingEvidenceHash: intake.absenceEvidenceHash,
    pendingSnapshotHash: intake.snapshot.snapshotHash,
    affectedEdgeIdsRoot,
    outcome: "no-input",
    terminalKind: "no-input",
    terminalOutcome: Object.freeze({ ...terminalBody, lineageHash: terminalLineageHash }),
    accounting: null,
    coverageRoot,
    candidateIds: Object.freeze([]),
    currentSource,
    terminalLineageHash,
    complete: true,
  });
  laneNoInputDenominators.set(laneFacts, deepFreeze({
    pendingSnapshot: intake.snapshot,
    absenceEvidenceHash: intake.absenceEvidenceHash,
    terminalLineageHash,
    currentSource,
  }));
  return laneFacts;
}

function sealLaneRunDraft(
  request: ProducerLaneRunInputV1<ProducerSessionV1>,
  value: ProducerLaneRunDraftV1,
): ProducerLaneOutcomeV1 {
  const record = objectValue(value, "producer lane run draft");
  if (record.kind === "terminal") {
    assertExactKeys(record, ["kind", "trigger", "terminalCapability", "pendingSnapshotHash", "currentSource"], "producerLaneRunDraft");
    const facts = issueTerminalLaneFacts(request, value as Extract<ProducerLaneRunDraftV1, { readonly kind: "terminal" }>);
    return Object.freeze({ kind: facts.outcome, ...(facts.outcome === "completed" ? {} : { reasonCode: facts.terminalKind }), facts });
  }
  if (record.kind === "no-input") {
    assertExactKeys(record, ["kind", "absence", "currentSource"], "producerLaneRunDraft");
    const draft = value as Extract<ProducerLaneRunDraftV1, { readonly kind: "no-input" }>;
    const facts = issueNoInputLaneFacts(request, draft.absence, draft.currentSource);
    return Object.freeze({ kind: "no-input", facts });
  }
  if (record.kind !== "retryable" && record.kind !== "failed" && record.kind !== "cancelled") throw new TypeError("producer lane run draft kind is invalid");
  assertExactKeys(record, ["kind", "reasonCode", "currentSource"], "producerLaneRunDraft");
  const draft = value as Extract<ProducerLaneRunDraftV1, { readonly kind: "retryable" | "failed" | "cancelled" }>;
  const reasonCode = assertNonEmptyString(record.reasonCode, "producerLaneRunDraft.reasonCode");
  const failureObservation = draft.currentSource === null
    ? undefined
    : issueProducerLaneFailureObservationV1(request, draft);
  return Object.freeze({
    kind: record.kind,
    reasonCode,
    ...(failureObservation === undefined ? {} : { failureObservation }),
  });
}

export function issueProducerLanePortV1<Session extends ProducerSessionV1>(
  input: ProducerLaneRunnerV1<Session>,
): ProducerLanePortV1<Session> {
  const value = objectValue(input, "producer lane port");
  if (value.kind !== "blockscan" && value.kind !== "backrun") throw new TypeError("producer lane kind is invalid");
  if (typeof value.run !== "function") throw new TypeError("producer lane run is required");
  const capability = Object.freeze({
    kind: value.kind as ProducerLaneKindV1,
    async run(request: Parameters<ProducerLanePortV1<Session>["run"]>[0]) {
      return sealLaneRunDraft(request, await input.run(request) as ProducerLaneRunDraftV1);
    },
  });
  laneIssued.add(capability);
  return capability;
}

export function assertIssuedProducerLanePortV1(
  value: unknown,
): asserts value is ProducerLanePortV1<ProducerSessionV1> {
  if (value === null || typeof value !== "object" || !laneIssued.has(value)) {
    throw new TypeError("producer lane port is not owner-issued");
  }
}

export function issueProducerSessionOwnerV1<Session extends ProducerSessionV1>(
  input: ProducerSessionOwnerV1<Session>,
): ProducerSessionOwnerV1<Session> {
  const value = objectValue(input, "producer session owner");
  if (typeof value.withProducerSession !== "function") throw new TypeError("producer session owner is invalid");
  const capability: ProducerSessionOwnerV1<Session> = Object.freeze({
    withProducerSession<Result>(
      head: CanonicalHead,
      run: (session: Session) => Promise<Result>,
      signal?: AbortSignal,
    ): Promise<Result> {
      return input.withProducerSession(head, run, signal);
    },
  });
  sessionOwnersIssued.add(capability);
  return capability;
}

export function assertIssuedProducerSessionOwnerV1(
  value: unknown,
): asserts value is ProducerSessionOwnerV1<ProducerSessionV1> {
  if (value === null || typeof value !== "object" || !sessionOwnersIssued.has(value)) {
    throw new TypeError("producer session owner is not owner-issued");
  }
}

/** Internal composition seam used by the candidate-owned current-source owner. */
export function issueProducerCurrentSourceHeadPortV1<Session extends ProducerSessionV1>(
  input: Pick<ProducerCurrentSourceHeadPortV1<Session>, "closeHead">,
): ProducerCurrentSourceHeadPortV1<Session> {
  const value = objectValue(input, "producer current-source head port");
  assertExactKeys(value, ["closeHead"], "producer current-source head port");
  if (typeof value.closeHead !== "function") throw new TypeError("producer current-source head close operation is required");
  const capability = Object.freeze({
    async closeHead(session: Session) {
      const facts = await input.closeHead(session);
      assertIssuedCurrentSourceRpcPhysicalFactsV1(facts);
      return facts;
    },
  }) as ProducerCurrentSourceHeadPortV1<Session>;
  currentSourceHeadPortsIssued.add(capability);
  return capability;
}

export function assertIssuedProducerCurrentSourceHeadPortV1(
  value: unknown,
): asserts value is ProducerCurrentSourceHeadPortV1<ProducerSessionV1> {
  if (value === null || typeof value !== "object" || !currentSourceHeadPortsIssued.has(value)) {
    throw new TypeError("producer current-source head port is not owner-issued");
  }
}

export function issueProducerHeadFactsCapabilityV1(
  input: ProducerHeadFactsV1,
): ProducerHeadFactsCapabilityV1 {
  const value = objectValue(input, "producer head facts");
  assertExactKeys(value, ["kind", "headHash", "generationId", "graphRoot", "laneFacts", "laneFailureObservations", "candidateRefs", "currentSourcePhysical", "sourceCoverageRoot", "complete"], "producer head facts");
  if (value.kind !== "aloha.producer-head-facts-v1") throw new TypeError("producer head facts kind is invalid");
  assertHash(value.headHash, "producerHeadFacts.headHash");
  if (value.generationId !== null) assertNonEmptyString(value.generationId, "producerHeadFacts.generationId");
  if (value.graphRoot !== null) assertHash(value.graphRoot, "producerHeadFacts.graphRoot");
  assertHash(value.sourceCoverageRoot, "producerHeadFacts.sourceCoverageRoot");
  if (typeof value.complete !== "boolean") throw new TypeError("producer head facts completion is invalid");
  if (!Array.isArray(value.laneFacts) || !Array.isArray(value.laneFailureObservations) || !Array.isArray(value.candidateRefs)) throw new TypeError("producer head facts arrays are required");
  for (const facts of value.laneFacts) {
    assertIssuedProducerLaneFactsV1(facts);
    const exact = readIssuedProducerLaneFactsV1(facts);
    if (exact.headHash !== value.headHash || exact.generationId !== value.generationId || exact.graphRoot !== value.graphRoot) {
      throw new TypeError("producer head facts lane binding mismatch");
    }
  }
  for (const observation of value.laneFailureObservations) {
    assertIssuedProducerLaneFailureObservationV1(observation);
    const exact = readIssuedProducerLaneFailureObservationV1(observation);
    if (exact.headHash !== value.headHash || exact.generationId !== value.generationId || exact.graphRoot !== value.graphRoot) {
      throw new TypeError("producer head facts failure observation binding mismatch");
    }
    if (value.laneFacts.some(facts => readIssuedProducerLaneFactsV1(facts).lane === exact.lane)) {
      throw new TypeError("producer head facts lane has both success and failure facts");
    }
  }
  const candidateRefs = value.candidateRefs.map((candidateRef, index) => assertHash(candidateRef, `producerHeadFacts.candidateRefs[${index}]`));
  if (candidateRefs.some((candidateRef, index) => index > 0 && candidateRefs[index - 1]! >= candidateRef)) throw new TypeError("producer head candidate refs must be strictly sorted");
  const expectedCandidateRefs = value.laneFacts.flatMap(laneCapability => {
    const lane = readIssuedProducerLaneFactsV1(laneCapability);
    return lane.accounting?.entries.map(entry => performanceLaneCandidateRefV1(lane.lane, entry.candidateId)) ?? [];
  }).sort();
  if (!sameHashes(candidateRefs, expectedCandidateRefs)) throw new TypeError("producer head candidate refs do not match lane accounting");
  if (value.currentSourcePhysical !== null) assertIssuedCurrentSourceRpcPhysicalFactsV1(value.currentSourcePhysical);
  const facts = deepFreeze(input);
  const capability = Object.freeze(Object.create(null)) as ProducerHeadFactsCapabilityV1;
  headFactsIssued.set(capability, facts);
  return capability;
}

export function assertIssuedProducerHeadFactsCapabilityV1(
  value: unknown,
): asserts value is ProducerHeadFactsCapabilityV1 {
  if (value === null || typeof value !== "object" || !headFactsIssued.has(value)) {
    throw new TypeError("producer head facts capability is not owner-issued");
  }
}

export function readIssuedProducerHeadFactsCapabilityV1(
  value: unknown,
): ProducerHeadFactsV1 {
  assertIssuedProducerHeadFactsCapabilityV1(value);
  return headFactsIssued.get(value)!;
}

/**
 * Release-performance narrow seam. The exact head-terminal capability owns
 * the complete lane set, so a caller cannot omit a slower lane or select a
 * convenient completion handle from the scheduler journal.
 */
export function readIssuedProducerHeadSchedulerCompletionV1(
  value: unknown,
): object | null {
  const evidence = readIssuedProducerHeadTerminalCapabilityV1(value);
  if (evidence.facts === null) return null;
  const facts = readIssuedProducerHeadFactsCapabilityV1(evidence.facts);
  const completions: object[] = [];
  for (const laneCapability of facts.laneFacts) {
    const lane = readIssuedProducerLaneFactsV1(laneCapability);
    const join = readIssuedProducerLaneSchedulerResourceJoinV1(laneCapability);
    if (join === null) continue;
    if (lane.terminalKind !== "unsigned-dry-run"
      || join.correlationId !== lane.correlationId
      || join.generationId !== lane.generationId
      || join.source.chainId !== lane.currentSource.source.chainId
      || join.source.number !== lane.currentSource.source.number
      || join.source.hash !== lane.currentSource.source.hash
      || join.source.stateRoot !== lane.currentSource.source.stateRoot
      || join.unsignedDryRunLineageHash !== lane.terminalLineageHash
      || !lane.candidateIds.includes(join.unsignedDryRunCandidateId)
      || !facts.candidateRefs.includes(performanceLaneCandidateRefV1(lane.lane, join.unsignedDryRunCandidateId))) {
      throw new TypeError("producer head scheduler completion lineage mismatch");
    }
    completions.push(join.schedulerCompletion);
  }
  if (completions.length > 1) throw new TypeError("producer head scheduler completion is ambiguous");
  return completions[0] ?? null;
}

export function issueProducerHeadTerminalCapabilityV1(input: {
  readonly terminal: ProducerTerminalV1;
  readonly facts: ProducerHeadFactsCapabilityV1 | null;
}): ProducerHeadTerminalCapabilityV1 {
  const value = objectValue(input, "producer head terminal evidence");
  assertExactKeys(value, ["terminal", "facts"], "producer head terminal evidence");
  const terminalRecord = objectValue(value.terminal, "producer terminal");
  assertExactKeys(terminalRecord, ["kind", "terminalId", "acceptedId", "sequence", "ordinal", "head", "revision", "status", "reason", "generationId", "graphRoot", "laneOutcomes"], "producer terminal");
  if (terminalRecord.kind !== "aloha.producer-terminal-v1") throw new TypeError("producer terminal kind is invalid");
  const terminal = deepFreeze(value.terminal as ProducerTerminalV1);
  const expectedTerminalId = hashDomain("aloha/producer-terminal/v1", {
    acceptedId: terminal.acceptedId,
    sequence: terminal.sequence,
    ordinal: terminal.ordinal,
    status: terminal.status,
    reason: terminal.reason,
    head: terminal.head,
    revision: terminal.revision,
    generationId: terminal.generationId,
    graphRoot: terminal.graphRoot,
    laneOutcomes: terminal.laneOutcomes,
  });
  if (terminal.terminalId !== expectedTerminalId) throw new TypeError("producer terminal identity mismatch");
  let facts: ProducerHeadFactsCapabilityV1 | null = null;
  if (value.facts !== null) {
    assertIssuedProducerHeadFactsCapabilityV1(value.facts);
    facts = value.facts;
    const exactFacts = readIssuedProducerHeadFactsCapabilityV1(facts);
    if (exactFacts.headHash !== terminal.head.hash
      || exactFacts.generationId !== terminal.generationId
      || exactFacts.graphRoot !== terminal.graphRoot) {
      throw new TypeError("producer terminal and head facts binding mismatch");
    }
  } else if (terminal.status === "completed") {
    throw new TypeError("completed producer terminal requires head facts");
  }
  const evidence = Object.freeze({ terminal, facts });
  const capability = Object.freeze(Object.create(null)) as ProducerHeadTerminalCapabilityV1;
  headTerminalIssued.set(capability, evidence);
  return capability;
}

export function assertIssuedProducerHeadTerminalCapabilityV1(
  value: unknown,
): asserts value is ProducerHeadTerminalCapabilityV1 {
  if (value === null || typeof value !== "object" || !headTerminalIssued.has(value)) {
    throw new TypeError("producer head terminal capability is not owner-issued");
  }
}

export function readIssuedProducerHeadTerminalCapabilityV1(
  value: unknown,
): ProducerHeadTerminalEvidenceV1 {
  assertIssuedProducerHeadTerminalCapabilityV1(value);
  return headTerminalIssued.get(value)!;
}

/**
 * Full-family release seam. The caller supplies only the exact final head
 * terminal; this owner fixes the complete two-lane denominator and selects
 * the blockscan search terminal without accepting a lane or terminal choice.
 */
export function readIssuedProducerFinalFullFamilyTerminalSetV1(
  value: unknown,
): ProducerFinalFullFamilyTerminalSetV1 {
  const evidence = readIssuedProducerHeadTerminalCapabilityV1(value);
  if (evidence.terminal.status !== "completed" || evidence.facts === null) {
    throw new TypeError("full-family terminal set requires a completed Producer head");
  }
  const facts = readIssuedProducerHeadFactsCapabilityV1(evidence.facts);
  if (!facts.complete || facts.generationId === null || facts.graphRoot === null
    || facts.laneFailureObservations.length !== 0 || facts.laneFacts.length !== 2
    || facts.headHash !== evidence.terminal.head.hash
    || facts.generationId !== evidence.terminal.generationId
    || facts.graphRoot !== evidence.terminal.graphRoot) {
    throw new TypeError("full-family terminal set lacks the exact complete two-lane denominator");
  }
  const lanes = facts.laneFacts.map(capability => ({
    capability,
    facts: readIssuedProducerLaneFactsV1(capability),
  }));
  const blockscan = lanes.find(entry => entry.facts.lane === "blockscan");
  const backrun = lanes.find(entry => entry.facts.lane === "backrun");
  if (blockscan === undefined || backrun === undefined || !blockscan.facts.complete || !backrun.facts.complete) {
    throw new TypeError("full-family terminal set must contain exactly blockscan and backrun");
  }
  const blockscanSearchTerminalCapability = readIssuedProducerLaneSearchTerminalCapabilityV1(blockscan.capability);
  if (blockscanSearchTerminalCapability === null
    || (blockscan.facts.terminalKind !== "route-set-terminal" && blockscan.facts.terminalKind !== "unsigned-dry-run")) {
    throw new TypeError("full-family terminal set lacks the blockscan route terminal");
  }
  const blockscanTerminal = readIssuedSearchTerminalCapabilityV1(blockscanSearchTerminalCapability);
  if (blockscanTerminal.kind !== blockscan.facts.terminalKind) {
    throw new TypeError("full-family blockscan terminal kind mismatch");
  }
  const producerHeadFactsRoot = hashDomain("aloha/searcher-production-evidence-head-facts/v1", facts);
  const laneTerminalSetRoot = hashDomain("aloha/producer-final-full-family-lane-terminal-set/v1", {
    headHash: facts.headHash,
    generationId: facts.generationId,
    graphRoot: facts.graphRoot,
    lanes: [blockscan.facts, backrun.facts],
    laneFailureObservations: facts.laneFailureObservations,
  });
  return Object.freeze({ blockscanSearchTerminalCapability, producerHeadFactsRoot, laneTerminalSetRoot });
}

export function issueProducerPerformancePortV1<EligibleHeadHandle>(
  input: ProducerPerformancePortV1<EligibleHeadHandle>,
): ProducerPerformancePortV1<EligibleHeadHandle> {
  const value = objectValue(input, "producer performance port");
  if (typeof value.acceptEligibleHead !== "function" || typeof value.readEligibleHeadBinding !== "function"
    || typeof value.bindEligibleHeadSession !== "function"
    || typeof value.bindEligibleHeadFacts !== "function" || typeof value.sealHeadTerminal !== "function") {
    throw new TypeError("producer performance port is invalid");
  }
  const capability = Object.freeze({
    acceptEligibleHead: (request: Parameters<ProducerPerformancePortV1<EligibleHeadHandle>["acceptEligibleHead"]>[0]) => input.acceptEligibleHead(request),
    readEligibleHeadBinding: (eligibleHead: EligibleHeadHandle) => {
      const binding = objectValue(input.readEligibleHeadBinding(eligibleHead), "producer eligible head binding");
      assertExactKeys(binding, ["admissionId", "ordinal", "headHash", "revision"], "producer eligible head binding");
      const ordinal = assertDecimalString(binding.ordinal, "producerEligibleHeadBinding.ordinal");
      if (BigInt(ordinal) < 1n || BigInt(ordinal) > 100n) throw new TypeError("producer eligible head binding ordinal is outside 1..100");
      return Object.freeze({
        admissionId: assertHash(binding.admissionId, "producerEligibleHeadBinding.admissionId"),
        ordinal,
        headHash: assertHash(binding.headHash, "producerEligibleHeadBinding.headHash"),
        revision: assertDecimalString(binding.revision, "producerEligibleHeadBinding.revision"),
      });
    },
    bindEligibleHeadSession: (request: Parameters<ProducerPerformancePortV1<EligibleHeadHandle>["bindEligibleHeadSession"]>[0]) => {
      if (request.session === null || typeof request.session !== "object") {
        throw new TypeError("producer performance session is invalid");
      }
      return input.bindEligibleHeadSession(request);
    },
    bindEligibleHeadFacts: (request: Parameters<ProducerPerformancePortV1<EligibleHeadHandle>["bindEligibleHeadFacts"]>[0]) => {
      assertIssuedProducerHeadFactsCapabilityV1(request.facts);
      return input.bindEligibleHeadFacts(request);
    },
    sealHeadTerminal: (request: Parameters<ProducerPerformancePortV1<EligibleHeadHandle>["sealHeadTerminal"]>[0]) => {
      assertIssuedProducerHeadTerminalCapabilityV1(request.terminal);
      return input.sealHeadTerminal(request);
    },
  });
  performanceIssued.add(capability);
  return capability;
}

export function assertIssuedProducerPerformancePortV1(
  value: unknown,
): asserts value is ProducerPerformancePortV1<unknown> {
  if (value === null || typeof value !== "object" || !performanceIssued.has(value)) {
    throw new TypeError("producer performance port is not owner-issued");
  }
}

export function issueProducerTerminalPortV1(
  input: ProducerTerminalPortV1,
): ProducerTerminalPortV1 {
  const value = objectValue(input, "producer terminal port");
  if (typeof value.appendTerminal !== "function") throw new TypeError("producer terminal append is required");
  const capability = Object.freeze({
    appendTerminal: (request: Parameters<ProducerTerminalPortV1["appendTerminal"]>[0]) => {
      assertIssuedProducerHeadTerminalCapabilityV1(request.terminal);
      return input.appendTerminal(request);
    },
  });
  terminalIssued.add(capability);
  return capability;
}

export function assertIssuedProducerTerminalPortV1(
  value: unknown,
): asserts value is ProducerTerminalPortV1 {
  if (value === null || typeof value !== "object" || !terminalIssued.has(value)) {
    throw new TypeError("producer terminal port is not owner-issued");
  }
}
