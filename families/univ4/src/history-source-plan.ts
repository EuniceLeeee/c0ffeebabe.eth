import { encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type CandidateNominationV1, type CanonicalCutoffV1, type SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import { decodeFamilySourcePlanPhysicalObservation, type FamilySourcePlanExecutionInputV1, type FamilySourcePlanNominationInputV1, type FamilySourcePlanNominationProgramV1, type FamilySourcePlanPhysicalPortV1, type FamilySourcePlanPhysicalResultV1, type FamilySourcePlanRuntimeV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { familyRollingObservationRangeV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { UNIV4_POOL_MANAGER, decodeUniv4InitializeLog } from "./abi.ts";
import { UNIV4_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { UNIV4_CONTRACT_EVIDENCE_TOPIC, UNIV4_FAMILY_ID, UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH } from "./manifest.ts";
import { UNIV4_HISTORY_SOURCE_PLAN } from "./source-plan.ts";

const CHUNK_BLOCKS = 10_000n;
const MANAGER = UNIV4_POOL_MANAGER.toLowerCase();
type Entry = { readonly poolId: Hash; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string };

const decimal = (value: bigint) => value.toString(10);
const blockTag = (value: string) => `0x${BigInt(value).toString(16)}`;
function quantity(value: string, path: string): bigint { if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new TypeError(`${path} must be a canonical JSON-RPC quantity`); return BigInt(value); }
function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }

function exactResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("univ4 history physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("univ4 history physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array) || sha256Hex(raw.bytes) !== raw.rawLocatorHash) throw new TypeError("univ4 history raw locator mismatch");
  return value;
}
function evidenceRef(input: FamilySourcePlanExecutionInputV1, value: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 { return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash }); }
const refKey = (value: SourcePlanEvidenceRefV1) => hashDomain("aloha/source-plan-evidence-ref/v1", value);
export function univ4HistoryCandidateSnapshotHash(poolId: Hash, cutoff: CanonicalCutoffV1, evidence: SourcePlanEvidenceRefV1): Hash { return hashDomain("aloha/univ4/history-candidate-snapshot/v1", { familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH, poolId, cutoff, evidence }); }

function decodeEntries(value: CanonicalJson, from: bigint, through: bigint): readonly Entry[] {
  if (!Array.isArray(value)) throw new TypeError("univ4 history response must be a JSON-RPC log array");
  let previous: { block: bigint; index: bigint } | null = null;
  const entries = value.map((item, index): Entry => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`univ4 history log[${index}] must be an object`);
    const log = item as Record<string, CanonicalJson>;
    if (Object.keys(log).sort().join(",") !== "address,blockHash,blockNumber,data,logIndex,removed,topics,transactionHash,transactionIndex" || log.address !== MANAGER || typeof log.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.blockHash) || typeof log.transactionHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.transactionHash) || typeof log.blockNumber !== "string" || typeof log.logIndex !== "string" || typeof log.transactionIndex !== "string" || log.removed !== false || typeof log.data !== "string" || !Array.isArray(log.topics) || log.topics.some(topic => typeof topic !== "string" || !/^0x[0-9a-f]{64}$/.test(topic))) throw new TypeError(`univ4 history log[${index}] is malformed`);
    const block = quantity(log.blockNumber, `univ4 history log[${index}].blockNumber`); const logIndex = quantity(log.logIndex, `univ4 history log[${index}].logIndex`); quantity(log.transactionIndex, `univ4 history log[${index}].transactionIndex`);
    if (block < from || block > through) throw new TypeError("univ4 history log is outside the requested range");
    if (previous && (block < previous.block || block === previous.block && logIndex <= previous.index)) throw new TypeError("univ4 history logs are not in strict chain order"); previous = { block, index: logIndex };
    const { poolId } = decodeUniv4InitializeLog({ address: log.address, topics: log.topics as readonly Hash[], data: log.data }, UNIV4_CONTRACT_EVIDENCE_TOPIC);
    return Object.freeze({ poolId, blockNumber: decimal(block), blockHash: log.blockHash as Hash, txHash: log.transactionHash as Hash, logIndex: decimal(logIndex) });
  });
  if (new Set(entries.map(entry => entry.poolId)).size !== entries.length) throw new TypeError("univ4 history returned duplicate poolIds");
  return Object.freeze(entries);
}

function observe(value: FamilySourcePlanPhysicalResultV1, input: FamilySourcePlanExecutionInputV1, from: string, through: string) {
  const result = exactResult(value); const observation = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes);
  const filter = { address: MANAGER, fromBlock: blockTag(from), toBlock: blockTag(through), topics: [UNIV4_CONTRACT_EVIDENCE_TOPIC] };
  if (observation.familyDefinitionHash !== UNIV4_FAMILY_DEFINITION_HASH || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan) || !sameCutoff(observation.cutoff, input.cutoff) || observation.requestSchemaHash !== UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH || observation.request.method !== "eth_getLogs" || observation.request.target !== MANAGER || observation.request.manager !== MANAGER || observation.request.topic !== UNIV4_CONTRACT_EVIDENCE_TOPIC || encodeCanonicalJson(observation.request.lookback) !== encodeCanonicalJson({ from, through }) || encodeCanonicalJson(observation.request.chunk) !== encodeCanonicalJson({ maxBlocks: CHUNK_BLOCKS.toString() }) || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([filter]) || encodeCanonicalJson(observation.response) !== encodeCanonicalJson(result.response)) throw new TypeError("univ4 history physical observation binding mismatch");
  return Object.freeze({ result, entries: decodeEntries(result.response, BigInt(from), BigInt(through)) });
}

