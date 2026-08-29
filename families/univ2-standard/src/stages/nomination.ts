import {
  decodeExactObject,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type {
  CandidateNominationV1,
  SourcePlanExecutionV1,
} from "../../../../packages/discovery/src/index.ts";
import {
  decodeCanonicalCutoff,
  decodeSourcePlanEvidenceReceipt,
  decodeSourcePlanExecution,
  familyCandidateKey,
  recentObservationRange,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  SOURCE_EVIDENCE_VERSION_V1,
  type SourcePlanEvidenceReceiptV1,
  type RecentLogEvidenceRefV1,
} from "../../../../packages/discovery/src/index.ts";
import { decodeEvmLogObservationBytes } from "../../../../packages/observation/src/index.ts";
import type {
  FamilySourcePlanExecutionInputV1,
  FamilySourcePlanNominationInputV1,
  FamilySourcePlanNominationProgramV1,
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanRuntimeV1,
} from "../../../../packages/family-sdk/runtime/index.ts";
import { UNIV2_STANDARD_FAMILY_DEFINITION_HASH } from "../family-definition.ts";
import {
  UNIV2_STANDARD_SOURCE_PLAN_DEFINITION,
  UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
} from "../source-plan.ts";
import { UNIV2_STANDARD_FAMILY_ID } from "../family-definition.ts";
import {
  decodeNominationObservation,
  nominationKeyForPool,
  nominationSnapshotHash,
  UNIV2_SYNC_EVENT_TOPIC0,
  type UniV2NominationObservationV1,
  type UniV2NominationV1,
} from "../schema/index.ts";

export type UniV2NominationOutcomeV1 =
  | { readonly status: "nominated"; readonly candidate: UniV2NominationV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "not-univ2-sync" | "evidence-pool-mismatch" | "evidence-after-cutoff" };

function exactRecentOnlyResult(value: unknown): { readonly kind: "univ2-recent-only"; readonly resultPartitionRoot: Hash } {
  return decodeExactObject(value, {
    kind: (item, path) => {
      if (item !== "univ2-recent-only") throw new TypeError(`${path} kind mismatch`);
      return "univ2-recent-only" as const;
    },
    resultPartitionRoot: (item, path) => {
      if (typeof item !== "string" || !/^0x[0-9a-f]{64}$/.test(item)) throw new TypeError(`${path} must be a hash`);
      return item as Hash;
    },
  }, "univ2SourcePlanResult");
}

function verifyRawSyncEvidence(bytes: Uint8Array, evidence: RecentLogEvidenceRefV1): void {
  const decoded = decodeEvmLogObservationBytes(bytes, "univ2.rawSyncEvidence");
  if (
    decoded.address !== evidence.address
    || decoded.blockNumber !== evidence.blockNumber
    || decoded.blockHash !== evidence.blockHash
    || decoded.transactionHash !== evidence.txHash
    || decoded.logIndex !== evidence.logIndex
    || decoded.topics[0] !== evidence.topic
    || decoded.topics[0] !== UNIV2_SYNC_EVENT_TOPIC0
  ) throw new TypeError("univ2-raw-evidence-binding-mismatch");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

/**
 * Nomination is deliberately evidence-driven.  It never turns an address
 * list into admission: the later identity stage must reverse-verify the
 * address through the factory and both getPair directions.
 */
export function nominateUniV2(input: UniV2NominationObservationV1): UniV2NominationOutcomeV1 {
  try {
    const observation = decodeNominationObservation(input);
    const instanceNominationKey = nominationKeyForPool(observation.pool);
    const candidate: UniV2NominationV1 = Object.freeze({
      pool: observation.pool,
      instanceNominationKey,
      candidateSnapshotHash: nominationSnapshotHash(observation),
      evidence: observation.evidence,
    });
    return Object.freeze({ status: "nominated", candidate });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("topic-not-univ2-sync")) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "not-univ2-sync" });
    if (message.includes("emitter-pool-mismatch")) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-pool-mismatch" });
    if (message.includes("after-cutoff")) return Object.freeze({ status: "chain-proven-rejected", reasonCode: "evidence-after-cutoff" });
    throw error;
  }
}

export function instanceNominationKey(candidate: UniV2NominationV1): string {
  const pool = "kind" in candidate.evidence ? candidate.evidence.pool : decodeNominationObservation({ pool: candidate.pool, evidence: candidate.evidence }).pool;
  const key = nominationKeyForPool(pool);
  if (candidate.instanceNominationKey !== key) throw new Error("univ2-instance-nomination-key-mismatch");
  return key;
}

