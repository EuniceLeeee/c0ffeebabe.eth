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
  familyRollingObservationRangeV1,
  type FamilyRawEvidenceReadPortV1,
  type FamilySourcePlanExecutionInputV1,
  type FamilySourcePlanNominationInputV1,
  type FamilySourcePlanNominationProgramV1,
  type FamilySourcePlanPhysicalPortV1,
  type FamilySourcePlanPhysicalResultV1,
  type FamilySourcePlanRuntimeV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import {
  ETHERTOKEN_NATIVE_REDEEM_FAMILY_ID,
  ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC,
} from "./manifest.ts";
import { ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN } from "./source-plan.ts";
import { canonicalAddress } from "./types.ts";

const CHUNK_BLOCKS = 500n;

export interface EtherTokenNativeRedeemDestructionHistoryEntryV1 {
  readonly target: string;
  readonly actor: string;
  readonly amount: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
}

interface RpcLogV1 {
  readonly address: string;
  readonly blockHash: Hash;
  readonly blockNumber: bigint;
  readonly data: string;
  readonly logIndex: bigint;
  readonly topics: readonly Hash[];
  readonly transactionHash: Hash;
}

const decimal = (value: bigint): string => value.toString(10);
const blockTag = (value: string): string => `0x${BigInt(value).toString(16)}`;
const refKey = (value: SourcePlanEvidenceRefV1): Hash => hashDomain("aloha/source-plan-evidence-ref/v1", value);

function quantity(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new TypeError(`${path} must be a canonical JSON-RPC quantity`);
  return BigInt(value);
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw new TypeError(`${path} must be a lowercase hash`);
  return value as Hash;
}

function indexedAddress(value: Hash): string | null {
  return /^0x0{24}[0-9a-f]{40}$/.test(value) ? canonicalAddress(`0x${value.slice(-40)}`) : null;
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function exactResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("ethertoken-native-redeem history physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("ethertoken-native-redeem history physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array) || sha256Hex(raw.bytes) !== raw.rawLocatorHash) throw new TypeError("ethertoken-native-redeem history raw locator mismatch");
  return value;
}

function evidenceRef(input: FamilySourcePlanExecutionInputV1, value: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 {
  return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash });
}

function decodeRpcLogs(value: CanonicalJson, from: bigint, through: bigint): readonly RpcLogV1[] {
  if (!Array.isArray(value)) throw new TypeError("ethertoken-native-redeem history response must be a JSON-RPC log array");
  let previous: { readonly block: bigint; readonly index: bigint } | null = null;
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index): RpcLogV1 => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`ethertoken-native-redeem history log[${index}] must be an object`);
    const log = item as Record<string, CanonicalJson>;
    if (Object.keys(log).sort().join(",") !== "address,blockHash,blockNumber,data,logIndex,removed,topics,transactionHash,transactionIndex") throw new TypeError(`ethertoken-native-redeem history log[${index}] has an unexpected shape`);
    if (typeof log.address !== "string" || !/^0x[0-9a-f]{40}$/.test(log.address) || log.removed !== false || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(log.data) || !Array.isArray(log.topics) || log.topics.length === 0) throw new TypeError(`ethertoken-native-redeem history log[${index}] is malformed`);
    const topics = Object.freeze(log.topics.map((topic, topicIndex) => hash(topic, `ethertoken-native-redeem history log[${index}].topics[${topicIndex}]`)));
    if (topics[0] !== ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC) throw new TypeError("ethertoken-native-redeem history topic mismatch");
    const block = quantity(log.blockNumber, `ethertoken-native-redeem history log[${index}].blockNumber`);
    const logIndex = quantity(log.logIndex, `ethertoken-native-redeem history log[${index}].logIndex`);
    quantity(log.transactionIndex, `ethertoken-native-redeem history log[${index}].transactionIndex`);
    if (block < from || block > through) throw new TypeError("ethertoken-native-redeem history log outside requested range");
    if (previous !== null && (block < previous.block || block === previous.block && logIndex <= previous.index)) throw new TypeError("ethertoken-native-redeem history logs are not in strict chain order");
    previous = { block, index: logIndex };
    const blockHash = hash(log.blockHash, `ethertoken-native-redeem history log[${index}].blockHash`);
    const transactionHash = hash(log.transactionHash, `ethertoken-native-redeem history log[${index}].transactionHash`);
    const key = `${blockHash}:${transactionHash}:${logIndex}`;
    if (seen.has(key)) throw new TypeError("ethertoken-native-redeem history contains a duplicate log");
    seen.add(key);
    return Object.freeze({ address: canonicalAddress(log.address), blockHash, blockNumber: block, data: log.data, logIndex, topics, transactionHash });
  }));
}

