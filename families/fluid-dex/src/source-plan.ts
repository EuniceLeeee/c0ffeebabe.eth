import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  defineFamilySourcePlan,
  sealNominationOnlySourceExecution,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type CandidateNominationV1,
  type SourcePlanEvidenceRefV1,
} from "../../../packages/discovery/src/index.ts";
import type {
  FamilySourcePlanExecutionInputV1,
  FamilySourcePlanNominationInputV1,
  FamilySourcePlanNominationProgramV1,
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanPhysicalResultV1,
  FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { decodeFamilySourcePlanPhysicalObservation } from "../../../packages/family-sdk/runtime/index.ts";
import { decodeEvmLogObservationBytes } from "../../../packages/observation/src/index.ts";

import { decodeFluidDexSwapEvent } from "./abi.ts";
import { FLUID_DEX_FACTORY, FLUID_DEX_FACTORY_SOURCE_PLAN_ID, FLUID_DEX_FAMILY_ID, FLUID_DEX_SOURCE_PLAN_ID, FLUID_DEX_CONTRACT_EVIDENCE_TOPIC } from "./manifest.ts";
import { FLUID_DEX_AUTHORING_HASH, FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH, FLUID_DEX_SOURCE_PLAN_SCHEMA_HASH } from "./metadata.ts";
import { canonicalAddress } from "./types.ts";
import { FLUID_DEX_CONTRACT_PATTERN, decodeFluidDexCandidate, nominateFluidDex } from "./stages.ts";

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function verifySwap(raw: ReturnType<typeof decodeEvmLogObservationBytes>, evidence: { readonly address: string; readonly topic: Hash }): void {
  if (raw.address !== evidence.address || evidence.topic !== FLUID_DEX_CONTRACT_EVIDENCE_TOPIC) throw new TypeError("fluid-dex Swap log binding mismatch");
  decodeFluidDexSwapEvent(raw.topics, raw.data, FLUID_DEX_CONTRACT_EVIDENCE_TOPIC);
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  if (
    input.execution.plan.familyDefinitionHash !== FLUID_DEX_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || encodeCanonicalJson(input.execution.sourceEvidenceRefs) !== encodeCanonicalJson(input.sourceEvidence.refs)
    || encodeCanonicalJson(input.execution.rawLocatorHashes) !== encodeCanonicalJson(input.sourceEvidence.rawLocatorHashes)
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
  ) throw new TypeError("fluid-dex nomination binding mismatch");
}

export const FLUID_DEX_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: FLUID_DEX_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: FLUID_DEX_SOURCE_PLAN_SCHEMA_HASH,
});

export const FLUID_DEX_FACTORY_SOURCE_PLAN = defineFamilySourcePlan({ sourcePlanId: FLUID_DEX_FACTORY_SOURCE_PLAN_ID, completeness: "complete-snapshot", historyStartBlock: null, schemaHash: FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH });

export const FLUID_DEX_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...FLUID_DEX_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== FLUID_DEX_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) {
      throw new TypeError("fluid-dex source plan binding mismatch");
    }
    return sealNominationOnlySourceExecution(input);
  },
});

