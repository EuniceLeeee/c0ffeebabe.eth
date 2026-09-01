import { encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type CandidateNominationV1, type CanonicalCutoffV1, type SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import { decodeFamilySourcePlanPhysicalObservation, type FamilyRawEvidenceReadPortV1, type FamilySourcePlanExecutionInputV1, type FamilySourcePlanNominationInputV1, type FamilySourcePlanNominationProgramV1, type FamilySourcePlanPhysicalPortV1, type FamilySourcePlanPhysicalResultV1, type FamilySourcePlanRuntimeV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { familyRollingObservationRangeV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { UNIV2_STANDARD_FAMILY_DEFINITION_HASH, UNIV2_STANDARD_FAMILY_ID } from "./family-definition.ts";
import { UNIV2_PAIR_CREATED_TOPIC0, UNIV2_STANDARD_HISTORY_SOURCE_PLAN_DEFINITION, UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH } from "./source-plan.ts";
import { canonicalAddress } from "./kernel/codec.ts";

const CHUNK_BLOCKS = 10_000n;
type Entry = { readonly factory: string; readonly pair: string; readonly blockNumber: string; readonly blockHash: Hash; readonly txHash: Hash; readonly logIndex: string };
const blockTag = (value: string) => `0x${BigInt(value).toString(16)}`;
const decimal = (value: bigint) => value.toString(10);
function quantity(value: string, path: string): bigint { if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new TypeError(`${path} must be a canonical JSON-RPC quantity`); return BigInt(value); }
function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean { return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot; }
export function sourceNominationSnapshotHash(pool: string, cutoff: CanonicalCutoffV1, evidence: SourcePlanEvidenceRefV1): Hash { return hashDomain("aloha/univ2-standard/source-candidate-snapshot/v1", { familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH, pool: canonicalAddress(pool), cutoff, evidence }); }

function exactResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("univ2 history physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("univ2 history physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array) || sha256Hex(raw.bytes) !== raw.rawLocatorHash) throw new TypeError("univ2 history raw locator mismatch");
  return value;
}
function ref(input: FamilySourcePlanExecutionInputV1, value: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 { return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash }); }
const refKey = (value: SourcePlanEvidenceRefV1) => hashDomain("aloha/source-plan-evidence-ref/v1", value);

function indexedAddress(value: unknown, path: string): string { if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/.test(value)) throw new TypeError(`${path} must be a padded indexed address`); return canonicalAddress(`0x${value.slice(-40)}`); }
function decodeEntries(value: CanonicalJson, from: bigint, through: bigint): readonly Entry[] {
  if (!Array.isArray(value)) throw new TypeError("univ2 history response must be a JSON-RPC log array");
  let previous: { block: bigint; index: bigint } | null = null;
  const entries = value.map((item, index): Entry => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`univ2 history log[${index}] must be an object`);
    const log = item as Record<string, CanonicalJson>;
    if (Object.keys(log).sort().join(",") !== "address,blockHash,blockNumber,data,logIndex,removed,topics,transactionHash,transactionIndex" || typeof log.address !== "string" || !/^0x[0-9a-f]{40}$/.test(log.address) || typeof log.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.blockHash) || typeof log.transactionHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.transactionHash) || typeof log.blockNumber !== "string" || typeof log.logIndex !== "string" || typeof log.transactionIndex !== "string" || log.removed !== false || typeof log.data !== "string" || !Array.isArray(log.topics) || log.topics.length !== 3 || log.topics[0] !== UNIV2_PAIR_CREATED_TOPIC0) throw new TypeError(`univ2 history log[${index}] is malformed`);
    const token0 = indexedAddress(log.topics[1], `univ2.PairCreated[${index}].token0`); const token1 = indexedAddress(log.topics[2], `univ2.PairCreated[${index}].token1`);
    if (token0 >= token1 || !/^0x0{24}[0-9a-f]{40}[0-9a-f]{64}$/.test(log.data)) throw new TypeError("univ2 PairCreated ABI mismatch");
    const pair = canonicalAddress(`0x${log.data.slice(26, 66)}`); if (pair === "0x0000000000000000000000000000000000000000") throw new TypeError("univ2 PairCreated zero pair");
    const block = quantity(log.blockNumber, "univ2.blockNumber"); const logIndex = quantity(log.logIndex, "univ2.logIndex"); quantity(log.transactionIndex, "univ2.transactionIndex");
    if (block < from || block > through) throw new TypeError("univ2 history log is outside the requested range");
    if (previous && (block < previous.block || block === previous.block && logIndex <= previous.index)) throw new TypeError("univ2 history logs are not in strict chain order"); previous = { block, index: logIndex };
    return Object.freeze({ factory: log.address, pair, blockNumber: decimal(block), blockHash: log.blockHash as Hash, txHash: log.transactionHash as Hash, logIndex: decimal(logIndex) });
  });
  if (new Set(entries.map(value => value.pair)).size !== entries.length) throw new TypeError("univ2 history returned duplicate pairs");
  return Object.freeze(entries);
}