export const UNIV2_STANDARD_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...UNIV2_STANDARD_SOURCE_PLAN_DEFINITION,
  async execute(
    input: FamilySourcePlanExecutionInputV1,
    _physical: FamilySourcePlanPhysicalPortV1,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw signal.reason;
    if (
      input.plan.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH
      || input.plan.completeness !== "nomination-only"
      || input.plan.historyStartBlock !== null
      || input.previousAppliedThrough !== null
    ) throw new TypeError("univ2-source-plan-binding-mismatch");
    const cutoff = decodeCanonicalCutoff(input.cutoff);
    const range = recentObservationRange(cutoff.number);
    const resultPartitionRoot = hashDomain("aloha/univ2-standard/source-plan-result/v1", {
      plan: input.plan,
      cutoff,
      mode: "recent-only",
    });
    const opaqueResult = Object.freeze({ kind: "univ2-recent-only" as const, resultPartitionRoot });
    const sourceEvidenceRefs = Object.freeze([] as const);
    const rawLocatorHashes = Object.freeze([] as const);
    const sourceEvidenceRoot = sourcePlanEvidenceRoot({
      plan: input.plan,
      cutoff,
      refs: sourceEvidenceRefs,
      rawLocatorHashes,
    });
    const executionWithoutRoot: Omit<SourcePlanExecutionV1, "executionRoot"> = {
      kind: "source-plan-execution",
      version: SOURCE_EVIDENCE_VERSION_V1,
      plan: input.plan,
      cutoff,
      outcome: "positive-only",
      from: range.from,
      through: range.to,
      previousAppliedThrough: null,
      resultPartitionRoot,
      opaqueResult,
      sourceEvidenceRefs,
      rawLocatorHashes,
      sourceEvidenceRoot,
    };
    const execution: SourcePlanExecutionV1 = deepFreeze({
      ...executionWithoutRoot,
      executionRoot: sourcePlanExecutionRoot(executionWithoutRoot),
    });
    const sourceEvidence: SourcePlanEvidenceReceiptV1 = deepFreeze({
      kind: "source-plan-evidence",
      version: SOURCE_EVIDENCE_VERSION_V1,
      plan: input.plan,
      cutoff,
      refs: sourceEvidenceRefs,
      rawLocatorHashes,
      evidenceRoot: sourceEvidenceRoot,
    });
    return deepFreeze({
      execution,
      sourceEvidence,
      rawEvidenceLocators: [],
    });
  },
});

export const UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(
    input: FamilySourcePlanNominationInputV1,
    signal: AbortSignal,
  ): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    const execution = decodeSourcePlanExecution(input.execution, "univ2.sourcePlanExecution");
    const sourceEvidence = decodeSourcePlanEvidenceReceipt(input.sourceEvidence, "univ2.sourcePlanEvidence");
    const result = exactRecentOnlyResult(execution.opaqueResult);
    if (
      execution.plan.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH
      || execution.resultPartitionRoot !== result.resultPartitionRoot
      || !sameCanonical(execution.plan, sourceEvidence.plan)
      || !sameCanonical(execution.cutoff, sourceEvidence.cutoff)
      || execution.sourceEvidenceRoot !== sourceEvidence.evidenceRoot
      || !sameCanonical(execution.sourceEvidenceRefs, sourceEvidence.refs)
      || !sameCanonical(execution.rawLocatorHashes, sourceEvidence.rawLocatorHashes)
      || execution.cutoff.hash !== input.recent.cutoff.hash
      || execution.cutoff.stateRoot !== input.recent.cutoff.stateRoot
      || execution.cutoff.number !== input.recent.cutoff.number
      || execution.cutoff.chainId !== input.recent.cutoff.chainId
      || execution.from !== input.recent.range.from
      || execution.through !== input.recent.range.to
      || execution.from !== recentObservationRange(execution.cutoff.number).from
      || execution.through !== recentObservationRange(execution.cutoff.number).to
    ) throw new TypeError("univ2-source-plan-result-binding-mismatch");
    const nominations: CandidateNominationV1[] = [];
    for (const evidence of input.recent.evidence) {
      // Recent observation is shared by every Family.  The topic is the
      // chain-observed discriminator owned by this Family, so unrelated
      // evidence must be ignored before touching its raw locator.  A matching
      // topic still requires exact raw-byte verification below; the filter is
      // routing, never an admission allowlist.
      if (evidence.topic !== UNIV2_SYNC_EVENT_TOPIC0) continue;
      verifyRawSyncEvidence(input.rawEvidence.read(evidence.rawLocatorHash), evidence);
      const outcome = nominateUniV2({
        pool: evidence.address,
        evidence: {
          cutoff: input.recent.cutoff,
          blockNumber: evidence.blockNumber,
          blockHash: evidence.blockHash,
          txHash: evidence.txHash,
          logIndex: evidence.logIndex,
          emitter: evidence.address,
          topic0: evidence.topic,
          rawLocatorHash: evidence.rawLocatorHash,
        },
      });
      if (outcome.status !== "nominated") continue;
      nominations.push(deepFreeze({
        kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: UNIV2_STANDARD_FAMILY_ID, familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH, instanceNominationKey: outcome.candidate.instanceNominationKey, evidence,
      }));
    }
    return deepFreeze(nominations);
  },
});

export function candidateFamilyKey(candidate: UniV2NominationV1): Hash {
  return familyCandidateKey(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, instanceNominationKey(candidate));
}