export const FLUID_DEX_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: FLUID_DEX_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    if (input.execution.sourceEvidenceRefs.length !== 0 || input.execution.rawLocatorHashes.length !== 0) throw new TypeError("fluid-dex recent plan carried source evidence");
    const output: CandidateNominationV1[] = [];
    const ownedRaw = new Set(input.recent.rawLocatorHashes);
    const seen = new Set<string>();
    for (const evidence of input.recent.evidence) {
      if (evidence.topic !== FLUID_DEX_CONTRACT_EVIDENCE_TOPIC) continue;
      if (!ownedRaw.has(evidence.rawLocatorHash)) throw new TypeError("fluid-dex raw locator is outside recent receipt");
      const rawBytes = input.rawEvidence.read(evidence.rawLocatorHash);
      const raw = decodeEvmLogObservationBytes(rawBytes, "fluid-dex.rawEvidence");
      if (sha256Hex(rawBytes) !== evidence.rawLocatorHash || raw.address !== evidence.address || raw.topics[0] !== evidence.topic || raw.blockNumber !== evidence.blockNumber || raw.blockHash !== evidence.blockHash || raw.transactionHash !== evidence.txHash || raw.logIndex !== evidence.logIndex) throw new TypeError("fluid-dex raw evidence/recent evidence mismatch");
      verifySwap(raw, evidence);
      const seed = decodeFluidDexCandidate({
        kind: "log",
        target: evidence.address,
        topic: evidence.topic,
        cutoff: input.recent.cutoff,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        txHash: evidence.txHash,
        logIndex: evidence.logIndex,
        rawLocatorHash: evidence.rawLocatorHash,
      }, FLUID_DEX_CONTRACT_PATTERN);
      if (seed === null) continue;
      const nomination = nominateFluidDex(seed);
      if (nomination.status === "nominated" && !seen.has(nomination.candidate.instanceNominationKey)) {
        seen.add(nomination.candidate.instanceNominationKey);
        output.push(Object.freeze({
          kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: FLUID_DEX_FAMILY_ID, familyDefinitionHash: FLUID_DEX_AUTHORING_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence,
        }));
      }
    }
    return Object.freeze(output);
  },
});