export function decodeEtherTokenNativeRedeemDestructionHistoryEntries(value: CanonicalJson, from: bigint, through: bigint): readonly EtherTokenNativeRedeemDestructionHistoryEntryV1[] {
  return Object.freeze(decodeRpcLogs(value, from, through).flatMap((log): readonly EtherTokenNativeRedeemDestructionHistoryEntryV1[] => {
    let actor: string | null = null;
    let amount = 0n;
    if (log.topics.length === 2 && /^0x[0-9a-f]{64}$/.test(log.data)) {
      actor = indexedAddress(log.topics[1]!);
      amount = BigInt(log.data);
    } else if (log.topics.length === 1 && /^0x(?:[0-9a-f]{64}){2}$/.test(log.data)) {
      const actorWord = `0x${log.data.slice(2, 66)}` as Hash;
      actor = indexedAddress(actorWord);
      amount = BigInt(`0x${log.data.slice(66, 130)}`);
    }
    if (actor === null || amount === 0n) return [];
    return [Object.freeze({ target: log.address, actor, amount: decimal(amount), blockNumber: decimal(log.blockNumber), blockHash: log.blockHash, txHash: log.transactionHash, logIndex: decimal(log.logIndex) })];
  }));
}

function observe(value: FamilySourcePlanPhysicalResultV1, input: FamilySourcePlanExecutionInputV1, from: string, through: string) {
  const result = exactResult(value);
  const observation = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes);
  const filter = { fromBlock: blockTag(from), toBlock: blockTag(through), topics: [ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC] };
  if (
    observation.familyDefinitionHash !== ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan)
    || !sameCutoff(observation.cutoff, input.cutoff)
    || observation.requestSchemaHash !== ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_SCHEMA_HASH
    || observation.request.method !== "eth_getLogs"
    || observation.request.target !== null
    || observation.request.manager !== null
    || observation.request.topic !== ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC
    || encodeCanonicalJson(observation.request.lookback) !== encodeCanonicalJson({ from, through })
    || encodeCanonicalJson(observation.request.chunk) !== encodeCanonicalJson({ maxBlocks: CHUNK_BLOCKS.toString() })
    || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([filter])
    || encodeCanonicalJson(observation.response) !== encodeCanonicalJson(result.response)
  ) throw new TypeError("ethertoken-native-redeem history physical observation binding mismatch");
  return Object.freeze({ result, entries: decodeEtherTokenNativeRedeemDestructionHistoryEntries(result.response, BigInt(from), BigInt(through)) });
}

type HistoryChunkV1 = { readonly evidence: SourcePlanEvidenceRefV1; readonly from: string; readonly through: string; readonly entries: readonly EtherTokenNativeRedeemDestructionHistoryEntryV1[] };

