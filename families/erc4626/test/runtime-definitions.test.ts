import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import {
  mergeAndDedupeNominations,
  type CanonicalCutoffV1,
  type RecentLogEvidenceRefV1,
  type SourcePlanEvidenceRefV1,
} from "../../../packages/discovery/src/index.ts";
import type { FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { encodeEvmLogObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import {
  ERC4626_FAMILY_AUTHORING_HASH,
  ERC4626_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  ERC4626_IDENTITY_DEFINITION,
  ERC4626_MATERIALIZATION_DEFINITION,
  ERC4626_PROJECTION_DEFINITION,
  ERC4626_WITHDRAW_TOPIC,
} from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/erc4626-runtime-definitions", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const vault = address("5");
const asset = address("1");
const sender = address("2");
const receiver = address("3");
const owner = address("4");
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const executorSource = Object.freeze({ chainId: source.chainId, blockNumber: source.number, blockHash: source.hash, stateRoot: source.stateRoot, executorAuthorityRoot: h("executor"), workerEpoch: "7", executorSessionHash: h("session") });
const canonical = (value: unknown): CanonicalJson => decodeCanonicalJson(encodeCanonicalJson(value));
const bytesHex = (value: Uint8Array): string => `0x${Array.from(value).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (value: string): string => `${"0".repeat(24)}${value.slice(2)}`;
const indexedAddress = (value: string): Hash => `0x${addressWord(value)}` as Hash;
const addressData = (value: string): string => `0x${addressWord(value)}`;

const recentBytes = encodeEvmLogObservation({
  kind: "evm-log",
  version: 1,
  blockNumber: source.number,
  blockHash: source.hash,
  transactionHash: h("recent-tx"),
  logIndex: "0",
  address: vault,
  topics: [ERC4626_WITHDRAW_TOPIC, indexedAddress(sender), indexedAddress(receiver), indexedAddress(owner)],
  data: `0x${word(10n)}${word(9n)}`,
});

const recentEvidence: RecentLogEvidenceRefV1 = Object.freeze({
  kind: "recent-log",
  version: 1,
  sourcePlanRef: null,
  ownerRef: null,
  blockNumber: source.number,
  blockHash: source.hash,
  txHash: h("recent-tx"),
  logIndex: "0",
  address: vault,
  topic: ERC4626_WITHDRAW_TOPIC,
  rawLocatorHash: sha256Hex(recentBytes),
});

function candidate(evidence: RecentLogEvidenceRefV1 | SourcePlanEvidenceRefV1): CanonicalJson {
  return canonical(mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "erc4626",
    familyDefinitionHash: ERC4626_FAMILY_AUTHORING_HASH,
    instanceNominationKey: vault,
    evidence,
  }])[0]!);
}

function prepare(
  definition: FamilyStageDefinitionV1,
  input: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0],
): { readonly payload: CanonicalJson; readonly requestIds: readonly Hash[] } {
  const payload = canonical(definition.payloadCodec.decodeExact(definition.prepareIssueValue(input)));
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("prepared payload must be an object");
  const record = payload as { readonly requestId?: unknown; readonly requestIds?: unknown };
  if (Array.isArray(record.requestIds)) return { payload, requestIds: record.requestIds as readonly Hash[] };
  if (typeof record.requestId === "string") return { payload, requestIds: [record.requestId as Hash] };
  throw new TypeError("prepared payload has no request ids");
}

function program(definition: FamilyStageDefinitionV1, payload: CanonicalJson, fingerprint: Hash): FrozenProgramEnvelopeV1 {
  return {
    schemaVersion: 1,
    kind: "aloha.frozen-program",
    envelopeSchemaRef: h("envelope"),
    payloadSchemaRef: definition.schemaHash,
    capabilityRef: {
      capabilityId: definition.capabilityId,
      version: definition.version,
      schemaHash: definition.schemaHash,
      interpreterHash: h("interpreter"),
      ownerRef: asOwnerRef(h("owner")),
    },
    issuerRef: asOwnerRef(h("issuer")),
    source,
    authorityHash: h("authority"),
    canonicalPayloadBytes: encodeCanonicalJson(payload),
    payloadHash: h("payload"),
    requestFingerprint: fingerprint,
  };
}

function returned(requestId: Hash, fingerprint: Hash, dataHex: string): TransportFactV1 {
  return { kind: "returned", requestId, requestFingerprint: fingerprint, dataHex, source: executorSource };
}

function interpret(
  definition: FamilyStageDefinitionV1,
  prepared: ReturnType<typeof prepare>,
  data: readonly string[],
  label: string,
) {
  const fingerprint = h(`${label}-program`);
  assert.equal(data.length, prepared.requestIds.length);
  return definition.interpret({
    program: program(definition, prepared.payload, fingerprint),
    payload: prepared.payload,
    facts: prepared.requestIds.map((requestId, index) => returned(requestId, fingerprint, data[index]!)),
    dependencyRefs: [],
    factSet: { factSetHash: h(`${label}-facts`) },
  });
}

function identityData(rawBytes: Uint8Array): readonly string[] {
  return [bytesHex(rawBytes), addressData(vault), addressData(vault), addressData(asset)];
}

function historyPhysical(input: {
  readonly physicalOwner?: Hash;
  readonly responseTarget?: string;
  readonly filterTopic?: Hash;
  readonly chunkBlocks?: string;
  readonly observationCutoff?: CanonicalCutoffV1;
  readonly data?: string;
}) {
  const physicalOwner = input.physicalOwner ?? h("history-owner");
  const responseTarget = input.responseTarget ?? vault;
  const filterTopic = input.filterTopic ?? ERC4626_WITHDRAW_TOPIC;
  const chunkBlocks = input.chunkBlocks ?? "10000";
  const observationCutoff = input.observationCutoff ?? source;
  const through = observationCutoff.number;
  const plan = Object.freeze({
    ownerRef: physicalOwner,
    sourcePlanRef: h("history-plan"),
    familyDefinitionHash: ERC4626_FAMILY_AUTHORING_HASH,
    completeness: "contiguous-history" as const,
    historyStartBlock: "0",
  });
  const response = Object.freeze([Object.freeze({
    address: responseTarget,
    blockHash: h("history-block"),
    blockNumber: "0x1",
    data: input.data ?? `0x${word(10n)}${word(9n)}`,
    logIndex: "0x0",
    removed: false,
    topics: Object.freeze([ERC4626_WITHDRAW_TOPIC, indexedAddress(sender), indexedAddress(receiver), indexedAddress(owner)]),
    transactionHash: h("history-tx"),
    transactionIndex: "0x0",
  })]);
  const requestId = h("history-request");
  const releaseBindingId = h("release-binding");
  const releaseProvenanceHash = h("release-provenance");
  const sourceAuthorityRoot = h("source-authority");
  const sourceAnchorRoot = h("source-anchor");
  const rawBytes = encodeCanonicalBytes({
    kind: "family-source-plan-physical-observation",
    version: 1,
    requestId,
    releaseBindingId,
    releaseProvenanceHash,
    sourceAuthorityRoot,
    sourceAnchorRoot,
    provider: "reth",
    backendEpoch: "1",
    familyDefinitionHash: ERC4626_FAMILY_AUTHORING_HASH,
    plan,
    cutoff: observationCutoff,
    requestSchemaHash: ERC4626_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
    request: {
      kind: "family-source-plan-rpc",
      version: 1,
      method: "eth_getLogs",
      params: [{ fromBlock: "0x0", toBlock: `0x${BigInt(through).toString(16)}`, topics: [filterTopic] }],
      target: null,
      manager: null,
      topic: ERC4626_WITHDRAW_TOPIC,
      lookback: { from: "0", through },
      chunk: { maxBlocks: chunkBlocks },
    },
    response,
  });
  const rawLocatorHash = sha256Hex(rawBytes);
  const evidenceRef = hashDomain("aloha/source-plan-physical-evidence/v1", {
    releaseBindingId,
    releaseProvenanceHash,
    sourceAuthorityRoot,
    sourceAnchorRoot,
    requestId,
    rawLocatorHash,
  });
  return Object.freeze({ plan, rawBytes, rawLocatorHash, evidenceRef });
}

function historyCandidate(
  physical: ReturnType<typeof historyPhysical>,
  evidenceOwner: Hash = physical.plan.ownerRef,
  evidenceRef: Hash = physical.evidenceRef,
): CanonicalJson {
  return candidate(Object.freeze({
    kind: "source-plan",
    version: 1,
    ownerRef: evidenceOwner,
    sourcePlanRef: physical.plan.sourcePlanRef,
    evidenceRef,
    rawLocatorHash: physical.rawLocatorHash,
  }));
}

test("ERC4626 recent raw evidence carries the candidate evidence root through publication", () => {
  const candidateValue = candidate(recentEvidence);
  const identityPrepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: candidateValue, cutoff: source, identityMemo: null, materializationOutput: null });
  const identity = interpret(ERC4626_IDENTITY_DEFINITION, identityPrepared, identityData(recentBytes), "recent-identity");
  assert.equal(identity.kind, "verified", JSON.stringify(identity));
  if (identity.kind !== "verified") return;
  assert.doesNotThrow(() => ERC4626_IDENTITY_DEFINITION.outputCodec.decodeExact(identity.output));
  const identityOutput = identity.output as { readonly identityMemo: CanonicalJson; readonly evidenceRoot: Hash };
  assert.equal(identityOutput.evidenceRoot, (candidateValue as { readonly candidateEvidenceRoot: Hash }).candidateEvidenceRoot);

  const materializationPrepared = prepare(ERC4626_MATERIALIZATION_DEFINITION, { stage: "materialization", candidate: candidateValue, cutoff: source, identityMemo: identityOutput.identityMemo, materializationOutput: null });
  const materialization = interpret(ERC4626_MATERIALIZATION_DEFINITION, materializationPrepared, [h("state-facts")], "materialization");
  assert.equal(materialization.kind, "verified", JSON.stringify(materialization));
  if (materialization.kind !== "verified") return;
  assert.doesNotThrow(() => ERC4626_MATERIALIZATION_DEFINITION.outputCodec.decodeExact(materialization.output));

  const projectionPrepared = prepare(ERC4626_PROJECTION_DEFINITION, { stage: "projection", candidate: candidateValue, cutoff: source, identityMemo: identityOutput.identityMemo, materializationOutput: materialization.output as CanonicalJson });
  const projection = interpret(ERC4626_PROJECTION_DEFINITION, projectionPrepared, [h("state-facts")], "projection");
  assert.equal(projection.kind, "verified", JSON.stringify(projection));
  if (projection.kind !== "verified") return;
  assert.equal((projection.output as { readonly evidenceRoot: Hash }).evidenceRoot, identityOutput.evidenceRoot);
  assert.doesNotThrow(() => ERC4626_PROJECTION_DEFINITION.outputCodec.decodeExact(projection.output));
  assert.throws(() => ERC4626_PROJECTION_DEFINITION.outputCodec.decodeExact({ ...projection.output as object, evidenceRoot: h("forged-root") }), /publication|hash/);
});

test("ERC4626 identity rejects a recent locator whose raw Withdraw bytes are malformed or spliced", () => {
  const candidateValue = candidate(recentEvidence);
  const prepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: candidateValue, cutoff: source, identityMemo: null, materializationOutput: null });
  const malformed = encodeEvmLogObservation({
    kind: "evm-log",
    version: 1,
    blockNumber: source.number,
    blockHash: source.hash,
    transactionHash: h("recent-tx"),
    logIndex: "0",
    address: vault,
    topics: [ERC4626_WITHDRAW_TOPIC, indexedAddress(sender), indexedAddress(receiver), indexedAddress(owner)],
    data: "0x",
  });
  assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, prepared, identityData(malformed), "recent-malformed").kind, "invalidProgram");
  assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, prepared, identityData(Uint8Array.from([...recentBytes, 0])), "recent-spliced").kind, "invalidProgram");
});

test("ERC4626 canonical zero-value Withdraw evidence remains admissible for reverse identity", () => {
  for (const [label, data] of [
    ["zero-assets", `0x${word(0n)}${word(9n)}`],
    ["zero-shares", `0x${word(10n)}${word(0n)}`],
  ] as const) {
    const raw = encodeEvmLogObservation({ kind: "evm-log", version: 1, blockNumber: source.number, blockHash: source.hash, transactionHash: h("recent-tx"), logIndex: "0", address: vault, topics: [ERC4626_WITHDRAW_TOPIC, indexedAddress(sender), indexedAddress(receiver), indexedAddress(owner)], data });
    const value = candidate(Object.freeze({ ...recentEvidence, rawLocatorHash: sha256Hex(raw) }));
    const prepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: value, cutoff: source, identityMemo: null, materializationOutput: null });
    assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, prepared, identityData(raw), label).kind, "verified");
    const history = historyPhysical({ data });
    const historyPrepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: historyCandidate(history), cutoff: source, identityMemo: null, materializationOutput: null });
    assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, historyPrepared, identityData(history.rawBytes), `history-${label}`).kind, "verified");
  }
});

test("ERC4626 complete-history identity binds owner, evidence receipt, filter, chunk and target", () => {
  const valid = historyPhysical({});
  const candidateValue = historyCandidate(valid);
  const prepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: candidateValue, cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, prepared, identityData(valid.rawBytes), "history-valid").kind, "verified");

  const ownerSplice = historyCandidate(valid, h("foreign-owner"));
  const ownerPrepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: ownerSplice, cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, ownerPrepared, identityData(valid.rawBytes), "history-owner-splice").kind, "invalidProgram");

  const evidenceSplice = historyCandidate(valid, valid.plan.ownerRef, h("foreign-evidence"));
  const evidencePrepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: evidenceSplice, cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, evidencePrepared, identityData(valid.rawBytes), "history-evidence-splice").kind, "invalidProgram");

  for (const [label, physical] of [
    ["filter", historyPhysical({ filterTopic: h("foreign-topic") })],
    ["chunk", historyPhysical({ chunkBlocks: "9999" })],
    ["target", historyPhysical({ responseTarget: address("9") })],
  ] as const) {
    const value = historyCandidate(physical);
    const valuePrepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: value, cutoff: source, identityMemo: null, materializationOutput: null });
    assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, valuePrepared, identityData(physical.rawBytes), `history-${label}`).kind, "invalidProgram");
  }
});

test("ERC4626 identity accepts durable predecessor evidence but rejects future or cross-chain history", () => {
  const old = historyPhysical({ observationCutoff: Object.freeze({ chainId: source.chainId, number: "99", hash: h("block-99"), stateRoot: h("state-99") }) });
  const oldPrepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: historyCandidate(old), cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, oldPrepared, identityData(old.rawBytes), "history-predecessor").kind, "verified");

  for (const [label, physical] of [
    ["future", historyPhysical({ observationCutoff: Object.freeze({ chainId: source.chainId, number: "101", hash: h("block-101"), stateRoot: h("state-101") }) })],
    ["cross-chain", historyPhysical({ observationCutoff: Object.freeze({ chainId: "10", number: "99", hash: h("chain-10-block-99"), stateRoot: h("chain-10-state-99") }) })],
  ] as const) {
    const prepared = prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: historyCandidate(physical), cutoff: source, identityMemo: null, materializationOutput: null });
    assert.equal(interpret(ERC4626_IDENTITY_DEFINITION, prepared, identityData(physical.rawBytes), `history-${label}`).kind, "invalidProgram");
  }
});

test("ERC4626 candidate subject and evidence roots cannot be self-consistently spliced into a stage", () => {
  const candidateValue = candidate(recentEvidence) as Record<string, CanonicalJson>;
  assert.throws(() => prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: { ...candidateValue, candidateSubjectHash: h("foreign-subject") }, cutoff: source, identityMemo: null, materializationOutput: null }), /candidate-subject/);
  assert.throws(() => prepare(ERC4626_IDENTITY_DEFINITION, { stage: "identity", candidate: { ...candidateValue, candidateEvidenceRoot: h("foreign-evidence-root") }, cutoff: source, identityMemo: null, materializationOutput: null }), /evidence-root/);
});
