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
import { mergeAndDedupeNominations, type RecentLogEvidenceRefV1, type SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { encodeEvmLogObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import {
  DODO_V2_FACTORIES,
  DODO_V2_FAMILY_AUTHORING_HASH,
  DODO_V2_FAMILY_ID,
  DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  DODO_V2_IDENTITY_DEFINITION,
  DODO_V2_MATERIALIZATION_DEFINITION,
  DODO_V2_PROJECTION_DEFINITION,
  DODO_V2_QUOTE_ACTOR,
  DODO_V2_SWAP_TOPIC,
} from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/dodo-runtime-definitions", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const pool = address("5");
const baseToken = address("1");
const quoteToken = address("2");
const creator = address("3");
const factory = DODO_V2_FACTORIES[0]!;
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const executorSource = Object.freeze({ ...source, blockNumber: source.number, blockHash: source.hash, executorAuthorityRoot: h("executor"), workerEpoch: "7", executorSessionHash: h("session") });
const bytesHex = (bytes: Uint8Array): string => `0x${Array.from(bytes).map(value => value.toString(16).padStart(2, "0")).join("")}`;
const canonical = (value: unknown): CanonicalJson => decodeCanonicalJson(encodeCanonicalJson(value));
const uintWord = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (value: string): string => `${"0".repeat(24)}${value.slice(2)}`;
const indexedAddress = (value: string): Hash => `0x${addressWord(value)}` as Hash;
const pmm = Object.freeze({ i: "2000000000000000000", K: "0", B: "1000", Q: "2000", B0: "1000", Q0: "2000", R: 0 as const });

const recentBytes = encodeEvmLogObservation({
  kind: "evm-log",
  version: 1,
  blockNumber: source.number,
  blockHash: source.hash,
  transactionHash: h("recent-tx"),
  logIndex: "0",
  address: pool,
  topics: [DODO_V2_SWAP_TOPIC, indexedAddress(baseToken), indexedAddress(quoteToken)],
  data: `0x${uintWord(100n)}${uintWord(99n)}`,
});
const recentEvidence: RecentLogEvidenceRefV1 = Object.freeze({ kind: "recent-log", version: 1, sourcePlanRef: null, ownerRef: null, blockNumber: source.number, blockHash: source.hash, txHash: h("recent-tx"), logIndex: "0", address: pool, topic: DODO_V2_SWAP_TOPIC, rawLocatorHash: sha256Hex(recentBytes) });

function candidate(evidence: RecentLogEvidenceRefV1 | SourcePlanEvidenceRefV1): CanonicalJson {
  return canonical(mergeAndDedupeNominations([{ kind: "aloha.candidate-nomination", version: "2", familyId: DODO_V2_FAMILY_ID, familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, instanceNominationKey: pool, evidence }])[0]!);
}

function identityFact(candidateValue: CanonicalJson, evidenceBytes: Uint8Array, registryPool = pool) {
  const subject = (candidateValue as { readonly candidateSubjectHash: Hash }).candidateSubjectHash;
  return Object.freeze({
    kind: "dodo-v2-identity-facts" as const,
    version: 1 as const,
    candidateSnapshotHash: subject,
    candidateEvidenceBytesHex: bytesHex(evidenceBytes),
    reads: Object.freeze({ cutoff: source, pool, factory: factory.address, registry: factory.address, registryPool, baseToken, quoteToken, quoteActor: DODO_V2_QUOTE_ACTOR, pmm, lpFeeRate: "100000000000000000", mtFeeRate: "0" }),
  });
}

function stateFact() {
  return Object.freeze({ kind: "dodo-v2-state-facts" as const, version: 1 as const, read: Object.freeze({ cutoff: source, pool, pmm, lpFeeRate: "100000000000000000", mtFeeRate: "0" }) });
}

function program(definition: FamilyStageDefinitionV1, requestFingerprint: Hash): FrozenProgramEnvelopeV1 {
  return { schemaVersion: 1, kind: "aloha.frozen-program", envelopeSchemaRef: h("envelope"), payloadSchemaRef: definition.schemaHash, capabilityRef: { capabilityId: definition.capabilityId, version: definition.version, schemaHash: definition.schemaHash, interpreterHash: h("interpreter"), ownerRef: asOwnerRef(h("owner")) }, issuerRef: asOwnerRef(h("issuer")), source, authorityHash: h("authority"), canonicalPayloadBytes: "null", payloadHash: h("payload"), requestFingerprint };
}

function returnedFact(requestId: Hash, requestFingerprint: Hash, value: unknown): TransportFactV1 {
  return { kind: "returned", requestId, requestFingerprint, dataHex: bytesHex(encodeCanonicalBytes(value)), source: executorSource };
}

function prepare(definition: FamilyStageDefinitionV1, input: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]) {
  const payload = canonical(definition.payloadCodec.decodeExact(definition.prepareIssueValue(input)));
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as { readonly requestId?: unknown }).requestId !== "string") throw new Error("fixture payload malformed");
  return { payload, requestId: (payload as { readonly requestId: Hash }).requestId };
}

function interpret(definition: FamilyStageDefinitionV1, payload: CanonicalJson, requestId: Hash, value: unknown, label: string) {
  const requestFingerprint = h(`${label}-program`);
  return definition.interpret({ program: program(definition, requestFingerprint), payload, facts: [returnedFact(requestId, requestFingerprint, value)], dependencyRefs: [], factSet: { factSetHash: h(`${label}-facts`) } });
}