function decodeHistory(execution: FamilySourcePlanNominationInputV1["execution"], sourceEvidence: FamilySourcePlanNominationInputV1["sourceEvidence"], rawEvidence: FamilyRawEvidenceReadPortV1): readonly HistoryChunkV1[] {
  if (encodeCanonicalJson(execution.plan) !== encodeCanonicalJson(sourceEvidence.plan) || execution.sourceEvidenceRoot !== sourceEvidence.evidenceRoot || encodeCanonicalJson(execution.sourceEvidenceRefs) !== encodeCanonicalJson(sourceEvidence.refs) || encodeCanonicalJson(execution.rawLocatorHashes) !== encodeCanonicalJson(sourceEvidence.rawLocatorHashes) || execution.previousAppliedThrough !== null || execution.from !== familyRollingObservationRangeV1(execution.cutoff.number).from || execution.through !== execution.cutoff.number) throw new TypeError("ethertoken-native-redeem history execution/evidence mismatch");
  const chunks = sourceEvidence.refs.map(evidence => {
    const bytes = rawEvidence.read(evidence.rawLocatorHash);
    if (sha256Hex(bytes) !== evidence.rawLocatorHash) throw new TypeError("ethertoken-native-redeem history raw hash mismatch");
    const observed = decodeFamilySourcePlanPhysicalObservation(bytes);
    const range = observed.request.lookback as { readonly from?: unknown; readonly through?: unknown };
    if (typeof range.from !== "string" || typeof range.through !== "string" || observed.familyDefinitionHash !== ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH || observed.plan.familyDefinitionHash !== ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH || observed.plan.ownerRef !== evidence.ownerRef || observed.plan.sourcePlanRef !== evidence.sourcePlanRef || observed.plan.completeness !== "rolling-observation" || observed.plan.historyStartBlock !== null || observed.requestSchemaHash !== ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_SCHEMA_HASH || observed.request.kind !== "family-source-plan-rpc" || observed.request.version !== 1 || observed.request.method !== "eth_getLogs" || observed.request.target !== null || observed.request.manager !== null || observed.request.topic !== ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC || !sameCutoff(observed.cutoff, execution.cutoff)) throw new TypeError("ethertoken-native-redeem history chunk binding mismatch");
    const filter = Object.freeze({ fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC]) });
    if (encodeCanonicalJson(observed.request.params) !== encodeCanonicalJson([filter]) || encodeCanonicalJson(observed.request.chunk) !== encodeCanonicalJson({ maxBlocks: CHUNK_BLOCKS.toString() })) throw new TypeError("ethertoken-native-redeem history predecessor request mismatch");
    return Object.freeze({ evidence, from: range.from, through: range.through, entries: decodeEtherTokenNativeRedeemDestructionHistoryEntries(observed.response, BigInt(range.from), BigInt(range.through)) });
  }).sort((left, right) => BigInt(left.from) < BigInt(right.from) ? -1 : BigInt(left.from) > BigInt(right.from) ? 1 : 0);
  let expectedFrom = BigInt(execution.from);
  for (const chunk of chunks) { if (BigInt(chunk.from) !== expectedFrom || BigInt(chunk.through) < expectedFrom || BigInt(chunk.through) - expectedFrom + 1n > CHUNK_BLOCKS) throw new TypeError("ethertoken-native-redeem history chunk coverage gap"); expectedFrom = BigInt(chunk.through) + 1n; }
  if (expectedFrom !== BigInt(execution.through) + 1n) throw new TypeError("ethertoken-native-redeem history chunk cutoff mismatch");
  const expected = { kind: "ethertoken-native-redeem-destruction-rolling-observation", version: 1, topic: ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC, from: execution.from, through: execution.through, chunkBlocks: CHUNK_BLOCKS.toString(), entryCount: String(chunks.reduce((count, chunk) => count + chunk.entries.length, 0)) };
  if (encodeCanonicalJson(expected) !== encodeCanonicalJson(execution.opaqueResult)) throw new TypeError("ethertoken-native-redeem history result/raw mismatch");
  return Object.freeze(chunks);
}

