import {
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type CandidateNominationV1,
  type CanonicalCutoffV1,
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
import { familyRollingObservationRangeV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { ASTRA_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import {
  ASTRA_CHANGE_TOPIC,
  ASTRA_FAMILY_ID,
  ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "./manifest.ts";
import { ASTRA_HISTORY_SOURCE_PLAN } from "./source-plan.ts";
import { decodeAstraCandidate } from "./discovery.ts";
import type { Address, AstraObservationV1 } from "./types.ts";

const CHUNK_BLOCKS = 500n;
export type AstraHistoryEntryV1 = {
  readonly target: Address;
  readonly actor: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: string;
  readonly observedAmountOut: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
};

const decimal = (value: bigint): string => value.toString(10);
const blockTag = (value: string): string => `0x${BigInt(value).toString(16)}`;
function quantity(value: string, path: string): bigint {
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new TypeError(`${path} must be a canonical JSON-RPC quantity`);
  return BigInt(value);
}
function address(value: unknown, path: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) throw new TypeError(`${path} must be a lowercase address`);
  return value as Address;
}
function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function exactResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("Astra history physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("Astra history physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array) || sha256Hex(raw.bytes) !== raw.rawLocatorHash) throw new TypeError("Astra history raw locator mismatch");
  return value;
}

function evidenceRef(input: FamilySourcePlanExecutionInputV1, value: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 {
  return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash });
}
const refKey = (value: SourcePlanEvidenceRefV1): Hash => hashDomain("aloha/source-plan-evidence-ref/v1", value);

export function decodeAstraHistoryEntries(value: CanonicalJson, cutoff: CanonicalCutoffV1, from: bigint, through: bigint): readonly AstraHistoryEntryV1[] {
  if (!Array.isArray(value)) throw new TypeError("Astra history response must be a JSON-RPC log array");
  let previous: { readonly block: bigint; readonly index: bigint } | null = null;
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index): AstraHistoryEntryV1 => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`Astra history log[${index}] must be an object`);
    const log = item as Record<string, CanonicalJson>;
    if (Object.keys(log).sort().join(",") !== "address,blockHash,blockNumber,data,logIndex,removed,topics,transactionHash,transactionIndex") throw new TypeError(`Astra history log[${index}] has an unexpected shape`);
    const target = address(log.address, `Astra history log[${index}].address`);
    if (typeof log.blockHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.blockHash) || typeof log.transactionHash !== "string" || !/^0x[0-9a-f]{64}$/.test(log.transactionHash) || typeof log.blockNumber !== "string" || typeof log.logIndex !== "string" || typeof log.transactionIndex !== "string" || log.removed !== false || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{64}){2}$/.test(log.data) || !Array.isArray(log.topics) || log.topics.length !== 4 || log.topics.some(topic => typeof topic !== "string" || !/^0x[0-9a-f]{64}$/.test(topic)) || log.topics[0] !== ASTRA_CHANGE_TOPIC) throw new TypeError(`Astra history log[${index}] is malformed`);
    const block = quantity(log.blockNumber, `Astra history log[${index}].blockNumber`);
    const logIndex = quantity(log.logIndex, `Astra history log[${index}].logIndex`);
    quantity(log.transactionIndex, `Astra history log[${index}].transactionIndex`);
    if (block < from || block > through) throw new TypeError("Astra history log is outside the requested range");
    if (previous !== null && (block < previous.block || block === previous.block && logIndex <= previous.index)) throw new TypeError("Astra history logs are not in strict chain order");
    previous = { block, index: logIndex };
    const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) throw new TypeError("Astra history contains a duplicate log");
    seen.add(key);
    const observation: AstraObservationV1 = Object.freeze({
      kind: "log",
      target,
      source: cutoff,
      blockNumber: decimal(block),
      blockHash: log.blockHash as Hash,
      txHash: log.transactionHash as Hash,
      logIndex: decimal(logIndex),
      topics: log.topics as readonly string[],
      dataHex: log.data,
    });
    const candidate = decodeAstraCandidate(observation, "astra-change-log");
    if (candidate === null || candidate.observedAmountOut === null) throw new TypeError("Astra history Change ABI is invalid");
    return Object.freeze({ target, actor: candidate.actor, tokenIn: candidate.tokenIn, tokenOut: candidate.tokenOut, amountIn: candidate.amountIn.toString(10), observedAmountOut: candidate.observedAmountOut.toString(10), blockNumber: decimal(block), blockHash: log.blockHash as Hash, txHash: log.transactionHash as Hash, logIndex: decimal(logIndex) });
  }));
}

function observe(value: FamilySourcePlanPhysicalResultV1, input: FamilySourcePlanExecutionInputV1, from: string, through: string) {
  const result = exactResult(value);
  const observation = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes);
  const filter = { fromBlock: blockTag(from), toBlock: blockTag(through), topics: [ASTRA_CHANGE_TOPIC] };
  if (observation.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan) || !sameCutoff(observation.cutoff, input.cutoff) || observation.requestSchemaHash !== ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH || observation.request.method !== "eth_getLogs" || observation.request.target !== null || observation.request.manager !== null || observation.request.topic !== ASTRA_CHANGE_TOPIC || encodeCanonicalJson(observation.request.lookback) !== encodeCanonicalJson({ from, through }) || encodeCanonicalJson(observation.request.chunk) !== encodeCanonicalJson({ maxBlocks: CHUNK_BLOCKS.toString() }) || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([filter]) || encodeCanonicalJson(observation.response) !== encodeCanonicalJson(result.response)) throw new TypeError("Astra history physical observation binding mismatch");
  return Object.freeze({ result, entries: decodeAstraHistoryEntries(result.response, input.cutoff, BigInt(from), BigInt(through)) });
}

