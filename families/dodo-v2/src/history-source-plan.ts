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
import { DODO_V2_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import {
  DODO_V2_FACTORIES,
  DODO_V2_FAMILY_ID,
  DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "./manifest.ts";
import { DODO_V2_HISTORY_SOURCE_PLAN } from "./source-plan.ts";
import { canonicalAddress } from "./types.ts";

const CHUNK_BLOCKS = 500n;
type FactoryDeclaration = (typeof DODO_V2_FACTORIES)[number];

export type DodoCreationHistoryEntryV1 = {
  readonly factoryKind: FactoryDeclaration["kind"];
  readonly factory: string;
  readonly creationTopic: Hash;
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly creator: string;
  readonly pool: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly txHash: Hash;
  readonly logIndex: string;
};

const decimal = (value: bigint): string => value.toString(10);
const blockTag = (value: string): string => `0x${BigInt(value).toString(16)}`;
const refKey = (value: SourcePlanEvidenceRefV1): Hash => hashDomain("aloha/source-plan-evidence-ref/v1", value);

function quantity(value: string, path: string): bigint {
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new TypeError(`${path} must be a canonical JSON-RPC quantity`);
  return BigInt(value);
}

function sameCutoff(left: CanonicalCutoffV1, right: CanonicalCutoffV1): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function exactResult(value: FamilySourcePlanPhysicalResultV1): FamilySourcePlanPhysicalResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).sort().join(",") !== "evidenceRef,rawEvidenceLocator,rawLocatorHash,response") throw new TypeError("DODO history physical result shape mismatch");
  if (!/^0x[0-9a-f]{64}$/.test(value.rawLocatorHash) || !/^0x[0-9a-f]{64}$/.test(value.evidenceRef)) throw new TypeError("DODO history physical result hash mismatch");
  const raw = value.rawEvidenceLocator;
  if (Reflect.ownKeys(raw).sort().join(",") !== "bytes,kind,rawLocatorHash,version" || raw.kind !== "raw-evidence-locator" || raw.version !== 1 || raw.rawLocatorHash !== value.rawLocatorHash || !(raw.bytes instanceof Uint8Array) || sha256Hex(raw.bytes) !== raw.rawLocatorHash) throw new TypeError("DODO history raw locator mismatch");
  return value;
}

function evidenceRef(input: FamilySourcePlanExecutionInputV1, value: FamilySourcePlanPhysicalResultV1): SourcePlanEvidenceRefV1 {
  return Object.freeze({ kind: "source-plan", version: 1, ownerRef: input.plan.ownerRef, sourcePlanRef: input.plan.sourcePlanRef, evidenceRef: value.evidenceRef, rawLocatorHash: value.rawLocatorHash });
}

function abiAddress(word: string, path: string): string {
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) throw new TypeError(`${path} must be a padded address word`);
  return canonicalAddress(`0x${word.slice(24)}`);
}