export const ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH || input.plan.completeness !== "rolling-observation" || input.plan.historyStartBlock !== null) throw new TypeError("ethertoken-native-redeem history source plan binding mismatch");
    if (input.previousAppliedThrough !== null || (input.predecessor ?? null) !== null) throw new TypeError("ethertoken-native-redeem rolling observation cannot bind a predecessor");
    const { from } = familyRollingObservationRangeV1(input.cutoff.number, input.rollingObservationRange);
    if (BigInt(from) > BigInt(input.cutoff.number)) throw new TypeError("ethertoken-native-redeem history cursor beyond cutoff");
    const chunks: { readonly from: string; readonly through: string; readonly result: FamilySourcePlanPhysicalResultV1; readonly entries: readonly EtherTokenNativeRedeemDestructionHistoryEntryV1[] }[] = [];
    for (let start = BigInt(from); start <= BigInt(input.cutoff.number); start += CHUNK_BLOCKS) {
      const end = start + CHUNK_BLOCKS - 1n > BigInt(input.cutoff.number) ? BigInt(input.cutoff.number) : start + CHUNK_BLOCKS - 1n;
      const range = Object.freeze({ from: decimal(start), through: decimal(end) });
      const filter = Object.freeze({ fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC]) });
      const raw = await physical.request({ familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, plan: input.plan, cutoff: input.cutoff, requestSchemaHash: ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: Object.freeze([filter]), target: null, manager: null, topic: ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC, lookback: range, chunk: Object.freeze({ maxBlocks: CHUNK_BLOCKS.toString() }) } }, signal);
      chunks.push({ ...range, ...observe(raw, input, range.from, range.through) });
    }
    const refs = Object.freeze(chunks.map(chunk => evidenceRef(input, chunk.result)).sort((left, right) => refKey(left).localeCompare(refKey(right))));
    const rawEvidenceLocators = Object.freeze(chunks.map(chunk => chunk.result.rawEvidenceLocator).sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash)));
    const rawLocatorHashes = Object.freeze(rawEvidenceLocators.map(locator => locator.rawLocatorHash));
    const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes });
    const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes, evidenceRoot });
    const entries = Object.freeze(chunks.flatMap(chunk => chunk.entries));
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "ethertoken-native-redeem-destruction-rolling-observation", version: 1, topic: ETHERTOKEN_NATIVE_REDEEM_DESTRUCTION_TOPIC, from, through: input.cutoff.number, chunkBlocks: CHUNK_BLOCKS.toString(), entryCount: String(entries.length) });
    const resultPartitionRoot = hashDomain("aloha/ethertoken-native-redeem/history-source-partition/v1", opaqueResult);
    const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators });
  },
});

export const ETHERTOKEN_NATIVE_REDEEM_HISTORY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: ETHERTOKEN_NATIVE_REDEEM_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    const { executionRoot, ...executionWithoutRoot } = input.execution;
    const expectedEvidenceRoot = sourcePlanEvidenceRoot({ plan: input.sourceEvidence.plan, cutoff: input.sourceEvidence.cutoff, refs: input.sourceEvidence.refs, rawLocatorHashes: input.sourceEvidence.rawLocatorHashes });
    if (
      input.execution.plan.familyDefinitionHash !== ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH
      || input.execution.plan.completeness !== "rolling-observation"
      || input.execution.outcome !== "complete"
      || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
      || executionRoot !== sourcePlanExecutionRoot(executionWithoutRoot)
      || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
      || input.sourceEvidence.evidenceRoot !== expectedEvidenceRoot
      || encodeCanonicalJson(input.execution.sourceEvidenceRefs) !== encodeCanonicalJson(input.sourceEvidence.refs)
      || encodeCanonicalJson(input.execution.rawLocatorHashes) !== encodeCanonicalJson(input.sourceEvidence.rawLocatorHashes)
      || input.sourceEvidence.refs.length === 0
      || !sameCutoff(input.execution.cutoff, input.sourceEvidence.cutoff)
      || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
    ) throw new TypeError("ethertoken-native-redeem history nomination binding mismatch");
    const keys = input.sourceEvidence.refs.map(refKey);
    if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== [...keys].sort()[index])) throw new TypeError("ethertoken-native-redeem history evidence order mismatch");
    const chunks = decodeHistory(input.execution, input.sourceEvidence, input.rawEvidence);
    return Object.freeze(chunks.flatMap(chunk => [...new Set(chunk.entries.map(entry => entry.target))].sort().map(target => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: ETHERTOKEN_NATIVE_REDEEM_FAMILY_ID, familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, instanceNominationKey: target, evidence: chunk.evidence }))));
  },
});
