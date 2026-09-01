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
import {
  decodeFamilySourcePlanPhysicalObservation,
  type FamilyRawEvidenceReadPortV1,
  type FamilySourcePlanExecutionInputV1,
  type FamilySourcePlanNominationInputV1,
  type FamilySourcePlanNominationProgramV1,
  type FamilySourcePlanPhysicalPortV1,
  type FamilySourcePlanPhysicalResultV1,
  type FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { familyRollingObservationRangeV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { decodeEvmLogObservationBytes } from "../../../packages/observation/src/index.ts";

import { UNIV3_STANDARD_FAMILY_ID, UNIV3_STANDARD_HISTORY_SOURCE_PLAN_ID, UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH, UNIV3_STANDARD_SOURCE_PLAN_ID, UNIV3_STANDARD_SOURCE_PLAN_SCHEMA_HASH, UNIV3_SWAP_TOPIC, UNIV3_POOL_CREATED_TOPIC } from "./manifest.ts";
import { UNIV3_STANDARD_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { decodeUniV3Candidate, sourceCandidateSnapshotHash } from "./discovery.ts";
import { nominateUniV3 } from "./nomination.ts";

export const UNIV3_STANDARD_SOURCE_PLAN = defineFamilySourcePlan({
  sourcePlanId: UNIV3_STANDARD_SOURCE_PLAN_ID,
  completeness: "nomination-only",
  historyStartBlock: null,
  schemaHash: UNIV3_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
});

export const UNIV3_STANDARD_HISTORY_SOURCE_PLAN = defineFamilySourcePlan({ sourcePlanId: UNIV3_STANDARD_HISTORY_SOURCE_PLAN_ID, completeness: "rolling-observation", historyStartBlock: null, schemaHash: UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH });

function sameCutoff(left: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }, right: typeof left): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function abiWords(data: string, count: number, path: string): readonly bigint[] {
  if (!new RegExp(`^0x(?:[0-9a-f]{64}){${count}}$`).test(data)) throw new TypeError(`${path} must contain exactly ${count} ABI words`);
  return Object.freeze(Array.from({ length: count }, (_, index) => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`)));
}

function signed(value: bigint): bigint {
  return value >= (1n << 255n) ? value - (1n << 256n) : value;
}

function indexedAddress(value: string, path: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(value)) throw new TypeError(`${path} is not a padded indexed address`);
  return `0x${value.slice(-40)}`;
}

function verifySwapLog(raw: ReturnType<typeof decodeEvmLogObservationBytes>): void {
  if (raw.topics.length !== 3 || raw.topics[0] !== UNIV3_SWAP_TOPIC) throw new TypeError("univ3 Swap topic layout mismatch");
  indexedAddress(raw.topics[1]!, "univ3.Swap.sender");
  indexedAddress(raw.topics[2]!, "univ3.Swap.recipient");
  const values = abiWords(raw.data, 5, "univ3.Swap.data");
  if (values[0] === 0n && values[1] === 0n || values[2] === 0n || values[3]! >= (1n << 128n) || signed(values[4]!) < -(1n << 23n) || signed(values[4]!) >= (1n << 23n)) throw new TypeError("univ3 Swap ABI domain mismatch");
  if (values[4]! < (1n << 255n) && values[4]! >= (1n << 24n) || values[4]! >= (1n << 255n) && values[4]! < ((1n << 256n) - (1n << 23n))) throw new TypeError("univ3 Swap tick is not sign-extended int24");
}

function verifyPoolCreatedLog(raw: ReturnType<typeof decodeEvmLogObservationBytes>): string {
  if (raw.topics.length !== 4 || raw.topics[0] !== UNIV3_POOL_CREATED_TOPIC) throw new TypeError("univ3 PoolCreated topic layout mismatch");
  const token0 = indexedAddress(raw.topics[1]!, "univ3.PoolCreated.token0");
  const token1 = indexedAddress(raw.topics[2]!, "univ3.PoolCreated.token1");
  const fee = BigInt(`0x${raw.topics[3]!.slice(2)}`);
  if (token0 >= token1 || fee >= (1n << 24n)) throw new TypeError("univ3 PoolCreated indexed domain mismatch");
  const values = abiWords(raw.data, 2, "univ3.PoolCreated.data");
  const tickSpacing = signed(values[0]!);
  if (tickSpacing < -(1n << 23n) || tickSpacing >= (1n << 23n) || values[0]! < (1n << 255n) && values[0]! >= (1n << 24n) || values[0]! >= (1n << 255n) && values[0]! < ((1n << 256n) - (1n << 23n))) throw new TypeError("univ3 PoolCreated tickSpacing is not sign-extended int24");
  const poolWord = values[1]!;
  if (poolWord >= (1n << 160n)) throw new TypeError("univ3 PoolCreated pool is not an ABI address");
  return `0x${poolWord.toString(16).padStart(40, "0")}`;
}

function readRawEvidence(
  input: FamilySourcePlanNominationInputV1,
  evidence: FamilySourcePlanNominationInputV1["recent"]["evidence"][number],
): ReturnType<typeof decodeEvmLogObservationBytes> {
  if (!new Set(input.recent.rawLocatorHashes).has(evidence.rawLocatorHash)) throw new TypeError("univ3 raw locator is outside recent receipt");
  const rawBytes = input.rawEvidence.read(evidence.rawLocatorHash);
  const raw = decodeEvmLogObservationBytes(rawBytes, "univ3.rawEvidence");
  if (
    sha256Hex(rawBytes) !== evidence.rawLocatorHash
    || raw.blockNumber !== evidence.blockNumber
    || raw.blockHash !== evidence.blockHash
    || raw.transactionHash !== evidence.txHash
    || raw.logIndex !== evidence.logIndex
    || raw.address !== evidence.address
    || raw.topics[0] !== evidence.topic
  ) throw new TypeError("univ3 raw evidence/recent evidence mismatch");
  return raw;
}

function assertNominationBinding(input: FamilySourcePlanNominationInputV1): void {
  if (
    input.execution.plan.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
    || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
    || input.execution.sourceEvidenceRefs.length !== 0
    || input.execution.rawLocatorHashes.length !== 0
    || input.sourceEvidence.refs.length !== 0
    || input.sourceEvidence.rawLocatorHashes.length !== 0
    || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    || !sameCutoff(input.sourceEvidence.cutoff, input.recent.cutoff)
  ) throw new TypeError("univ3-standard nomination binding mismatch");
}

export const UNIV3_STANDARD_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...UNIV3_STANDARD_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, _physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_AUTHORING_HASH || input.plan.completeness !== "nomination-only" || input.plan.historyStartBlock !== null || input.previousAppliedThrough !== null) {
      throw new TypeError("univ3-standard source plan binding mismatch");
    }
    return sealNominationOnlySourceExecution(input);
  },
});

export const UNIV3_STANDARD_SOURCE_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: UNIV3_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    assertNominationBinding(input);
    const output: CandidateNominationV1[] = [];
    for (const evidence of input.recent.evidence) {
      const pattern = evidence.topic === UNIV3_SWAP_TOPIC ? "univ3-swap-log" : evidence.topic === UNIV3_POOL_CREATED_TOPIC ? "univ3-pool-created" : null;
      if (pattern === null) continue;
      const raw = readRawEvidence(input, evidence);
      const target = pattern === "univ3-swap-log" ? (verifySwapLog(raw), raw.address) : verifyPoolCreatedLog(raw);
      const seed = decodeUniV3Candidate({
        kind: "log",
        target,
        cutoff: input.recent.cutoff,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        txHash: evidence.txHash,
        logIndex: evidence.logIndex,
        rawLocatorHash: evidence.rawLocatorHash,
        topic0: evidence.topic,
      }, pattern as never);
      if (seed === null) continue;
      const nomination = nominateUniV3(seed);
      if (nomination.status === "nominated") output.push(Object.freeze({
        kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: UNIV3_STANDARD_FAMILY_ID, familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH, instanceNominationKey: nomination.candidate.instanceNominationKey, evidence,
      }));
    }
    return Object.freeze(output);
  },
});

type PoolCreatedEntry = {
  readonly factory: string;
  readonly pool: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
};
const HISTORY_CHUNK_BLOCKS = 500n;

function quantity(value: string, path: string): bigint {
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new TypeError(`${path} must be a canonical JSON-RPC quantity`);
  return BigInt(value);
}

function blockTag(value: string): string { return `0x${BigInt(value).toString(16)}`; }
function decimal(value: bigint): string { return value.toString(10); }

function exactPhysicalResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("univ3 history physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("univ3 history physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (raw === null || typeof raw !== "object" || Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array) || sha256Hex(raw.bytes) !== raw.rawLocatorHash) throw new TypeError("univ3 history raw locator mismatch");
  return value;
}

function sourceRef(input: FamilySourcePlanExecutionInputV1, value: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 {
  return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash });
}

function decodePoolCreatedResponse(value: CanonicalJson, from: bigint, through: bigint): readonly PoolCreatedEntry[] {
  if (!Array.isArray(value)) throw new TypeError("univ3 history response must be a JSON-RPC log array");
  let previous: { readonly block: bigint; readonly index: bigint } | null = null;
  const seen = new Set<string>();
  const entries = value.map((item, index): PoolCreatedEntry => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`univ3 history log[${index}] must be an object`);
    const log = item as Record<string, CanonicalJson>;
    if (Object.keys(log).sort().join(",") !== "address,blockHash,blockNumber,data,logIndex,removed,topics,transactionHash,transactionIndex") throw new TypeError(`univ3 history log[${index}] has an unexpected ABI shape`);
    if (typeof log.address !== "string" || !/^0x[0-9a-f]{40}$/.test(log.address) || typeof log.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.blockHash) || typeof log.transactionHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.transactionHash) || typeof log.blockNumber !== "string" || typeof log.logIndex !== "string" || typeof log.transactionIndex !== "string" || log.removed !== false || typeof log.data !== "string" || !Array.isArray(log.topics) || log.topics.some(topic => typeof topic !== "string" || !/^0x[0-9a-f]{64}$/.test(topic))) throw new TypeError(`univ3 history log[${index}] is malformed`);
    const block = quantity(log.blockNumber, `univ3 history log[${index}].blockNumber`);
    const logIndex = quantity(log.logIndex, `univ3 history log[${index}].logIndex`);
    quantity(log.transactionIndex, `univ3 history log[${index}].transactionIndex`);
    if (block < from || block > through) throw new TypeError("univ3 history log is outside the requested range");
    if (previous !== null && (block < previous.block || block === previous.block && logIndex <= previous.index)) throw new TypeError("univ3 history logs are not in strict chain order");
    previous = { block, index: logIndex };
    const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) throw new TypeError("univ3 history response contains a duplicate log");
    seen.add(key);
    const raw = { topics: log.topics as string[], data: log.data };
    const pool = verifyPoolCreatedLog(raw as unknown as ReturnType<typeof decodeEvmLogObservationBytes>);
    if (pool === "0x0000000000000000000000000000000000000000") throw new TypeError("univ3 PoolCreated returned the zero pool");
    return Object.freeze({ factory: log.address, pool, blockNumber: decimal(block), blockHash: log.blockHash as Hash, txHash: log.transactionHash as Hash, logIndex: decimal(logIndex) });
  });
  if (new Set(entries.map(entry => entry.pool)).size !== entries.length) throw new TypeError("univ3 history returned a duplicate pool");
  return Object.freeze(entries);
}

function exactHistoryObservation(resultValue: FamilySourcePlanPhysicalResultV1, input: FamilySourcePlanExecutionInputV1, from: string, through: string): { readonly result: FamilySourcePlanPhysicalResultV1; readonly entries: readonly PoolCreatedEntry[] } {
  const result = exactPhysicalResult(resultValue);
  const observation = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes);
  const filter = { fromBlock: blockTag(from), toBlock: blockTag(through), topics: [UNIV3_POOL_CREATED_TOPIC] };
  if (observation.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_AUTHORING_HASH || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan) || !sameCutoff(observation.cutoff, input.cutoff) || observation.requestSchemaHash !== UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH || observation.request.method !== "eth_getLogs" || observation.request.target !== null || observation.request.manager !== null || observation.request.topic !== UNIV3_POOL_CREATED_TOPIC || encodeCanonicalJson(observation.request.lookback) !== encodeCanonicalJson({ from, through }) || encodeCanonicalJson(observation.request.chunk) !== encodeCanonicalJson({ maxBlocks: HISTORY_CHUNK_BLOCKS.toString() }) || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([filter]) || encodeCanonicalJson(observation.response) !== encodeCanonicalJson(result.response)) throw new TypeError("univ3 history physical observation binding mismatch");
  return Object.freeze({ result, entries: decodePoolCreatedResponse(result.response, BigInt(from), BigInt(through)) });
}

function sourceRefKey(value: SourcePlanEvidenceRefV1): Hash { return hashDomain("aloha/source-plan-evidence-ref/v1", value); }

type HistoryChunk = { readonly evidence: SourcePlanEvidenceRefV1; readonly from: string; readonly through: string; readonly entries: readonly PoolCreatedEntry[] };

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
  ) throw new TypeError("univ3 history execution/evidence mismatch");
  const chunks = sourceEvidence.refs.map(evidence => {
    const observation = decodeFamilySourcePlanPhysicalObservation(rawEvidence.read(evidence.rawLocatorHash));
    const lookback = observation.request.lookback as { readonly from?: unknown; readonly through?: unknown };
    if (
      typeof lookback.from !== "string"
      || typeof lookback.through !== "string"
      || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(execution.plan)
      || observation.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_AUTHORING_HASH
      || observation.requestSchemaHash !== UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH
    ) throw new TypeError("univ3 history predecessor chunk binding mismatch");
    return Object.freeze({ evidence, from: lookback.from, through: lookback.through, entries: decodePoolCreatedResponse(observation.response, BigInt(lookback.from), BigInt(lookback.through)) });
  }).sort((left, right) => BigInt(left.from) < BigInt(right.from) ? -1 : 1);
  let expectedFrom = BigInt(execution.from);
  for (const chunk of chunks) {
    if (BigInt(chunk.from) !== expectedFrom || BigInt(chunk.through) < expectedFrom || BigInt(chunk.through) - expectedFrom + 1n > HISTORY_CHUNK_BLOCKS) throw new TypeError("univ3 history chunk coverage gap");
    expectedFrom = BigInt(chunk.through) + 1n;
  }
  if (expectedFrom !== BigInt(execution.through) + 1n) throw new TypeError("univ3 history chunk coverage cutoff mismatch");
  const entries = chunks.flatMap(value => value.entries);
  if (new Set(entries.map(value => value.pool)).size !== entries.length) throw new TypeError("univ3 history returned a duplicate pool across chunks");
  const expected = { kind: "univ3-pool-created-rolling-observation", version: 1, topic: UNIV3_POOL_CREATED_TOPIC, from: execution.from, through: execution.through, chunkBlocks: HISTORY_CHUNK_BLOCKS.toString(), entryCount: String(entries.length) };
  if (encodeCanonicalJson(execution.opaqueResult) !== encodeCanonicalJson(expected)) throw new TypeError("univ3 history result/raw observation mismatch");
  return Object.freeze(chunks);
}

export const UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...UNIV3_STANDARD_HISTORY_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_AUTHORING_HASH || input.plan.completeness !== "rolling-observation" || input.plan.historyStartBlock !== null) throw new TypeError("univ3 history source plan binding mismatch");
    if (input.previousAppliedThrough !== null || (input.predecessor ?? null) !== null) throw new TypeError("univ3 rolling observation cannot bind a predecessor");
    const { from } = familyRollingObservationRangeV1(input.cutoff.number);
    const observedChunks: { readonly from: string; readonly through: string; readonly result: FamilySourcePlanPhysicalResultV1; readonly entries: readonly PoolCreatedEntry[] }[] = [];
    for (let chunkFrom = BigInt(from); chunkFrom <= BigInt(input.cutoff.number); chunkFrom += HISTORY_CHUNK_BLOCKS) {
      const chunkThrough = chunkFrom + HISTORY_CHUNK_BLOCKS - 1n > BigInt(input.cutoff.number) ? BigInt(input.cutoff.number) : chunkFrom + HISTORY_CHUNK_BLOCKS - 1n;
      const range = { from: decimal(chunkFrom), through: decimal(chunkThrough) };
      const filter = Object.freeze({ fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([UNIV3_POOL_CREATED_TOPIC]) });
      const physicalResult = await physical.request({ familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: Object.freeze([filter]), target: null, manager: null, topic: UNIV3_POOL_CREATED_TOPIC, lookback: Object.freeze(range), chunk: Object.freeze({ maxBlocks: HISTORY_CHUNK_BLOCKS.toString() }) } }, signal);
      observedChunks.push(Object.freeze({ ...range, ...exactHistoryObservation(physicalResult, input, range.from, range.through) }));
    }
    const allEntries = observedChunks.flatMap(value => value.entries);
    if (new Set(allEntries.map(value => value.pool)).size !== allEntries.length) throw new TypeError("univ3 history returned a duplicate pool across chunks or executions");
    const refs = Object.freeze(observedChunks.map(value => sourceRef(input, value.result)).sort((left, right) => sourceRefKey(left).localeCompare(sourceRefKey(right))));
    const rawEvidenceLocators = Object.freeze(observedChunks.map(value => value.result.rawEvidenceLocator).sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash)));
    const rawLocatorHashes = Object.freeze(rawEvidenceLocators.map(value => value.rawLocatorHash));
    const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes });
    const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes, evidenceRoot });
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "univ3-pool-created-rolling-observation", version: 1, topic: UNIV3_POOL_CREATED_TOPIC, from, through: input.cutoff.number, chunkBlocks: HISTORY_CHUNK_BLOCKS.toString(), entryCount: String(allEntries.length) });
    const resultPartitionRoot = hashDomain("aloha/univ3-standard/history-source-partition/v1", opaqueResult);
    const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators });
  },
});

export const UNIV3_STANDARD_HISTORY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.execution.plan.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_AUTHORING_HASH || input.execution.plan.completeness !== "rolling-observation" || input.execution.outcome !== "complete" || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan) || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot || input.sourceEvidence.refs.length === 0 || !sameCutoff(input.execution.cutoff, input.recent.cutoff)) throw new TypeError("univ3 history nomination binding mismatch");
    const chunks = decodeHistory(input.execution, input.sourceEvidence, input.rawEvidence);
    return Object.freeze(chunks.flatMap(chunk => chunk.entries.map(entry => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: UNIV3_STANDARD_FAMILY_ID, familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH, instanceNominationKey: entry.pool, evidence: chunk.evidence }))));
  },
});