function observation(value: FamilySourcePlanPhysicalResultV1, input: FamilySourcePlanExecutionInputV1, from: string, through: string) {
  const result = exactResult(value); const observed = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes);
  const filter = { fromBlock: blockTag(from), toBlock: blockTag(through), topics: [UNIV2_PAIR_CREATED_TOPIC0] };
  if (observed.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH || encodeCanonicalJson(observed.plan) !== encodeCanonicalJson(input.plan) || !sameCutoff(observed.cutoff, input.cutoff) || observed.requestSchemaHash !== UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH || observed.request.method !== "eth_getLogs" || observed.request.target !== null || observed.request.manager !== null || observed.request.topic !== UNIV2_PAIR_CREATED_TOPIC0 || encodeCanonicalJson(observed.request.lookback) !== encodeCanonicalJson({ from, through }) || encodeCanonicalJson(observed.request.chunk) !== encodeCanonicalJson({ maxBlocks: CHUNK_BLOCKS.toString() }) || encodeCanonicalJson(observed.request.params) !== encodeCanonicalJson([filter]) || encodeCanonicalJson(observed.response) !== encodeCanonicalJson(result.response)) throw new TypeError("univ2 history physical observation binding mismatch");
  return Object.freeze({ result, entries: decodeEntries(result.response, BigInt(from), BigInt(through)) });
}

type HistoryChunk = { readonly evidence: SourcePlanEvidenceRefV1; readonly from: string; readonly through: string; readonly entries: readonly Entry[] };

function decodeHistory(
  execution: FamilySourcePlanNominationInputV1["execution"],
  sourceEvidence: FamilySourcePlanNominationInputV1["sourceEvidence"],
  rawEvidence: FamilyRawEvidenceReadPortV1,
): readonly HistoryChunk[] {
  if (
    encodeCanonicalJson(execution.plan) !== encodeCanonicalJson(sourceEvidence.plan)
    || execution.sourceEvidenceRoot !== sourceEvidence.evidenceRoot
    || encodeCanonicalJson(execution.sourceEvidenceRefs) !== encodeCanonicalJson(sourceEvidence.refs)
    || encodeCanonicalJson(execution.rawLocatorHashes) !== encodeCanonicalJson(sourceEvidence.rawLocatorHashes)
  ) throw new TypeError("univ2 history execution/evidence mismatch");
  const chunks = sourceEvidence.refs.map(evidence => {
    const observed = decodeFamilySourcePlanPhysicalObservation(rawEvidence.read(evidence.rawLocatorHash));
    const range = observed.request.lookback as { from?: unknown; through?: unknown };
    if (
      typeof range.from !== "string"
      || typeof range.through !== "string"
      || encodeCanonicalJson(observed.plan) !== encodeCanonicalJson(execution.plan)
      || observed.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH
      || observed.requestSchemaHash !== UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH
    ) throw new TypeError("univ2 history predecessor chunk binding mismatch");
    return Object.freeze({ evidence, from: range.from, through: range.through, entries: decodeEntries(observed.response, BigInt(range.from), BigInt(range.through)) });
  }).sort((left, right) => BigInt(left.from) < BigInt(right.from) ? -1 : 1);
  let expectedFrom = 0n;
  for (const chunk of chunks) {
    if (BigInt(chunk.from) !== expectedFrom || BigInt(chunk.through) < expectedFrom || BigInt(chunk.through) - expectedFrom + 1n > CHUNK_BLOCKS) {
      throw new TypeError("univ2 history chunk coverage gap");
    }
    expectedFrom = BigInt(chunk.through) + 1n;
  }
  if (expectedFrom !== BigInt(execution.through) + 1n) throw new TypeError("univ2 history chunk cutoff mismatch");
  const entries = chunks.flatMap(value => value.entries);
  if (new Set(entries.map(value => value.pair)).size !== entries.length) throw new TypeError("univ2 history returned duplicate pairs across chunks");
  const expected = { kind: "univ2-pair-created-rolling-observation", version: 1, topic: UNIV2_PAIR_CREATED_TOPIC0, from: execution.from, through: execution.through, chunkBlocks: CHUNK_BLOCKS.toString(), entries };
  if (encodeCanonicalJson(expected) !== encodeCanonicalJson(execution.opaqueResult)) throw new TypeError("univ2 history result/raw mismatch");
  return Object.freeze(chunks);
}