export function decodeDodoCreationHistoryEntries(
  value: CanonicalJson,
  declaration: FactoryDeclaration,
  from: bigint,
  through: bigint,
): readonly DodoCreationHistoryEntryV1[] {
  if (!Array.isArray(value)) throw new TypeError("DODO history response must be a JSON-RPC log array");
  let previous: { readonly block: bigint; readonly index: bigint } | null = null;
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index): DodoCreationHistoryEntryV1 => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`DODO history log[${index}] must be an object`);
    const log = item as Record<string, CanonicalJson>;
    if (Object.keys(log).sort().join(",") !== "address,blockHash,blockNumber,data,logIndex,removed,topics,transactionHash,transactionIndex") throw new TypeError(`DODO history log[${index}] has an unexpected shape`);
    if (
      log.address !== declaration.address
      || typeof log.blockHash !== "string"
      || !/^0x[0-9a-f]{64}$/.test(log.blockHash)
      || typeof log.transactionHash !== "string"
      || !/^0x[0-9a-f]{64}$/.test(log.transactionHash)
      || typeof log.blockNumber !== "string"
      || typeof log.logIndex !== "string"
      || typeof log.transactionIndex !== "string"
      || log.removed !== false
      || typeof log.data !== "string"
      || !/^0x(?:[0-9a-f]{64}){4}$/.test(log.data)
      || !Array.isArray(log.topics)
      || log.topics.length !== 1
      || log.topics[0] !== declaration.creationTopic
    ) throw new TypeError(`DODO history log[${index}] is malformed`);
    const block = quantity(log.blockNumber, `DODO history log[${index}].blockNumber`);
    const logIndex = quantity(log.logIndex, `DODO history log[${index}].logIndex`);
    quantity(log.transactionIndex, `DODO history log[${index}].transactionIndex`);
    if (block < from || block > through) throw new TypeError("DODO history log is outside the requested range");
    if (previous !== null && (block < previous.block || block === previous.block && logIndex <= previous.index)) throw new TypeError("DODO history logs are not in strict chain order");
    previous = { block, index: logIndex };
    const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) throw new TypeError("DODO history contains a duplicate log");
    seen.add(key);
    const words = log.data.slice(2).match(/.{64}/g);
    if (words === null || words.length !== 4) throw new TypeError("DODO history creation ABI mismatch");
    return Object.freeze({
      factoryKind: declaration.kind,
      factory: declaration.address,
      creationTopic: declaration.creationTopic,
      baseToken: abiAddress(words[0]!, "DODO history baseToken"),
      quoteToken: abiAddress(words[1]!, "DODO history quoteToken"),
      creator: abiAddress(words[2]!, "DODO history creator"),
      pool: abiAddress(words[3]!, "DODO history pool"),
      blockNumber: decimal(block),
      blockHash: log.blockHash as Hash,
      txHash: log.transactionHash as Hash,
      logIndex: decimal(logIndex),
    });
  }));
}

function observe(
  value: FamilySourcePlanPhysicalResultV1,
  input: FamilySourcePlanExecutionInputV1,
  declaration: FactoryDeclaration,
  from: string,
  through: string,
) {
  const result = exactResult(value);
  const observation = decodeFamilySourcePlanPhysicalObservation(result.rawEvidenceLocator.bytes);
  const filter = { address: declaration.address, fromBlock: blockTag(from), toBlock: blockTag(through), topics: [declaration.creationTopic] };
  if (
    observation.familyDefinitionHash !== DODO_V2_FAMILY_AUTHORING_HASH
    || encodeCanonicalJson(observation.plan) !== encodeCanonicalJson(input.plan)
    || !sameCutoff(observation.cutoff, input.cutoff)
    || observation.requestSchemaHash !== DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH
    || observation.request.method !== "eth_getLogs"
    || observation.request.target !== declaration.address
    || observation.request.manager !== declaration.address
    || observation.request.topic !== declaration.creationTopic
    || encodeCanonicalJson(observation.request.lookback) !== encodeCanonicalJson({ from, through })
    || encodeCanonicalJson(observation.request.chunk) !== encodeCanonicalJson({ maxBlocks: CHUNK_BLOCKS.toString() })
    || encodeCanonicalJson(observation.request.params) !== encodeCanonicalJson([filter])
    || encodeCanonicalJson(observation.response) !== encodeCanonicalJson(result.response)
  ) throw new TypeError("DODO history physical observation binding mismatch");
  return Object.freeze({ result, entries: decodeDodoCreationHistoryEntries(result.response, declaration, BigInt(from), BigInt(through)) });
}

