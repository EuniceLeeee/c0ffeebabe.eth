import assert from "node:assert/strict";
import test from "node:test";

import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { mergeAndDedupeNominations, sealSourceCoverage, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1, FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import {
  MORPHO_BLUE_SINGLETON,
  MORPHO_FLASH_FAMILY_AUTHORING_HASH,
  MORPHO_FLASH_SINGLETON_NOMINATION_PROGRAM,
  MORPHO_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME,
  MORPHO_FLASH_STAGE_DEFINITIONS,
} from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/morpho-singleton-source", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block-100"), stateRoot: h("state-100") });
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: MORPHO_FLASH_FAMILY_AUTHORING_HASH, completeness: "complete-snapshot", historyStartBlock: null });
const address = (digit: string) => `0x${digit.repeat(40)}`;

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

function physical(response: CanonicalJson, mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1) => void): FamilySourcePlanPhysicalPortV1 {
  return Object.freeze({
    async request(request: FamilySourcePlanPhysicalRequestV1) {
      const observation: Record<string, unknown> = {
        kind: "family-source-plan-physical-observation",
        version: 1,
        requestId: h("request"),
        releaseBindingId: h("release-binding"),
        releaseProvenanceHash: h("release-provenance"),
        sourceAuthorityRoot: h("source-authority"),
        sourceAnchorRoot: h("source-anchor"),
        provider: "reth",
        backendEpoch: "epoch-1",
        familyDefinitionHash: request.familyDefinitionHash,
        plan: request.plan,
        cutoff: request.cutoff,
        requestSchemaHash: request.requestSchemaHash,
        request: request.request,
        response,
      };
      mutate?.(observation, request);
      const bytes = encodeCanonicalBytes(observation);
      const rawLocatorHash = sha256Hex(bytes);
      return Object.freeze({ response, rawLocatorHash, evidenceRef: h("evidence"), rawEvidenceLocator: Object.freeze({ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash, bytes }) });
    },
  });
}

function dataHex(value: CanonicalJson): string {
  return `0x${[...encodeCanonicalBytes(value)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function runStage(definition: FamilyStageDefinitionV1, payload: unknown, factValue: CanonicalJson): Record<string, unknown> {
  const decoded = definition.payloadCodec.decodeExact(payload) as { readonly requestId: Hash };
  const requestFingerprint = h(`${definition.stage}-program`);
  const program: FrozenProgramEnvelopeV1 = { schemaVersion: 1, kind: "aloha.frozen-program", envelopeSchemaRef: h("envelope-schema"), payloadSchemaRef: h("payload-schema") as never, capabilityRef: {} as never, issuerRef: h("issuer") as never, source: cutoff, authorityHash: h("authority"), canonicalPayloadBytes: "{}", payloadHash: h("payload"), requestFingerprint };
  const fact: TransportFactV1 = { kind: "returned", requestId: decoded.requestId, requestFingerprint, dataHex: dataHex(factValue), source: { chainId: cutoff.chainId, blockNumber: cutoff.number, blockHash: cutoff.hash, stateRoot: cutoff.stateRoot, executorAuthorityRoot: h("executor-authority"), workerEpoch: "epoch-1", executorSessionHash: h("executor-session") } };
  const draft = definition.interpret({ program, payload: payload as CanonicalJson, facts: [fact], dependencyRefs: [], factSet: { factSetHash: h("fact-set") } });
  if (draft.kind !== "verified") throw new Error(`expected ${definition.stage} verification: ${JSON.stringify(draft)}`);
  return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

test("Morpho singleton snapshot contributes omission authority and nominates without a recent FlashLoan", async () => {
  const result = await MORPHO_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical("0x60006000"), new AbortController().signal);
  assert.equal(result.execution.outcome, "complete");
  assert.equal(result.execution.from, cutoff.number);
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.sourceEvidence.refs.length, 1);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(item => [item.rawLocatorHash, item.bytes]));
  const nominations = await MORPHO_FLASH_SINGLETON_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } } }, new AbortController().signal);
  assert.equal(nominations.length, 1);
  assert.equal(nominations[0]!.instanceNominationKey, MORPHO_BLUE_SINGLETON.toLowerCase());
  assert.equal(nominations[0]!.evidence.kind, "source-plan");

  const candidates = mergeAndDedupeNominations(nominations);
  const candidate = candidates[0]!;
  const identityDefinition = MORPHO_FLASH_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const identityPayload = identityDefinition.prepareIssueValue({ stage: "identity", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: null, materializationOutput: null });
  const evidenceBytes = raw.get(nominations[0]!.evidence.rawLocatorHash)!;
  const identity = runStage(identityDefinition, identityPayload, {
    kind: "morpho-flash-identity-facts",
    version: 1,
    candidateSnapshotHash: candidate.candidateSubjectHash,
    candidateEvidenceBytesHex: dataHex(JSON.parse(new TextDecoder().decode(evidenceBytes)) as CanonicalJson),
    reads: { cutoff, target: MORPHO_BLUE_SINGLETON, reverseLender: MORPHO_BLUE_SINGLETON, asset: address("1"), receiver: address("2"), assetHasCode: true, receiverHasCode: true, feeBps: "0" },
  });
  assert.equal(identity.evidenceRoot, candidate.candidateEvidenceRoot);
  assert.equal((identity.identityMemo as { readonly candidateEvidenceRoot: Hash }).candidateEvidenceRoot, candidate.candidateEvidenceRoot);

  const materializationDefinition = MORPHO_FLASH_STAGE_DEFINITIONS.find(item => item.stage === "materialization")!;
  const materializationPayload = materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: null });
  const instanceKey = (identity.identityMemo as { readonly identity: { readonly instanceKey: Hash } }).identity.instanceKey;
  const materialization = runStage(materializationDefinition, materializationPayload, { cutoff, instanceKey, availableLiquidity: "1000" });
  const projectionDefinition = MORPHO_FLASH_STAGE_DEFINITIONS.find(item => item.stage === "projection")!;
  const projectionPayload = projectionDefinition.prepareIssueValue({ stage: "projection", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: materialization as CanonicalJson });
  const publication = runStage(projectionDefinition, projectionPayload, { cutoff, instanceKey, availableLiquidity: "1000" });
  assert.equal(publication.evidenceRoot, candidate.candidateEvidenceRoot);
});

test("Morpho singleton snapshot proves a valid zero-instance partition when code is absent", async () => {
  const result = await MORPHO_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical("0x"), new AbortController().signal);
  const raw = new Map(result.rawEvidenceLocators.map(item => [item.rawLocatorHash, item.bytes]));
  const nominations = await MORPHO_FLASH_SINGLETON_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } } }, new AbortController().signal);
  assert.deepEqual(nominations, []);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
});

test("Morpho singleton snapshot rejects a physical request/response splice", async () => {
  await assert.rejects(() => MORPHO_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical("0x6000", observation => { const request = observation.request as Record<string, unknown>; observation.request = { ...request, target: address("9") }; }), new AbortController().signal), /physical observation binding mismatch/);
});