export const ASTRA_HISTORY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...ASTRA_HISTORY_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH || input.plan.completeness !== "rolling-observation" || input.plan.historyStartBlock !== null) throw new TypeError("Astra history source plan binding mismatch");
    if (input.previousAppliedThrough !== null || (input.predecessor ?? null) !== null) throw new TypeError("Astra rolling observation cannot bind a predecessor");
    const { from } = familyRollingObservationRangeV1(input.cutoff.number);
    if (BigInt(from) > BigInt(input.cutoff.number)) throw new TypeError("Astra history cursor beyond cutoff");
    const chunks: { readonly from: string; readonly through: string; readonly result: FamilySourcePlanPhysicalResultV1; readonly entries: readonly AstraHistoryEntryV1[] }[] = [];
    for (let start = BigInt(from); start <= BigInt(input.cutoff.number); start += CHUNK_BLOCKS) {
      const end = start + CHUNK_BLOCKS - 1n > BigInt(input.cutoff.number) ? BigInt(input.cutoff.number) : start + CHUNK_BLOCKS - 1n;
      const range = Object.freeze({ from: decimal(start), through: decimal(end) });
      const filter = Object.freeze({ fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([ASTRA_CHANGE_TOPIC]) });
      const raw = await physical.request({ familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: Object.freeze([filter]), target: null, manager: null, topic: ASTRA_CHANGE_TOPIC, lookback: range, chunk: Object.freeze({ maxBlocks: CHUNK_BLOCKS.toString() }) } }, signal);
      chunks.push({ ...range, ...observe(raw, input, range.from, range.through) });
    }
    const refs = Object.freeze(chunks.map(chunk => evidenceRef(input, chunk.result)).sort((left, right) => refKey(left).localeCompare(refKey(right))));
    const rawEvidenceLocators = Object.freeze(chunks.map(chunk => chunk.result.rawEvidenceLocator).sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash)));
    const rawLocatorHashes = Object.freeze(rawEvidenceLocators.map(locator => locator.rawLocatorHash));
    const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes });
    const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes, evidenceRoot });
    const entries = Object.freeze(chunks.flatMap(chunk => chunk.entries));
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "astra-change-rolling-observation", version: 1, topic: ASTRA_CHANGE_TOPIC, from, through: input.cutoff.number, chunkBlocks: CHUNK_BLOCKS.toString(), entries });
    const resultPartitionRoot = hashDomain("aloha/astra-multitoken/history-source-partition/v1", opaqueResult);
    const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators });
  },
});

export const ASTRA_HISTORY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    if (input.execution.plan.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH || input.execution.plan.completeness !== "rolling-observation" || input.execution.outcome !== "complete" || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan) || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot || input.sourceEvidence.refs.length === 0 || !sameCutoff(input.execution.cutoff, input.recent.cutoff)) throw new TypeError("Astra history nomination binding mismatch");
    const chunks = input.sourceEvidence.refs.map(evidence => {
      const bytes = input.rawEvidence.read(evidence.rawLocatorHash);
      if (sha256Hex(bytes) !== evidence.rawLocatorHash) throw new TypeError("Astra history raw hash mismatch");
      const observation = decodeFamilySourcePlanPhysicalObservation(bytes);
      const range = observation.request.lookback as { readonly from?: unknown; readonly through?: unknown };
      if (typeof range.from !== "string" || typeof range.through !== "string") throw new TypeError("Astra history chunk range malformed");
      return Object.freeze({ evidence, from: range.from, through: range.through, entries: decodeAstraHistoryEntries(observation.response, input.execution.cutoff, BigInt(range.from), BigInt(range.through)) });
    }).sort((left, right) => BigInt(left.from) < BigInt(right.from) ? -1 : 1);
    let expectedFrom = BigInt(input.execution.from);
    for (const chunk of chunks) {
      if (BigInt(chunk.from) !== expectedFrom || BigInt(chunk.through) < expectedFrom || BigInt(chunk.through) - expectedFrom + 1n > CHUNK_BLOCKS) throw new TypeError("Astra history chunk coverage gap");
      expectedFrom = BigInt(chunk.through) + 1n;
    }
    if (expectedFrom !== BigInt(input.execution.through) + 1n) throw new TypeError("Astra history chunk cutoff mismatch");
    const entries = chunks.flatMap(chunk => chunk.entries);
    const expected = { kind: "astra-change-rolling-observation", version: 1, topic: ASTRA_CHANGE_TOPIC, from: input.execution.from, through: input.execution.through, chunkBlocks: CHUNK_BLOCKS.toString(), entries };
    if (encodeCanonicalJson(expected) !== encodeCanonicalJson(input.execution.opaqueResult)) throw new TypeError("Astra history result/raw mismatch");
    return Object.freeze(chunks.flatMap(chunk => {
      const targets = [...new Set(chunk.entries.map(entry => entry.target))].sort();
      return targets.map(target => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: ASTRA_FAMILY_ID, familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH, instanceNominationKey: target, evidence: chunk.evidence }));
    }));
  },
});
