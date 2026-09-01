import { encodeCanonicalJson, sha256Hex, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  defineFamilySourcePlan,
  sealNominationOnlySourceExecution,
  sourcePlanExecutionRoot,
  type CandidateNominationV1,
} from "../../../packages/discovery/src/index.ts";
import { decodeEvmLogObservationBytes } from "../../../packages/observation/src/index.ts";
import { decodeEtherTokenNativeRedeemCandidate } from "./discovery.ts";
import { nominateEtherTokenNativeRedeem } from "./nomination.ts";
import type {
  FamilySourcePlanExecutionInputV1,
  FamilySourcePlanNominationInputV1,
  FamilySourcePlanNominationProgramV1,
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";

import { ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC, ETHERTOKEN_NATIVE_REDEEM_FAMILY_ID, ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_ID, ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_SCHEMA_HASH, ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_ID, ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_SCHEMA_HASH } from "./manifest.ts";
import { ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH } from "./family-definition.ts";

export const ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_SCHEMA_HASH,
});

export const ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_ID,
  completeness: "rolling-observation",
  historyStartBlock: null,
  schemaHash: ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
});

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  const through = BigInt(input.recent.cutoff.number);
  const expectedFrom = (through > 49n ? through - 49n : 0n).toString();
  if (
    input.execution.plan.familyDefinitionHash !== ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || input.execution.outcome !== "positive-only"
    || input.execution.sourceEvidenceRefs.length !== 0
    || input.execution.rawLocatorHashes.length !== 0
    || input.sourceEvidence.refs.length !== 0
    || input.sourceEvidence.rawLocatorHashes.length !== 0
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
    || input.execution.from !== expectedFrom
    || input.execution.through !== input.recent.cutoff.number
    || input.recent.range.from !== input.execution.from
    || input.recent.range.to !== input.execution.through
  ) throw new TypeError("ethertoken-native-redeem nomination binding mismatch");
}

function sealPositiveOnlySourceExecution(input: FamilySourcePlanExecutionInputV1) {
  const result = sealNominationOnlySourceExecution(input);
  const withoutRoot = { ...result.execution, outcome: "positive-only" as const };
  return Object.freeze({
    ...result,
    execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }),
  });
}

export const ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) {
      throw new TypeError("ethertoken-native-redeem source plan binding mismatch");
    }
    return sealPositiveOnlySourceExecution(input);
  },
});

export const ETHERTOKEN_NATIVE_REDEEM_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    const ownedRaw = new Set(input.recent.rawLocatorHashes);
    const nominations: CandidateNominationV1[] = [];
    for (const evidence of input.recent.evidence) {
      if (evidence.topic !== ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC) continue;
      if (!ownedRaw.has(evidence.rawLocatorHash)) throw new TypeError("ethertoken-native-redeem raw locator is outside recent receipt");
      const rawBytes = input.rawEvidence.read(evidence.rawLocatorHash);
      const raw = decodeEvmLogObservationBytes(rawBytes, "ethertoken-native-redeem.rawEvidence");
      if (
        raw.address !== evidence.address
        || raw.topics[0] !== evidence.topic
        || raw.blockNumber !== evidence.blockNumber
        || raw.blockHash !== evidence.blockHash
        || raw.transactionHash !== evidence.txHash
        || raw.logIndex !== evidence.logIndex
        || sha256Hex(rawBytes) !== evidence.rawLocatorHash
      ) throw new TypeError("ethertoken-native-redeem raw evidence/recent evidence mismatch");
      const observation = Object.freeze({
        kind: "log" as const,
        cutoff: input.recent.cutoff,
        blockNumber: raw.blockNumber,
        blockHash: raw.blockHash,
        txHash: raw.transactionHash,
        logIndex: raw.logIndex,
        target: raw.address,
        topic: evidence.topic,
        rawLocatorHash: evidence.rawLocatorHash,
      });
      const seed = decodeEtherTokenNativeRedeemCandidate(observation, "ethertoken-native-call");
      if (seed === null) continue;
      const nomination = nominateEtherTokenNativeRedeem({ target: seed.target, evidence: observation });
      if (nomination.status !== "nominated") continue;
      nominations.push(Object.freeze({
        kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: ETHERTOKEN_NATIVE_REDEEM_FAMILY_ID, familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence,
      }));
    }
    return Object.freeze(nominations);
  },
});
