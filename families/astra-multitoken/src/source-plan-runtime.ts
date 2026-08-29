import {
  assertHash,
  decodeCanonicalJson,
  decodeExactObject,
  encodeCanonicalJson,
  fieldArray,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeCanonicalCutoff,
  decodeSourcePlanEvidenceReceipt,
  decodeSourcePlanExecution,
  decodeSourcePlanRef,
  sealNominationOnlySourceExecution,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type CandidateNominationV1,
  type SourcePlanEvidenceReceiptV1,
  type SourcePlanExecutionV1,
} from "../../../packages/discovery/src/index.ts";
import type {
  FamilySourcePlanExecutionInputV1,
  FamilySourcePlanNominationInputV1,
  FamilySourcePlanNominationProgramV1,
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
import { decodeEvmLogObservationBytes } from "../../../packages/observation/src/index.ts";
import { ASTRA_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { ASTRA_CHANGE_TOPIC, ASTRA_FAMILY_ID, ASTRA_SOURCE_PLAN_ID } from "./manifest.ts";
import { decodeAstraCandidate, instanceNominationKey } from "./discovery.ts";
import { nominateAstra } from "./nomination.ts";
import { ASTRA_SOURCE_PLAN, ASTRA_SOURCE_PLAN_SCHEMA_HASH } from "./source-plan.ts";
import type { Address, AstraObservationV1 } from "./types.ts";

export interface AstraRawEvidenceEnvelopeV1 {
  readonly kind: "astra-log-evidence";
  readonly version: 1;
  readonly target: Address;
  readonly topics: readonly string[];
  readonly dataHex: string;
}

function address(value: unknown, path: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be an address`);
  return `0x${value.slice(2).toLowerCase()}` as Address;
}

function hexWord(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${path} must be a 32-byte word`);
  return value.toLowerCase();
}

function hexWords(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{64}){2,}$/.test(value)) throw new TypeError(`${path} must contain at least two ABI words`);
  return value.toLowerCase();
}

function decodeTopics(value: unknown, path: string): readonly string[] {
  const topics = fieldArray(value, hexWord, path);
  if (topics.length < 4) throw new TypeError(`${path} must contain Astra's indexed fields`);
  return topics;
}

export function decodeAstraRawEvidenceEnvelope(bytes: Uint8Array): AstraRawEvidenceEnvelopeV1 {
  const decoded = decodeCanonicalJson(bytes);
  return decodeExactObject(decoded, {
    kind: (field, path) => field === "astra-log-evidence" ? field : (() => { throw new TypeError(`${path} kind mismatch`); })(),
    version: (field, path) => field === 1 ? 1 as const : (() => { throw new TypeError(`${path} version mismatch`); })(),
    target: (field, path) => address(field, path),
    topics: decodeTopics,
    dataHex: (field, path) => hexWords(field, path),
  });
}

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assertPlanInput(input: FamilySourcePlanExecutionInputV1): void {
  const plan = decodeSourcePlanRef(input.plan);
  if (
    plan.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH
    || plan.completeness !== "nomination-only"
    || plan.historyStartBlock !== null
    || input.previousAppliedThrough !== null
  ) throw new TypeError("Astra source plan binding mismatch");
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  const execution = decodeSourcePlanExecution(input.execution);
  const sourceEvidence = decodeSourcePlanEvidenceReceipt(input.sourceEvidence);
  if (
    execution.plan.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH
    || execution.plan.completeness !== "nomination-only"
    || execution.plan.historyStartBlock !== null
    || encodeCanonicalJson(execution.plan) !== encodeCanonicalJson(sourceEvidence.plan)
    || !sameCutoff(execution.cutoff, sourceEvidence.cutoff)
    || !sameCutoff(execution.cutoff, input.recent.cutoff)
    || execution.from !== input.recent.range.from
    || execution.through !== input.recent.range.to
    || execution.outcome !== "complete"
    || execution.sourceEvidenceRefs.length !== 0
    || execution.rawLocatorHashes.length !== 0
    || sourceEvidence.refs.length !== 0
    || sourceEvidence.rawLocatorHashes.length !== 0
    || execution.sourceEvidenceRoot !== sourceEvidence.evidenceRoot
    || encodeCanonicalJson(execution.sourceEvidenceRefs) !== encodeCanonicalJson(sourceEvidence.refs)
    || encodeCanonicalJson(execution.rawLocatorHashes) !== encodeCanonicalJson(sourceEvidence.rawLocatorHashes)
    || sourcePlanEvidenceRoot({ plan: sourceEvidence.plan, cutoff: sourceEvidence.cutoff, refs: sourceEvidence.refs, rawLocatorHashes: sourceEvidence.rawLocatorHashes }) !== sourceEvidence.evidenceRoot
    || sourcePlanExecutionRoot(execution) !== execution.executionRoot
  ) throw new TypeError("Astra nomination binding mismatch");
}

