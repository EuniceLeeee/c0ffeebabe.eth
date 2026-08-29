import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalBytes, encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import { mergeAndDedupeNominations, type CandidateEvidenceRefV1, type SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { encodeEvmLogObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { EIGENPIE_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { EIGENPIE_ASSET_DEPOSIT_TOPIC, EIGENPIE_FAMILY_ID, EIGENPIE_HISTORY_SOURCE_PLAN_SCHEMA_HASH } from "../src/manifest.ts";
import { EIGENPIE_IDENTITY_DEFINITION, EIGENPIE_MATERIALIZATION_DEFINITION, EIGENPIE_PROJECTION_DEFINITION } from "../src/runtime/definitions.ts";

const h = (value: string): Hash => hashDomain("test/eigenpie-runtime/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const target = address("5"); const inputAsset = address("1"); const outputAsset = address("2");
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const executorSource = Object.freeze({ chainId: source.chainId, blockNumber: source.number, blockHash: source.hash, stateRoot: source.stateRoot, executorAuthorityRoot: h("executor"), workerEpoch: "1", executorSessionHash: h("session") });
const canonical = (value: unknown): CanonicalJson => decodeCanonicalJson(encodeCanonicalJson(value));
const bytesHex = (value: Uint8Array): string => `0x${Array.from(value).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressTopic = (value: string): Hash => `0x${value.slice(2).padStart(64, "0")}` as Hash;

const recentBytes = encodeEvmLogObservation({ kind: "evm-log", version: 1, blockNumber: "100", blockHash: source.hash, transactionHash: h("tx"), logIndex: "0", address: target, topics: [EIGENPIE_ASSET_DEPOSIT_TOPIC, addressTopic(address("3")), addressTopic(inputAsset), addressTopic(address("4"))], data: `0x${word(10n)}${word(9n)}${word(0n)}` });
const recentEvidence = Object.freeze({ kind: "recent-log" as const, version: 1 as const, sourcePlanRef: null, ownerRef: null, blockNumber: "100", blockHash: source.hash, txHash: h("tx"), logIndex: "0", address: target, topic: EIGENPIE_ASSET_DEPOSIT_TOPIC, rawLocatorHash: sha256Hex(recentBytes) });

function candidate(evidence: CandidateEvidenceRefV1): CanonicalJson { return canonical(mergeAndDedupeNominations([{ kind: "aloha.candidate-nomination", version: "2", familyId: EIGENPIE_FAMILY_ID, familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, instanceNominationKey: target, evidence }])[0]!); }
function identityFact(candidateValue: CanonicalJson, raw: Uint8Array) { return Object.freeze({ kind: "eigenpie-identity-facts", version: 1, candidateSnapshotHash: (candidateValue as { readonly candidateSubjectHash: Hash }).candidateSubjectHash, candidateEvidenceBytesHex: bytesHex(raw), reads: Object.freeze({ cutoff: source, target, reverseTarget: target, inputAsset, outputAsset }) }); }
function program(definition: FamilyStageDefinitionV1, fingerprint: Hash, payload: CanonicalJson): FrozenProgramEnvelopeV1 { return { schemaVersion: 1, kind: "aloha.frozen-program", envelopeSchemaRef: h("envelope"), payloadSchemaRef: definition.schemaHash, capabilityRef: { capabilityId: definition.capabilityId, version: definition.version, schemaHash: definition.schemaHash, interpreterHash: h("interpreter"), ownerRef: asOwnerRef(h("owner")) }, issuerRef: asOwnerRef(h("issuer")), source, authorityHash: h("authority"), canonicalPayloadBytes: encodeCanonicalJson(payload), payloadHash: h("payload"), requestFingerprint: fingerprint }; }
function prepare(definition: FamilyStageDefinitionV1, input: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]) { const payload = canonical(definition.payloadCodec.decodeExact(definition.prepareIssueValue(input))); return { payload, requestId: (payload as { readonly requestId: Hash }).requestId }; }
function interpret(definition: FamilyStageDefinitionV1, prepared: { readonly payload: CanonicalJson; readonly requestId: Hash }, dataHex: string, label: string) { const fingerprint = h(`${label}-program`); const fact: TransportFactV1 = { kind: "returned", requestId: prepared.requestId, requestFingerprint: fingerprint, dataHex, source: executorSource }; return definition.interpret({ program: program(definition, fingerprint, prepared.payload), payload: prepared.payload, facts: [fact], dependencyRefs: [], factSet: { factSetHash: h(`${label}-facts`) } }); }

function history(owner: Hash, physicalOwner = owner) { const plan = Object.freeze({ ownerRef: physicalOwner, sourcePlanRef: h("history-plan"), familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, completeness: "contiguous-history" as const, historyStartBlock: "0" }); const response = Object.freeze([{ address: target, blockHash: h("creation-block"), blockNumber: "0x1", data: `0x${word(10n)}${word(9n)}${word(0n)}`, logIndex: "0x0", removed: false, topics: Object.freeze([EIGENPIE_ASSET_DEPOSIT_TOPIC, addressTopic(address("3")), addressTopic(inputAsset), addressTopic(address("4"))]), transactionHash: h("creation-tx"), transactionIndex: "0x0" }]); const filter = Object.freeze({ fromBlock: "0x0", toBlock: "0x64", topics: Object.freeze([EIGENPIE_ASSET_DEPOSIT_TOPIC]) }); const raw = encodeCanonicalBytes({ kind: "family-source-plan-physical-observation", version: 1, requestId: h("history-request"), releaseBindingId: h("release"), releaseProvenanceHash: h("provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("anchor"), provider: "reth", backendEpoch: "1", familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, plan, cutoff: source, requestSchemaHash: EIGENPIE_HISTORY_SOURCE_PLAN_SCHEMA_HASH, request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: [filter], target: null, manager: null, topic: EIGENPIE_ASSET_DEPOSIT_TOPIC, lookback: { from: "0", through: "100" }, chunk: { maxBlocks: "10000" } }, response }); const evidence: SourcePlanEvidenceRefV1 = Object.freeze({ kind: "source-plan", version: 1, ownerRef: owner, sourcePlanRef: plan.sourcePlanRef, evidenceRef: h("history-evidence"), rawLocatorHash: sha256Hex(raw) }); const candidateValue = candidate(evidence); return { candidateValue, raw }; }

test("Eigenpie runtime carries raw evidence root through identity, materialization and publication", () => {
  const candidateValue = candidate(recentEvidence);
  const identityPrepared = prepare(EIGENPIE_IDENTITY_DEFINITION, { stage: "identity", candidate: candidateValue, cutoff: source, identityMemo: null, materializationOutput: null });
  const identity = interpret(EIGENPIE_IDENTITY_DEFINITION, identityPrepared, bytesHex(encodeCanonicalBytes(identityFact(candidateValue, recentBytes))), "identity"); assert.equal(identity.kind, "verified", JSON.stringify(identity)); if (identity.kind !== "verified") return;
  const identityOutput = identity.output as { readonly identityMemo: CanonicalJson; readonly evidenceRoot: Hash }; assert.equal(identityOutput.evidenceRoot, (candidateValue as { readonly candidateEvidenceRoot: Hash }).candidateEvidenceRoot);
  const materializationPrepared = prepare(EIGENPIE_MATERIALIZATION_DEFINITION, { stage: "materialization", candidate: candidateValue, cutoff: source, identityMemo: identityOutput.identityMemo, materializationOutput: null });
  const materialization = interpret(EIGENPIE_MATERIALIZATION_DEFINITION, materializationPrepared, (identityOutput.identityMemo as { readonly identity: { readonly factsHash: Hash } }).identity.factsHash, "materialization"); assert.equal(materialization.kind, "verified", JSON.stringify(materialization)); if (materialization.kind !== "verified") return;
  const projectionPrepared = prepare(EIGENPIE_PROJECTION_DEFINITION, { stage: "projection", candidate: candidateValue, cutoff: source, identityMemo: identityOutput.identityMemo, materializationOutput: materialization.output as CanonicalJson });
  const projection = interpret(EIGENPIE_PROJECTION_DEFINITION, projectionPrepared, (identityOutput.identityMemo as { readonly identity: { readonly factsHash: Hash } }).identity.factsHash, "projection"); assert.equal(projection.kind, "verified", JSON.stringify(projection)); if (projection.kind !== "verified") return;
  assert.equal((projection.output as { readonly evidenceRoot: Hash }).evidenceRoot, identityOutput.evidenceRoot);
  assert.throws(() => EIGENPIE_PROJECTION_DEFINITION.outputCodec.decodeExact({ ...(projection.output as object), evidenceRoot: h("forged") }), /publication/);
});

test("Eigenpie identity accepts history bytes and rejects raw, owner, subject and evidence-root splices", () => {
  const valid = history(h("owner")); const prepared = prepare(EIGENPIE_IDENTITY_DEFINITION, { stage: "identity", candidate: valid.candidateValue, cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal(interpret(EIGENPIE_IDENTITY_DEFINITION, prepared, bytesHex(encodeCanonicalBytes(identityFact(valid.candidateValue, valid.raw))), "history").kind, "verified");
  assert.equal(interpret(EIGENPIE_IDENTITY_DEFINITION, prepared, bytesHex(encodeCanonicalBytes(identityFact(valid.candidateValue, new Uint8Array([...valid.raw, 0])))), "raw-splice").kind, "invalidProgram");
  const ownerSplice = history(h("evidence-owner"), h("physical-owner")); const ownerPrepared = prepare(EIGENPIE_IDENTITY_DEFINITION, { stage: "identity", candidate: ownerSplice.candidateValue, cutoff: source, identityMemo: null, materializationOutput: null }); assert.equal(interpret(EIGENPIE_IDENTITY_DEFINITION, ownerPrepared, bytesHex(encodeCanonicalBytes(identityFact(ownerSplice.candidateValue, ownerSplice.raw))), "owner-splice").kind, "invalidProgram");
  assert.throws(() => EIGENPIE_IDENTITY_DEFINITION.prepareIssueValue({ stage: "identity", candidate: { ...(valid.candidateValue as object), candidateSubjectHash: h("subject-splice") } as CanonicalJson, cutoff: source, identityMemo: null, materializationOutput: null }), /subject/);
  assert.throws(() => EIGENPIE_IDENTITY_DEFINITION.prepareIssueValue({ stage: "identity", candidate: { ...(valid.candidateValue as object), candidateEvidenceRoot: h("root-splice") } as CanonicalJson, cutoff: source, identityMemo: null, materializationOutput: null }), /evidence-root/);
});