function historyFixture(evidenceOwner: Hash, physicalOwner: Hash = evidenceOwner) {
  const plan = Object.freeze({ ownerRef: physicalOwner, sourcePlanRef: h("history-plan"), familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, completeness: "contiguous-history" as const, historyStartBlock: "0" });
  const response = Object.freeze([Object.freeze({ address: factory.address, blockHash: h("creation-block"), blockNumber: "0x1", data: `0x${addressWord(baseToken)}${addressWord(quoteToken)}${addressWord(creator)}${addressWord(pool)}`, logIndex: "0x0", removed: false, topics: Object.freeze([factory.creationTopic]), transactionHash: h("creation-tx"), transactionIndex: "0x0" })]);
  const filter = Object.freeze({ address: factory.address, fromBlock: "0x0", toBlock: "0x64", topics: Object.freeze([factory.creationTopic]) });
  const rawBytes = encodeCanonicalBytes({ kind: "family-source-plan-physical-observation", version: 1, requestId: h("history-request"), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "1", familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, plan, cutoff: source, requestSchemaHash: DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: [filter], target: factory.address, manager: factory.address, topic: factory.creationTopic, lookback: { from: "0", through: "100" }, chunk: { maxBlocks: "10000" } }, response });
  const evidence: SourcePlanEvidenceRefV1 = Object.freeze({ kind: "source-plan", version: 1, ownerRef: evidenceOwner, sourcePlanRef: plan.sourcePlanRef, evidenceRef: h("history-evidence"), rawLocatorHash: sha256Hex(rawBytes) });
  const candidateValue = candidate(evidence);
  return Object.freeze({ candidate: candidateValue, rawBytes, fact: identityFact(candidateValue, rawBytes) });
}

test("DODO runtime carries recent raw evidence through identity, materialization and publication", () => {
  const candidateValue = candidate(recentEvidence);
  const identityPrepared = prepare(DODO_V2_IDENTITY_DEFINITION, { stage: "identity", candidate: candidateValue, cutoff: source, identityMemo: null, materializationOutput: null });
  const identity = interpret(DODO_V2_IDENTITY_DEFINITION, identityPrepared.payload, identityPrepared.requestId, identityFact(candidateValue, recentBytes), "recent-identity");
  assert.equal(identity.kind, "verified", JSON.stringify(identity));
  if (identity.kind !== "verified") return;
  assert.doesNotThrow(() => DODO_V2_IDENTITY_DEFINITION.outputCodec.decodeExact(identity.output));
  const identityOutput = identity.output as { readonly identityMemo: CanonicalJson; readonly evidenceRoot: Hash };
  assert.equal(identityOutput.evidenceRoot, (candidateValue as { readonly candidateEvidenceRoot: Hash }).candidateEvidenceRoot);
  const materializationPrepared = prepare(DODO_V2_MATERIALIZATION_DEFINITION, { stage: "materialization", candidate: candidateValue, cutoff: source, identityMemo: identityOutput.identityMemo, materializationOutput: null });
  const materialization = interpret(DODO_V2_MATERIALIZATION_DEFINITION, materializationPrepared.payload, materializationPrepared.requestId, stateFact(), "materialization");
  assert.equal(materialization.kind, "verified", JSON.stringify(materialization));
  if (materialization.kind !== "verified") return;
  assert.doesNotThrow(() => DODO_V2_MATERIALIZATION_DEFINITION.outputCodec.decodeExact(materialization.output));
  const projectionPrepared = prepare(DODO_V2_PROJECTION_DEFINITION, { stage: "projection", candidate: candidateValue, cutoff: source, identityMemo: identityOutput.identityMemo, materializationOutput: materialization.output as CanonicalJson });
  const projection = interpret(DODO_V2_PROJECTION_DEFINITION, projectionPrepared.payload, projectionPrepared.requestId, stateFact(), "projection");
  assert.equal(projection.kind, "verified", JSON.stringify(projection));
  if (projection.kind === "verified") {
    assert.equal((projection.output as { readonly evidenceRoot: Hash }).evidenceRoot, identityOutput.evidenceRoot);
    assert.doesNotThrow(() => DODO_V2_PROJECTION_DEFINITION.outputCodec.decodeExact(projection.output));
    assert.throws(() => DODO_V2_PROJECTION_DEFINITION.outputCodec.decodeExact({ ...projection.output as object, evidenceRoot: h("forged-evidence-root") }), /publication lineage|publication-hash/);
  }
});

test("DODO strict identity consumes complete-history bytes and rejects forged lineage or a removed pool", () => {
  const valid = historyFixture(h("history-owner"));
  const prepared = prepare(DODO_V2_IDENTITY_DEFINITION, { stage: "identity", candidate: valid.candidate, cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal(interpret(DODO_V2_IDENTITY_DEFINITION, prepared.payload, prepared.requestId, valid.fact, "history-valid").kind, "verified");
  assert.equal(interpret(DODO_V2_IDENTITY_DEFINITION, prepared.payload, prepared.requestId, { ...valid.fact, candidateEvidenceBytesHex: `${valid.fact.candidateEvidenceBytesHex}00` }, "history-raw-forged").kind, "invalidProgram");
  const forgedOwner = historyFixture(h("evidence-owner"), h("physical-owner"));
  const forgedPrepared = prepare(DODO_V2_IDENTITY_DEFINITION, { stage: "identity", candidate: forgedOwner.candidate, cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal(interpret(DODO_V2_IDENTITY_DEFINITION, forgedPrepared.payload, forgedPrepared.requestId, forgedOwner.fact, "history-owner-forged").kind, "invalidProgram");
  const removed = interpret(DODO_V2_IDENTITY_DEFINITION, prepared.payload, prepared.requestId, identityFact(valid.candidate, valid.rawBytes, address("9")), "history-removed");
  assert.equal(removed.kind, "chainProvenRejected");
});