function makeObservation(input: { readonly evidence: RecentObservationReceiptV1["evidence"][number]; readonly raw: AstraRawEvidenceEnvelopeV1; readonly cutoff: RecentObservationReceiptV1["cutoff"] }): AstraObservationV1 {
  if (address(input.evidence.address, "recent.evidence.address") !== input.raw.target || input.raw.topics[0] !== input.evidence.topic) {
    throw new TypeError("Astra raw evidence/recent evidence mismatch");
  }
  return Object.freeze({
    kind: "log",
    target: input.raw.target,
    source: input.cutoff,
    blockNumber: input.evidence.blockNumber,
    blockHash: input.evidence.blockHash,
    txHash: input.evidence.txHash,
    logIndex: input.evidence.logIndex,
    dataHex: input.raw.dataHex,
    topics: input.raw.topics,
  });
}

export const ASTRA_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...ASTRA_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    assertPlanInput(input);
    return sealNominationOnlySourceExecution(input);
  },
});

export const ASTRA_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: ASTRA_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    const ownedRaw = new Set(input.recent.rawLocatorHashes);
    const seenTargets = new Set<string>();
    const nominations: CandidateNominationV1[] = [];
    for (const evidence of input.recent.evidence) {
      if (evidence.topic !== ASTRA_CHANGE_TOPIC || !ownedRaw.has(evidence.rawLocatorHash)) continue;
      const target = instanceNominationKey({ target: evidence.address });
      if (seenTargets.has(target)) continue;
      seenTargets.add(target);
      const rawBytes = input.rawEvidence.read(evidence.rawLocatorHash);
      if (sha256Hex(rawBytes) !== evidence.rawLocatorHash) throw new TypeError("Astra raw evidence hash mismatch");
      let raw: AstraRawEvidenceEnvelopeV1;
      try {
        const evm = decodeEvmLogObservationBytes(rawBytes, "astra.rawEvidence");
        if (evm.address !== evidence.address || evm.topics[0] !== evidence.topic || evm.blockNumber !== evidence.blockNumber || evm.blockHash !== evidence.blockHash || evm.transactionHash !== evidence.txHash || evm.logIndex !== evidence.logIndex) throw new TypeError("Astra raw evidence/recent evidence mismatch");
        raw = Object.freeze({ kind: "astra-log-evidence", version: 1, target: evm.address as Address, topics: evm.topics, dataHex: evm.data });
      } catch (error) {
        // Keep the pre-existing family envelope readable for already-sealed
        // checkpoints; new observations are always preferred as protocol-
        // neutral EVM log bytes above.
        if (error instanceof TypeError && String(error.message).includes("Astra raw evidence/recent")) throw error;
        raw = decodeAstraRawEvidenceEnvelope(rawBytes);
      }
      const observation = makeObservation({ evidence, raw, cutoff: input.recent.cutoff });
      const seed = decodeAstraCandidate(observation, "astra-change-log");
      if (seed === null) continue;
      const nomination = nominateAstra({ target, evidence: observation });
      if (nomination.status !== "nominated") continue;
      nominations.push(Object.freeze({
        kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: ASTRA_FAMILY_ID, familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence,
      }));
    }
    return Object.freeze(nominations);
  },
});