export const DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME: FamilySourcePlanRuntimeV1 = Object.freeze({
  ...DODO_V2_HISTORY_SOURCE_PLAN,
  async execute(input: FamilySourcePlanExecutionInputV1, physical: FamilySourcePlanPhysicalPortV1, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (input.plan.familyDefinitionHash !== DODO_V2_FAMILY_AUTHORING_HASH || input.plan.completeness !== "rolling-observation" || input.plan.historyStartBlock !== null) throw new TypeError("DODO history source plan binding mismatch");
    if (input.previousAppliedThrough !== null || (input.predecessor ?? null) !== null) throw new TypeError("DODO rolling observation cannot bind a predecessor");
    const { from } = familyRollingObservationRangeV1(input.cutoff.number);
    if (BigInt(from) > BigInt(input.cutoff.number)) throw new TypeError("DODO history cursor beyond cutoff");
    const observations: { readonly from: string; readonly through: string; readonly declaration: FactoryDeclaration; readonly result: FamilySourcePlanPhysicalResultV1; readonly entries: readonly DodoCreationHistoryEntryV1[] }[] = [];
    for (let start = BigInt(from); start <= BigInt(input.cutoff.number); start += CHUNK_BLOCKS) {
      const end = start + CHUNK_BLOCKS - 1n > BigInt(input.cutoff.number) ? BigInt(input.cutoff.number) : start + CHUNK_BLOCKS - 1n;
      const range = Object.freeze({ from: decimal(start), through: decimal(end) });
      for (const declaration of DODO_V2_FACTORIES) {
        const filter = Object.freeze({ address: declaration.address, fromBlock: blockTag(range.from), toBlock: blockTag(range.through), topics: Object.freeze([declaration.creationTopic]) });
        const raw = await physical.request({
          familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
          plan: input.plan,
          cutoff: input.cutoff,
          requestSchemaHash: DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
          request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: Object.freeze([filter]), target: declaration.address, manager: declaration.address, topic: declaration.creationTopic, lookback: range, chunk: Object.freeze({ maxBlocks: CHUNK_BLOCKS.toString() }) },
        }, signal);
        observations.push({ ...range, declaration, ...observe(raw, input, declaration, range.from, range.through) });
      }
    }
    const refs = Object.freeze(observations.map(item => evidenceRef(input, item.result)).sort((left, right) => refKey(left).localeCompare(refKey(right))));
    const rawEvidenceLocators = Object.freeze(observations.map(item => item.result.rawEvidenceLocator).sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash)));
    const rawLocatorHashes = Object.freeze(rawEvidenceLocators.map(locator => locator.rawLocatorHash));
    const evidenceRoot = sourcePlanEvidenceRoot({ plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes });
    const sourceEvidence = Object.freeze({ kind: "source-plan-evidence" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, refs, rawLocatorHashes, evidenceRoot });
    const entries = Object.freeze(observations.flatMap(item => item.entries));
    const opaqueResult: CanonicalJson = Object.freeze({ kind: "dodo-v2-creation-rolling-observation", version: 1, from, through: input.cutoff.number, chunkBlocks: CHUNK_BLOCKS.toString(), factories: DODO_V2_FACTORIES, entryCount: String(entries.length) });
    const resultPartitionRoot = hashDomain("aloha/dodo-v2/history-source-partition/v1", opaqueResult);
    const withoutRoot = { kind: "source-plan-execution" as const, version: 1 as const, plan: input.plan, cutoff: input.cutoff, outcome: "complete" as const, from, through: input.cutoff.number, previousAppliedThrough: null, resultPartitionRoot, opaqueResult, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot };
    return Object.freeze({ execution: Object.freeze({ ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) }), sourceEvidence, rawEvidenceLocators });
  },
});

function declarationForObservation(value: ReturnType<typeof decodeFamilySourcePlanPhysicalObservation>): FactoryDeclaration {
  const declaration = DODO_V2_FACTORIES.find(item => item.address === value.request.target && item.address === value.request.manager && item.creationTopic === value.request.topic);
  if (declaration === undefined) throw new TypeError("DODO history factory/topic declaration mismatch");
  return declaration;
}