export const UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...UNIV2_STANDARD_HISTORY_SOURCE_PLAN_DEFINITION,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH || input.plan.completeness !== "rolling-observation" || input.plan.historyStartBlock !== null) throw new TypeError("univ2 history source plan binding mismatch");
    if (input.previousAppliedThrough !== null || (input.predecessor ?? null) !== null) throw new TypeError("univ2 rolling observation cannot bind a predecessor");
    const { from } = familyRollingObservationRangeV1(input.cutoff.number);
    const chunks: { from: string; through: string; result: FamilySourcePlanPhysicalResultV1; entries: readonly Entry[] }[] = [];
    for (let start = BigInt(from); start <= BigInt(input.cutoff.number); start += CHUNK_BLOCKS) { const end = start + CHUNK_BLOCKS - 1n > BigInt(input.cutoff.number) ? BigInt(input.cutoff.number) : start + CHUNK_BLOCKS - 1n; const range = { from: decimal(start), through: decimal(end) }; const filter = Object.freeze({ fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([UNIV2_PAIR_CREATED_TOPIC0]) }); const raw = await physical.request({ familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: Object.freeze([filter]), target: null, manager: null, topic: UNIV2_PAIR_CREATED_TOPIC0, lookback: Object.freeze(range), chunk: Object.freeze({ maxBlocks: CHUNK_BLOCKS.toString() }) } }, signal); chunks.push({ ...range, ...observation(raw, input, range.from, range.through) }); }
    const entries = chunks.flatMap(value => value.entries); if (new Set(entries.map(value => value.pair)).size !== entries.length) throw new TypeError("univ2 history returned duplicate pairs across executions");
    const refs = Object.freeze(chunks.map(value => ref(input, value.result)).sort((a, b) => refKey(a).localeCompare(refKey(b))));
    const rawEvidenceLocators = Object.freeze(chunks.map(value => value.result.rawEvidenceLocator).sort((a, b) => a.rawLocatorHash.localeCompare(b.rawLocatorHash))); const rawLocatorHashes = Object.freeze(rawEvidenceLocators.map(value => value.rawLocatorHash)); const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes }); const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes, evidenceRoot });
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "univ2-pair-created-rolling-observation", version: 1, topic: UNIV2_PAIR_CREATED_TOPIC0, from, through: input.cutoff.number, chunkBlocks: CHUNK_BLOCKS.toString(), entries: Object.freeze(entries) }); const resultPartitionRoot = hashDomain("aloha/univ2-standard/history-source-partition/v1", opaqueResult); const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators });
  },
});

export const UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    if (input.execution.plan.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH || input.execution.plan.completeness !== "rolling-observation" || input.execution.outcome !== "complete" || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan) || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot || input.sourceEvidence.refs.length === 0 || !sameCutoff(input.execution.cutoff, input.recent.cutoff)) throw new TypeError("univ2 history nomination binding mismatch");
    const chunks = decodeHistory(input.execution, input.sourceEvidence, input.rawEvidence);
    return Object.freeze(chunks.flatMap(chunk => chunk.entries.map(entry => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: UNIV2_STANDARD_FAMILY_ID, familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH, instanceNominationKey: entry.pair, evidence: chunk.evidence }))));
  },
});
