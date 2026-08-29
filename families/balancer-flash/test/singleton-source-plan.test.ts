import assert from "node:assert/strict";
import test from "node:test";

import { encodeCanonicalBytes, encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { mergeAndDedupeNominations, sealSourceCoverage, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1, FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import {
  BALANCER_FLASH_FAMILY_AUTHORING_HASH,
  BALANCER_FLASH_SINGLETON_NOMINATION_PROGRAM,
  BALANCER_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME,
  BALANCER_FLASH_STAGE_DEFINITIONS,
  BALANCER_VAULT,
} from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/balancer-singleton-source", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block-100"), stateRoot: h("state-100") });
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: BALANCER_FLASH_FAMILY_AUTHORING_HASH, completeness: "complete-snapshot", historyStartBlock: null });
const address = (digit: string) => `0x${digit.repeat(40)}`;
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
const bytesHex = (value: Uint8Array) => `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;

function recent() {
  const blocks = [];
  let parentHash = h("block-50");
  for (let number = 51; number <= 100; number += 1) {
    const hash = number === 100 ? cutoff.hash : h(`block-${number}`);
    blocks.push({ number: String(number), hash, parentHash, evidence: [] });
    parentHash = hash;
  }
  return sealRecentObservation(cutoff, { from: "51", to: "100" }, blocks, []);
}

function physical(response: CanonicalJson, mutate?: (observation: Record<string, unknown>) => void): FamilySourcePlanPhysicalPortV1 {
  return Object.freeze({
    async request(request: FamilySourcePlanPhysicalRequestV1) {
      const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h("request"), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch-1", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response };
      mutate?.(observation);
      const bytes = encodeCanonicalBytes(observation);
      const rawLocatorHash = sha256Hex(bytes);
      return Object.freeze({ response, rawLocatorHash, evidenceRef: h("evidence"), rawEvidenceLocator: Object.freeze({ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash, bytes }) });
    },
  });
}

function program(definition: FamilyStageDefinitionV1, payload: unknown, requestFingerprint: Hash): FrozenProgramEnvelopeV1 {
  return { schemaVersion: 1, kind: "aloha.frozen-program", envelopeSchemaRef: h("envelope-schema"), payloadSchemaRef: definition.schemaHash, capabilityRef: { capabilityId: definition.capabilityId, version: definition.version, schemaHash: definition.schemaHash, interpreterHash: h(`${definition.stage}-interpreter`), ownerRef: h("owner") as never }, issuerRef: h("issuer") as never, source: cutoff, authorityHash: h("authority"), canonicalPayloadBytes: encodeCanonicalJson(payload), payloadHash: h(`${definition.stage}-payload`), requestFingerprint };
}
function fact(requestId: Hash, requestFingerprint: Hash, dataHex: string): TransportFactV1 {
  return { kind: "returned", requestId, requestFingerprint, dataHex, source: { chainId: cutoff.chainId, blockNumber: cutoff.number, blockHash: cutoff.hash, stateRoot: cutoff.stateRoot, executorAuthorityRoot: h("executor-authority"), workerEpoch: "epoch-1", executorSessionHash: h("executor-session") } };
}
function reserveWords(left: bigint, right: bigint): string { return `0x${left.toString(16).padStart(64, "0")}${right.toString(16).padStart(64, "0")}`; }

function runIdentity(definition: FamilyStageDefinitionV1, payload: unknown, evidenceBytes: Uint8Array): Record<string, unknown> {
  const decoded = definition.payloadCodec.decodeExact(payload) as { readonly requestIds: readonly Hash[] };
  const requestFingerprint = h("identity-program");
  const values = [addressWord(BALANCER_VAULT), addressWord(BALANCER_VAULT), addressWord(address("1")), addressWord(address("2")), bytesHex(evidenceBytes)];
  const facts = decoded.requestIds.map((requestId, index) => fact(requestId, requestFingerprint, values[index]!));
  const draft = definition.interpret({ program: program(definition, payload, requestFingerprint), payload: payload as CanonicalJson, facts, dependencyRefs: [], factSet: { factSetHash: h("identity-fact-set") } });
  if (draft.kind !== "verified") throw new Error(`expected identity verification: ${JSON.stringify(draft)}`);
  return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

function runOne(definition: FamilyStageDefinitionV1, payload: unknown, dataHex: string): Record<string, unknown> {
  const decoded = definition.payloadCodec.decodeExact(payload) as { readonly requestId: Hash };
  const requestFingerprint = h(`${definition.stage}-program`);
  const draft = definition.interpret({ program: program(definition, payload, requestFingerprint), payload: payload as CanonicalJson, facts: [fact(decoded.requestId, requestFingerprint, dataHex)], dependencyRefs: [], factSet: { factSetHash: h(`${definition.stage}-fact-set`) } });
  if (draft.kind !== "verified") throw new Error(`expected ${definition.stage} verification: ${JSON.stringify(draft)}`);
  return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

test("Balancer Vault snapshot contributes omission authority and nominates without a recent FlashLoan", async () => {
  const result = await BALANCER_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical("0x60006000"), new AbortController().signal);
  assert.equal(result.execution.outcome, "complete");
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(item => [item.rawLocatorHash, item.bytes]));
  const nominations = await BALANCER_FLASH_SINGLETON_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } } }, new AbortController().signal);
  assert.equal(nominations.length, 1);
  assert.equal(nominations[0]!.instanceNominationKey, BALANCER_VAULT);
  assert.equal(nominations[0]!.evidence.kind, "source-plan");

  const candidate = mergeAndDedupeNominations(nominations)[0]!;
  const identityDefinition = BALANCER_FLASH_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const identityPayload = identityDefinition.prepareIssueValue({ stage: "identity", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: null, materializationOutput: null });
  const evidenceBytes = raw.get(nominations[0]!.evidence.rawLocatorHash)!;
  const identity = runIdentity(identityDefinition, identityPayload, evidenceBytes);
  assert.equal(identity.evidenceRoot, candidate.candidateEvidenceRoot);
  assert.equal((identity.identityMemo as { readonly candidateEvidenceRoot: Hash }).candidateEvidenceRoot, candidate.candidateEvidenceRoot);

  const materializationDefinition = BALANCER_FLASH_STAGE_DEFINITIONS.find(item => item.stage === "materialization")!;
  const materializationPayload = materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: null });
  const state = reserveWords(1000n, 1000n);
  const materialization = runOne(materializationDefinition, materializationPayload, state);
  const projectionDefinition = BALANCER_FLASH_STAGE_DEFINITIONS.find(item => item.stage === "projection")!;
  const projectionPayload = projectionDefinition.prepareIssueValue({ stage: "projection", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: materialization as CanonicalJson });
  const publication = runOne(projectionDefinition, projectionPayload, state);
  assert.equal(publication.evidenceRoot, candidate.candidateEvidenceRoot);
});

test("Balancer Vault snapshot proves a valid zero-instance partition when code is absent", async () => {
  const result = await BALANCER_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical("0x"), new AbortController().signal);
  const raw = new Map(result.rawEvidenceLocators.map(item => [item.rawLocatorHash, item.bytes]));
  const nominations = await BALANCER_FLASH_SINGLETON_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } } }, new AbortController().signal);
  assert.deepEqual(nominations, []);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
});

test("Balancer Vault snapshot rejects a physical request splice", async () => {
  await assert.rejects(() => BALANCER_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical("0x6000", observation => { const request = observation.request as Record<string, unknown>; observation.request = { ...request, target: address("9") }; }), new AbortController().signal), /physical observation binding mismatch/);
});
