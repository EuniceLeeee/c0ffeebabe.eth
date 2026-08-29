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

import {
  DODO_V2_FAMILY_ID,
  DODO_V2_HISTORY_SOURCE_PLAN_ID,
  DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  DODO_V2_SOURCE_PLAN_ID,
  DODO_V2_SOURCE_PLAN_SCHEMA_HASH,
  DODO_V2_SWAP_TOPIC,
} from "./manifest.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { decodeDodoCandidate } from "./discovery.ts";
import { nominateDodoV2 } from "./nomination.ts";


function sameCutoff(
  left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash },
  right: typeof left,
): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function abiWords(data: string, count: number, path: string): readonly bigint[] {
  if (!new RegExp(`^0x(?:[0-9a-f]{64}){${count}}$`).test(data)) throw new TypeError(`${path} must contain exactly ${count} ABI words`);
  return Object.freeze(Array.from({ length: count }, (_, index) => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`)));
}

function indexedAddress(value: string, path: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(value)) throw new TypeError(`${path} is not a padded indexed address`);
  return `0x${value.slice(-40)}`;
}

function verifySwapLog(raw: ReturnType<typeof decodeEvmLogObservationBytes>): void {
  if (raw.topics.length !== 3 || raw.topics[0] !== DODO_V2_SWAP_TOPIC) throw new TypeError("dodo-v2 Swap topic layout mismatch");
  indexedAddress(raw.topics[1]!, "dodo-v2.DODOSwap.fromToken");
  indexedAddress(raw.topics[2]!, "dodo-v2.DODOSwap.toToken");
  const values = abiWords(raw.data, 2, "dodo-v2.DODOSwap.data");
  if (values[0] === 0n || values[1] === 0n) throw new TypeError("dodo-v2 DODOSwap contains a zero amount");
}

function readRawEvidence(
  input: FamilySourcePlanNominationInputV1,
  evidence: FamilySourcePlanNominationInputV1["recent"]["evidence"][number],
): ReturnType<typeof decodeEvmLogObservationBytes> {
  if (!new Set(input.recent.rawLocatorHashes).has(evidence.rawLocatorHash)) throw new TypeError("dodo-v2 raw locator is outside recent receipt");
  const rawBytes = input.rawEvidence.read(evidence.rawLocatorHash);
  const raw = decodeEvmLogObservationBytes(rawBytes, "dodo-v2.rawEvidence");
  if (
    sha256Hex(rawBytes) !== evidence.rawLocatorHash
    || raw.blockNumber !== evidence.blockNumber
    || raw.blockHash !== evidence.blockHash
    || raw.transactionHash !== evidence.txHash
    || raw.logIndex !== evidence.logIndex
    || raw.address !== evidence.address
    || raw.topics[0] !== evidence.topic
  ) throw new TypeError("dodo-v2 raw evidence/recent evidence mismatch");
  return raw;
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  if (
    input.execution.plan.familyDefinitionHash !== DODO_V2_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || input.execution.sourceEvidenceRefs.length !== 0
    || input.execution.rawLocatorHashes.length !== 0
    || input.sourceEvidence.refs.length !== 0
    || input.sourceEvidence.rawLocatorHashes.length !== 0
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
  ) throw new TypeError("dodo-v2 nomination binding mismatch");
}

export const DODO_V2_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: DODO_V2_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: DODO_V2_SOURCE_PLAN_SCHEMA_HASH,
});

export const DODO_V2_HISTORY_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: DODO_V2_HISTORY_SOURCE_PLAN_ID,
  completeness: "contiguous-history",
  historyStartBlock: "0",
  schemaHash: DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
});

export const DODO_V2_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...DODO_V2_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (
      input.plan.familyDefinitionHash !== DODO_V2_FAMILY_AUTHORING_HASH
      || input.plan.completeness !== "nomination-only"
      || input.plan.historyStartBlock !== null
      || input.previousAppliedThrough !== null
    ) throw new TypeError("dodo-v2 source plan binding mismatch");
    return sealNominationOnlySourceExecution(input);
  },
});

export const DODO_V2_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: DODO_V2_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    const output: CandidateNominationV1[] = [];
    for (const evidence of input.recent.evidence) {
      if (evidence.topic !== DODO_V2_SWAP_TOPIC) continue;
      const raw = readRawEvidence(input, evidence);
      verifySwapLog(raw);
      const seed = decodeDodoCandidate({
        kind: "log",
        target: evidence.address,
        cutoff: input.recent.cutoff,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        txHash: evidence.txHash,
        logIndex: evidence.logIndex,
        rawLocatorHash: evidence.rawLocatorHash,
        topic0: evidence.topic,
      }, "dodo-v2-swap-log");
      if (seed === null) continue;
      const nomination = nominateDodoV2(seed);
      if (nomination.status === "nominated") output.push(Object.freeze({
        kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: DODO_V2_FAMILY_ID, familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence,
      }));
    }
    return Object.freeze(output);
  },
});