export const DODO_V2_HISTORY_NOMINATION_PROGRAM: FamilySourcePlanNominationProgramV1 = Object.freeze({
  kind: "aloha.family-source-plan-nomination-program",
  version: 1,
  schemaHash: DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  async evaluate(input: FamilySourcePlanNominationInputV1, signal: AbortSignal): Promise<readonly CandidateNominationV1[]> {
    if (signal.aborted) throw signal.reason;
    const { executionRoot, ...executionWithoutRoot } = input.execution;
    if (
      input.execution.plan.familyDefinitionHash !== DODO_V2_FAMILY_AUTHORING_HASH
      || input.execution.plan.completeness !== "rolling-observation"
      || input.execution.outcome !== "complete"
      || encodeCanonicalJson(input.execution.plan) !== encodeCanonicalJson(input.sourceEvidence.plan)
      || input.execution.sourceEvidenceRoot !== input.sourceEvidence.evidenceRoot
      || executionRoot !== sourcePlanExecutionRoot(executionWithoutRoot)
      || input.sourceEvidence.evidenceRoot !== sourcePlanEvidenceRoot({ plan: input.sourceEvidence.plan, cutoff: input.sourceEvidence.cutoff, refs: input.sourceEvidence.refs, rawLocatorHashes: input.sourceEvidence.rawLocatorHashes })
      || encodeCanonicalJson(input.execution.sourceEvidenceRefs) !== encodeCanonicalJson(input.sourceEvidence.refs)
      || encodeCanonicalJson(input.execution.rawLocatorHashes) !== encodeCanonicalJson(input.sourceEvidence.rawLocatorHashes)
      || input.sourceEvidence.refs.length === 0
      || !sameCutoff(input.execution.cutoff, input.recent.cutoff)
      || !sameCutoff(input.execution.cutoff, input.sourceEvidence.cutoff)
    ) throw new TypeError("DODO history nomination binding mismatch");
    const observations = input.sourceEvidence.refs.map(evidence => {
      const bytes = input.rawEvidence.read(evidence.rawLocatorHash);
      if (sha256Hex(bytes) !== evidence.rawLocatorHash) throw new TypeError("DODO history raw hash mismatch");
      const observation = decodeFamilySourcePlanPhysicalObservation(bytes);
      const declaration = declarationForObservation(observation);
      const range = observation.request.lookback as { readonly from?: unknown; readonly through?: unknown };
      if (typeof range.from !== "string" || typeof range.through !== "string") throw new TypeError("DODO history chunk range malformed");
      const exact = observe({ evidenceRef: evidence.evidenceRef, rawLocatorHash: evidence.rawLocatorHash, rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash: evidence.rawLocatorHash, bytes }, response: observation.response }, { plan: input.execution.plan, cutoff: input.execution.cutoff, previousAppliedThrough: input.execution.previousAppliedThrough }, declaration, range.from, range.through);
      return Object.freeze({ evidence, declaration, from: range.from, through: range.through, entries: exact.entries });
    });
    const factoryOrder = new Map(DODO_V2_FACTORIES.map((item, index) => [item.kind, index]));
    const ordered = observations.slice().sort((left, right) => BigInt(left.from) === BigInt(right.from) ? factoryOrder.get(left.declaration.kind)! - factoryOrder.get(right.declaration.kind)! : BigInt(left.from) < BigInt(right.from) ? -1 : 1);
    let expectedFrom = BigInt(input.execution.from);
    for (let index = 0; index < ordered.length; index += DODO_V2_FACTORIES.length) {
      const group = ordered.slice(index, index + DODO_V2_FACTORIES.length);
      if (group.length !== DODO_V2_FACTORIES.length || group.some((item, factoryIndex) => item.declaration.kind !== DODO_V2_FACTORIES[factoryIndex]!.kind || BigInt(item.from) !== expectedFrom || item.through !== group[0]!.through)) throw new TypeError("DODO history factory grid coverage gap");
      const through = BigInt(group[0]!.through);
      if (through < expectedFrom || through - expectedFrom + 1n > CHUNK_BLOCKS) throw new TypeError("DODO history chunk range mismatch");
      expectedFrom = through + 1n;
    }
    if (expectedFrom !== BigInt(input.execution.through) + 1n) throw new TypeError("DODO history chunk cutoff mismatch");
    const entries = ordered.flatMap(item => item.entries);
    const expected = { kind: "dodo-v2-creation-rolling-observation", version: 1, from: input.execution.from, through: input.execution.through, chunkBlocks: CHUNK_BLOCKS.toString(), factories: DODO_V2_FACTORIES, entryCount: String(entries.length) };
    if (encodeCanonicalJson(expected) !== encodeCanonicalJson(input.execution.opaqueResult)) throw new TypeError("DODO history result/raw mismatch");
    return Object.freeze(ordered.flatMap(item => item.entries.map(entry => Object.freeze({ kind: "aloha.candidate-nomination" as const, version: "2" as const, familyId: DODO_V2_FAMILY_ID, familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, instanceNominationKey: entry.pool, evidence: item.evidence }))));
  },
});
