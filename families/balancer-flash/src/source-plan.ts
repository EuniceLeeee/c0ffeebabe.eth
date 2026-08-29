import { encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  defineFamilySourcePlan,
  sealNominationOnlySourceExecution,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type CandidateNominationV1,
  type SourcePlanEvidenceRefV1,
} from "../../../packages/discovery/src/index.ts";
import {
  decodeFamilySourcePlanPhysicalObservation,
  type FamilySourcePlanExecutionInputV1,
  type FamilySourcePlanNominationInputV1,
  type FamilySourcePlanNominationProgramV1,
  type FamilySourcePlanPhysicalPortV1,
  type FamilySourcePlanPhysicalResultV1,
  type FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { decodeEvmLogObservationBytes } from "../../../packages/observation/src/index.ts";

import { BALANCER_FLASH_FAMILY_ID, BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID, BALANCER_FLASH_SOURCE_PLAN_ID, BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC, BALANCER_VAULT } from "./manifest.ts";
import { BALANCER_FLASH_AUTHORING_HASH, BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH, BALANCER_FLASH_SOURCE_PLAN_SCHEMA_HASH } from "./metadata.ts";
import { BALANCER_FLASH_CONTRACT_PATTERN, decodeBalancerFlashCandidate, nominateBalancerFlash } from "./stages.ts";
import { canonicalAddress } from "./types.ts";

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  if (
    input.execution.plan.familyDefinitionHash !== BALANCER_FLASH_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || input.execution.sourceEvidenceRefs.length !== 0
    || input.execution.rawLocatorHashes.length !== 0
    || input.sourceEvidence.refs.length !== 0
    || input.sourceEvidence.rawLocatorHashes.length !== 0
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
  ) throw new TypeError("balancer-flash nomination binding mismatch");
}

function word(data: string, index: number, path: string): bigint {
  if (!/^0x(?:[0-9a-f]{64})+$/.test(data) || data.length < 2 + (index + 1) * 64) throw new TypeError(`${path} is not an ABI word`);
  return BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
}
function verifyFlashLoan(raw: ReturnType<typeof decodeEvmLogObservationBytes>, evidence: { readonly address: string; readonly topic: Hash }): void {
  if (raw.address !== evidence.address || raw.topics[0] !== evidence.topic || raw.topics.length < 3 || !/^0x[0-9a-f]{64}$/.test(raw.topics[1] ?? "") || !/^0x[0-9a-f]{64}$/.test(raw.topics[2] ?? "") || word(raw.data, 0, "balancer-flash.FlashLoan.amount") === 0n) throw new TypeError("balancer-flash FlashLoan ABI mismatch");
  word(raw.data, 1, "balancer-flash.FlashLoan.feeAmount");
}

export const BALANCER_FLASH_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: BALANCER_FLASH_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: BALANCER_FLASH_SOURCE_PLAN_SCHEMA_HASH,
});

export const BALANCER_FLASH_SINGLETON_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID,
  completeness: "complete-snapshot",
  historyStartBlock: null,
  schemaHash: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH,
});