export const UNIV4_HISTORY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...UNIV4_HISTORY_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== UNIV4_FAMILY_DEFINITION_HASH || input.plan.completeness !== "rolling-observation" || input.plan.historyStartBlock !== null) throw new TypeError("univ4 history source plan binding mismatch");
    if (input.previousAppliedThrough !== null || (input.predecessor ?? null) !== null) throw new TypeError("univ4 rolling observation cannot bind a predecessor");
    const { from } = familyRollingObservationRangeV1(input.cutoff.number);
    const chunks: { from: string; through: string; result: FamilySourcePlanPhysicalResultV1; entries: readonly Entry[] }[] = [];
    for (let start = BigInt(from); start <= BigInt(input.cutoff.number); start += CHUNK_BLOCKS) { const end = start + CHUNK_BLOCKS - 1n > BigInt(input.cutoff.number) ? BigInt(input.cutoff.number) : start + CHUNK_BLOCKS - 1n; const range = { from: decimal(start), through: decimal(end) }; const filter = Object.freeze({ address: MANAGER, fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([UNIV4_CONTRACT_EVIDENCE_TOPIC]) }); const raw = await physical.request({ familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: Object.freeze([filter]), target: MANAGER, manager: MANAGER, topic: UNIV4_CONTRACT_EVIDENCE_TOPIC, lookback: Object.freeze(range), chunk: Object.freeze({ maxBlocks: CHUNK_BLOCKS.toString() }) } }, signal); chunks.push({ ...range, ...observe(raw, input, range.from, range.through) }); }
    const entries = chunks.flatMap(chunk => chunk.entries); if (new Set(entries.map(entry => entry.poolId)).size !== entries.length) throw new TypeError("univ4 history returned duplicate poolIds across chunks");
    const refs = Object.freeze(chunks.map(chunk => evidenceRef(input, chunk.result)).sort((a, b) => refKey(a).localeCompare(refKey(b)))); const rawEvidenceLocators = Object.freeze(chunks.map(chunk => chunk.result.rawEvidenceLocator).sort((a, b) => a.rawLocatorHash.localeCompare(b.rawLocatorHash))); const rawLocatorHashes = Object.freeze(rawEvidenceLocators.map(locator => locator.rawLocatorHash)); const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes }); const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes, evidenceRoot });
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "univ4-initialize-rolling-observation", version: 1, manager: MANAGER, topic: UNIV4_CONTRACT_EVIDENCE_TOPIC, from, through: input.cutoff.number, chunkBlocks: CHUNK_BLOCKS.toString(), entries: Object.freeze(entries) }); const resultPartitionRoot = hashDomain("aloha/univ4/history-source-partition/v1", opaqueResult); const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators });
  },
});

export const UNIV4_HISTORY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    if (input.execution.plan.familyDefinitionHash !== UNIV4_FAMILY_DEFINITION_HASH || input.execution.plan.completeness !== "rolling-observation" || input.execution.outcome !== "complete" || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan) || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot || input.sourceEvidence.refs.length === 0 || !sameCutoff(input.execution.cutoff, input.recent.cutoff)) throw new TypeError("univ4 history nomination binding mismatch");
    const chunks = input.sourceEvidence.refs.map(evidence => { const observation = decodeFamilySourcePlanPhysicalObservation(input.rawEvidence.read(evidence.rawLocatorHash)); const range = observation.request.lookback as { from?: unknown; through?: unknown }; if (typeof range.from !== "string" || typeof range.through !== "string") throw new TypeError("univ4 history chunk range malformed"); return { evidence, from: range.from, through: range.through, entries: decodeEntries(observation.response, BigInt(range.from), BigInt(range.through)) }; }).sort((a, b) => BigInt(a.from) < BigInt(b.from) ? -1 : 1);
    let expectedFrom = BigInt(input.execution.from); for (const chunk of chunks) { if (BigInt(chunk.from) !== expectedFrom || BigInt(chunk.through) < expectedFrom || BigInt(chunk.through) - expectedFrom + 1n > CHUNK_BLOCKS) throw new TypeError("univ4 history chunk coverage gap"); expectedFrom = BigInt(chunk.through) + 1n; } if (expectedFrom !== BigInt(input.execution.through) + 1n) throw new TypeError("univ4 history chunk cutoff mismatch");
    const entries = chunks.flatMap(chunk => chunk.entries); const expected = { kind: "univ4-initialize-rolling-observation", version: 1, manager: MANAGER, topic: UNIV4_CONTRACT_EVIDENCE_TOPIC, from: input.execution.from, through: input.execution.through, chunkBlocks: CHUNK_BLOCKS.toString(), entries }; if (encodeCanonicalJson(expected) !== encodeCanonicalJson(input.execution.opaqueResult)) throw new TypeError("univ4 history result/raw mismatch");
    return Object.freeze(chunks.flatMap(chunk => chunk.entries.map(entry => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: UNIV4_FAMILY_ID, familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH, instanceNominationKey: entry.poolId, evidence: chunk.evidence }))));
  },
});
