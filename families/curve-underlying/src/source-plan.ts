import { encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { defineFamilySourcePlan, sealNominationOnlySourceExecution, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type CandidateNominationV1, type SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import { decodeFamilySourcePlanPhysicalObservation, type FamilySourcePlanExecutionInputV1, type FamilySourcePlanNominationInputV1, type FamilySourcePlanNominationProgramV1, type FamilySourcePlanPhysicalPortV1, type FamilySourcePlanPhysicalResultV1, type FamilySourcePlanRuntimeV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { decodeEvmLogObservationBytes } from "../../../packages/observation/src/index.ts";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_FAMILY_ID, CURVE_UNDERLYING_I128_SWAP_TOPIC, CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_ID, CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_SCHEMA_HASH, CURVE_UNDERLYING_SOURCE_PLAN_ID, CURVE_UNDERLYING_SOURCE_PLAN_SCHEMA_HASH, CURVE_UNDERLYING_UINT_SWAP_TOPIC } from "./manifest.ts";
import { CURVE_UNDERLYING_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { decodeCurveUnderlyingCandidate, sourceCandidateSnapshotHash } from "./discovery.ts";
import { nominateCurveUnderlying } from "./nomination.ts";
import { canonicalAddress } from "./types.ts";

const POOL_COUNT_SELECTOR = "0x956aae3a";
const POOL_LIST_SELECTOR = "0x3a1d5d8e";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const CURVE_UNDERLYING_SOURCE_PLAN = defineFamilySourcePlan({ sourcePlanId: CURVE_UNDERLYING_SOURCE_PLAN_ID, completeness: "nomination-only", historyStartBlock: null, schemaHash: CURVE_UNDERLYING_SOURCE_PLAN_SCHEMA_HASH });
export const CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN = defineFamilySourcePlan({ sourcePlanId: CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_ID, completeness: "complete-snapshot", historyStartBlock: null, schemaHash: CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_SCHEMA_HASH });

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }
function blockTag(number: string): string { return `0x${BigInt(number).toString(16)}`; }
function uintWord(value: bigint): string { if (value < 0n || value >= 1n << 256n) throw new TypeError("curve registry index is outside uint256"); return value.toString(16).padStart(64, "0"); }
function decodeUintResult(value: unknown, path: string): bigint { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${path} must be one ABI uint256 word`); return BigInt(value); }
function decodeAddressResult(value: unknown, path: string): string { if (typeof value !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) throw new TypeError(`${path} must be one padded ABI address word`); const address = canonicalAddress(`0x${value.slice(-40)}`); if (address === ZERO_ADDRESS) throw new TypeError(`${path} returned the zero address`); return address; }
function refKey(value: SourcePlanEvidenceRefV1): Hash { return hashDomain("aloha/source-plan-evidence-ref/v1", value); }

function sourceRef(input: FamilySourcePlanExecutionInputV1, value: Awaited<ReturnType<FamilySourcePlanPhysicalPortV1["request"]>>): SourcePlanEvidenceRefV1 {
  return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash });
}

function exactPhysicalResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("curve registry physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("curve registry physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (raw === null || typeof raw !== "object" || Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array)) throw new TypeError("curve registry raw locator shape mismatch");
  return value;
}

function exactPhysicalResponse(value: Awaited<ReturnType<FamilySourcePlanPhysicalPortV1["request"]>>, input: FamilySourcePlanExecutionInputV1, expectedData: string): CanonicalJson {
  const result = exactPhysicalResult(value);
  if (sha256Hex(result.rawEvidenceLocator.bytes) !== result.rawLocatorHash) throw new TypeError("curve registry raw observation hash mismatch");
  const observation = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes);
  if (observation.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_AUTHORING_HASH || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan) || !sameCutoff(observation.cutoff, input.cutoff) || observation.requestSchemaHash !== CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_SCHEMA_HASH || observation.request.method !== "eth_call" || observation.request.target !== CURVE_METAREGISTRY || observation.request.manager !== CURVE_METAREGISTRY || observation.request.topic !== null || observation.request.lookback !== null || observation.request.chunk !== null || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([{ to: CURVE_METAREGISTRY, data: expectedData }, blockTag(input.cutoff.number)]) || encodeCanonicalJson(observation.response) !== encodeCanonicalJson(result.response)) throw new TypeError("curve registry physical observation binding mismatch");
  return result.response;
}

async function registryRead(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, data: string, signal: AbortSignal) {
  const result = await physical.request({ familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_call", params: Object.freeze([{ to: CURVE_METAREGISTRY, data }, blockTag(input.cutoff.number)]), target: CURVE_METAREGISTRY, manager: CURVE_METAREGISTRY, topic: null, lookback: null, chunk: null } }, signal);
  return Object.freeze({ result, response: exactPhysicalResponse(result, input, data) });
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  if (input.execution.plan.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_AUTHORING_HASH || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan) || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot || encodeCanonicalJson(input.execution.sourceEvidenceRefs) !== encodeCanonicalJson(input.sourceEvidence.refs) || encodeCanonicalJson(input.execution.rawLocatorHashes) !== encodeCanonicalJson(input.sourceEvidence.rawLocatorHashes) || !sameCutoff(input.execution.cutoff, input.recent.cutoff) || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)) throw new TypeError("curve-underlying nomination binding mismatch");
}

function registryObservation(
  input: FamilySourcePlanNominationInputV1,
  ref: SourcePlanEvidenceRefV1,
): { readonly data: string; readonly response: CanonicalJson } {
  const bytes = input.rawEvidence.read(ref.rawLocatorHash);
  if (sha256Hex(bytes) !== ref.rawLocatorHash) throw new TypeError("curve registry nomination raw observation hash mismatch");
  const observation = decodeFamilySourcePlanPhysicalObservation(bytes, "curve.registry.nomination.observation");
  if (
    observation.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.execution.plan)
    || !sameCutoff(observation.cutoff, input.execution.cutoff)
    || observation.requestSchemaHash !== CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_SCHEMA_HASH
    || observation.request.method !== "eth_call"
    || observation.request.target !== CURVE_METAREGISTRY
    || observation.request.manager !== CURVE_METAREGISTRY
    || observation.request.topic !== null
    || observation.request.lookback !== null
    || observation.request.chunk !== null
  ) throw new TypeError("curve registry nomination physical observation binding mismatch");
  const params = observation.request.params;
  if (!Array.isArray(params) || params.length !== 2 || params[1] !== blockTag(input.execution.cutoff.number)) throw new TypeError("curve registry nomination request params mismatch");
  const call = params[0];
  if (call === null || typeof call !== "object" || Array.isArray(call) || Reflect.ownKeys(call).sort().join(",") !== "data,to" || call.to !== CURVE_METAREGISTRY || typeof call.data !== "string") throw new TypeError("curve registry nomination call shape mismatch");
  return Object.freeze({ data: call.data, response: observation.response });
}

function registryPoolEvidence(
  input: FamilySourcePlanNominationInputV1,
  poolCount: bigint,
  pools: readonly string[],
): ReadonlyMap<bigint, SourcePlanEvidenceRefV1> {
  if (input.sourceEvidence.refs.length !== pools.length + 1) throw new TypeError("curve registry evidence cardinality mismatch");
  let countSeen = false;
  const byIndex = new Map<bigint, SourcePlanEvidenceRefV1>();
  for (const ref of input.sourceEvidence.refs) {
    const observation = registryObservation(input, ref);
    if (observation.data === POOL_COUNT_SELECTOR) {
      if (countSeen) throw new TypeError("curve registry duplicate pool count evidence");
      countSeen = true;
      if (decodeUintResult(observation.response, "curve.metaregistry.pool_count evidence") !== poolCount) throw new TypeError("curve registry pool count evidence mismatch");
      continue;
    }
    if (!observation.data.startsWith(POOL_LIST_SELECTOR) || observation.data.length !== POOL_LIST_SELECTOR.length + 64) throw new TypeError("curve registry unexpected pool evidence request");
    const indexWord = observation.data.slice(POOL_LIST_SELECTOR.length);
    if (!/^[0-9a-fA-F]{64}$/.test(indexWord)) throw new TypeError("curve registry pool evidence index is malformed");
    const index = BigInt(`0x${indexWord}`);
    if (index >= poolCount) throw new TypeError("curve registry extra pool evidence index");
    if (byIndex.has(index)) throw new TypeError("curve registry duplicate pool evidence index");
    const pool = decodeAddressResult(observation.response, `curve.metaregistry.pool_list[${index}] evidence`);
    if (pool !== pools[Number(index)]) throw new TypeError("curve registry pool evidence value mismatch");
    byIndex.set(index, ref);
  }
  if (!countSeen) throw new TypeError("curve registry pool count evidence is missing");
  for (let index = 0n; index < poolCount; index += 1n) {
    if (!byIndex.has(index)) throw new TypeError("curve registry pool evidence index is missing");
  }
  return byIndex;
}

function recentNominations(input: FamilySourcePlanNominationInputV1): readonly CandidateNominationV1[] {
  const output: CandidateNominationV1[] = [];
  for (const evidence of input.recent.evidence) {
    const pattern = evidence.topic === CURVE_UNDERLYING_I128_SWAP_TOPIC ? "curve-underlying-i128-log" : evidence.topic === CURVE_UNDERLYING_UINT_SWAP_TOPIC ? "curve-underlying-uint-log" : null;
    if (pattern === null) continue;
    const raw = decodeEvmLogObservationBytes(input.rawEvidence.read(evidence.rawLocatorHash), "curve-underlying.rawEvidence");
    if (raw.address !== evidence.address || raw.topics[0] !== evidence.topic || raw.blockNumber !== evidence.blockNumber || raw.blockHash !== evidence.blockHash || raw.transactionHash !== evidence.txHash || raw.logIndex !== evidence.logIndex) throw new TypeError("curve-underlying raw evidence/recent evidence mismatch");
    const seed = decodeCurveUnderlyingCandidate({ kind: "log", target: evidence.address, cutoff: input.recent.cutoff, blockNumber: evidence.blockNumber, blockHash: evidence.blockHash, txHash: evidence.txHash, logIndex: evidence.logIndex, rawLocatorHash: evidence.rawLocatorHash, topic0: evidence.topic }, pattern);
    const nomination = seed === null ? null : nominateCurveUnderlying(seed);
    if (nomination?.status === "nominated") output.push(Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: CURVE_UNDERLYING_FAMILY_ID, familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence }));
  }
  return Object.freeze(output);
}

export const CURVE_UNDERLYING_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...CURVE_UNDERLYING_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) { if (signal.aborted) throw signal.reason; if (input.plan.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) throw new TypeError("curve-underlying recent source plan binding mismatch"); return sealNominationOnlySourceExecution(input); },
});

export const CURVE_UNDERLYING_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: CURVE_UNDERLYING_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal) { if (signal.aborted) throw signal.reason; assertNominationBinding(input); if (input.execution.sourceEvidenceRefs.length !== 0 || input.execution.rawLocatorHashes.length !== 0) throw new TypeError("curve recent plan carried source evidence"); return recentNominations(input); },
});

export const CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.cutoff.chainId !== "1" || input.plan.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_AUTHORING_HASH || input.plan.completeness !== "complete-snapshot" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) throw new TypeError("curve registry source plan binding mismatch");
    const countRead = await registryRead(input, physical, POOL_COUNT_SELECTOR, signal);
    const count = decodeUintResult(countRead.response, "curve.metaregistry.pool_count");
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("curve registry pool count is too large");
    const observations = [countRead.result];
    const pools: string[] = [];
    for (let index = 0n; index < count; index += 1n) { const read = await registryRead(input, physical, `${POOL_LIST_SELECTOR}${uintWord(index)}`, signal); observations.push(read.result); pools.push(decodeAddressResult(read.response, `curve.metaregistry.pool_list[${index}]`)); }
    if (new Set(pools).size !== pools.length) throw new TypeError("curve registry returned duplicate pools");
    const refs = observations.map(value => sourceRef(input, value)).sort((left, right) => refKey(left).localeCompare(refKey(right)));
    const rawEvidenceLocators = observations.map(value => value.rawEvidenceLocator).sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash));
    const rawLocatorHashes = rawEvidenceLocators.map(value => value.rawLocatorHash);
    const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes });
    const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs: Object.freeze(refs), rawLocatorHashes: Object.freeze(rawLocatorHashes), evidenceRoot });
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "curve-metaregistry-complete-snapshot", version: 1, manager: CURVE_METAREGISTRY, poolCount: count.toString(), pools: Object.freeze(pools) });
    const resultPartitionRoot = hashDomain("aloha/curve-underlying/registry-source-partition/v1", opaqueResult);
    const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from: input.cutoff.number, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: Object.freeze(refs), rawLocatorHashes: Object.freeze(rawLocatorHashes), sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators: Object.freeze(rawEvidenceLocators) });
  },
});

export const CURVE_UNDERLYING_REGISTRY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    if (input.execution.plan.completeness !== "complete-snapshot" || input.execution.outcome !== "complete" || input.execution.from !== input.recent.cutoff.number || input.execution.through !== input.recent.cutoff.number) throw new TypeError("curve registry execution is not a complete cutoff snapshot");
    const opaque = input.execution.opaqueResult as { readonly kind?: unknown; readonly version?: unknown; readonly manager?: unknown; readonly poolCount?: unknown; readonly pools?: unknown };
    if (opaque.kind !== "curve-metaregistry-complete-snapshot" || opaque.version !== 1 || opaque.manager !== CURVE_METAREGISTRY || typeof opaque.poolCount !== "string" || !/^(0|[1-9][0-9]*)$/.test(opaque.poolCount) || !Array.isArray(opaque.pools)) throw new TypeError("curve registry opaque result is malformed");
    const poolCount = BigInt(opaque.poolCount);
    if (poolCount !== BigInt(opaque.pools.length)) throw new TypeError("curve registry opaque result is malformed");
    const pools = Object.freeze(opaque.pools.map(value => canonicalAddress(String(value))));
    if (new Set(pools).size !== pools.length) throw new TypeError("curve registry opaque result has duplicate pools");
    const poolEvidence = registryPoolEvidence(input, poolCount, pools);
    return Object.freeze(pools.map((target, index) => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: CURVE_UNDERLYING_FAMILY_ID, familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH, instanceNominationKey: target, evidence: poolEvidence.get(BigInt(index))! })));
  },
});