const singleton = canonicalAddress(BALANCER_VAULT);
function blockTag(number: string): string { return `0x${BigInt(number).toString(16)}`; }
function decodeCode(value: unknown, path: string): string { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${path} must be canonical code bytes`); return value.toLowerCase(); }
function codePresent(code: string): boolean { return code !== "0x" && !/^0x(?:00)+$/.test(code); }
function sourceRef(input: FamilySourcePlanExecutionInputV1, result: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 { return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: result.evidenceRef, rawLocatorHash: result.rawLocatorHash }); }
function exactPhysicalResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("balancer singleton physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("balancer singleton physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (raw === null || typeof raw !== "object" || Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array) || sha256Hex(raw.bytes) !== value.rawLocatorHash) throw new TypeError("balancer singleton raw locator mismatch");
  return value;
}
function assertSingletonObservation(bytes: Uint8Array, input: { readonly plan: FamilySourcePlanExecutionInputV1["plan"]; readonly cutoff: FamilySourcePlanExecutionInputV1["cutoff"] }, response?: CanonicalJson): string {
  const observation = decodeFamilySourcePlanPhysicalObservation(bytes, "balancer.singleton.observation");
  if (observation.familyDefinitionHash !== BALANCER_FLASH_AUTHORING_HASH || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan) || !sameCutoff(observation.cutoff, input.cutoff) || observation.requestSchemaHash !== BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH || observation.request.method !== "eth_getCode" || observation.request.target !== singleton || observation.request.manager !== singleton || observation.request.topic !== null || observation.request.lookback !== null || observation.request.chunk !== null || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([BALANCER_VAULT, blockTag(input.cutoff.number)]) || (response !== undefined && encodeCanonicalJson(observation.response) !== encodeCanonicalJson(response))) throw new TypeError("balancer singleton physical observation binding mismatch");
  return decodeCode(observation.response, "balancer singleton code response");
}

export const BALANCER_FLASH_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...BALANCER_FLASH_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== BALANCER_FLASH_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) {
      throw new TypeError("balancer-flash source plan binding mismatch");
    }
    return sealNominationOnlySourceExecution(input);
  },
});

export const BALANCER_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...BALANCER_FLASH_SINGLETON_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.cutoff.chainId !== "1" || input.plan.familyDefinitionHash !== BALANCER_FLASH_AUTHORING_HASH || input.plan.completeness !== "complete-snapshot" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) throw new TypeError("balancer singleton source plan binding mismatch");
    const result = exactPhysicalResult(await physical.request({ familyDefinitionHash: BALANCER_FLASH_AUTHORING_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getCode", params: Object.freeze([BALANCER_VAULT, blockTag(input.cutoff.number)]), target: singleton, manager: singleton, topic: null, lookback: null, chunk: null } }, signal));
    const code = assertSingletonObservation(result.rawEvidenceLocator.bytes, input, result.response);
    const refs = Object.freeze([sourceRef(input, result)]);
    const rawEvidenceLocators = Object.freeze([result.rawEvidenceLocator]);
    const rawLocatorHashes = Object.freeze([result.rawLocatorHash]);
    const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes });
    const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes, evidenceRoot });
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "balancer-v2-vault-complete-snapshot", version: 1, singleton, present: codePresent(code), codeHash: hashDomain("aloha/balancer-flash/singleton-code/v1", code) });
    const resultPartitionRoot = hashDomain("aloha/balancer-flash/singleton-source-partition/v1", opaqueResult);
    const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from: input.cutoff.number, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators });
  },
});

export const BALANCER_FLASH_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: BALANCER_FLASH_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    const output: CandidateNominationV1[] = [];
    const ownedRaw = new Set(input.recent.rawLocatorHashes);
    const seen = new Set<string>();
    for (const evidence of input.recent.evidence) {
      if (evidence.topic !== BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC) continue;
      if (!ownedRaw.has(evidence.rawLocatorHash)) throw new TypeError("balancer-flash raw locator is outside recent receipt");
      const rawBytes = input.rawEvidence.read(evidence.rawLocatorHash);
      const raw = decodeEvmLogObservationBytes(rawBytes, "balancer-flash.rawEvidence");
      if (sha256Hex(rawBytes) !== evidence.rawLocatorHash || raw.address !== evidence.address || raw.topics[0] !== evidence.topic || raw.blockNumber !== evidence.blockNumber || raw.blockHash !== evidence.blockHash || raw.transactionHash !== evidence.txHash || raw.logIndex !== evidence.logIndex) throw new TypeError("balancer-flash raw evidence/recent evidence mismatch");
      verifyFlashLoan(raw, evidence);
      const seed = decodeBalancerFlashCandidate({
        kind: "log",
        target: evidence.address,
        topic: evidence.topic,
        cutoff: input.recent.cutoff,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        txHash: evidence.txHash,
        logIndex: evidence.logIndex,
        rawLocatorHash: evidence.rawLocatorHash,
      }, BALANCER_FLASH_CONTRACT_PATTERN);
      if (seed === null) continue;
      const nomination = nominateBalancerFlash(seed);
      if (nomination.status === "nominated" && !seen.has(nomination.candidate.instanceNominationKey)) {
        seen.add(nomination.candidate.instanceNominationKey);
        output.push(Object.freeze({
          kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: BALANCER_FLASH_FAMILY_ID, familyDefinitionHash: BALANCER_FLASH_AUTHORING_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence,
        }));
      }
    }
    return Object.freeze(output);
  },
});

export const BALANCER_FLASH_SINGLETON_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    if (input.execution.plan.familyDefinitionHash !== BALANCER_FLASH_AUTHORING_HASH || input.execution.plan.completeness !== "complete-snapshot" || input.execution.outcome !== "complete" || input.execution.from !== input.recent.cutoff.number || input.execution.through !== input.recent.cutoff.number || input.execution.previousAppliedThrough !== null || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan) || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot || encodeCanonicalJson(input.execution.sourceEvidenceRefs) !== encodeCanonicalJson(input.sourceEvidence.refs) || encodeCanonicalJson(input.execution.rawLocatorHashes) !== encodeCanonicalJson(input.sourceEvidence.rawLocatorHashes) || !sameCutoff(input.execution.cutoff, input.recent.cutoff) || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff) || input.sourceEvidence.refs.length !== 1 || input.sourceEvidence.rawLocatorHashes.length !== 1) throw new TypeError("balancer singleton nomination binding mismatch");
    const opaque = input.execution.opaqueResult as { readonly kind?: unknown; readonly version?: unknown; readonly singleton?: unknown; readonly present?: unknown; readonly codeHash?: unknown };
    if (Reflect.ownKeys(opaque).sort().join(",") !== "codeHash,kind,present,singleton,version" || opaque.kind !== "balancer-v2-vault-complete-snapshot" || opaque.version !== 1 || opaque.singleton !== singleton || typeof opaque.present !== "boolean" || typeof opaque.codeHash !== "string") throw new TypeError("balancer singleton opaque result is malformed");
    const ref = input.sourceEvidence.refs[0]!;
    if (ref.rawLocatorHash !== input.sourceEvidence.rawLocatorHashes[0]) throw new TypeError("balancer singleton raw locator partition mismatch");
    const raw = input.rawEvidence.read(ref.rawLocatorHash);
    if (sha256Hex(raw) !== ref.rawLocatorHash) throw new TypeError("balancer singleton nomination raw observation hash mismatch");
    const code = assertSingletonObservation(raw, { plan: input.execution.plan, cutoff: input.execution.cutoff });
    if (opaque.present !== codePresent(code) || opaque.codeHash !== hashDomain("aloha/balancer-flash/singleton-code/v1", code)) throw new TypeError("balancer singleton opaque result/evidence mismatch");
    if (!opaque.present) return Object.freeze([]);
    return Object.freeze([Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: BALANCER_FLASH_FAMILY_ID, familyDefinitionHash: BALANCER_FLASH_AUTHORING_HASH, instanceNominationKey: singleton, evidence: ref })]);
  },
});