const TOTAL_DEXES_SELECTOR = "0x93656c17";
const GET_DEX_ADDRESS_SELECTOR = "0x12e366aa";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
function blockTag(number: string): string { return `0x${BigInt(number).toString(16)}`; }
function uintWord(value: bigint): string { if (value <= 0n || value >= 1n << 256n) throw new TypeError("fluid-dex index is outside uint256"); return value.toString(16).padStart(64, "0"); }
function decodeUintResult(value: unknown, path: string): bigint { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${path} must be one ABI uint256 word`); return BigInt(value); }
function decodeAddressResult(value: unknown, path: string): string { if (typeof value !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be one padded ABI address word`); const result = canonicalAddress(`0x${value.slice(-40)}`); if (result === ZERO_ADDRESS) throw new TypeError(`${path} returned the zero address`); return result; }
function sourceRef(input: FamilySourcePlanExecutionInputV1, value: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 { return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash }); }
function refKey(value: SourcePlanEvidenceRefV1): Hash { return hashDomain("aloha/source-plan-evidence-ref/v1", value); }
function exactPhysicalResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 { if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("fluid-dex factory physical result shape mismatch"); if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("fluid-dex factory physical result hash mismatch"); const raw = value.rawEvidenceLocator; if (raw === null || typeof raw !== "object" || Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array)) throw new TypeError("fluid-dex factory raw locator shape mismatch"); return value; }
function exactPhysicalResponse(value: FamilySourcePlanPhysicalResultV1, input: FamilySourcePlanExecutionInputV1, expectedData: string): CanonicalJson { const result = exactPhysicalResult(value); if (sha256Hex(result.rawEvidenceLocator.bytes) !== result.rawLocatorHash) throw new TypeError("fluid-dex factory raw observation hash mismatch"); const observation = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes); if (observation.familyDefinitionHash !== FLUID_DEX_AUTHORING_HASH || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan) || !sameCutoff(observation.cutoff, input.cutoff) || observation.requestSchemaHash !== FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH || observation.request.method !== "eth_call" || observation.request.target !== FLUID_DEX_FACTORY || observation.request.manager !== FLUID_DEX_FACTORY || observation.request.topic !== null || observation.request.lookback !== null || observation.request.chunk !== null || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([{ to: FLUID_DEX_FACTORY, data: expectedData }, blockTag(input.cutoff.number)]) || encodeCanonicalJson(observation.response) !== encodeCanonicalJson(result.response)) throw new TypeError("fluid-dex factory physical observation binding mismatch"); return result.response; }
async function factoryRead(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, data: string, signal: AbortSignal) { const result = exactPhysicalResult(await physical.request({ familyDefinitionHash: FLUID_DEX_AUTHORING_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_call", params: Object.freeze([{ to: FLUID_DEX_FACTORY, data }, blockTag(input.cutoff.number)]), target: FLUID_DEX_FACTORY, manager: FLUID_DEX_FACTORY, topic: null, lookback: null, chunk: null } }, signal)); return Object.freeze({ result, response: exactPhysicalResponse(result, input, data) }); }
function factoryObservation(input: FamilySourcePlanNominationInputV1, ref: SourcePlanEvidenceRefV1): { readonly data: string; readonly response: CanonicalJson } { const bytes = input.rawEvidence.read(ref.rawLocatorHash); if (sha256Hex(bytes) !== ref.rawLocatorHash) throw new TypeError("fluid-dex factory nomination raw observation hash mismatch"); const observation = decodeFamilySourcePlanPhysicalObservation(bytes, "fluid-dex.factory.nomination.observation"); if (observation.familyDefinitionHash !== FLUID_DEX_AUTHORING_HASH || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.execution.plan) || !sameCutoff(observation.cutoff, input.execution.cutoff) || observation.requestSchemaHash !== FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH || observation.request.method !== "eth_call" || observation.request.target !== FLUID_DEX_FACTORY || observation.request.manager !== FLUID_DEX_FACTORY || observation.request.topic !== null || observation.request.lookback !== null || observation.request.chunk !== null) throw new TypeError("fluid-dex factory nomination physical observation binding mismatch"); const params = observation.request.params; if (!Array.isArray(params) || params.length !== 2 || params[1] !== blockTag(input.execution.cutoff.number)) throw new TypeError("fluid-dex factory nomination request params mismatch"); const call = params[0]; if (call === null || typeof call !== "object" || Array.isArray(call) || Reflect.ownKeys(call).sort().join(",") !== "data,to" || call.to !== FLUID_DEX_FACTORY || typeof call.data !== "string") throw new TypeError("fluid-dex factory nomination call shape mismatch"); return Object.freeze({ data: call.data, response: observation.response }); }
function indexedEvidence(input: FamilySourcePlanNominationInputV1, count: bigint, addresses: readonly string[]): ReadonlyMap<bigint, SourcePlanEvidenceRefV1> { if (input.sourceEvidence.refs.length !== addresses.length + 1) throw new TypeError("fluid-dex factory evidence cardinality mismatch"); let countSeen = false; const byIndex = new Map<bigint, SourcePlanEvidenceRefV1>(); for (const ref of input.sourceEvidence.refs) { const observed = factoryObservation(input, ref); if (observed.data === TOTAL_DEXES_SELECTOR) { if (countSeen) throw new TypeError("fluid-dex duplicate count evidence"); countSeen = true; if (decodeUintResult(observed.response, "fluid-dex.totalDexes evidence") !== count) throw new TypeError("fluid-dex count evidence mismatch"); continue; } if (!observed.data.startsWith(GET_DEX_ADDRESS_SELECTOR) || observed.data.length !== GET_DEX_ADDRESS_SELECTOR.length + 64) throw new TypeError("fluid-dex unexpected factory evidence request"); const index = BigInt(`0x${observed.data.slice(GET_DEX_ADDRESS_SELECTOR.length)}`); if (index < 1n || index > count || byIndex.has(index)) throw new TypeError("fluid-dex duplicate or out-of-range evidence index"); if (decodeAddressResult(observed.response, `fluid-dex.getDexAddress[${index}] evidence`) !== addresses[Number(index - 1n)]) throw new TypeError("fluid-dex address evidence value mismatch"); byIndex.set(index, ref); } if (!countSeen) throw new TypeError("fluid-dex count evidence is missing"); for (let index = 1n; index <= count; index += 1n) if (!byIndex.has(index)) throw new TypeError("fluid-dex evidence index is missing"); return byIndex; }

export const FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...FLUID_DEX_FACTORY_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.cutoff.chainId !== "1" || input.plan.familyDefinitionHash !== FLUID_DEX_AUTHORING_HASH || input.plan.completeness !== "complete-snapshot" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) throw new TypeError("fluid-dex factory source plan binding mismatch");
    const countRead = await factoryRead(input, physical, TOTAL_DEXES_SELECTOR, signal); const count = decodeUintResult(countRead.response, "fluid-dex.totalDexes"); if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("fluid-dex count is too large");
    const observations = [countRead.result]; const dexes: string[] = []; for (let index = 1n; index <= count; index += 1n) { const read = await factoryRead(input, physical, `${GET_DEX_ADDRESS_SELECTOR}${uintWord(index)}`, signal); observations.push(read.result); dexes.push(decodeAddressResult(read.response, `fluid-dex.getDexAddress[${index}]`)); }
    if (new Set(dexes).size !== dexes.length) throw new TypeError("fluid-dex factory returned duplicate dexes");
    const refs = observations.map(value => sourceRef(input, value)).sort((left, right) => refKey(left).localeCompare(refKey(right))); const rawEvidenceLocators = observations.map(value => value.rawEvidenceLocator).sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash)); const rawLocatorHashes = rawEvidenceLocators.map(value => value.rawLocatorHash); const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes }); const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs: Object.freeze(refs), rawLocatorHashes: Object.freeze(rawLocatorHashes), evidenceRoot });
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "fluid-dex-factory-complete-snapshot", version: 1, factory: FLUID_DEX_FACTORY, dexCount: count.toString(), dexes: Object.freeze(dexes) }); const resultPartitionRoot = hashDomain("aloha/fluid-dex/factory-source-partition/v1", opaqueResult); const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from: input.cutoff.number, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: Object.freeze(refs), rawLocatorHashes: Object.freeze(rawLocatorHashes), sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators: Object.freeze(rawEvidenceLocators) });
  },
});

