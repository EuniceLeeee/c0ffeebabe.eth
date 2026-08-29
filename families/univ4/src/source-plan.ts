import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { encodeCanonicalJson, hashDomain, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  defineFamilySourcePlan,
  sealNominationOnlySourceExecution,
  type CandidateNominationV1,
} from "../../../packages/discovery/src/index.ts";
import type {
  FamilySourcePlanExecutionInputV1,
  FamilySourcePlanNominationInputV1,
  FamilySourcePlanNominationProgramV1,
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { decodeEvmLogObservationBytes } from "../../../packages/observation/src/index.ts";

import { UNIV4_FAMILY_ID, UNIV4_SOURCE_PLAN_ID, UNIV4_HISTORY_SOURCE_PLAN_ID, UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH, UNIV4_CONTRACT_EVIDENCE_TOPIC } from "./manifest.ts";
import { UNIV4_AUTHORING_HASH, UNIV4_SOURCE_PLAN_SCHEMA_HASH } from "./metadata.ts";
import { decodeUniv4InitializeLog } from "./abi.ts";
import { UNIV4_CONTRACT_PATTERN, decodeUniv4Candidate, nominateUniv4 } from "./stages.ts";

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  if (
    input.execution.plan.familyDefinitionHash !== UNIV4_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || input.execution.sourceEvidenceRefs.length !== 0
    || input.execution.rawLocatorHashes.length !== 0
    || input.sourceEvidence.refs.length !== 0
    || input.sourceEvidence.rawLocatorHashes.length !== 0
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
  ) throw new TypeError("univ4 nomination binding mismatch");
}

export const UNIV4_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: UNIV4_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: UNIV4_SOURCE_PLAN_SCHEMA_HASH,
});
export const UNIV4_HISTORY_SOURCE_PLAN = defineFamilySourcePlan({ sourcePlanId: UNIV4_HISTORY_SOURCE_PLAN_ID, completeness: "contiguous-history", historyStartBlock: "0", schemaHash: asSchemaRef(UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH) });

export const UNIV4_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...UNIV4_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== UNIV4_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) {
      throw new TypeError("univ4 source plan binding mismatch");
    }
    return sealNominationOnlySourceExecution(input);
  },
});

export const UNIV4_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: UNIV4_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    const output: CandidateNominationV1[] = [];
    const ownedRaw = new Set(input.recent.rawLocatorHashes);
    const seen = new Set<string>();
    for (const evidence of input.recent.evidence) {
      if (evidence.topic !== UNIV4_CONTRACT_EVIDENCE_TOPIC) continue;
      if (!ownedRaw.has(evidence.rawLocatorHash)) throw new TypeError("univ4 raw locator is outside recent receipt");
      const rawBytes = input.rawEvidence.read(evidence.rawLocatorHash);
      const raw = decodeEvmLogObservationBytes(rawBytes, "univ4.rawEvidence");
      if (sha256Hex(rawBytes) !== evidence.rawLocatorHash || raw.address !== evidence.address || raw.topics[0] !== evidence.topic || raw.blockNumber !== evidence.blockNumber || raw.blockHash !== evidence.blockHash || raw.transactionHash !== evidence.txHash || raw.logIndex !== evidence.logIndex) throw new TypeError("univ4 raw evidence/recent evidence mismatch");
      const { poolId } = decodeUniv4InitializeLog(raw, evidence.topic);
      const seed = decodeUniv4Candidate({ kind: "log", target: raw.address, topic: evidence.topic, cutoff: input.recent.cutoff, blockNumber: raw.blockNumber, blockHash: raw.blockHash, txHash: raw.transactionHash, logIndex: raw.logIndex, rawLocatorHash: evidence.rawLocatorHash }, UNIV4_CONTRACT_PATTERN);
      if (seed === null) continue;
      const nomination = nominateUniv4({ ...seed, poolId });
      if (nomination.status !== "nominated" || seen.has(nomination.candidate.instanceNominationKey)) continue;
      seen.add(nomination.candidate.instanceNominationKey);
      output.push(Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: UNIV4_FAMILY_ID, familyDefinitionHash: UNIV4_AUTHORING_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence }));
    }
    return Object.freeze(output);
  },
});