export const FLUID_DEX_FACTORY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({ kind: "aloha.family-source-plan-nomination-program", version: 1, schemaHash: FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH, async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal) { if (signal.aborted) throw signal.reason; assertNominationBinding(input); if (input.execution.plan.completeness !== "complete-snapshot" || input.execution.outcome !== "complete" || input.execution.from !== input.recent.cutoff.number || input.execution.through !== input.recent.cutoff.number) throw new TypeError("fluid-dex factory execution is not a complete cutoff snapshot"); const opaque = input.execution.opaqueResult as { readonly kind?: unknown; readonly version?: unknown; readonly factory?: unknown; readonly dexCount?: unknown; readonly dexes?: unknown }; if (opaque.kind !== "fluid-dex-factory-complete-snapshot" || opaque.version !== 1 || opaque.factory !== FLUID_DEX_FACTORY || typeof opaque.dexCount !== "string" || !/^(0|[1-9][0-9]*)$/.test(opaque.dexCount) || !Array.isArray(opaque.dexes)) throw new TypeError("fluid-dex factory opaque result is malformed"); const count = BigInt(opaque.dexCount); if (count !== BigInt(opaque.dexes.length)) throw new TypeError("fluid-dex factory opaque count mismatch"); const dexes = Object.freeze(opaque.dexes.map(value => canonicalAddress(String(value)))); if (new Set(dexes).size !== dexes.length) throw new TypeError("fluid-dex factory opaque result has duplicate dexes"); const evidence = indexedEvidence(input, count, dexes); return Object.freeze(dexes.map((target, offset) => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: FLUID_DEX_FAMILY_ID, familyDefinitionHash: FLUID_DEX_AUTHORING_HASH, instanceNominationKey: target, evidence: evidence.get(BigInt(offset + 1))! }))); } });
