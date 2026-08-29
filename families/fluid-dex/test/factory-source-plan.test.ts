import assert from "node:assert/strict";
import test from "node:test";

import { encodeCanonicalBytes, encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { mergeAndDedupeNominations, sealSourceCoverage, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1, FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { FLUID_DEX_FACTORY, FLUID_DEX_FACTORY_NOMINATION_PROGRAM, FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME, FLUID_DEX_FAMILY_AUTHORING_HASH, FLUID_DEX_STAGE_DEFINITIONS } from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/fluid-dex-factory", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: FLUID_DEX_FAMILY_AUTHORING_HASH, completeness: "complete-snapshot", historyStartBlock: null });
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const addr = (digit: string) => `0x${digit.repeat(40)}`;
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;
function recent() { const blocks = []; let parentHash = h("block-50"); for (let number = 51; number <= 100; number += 1) { const hash = number === 100 ? cutoff.hash : h(`block-${number}`); blocks.push({ number: String(number), hash, parentHash, evidence: [] }); parentHash = hash; } return sealRecentObservation(cutoff, { from: "51", to: "100" }, blocks, []); }
function physical(responses: readonly CanonicalJson[], mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1, index: number) => void): FamilySourcePlanPhysicalPortV1 { let index = 0; return Object.freeze({ async request(request: FamilySourcePlanPhysicalRequestV1) { const response = responses[index++]!; const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h(`request-${index}`), releaseBindingId: h("release"), releaseProvenanceHash: h("provenance"), sourceAuthorityRoot: h("authority"), sourceAnchorRoot: h("anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }; mutate?.(observation, request, index); const bytes = encodeCanonicalBytes(observation); const rawLocatorHash = sha256Hex(bytes); return Object.freeze({ response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: Object.freeze({ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash, bytes }) }); } }); }
const bytesHex = (value: Uint8Array) => `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
function runStage(definition: FamilyStageDefinitionV1, payload: unknown, dataHexes: readonly string[]): Record<string, unknown> {
  const decoded = definition.payloadCodec.decodeExact(payload) as { readonly requestId?: Hash; readonly requestIds?: readonly Hash[] };
  const ids = decoded.requestIds ?? (decoded.requestId === undefined ? [] : [decoded.requestId]);
  assert.equal(dataHexes.length, ids.length);
  const requestFingerprint = h(`${definition.stage}-program`);
  const program: FrozenProgramEnvelopeV1 = { schemaVersion: 1, kind: "aloha.frozen-program", envelopeSchemaRef: h("envelope"), payloadSchemaRef: definition.schemaHash, capabilityRef: { capabilityId: definition.capabilityId, version: definition.version, schemaHash: definition.schemaHash, interpreterHash: h("interpreter"), ownerRef: h("owner") as never }, issuerRef: h("issuer") as never, source: cutoff, authorityHash: h("authority"), canonicalPayloadBytes: encodeCanonicalJson(payload), payloadHash: h("payload"), requestFingerprint };
  const facts: readonly TransportFactV1[] = ids.map((requestId, index) => ({ kind: "returned" as const, requestId, requestFingerprint, dataHex: dataHexes[index]!, source: { chainId: cutoff.chainId, blockNumber: cutoff.number, blockHash: cutoff.hash, stateRoot: cutoff.stateRoot, executorAuthorityRoot: h("executor"), workerEpoch: "epoch", executorSessionHash: h("session") } }));
  const draft = definition.interpret({ program, payload: payload as CanonicalJson, facts, dependencyRefs: [], factSet: { factSetHash: h("fact-set") } });
  if (draft.kind !== "verified") throw new Error(`expected ${definition.stage} verified: ${JSON.stringify(draft)}`);
  return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

test("Fluid DEX factory snapshot enumerates 1..N and supplies omission authority", async () => {
  const dexes = [addr("1"), addr("2")];
  const result = await FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(2n), ...dexes.map(addressWord)]), new AbortController().signal);
  assert.deepEqual((result.execution.opaqueResult as { readonly dexes: readonly string[] }).dexes, dexes);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const nominations = await FLUID_DEX_FACTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), dexes);
  assert.ok(nominations.every(value => value.evidence.kind === "source-plan"));

  const candidate = mergeAndDedupeNominations(nominations)[0]!;
  const identityDefinition = FLUID_DEX_STAGE_DEFINITIONS.find(value => value.stage === "identity")!;
  const identityPayload = identityDefinition.prepareIssueValue({ stage: "identity", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: null, materializationOutput: null });
  const selectedDex = candidate.instanceNominationKey;
  const selectedEvidence = candidate.evidence.find(value => value.kind === "source-plan")!;
  const evidenceBytes = raw.get(selectedEvidence.rawLocatorHash)!;
  const identity = runStage(identityDefinition, identityPayload, [addressWord(selectedDex), addressWord(selectedDex), addressWord(addr("3")), addressWord(addr("4")), bytesHex(evidenceBytes)]);
  assert.equal(identity.evidenceRoot, candidate.candidateEvidenceRoot);
  const materializationDefinition = FLUID_DEX_STAGE_DEFINITIONS.find(value => value.stage === "materialization")!;
  const materializationPayload = materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: null });
  const reserveWords = `${word(10_000n)}${word(20_000n).slice(2)}`;
  const materialization = runStage(materializationDefinition, materializationPayload, [reserveWords]);
  const projectionDefinition = FLUID_DEX_STAGE_DEFINITIONS.find(value => value.stage === "projection")!;
  const projectionPayload = projectionDefinition.prepareIssueValue({ stage: "projection", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: materialization as CanonicalJson });
  const publication = runStage(projectionDefinition, projectionPayload, [reserveWords]);
  assert.equal(publication.evidenceRoot, candidate.candidateEvidenceRoot);
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identity, evidenceRoot: h("forged") }), /identity output evidence mismatch/);
  const forgedEvidenceBytes = new Uint8Array(evidenceBytes); forgedEvidenceBytes[forgedEvidenceBytes.length - 1] ^= 1;
  assert.throws(() => runStage(identityDefinition, identityPayload, [addressWord(selectedDex), addressWord(selectedDex), addressWord(addr("3")), addressWord(addr("4")), bytesHex(forgedEvidenceBytes)]), /identity-invalid|raw-locator/);
  assert.throws(() => identityDefinition.prepareIssueValue({ stage: "identity", candidate: { ...candidate, candidateEvidenceRoot: h("forged-root") } as unknown as CanonicalJson, cutoff, identityMemo: null, materializationOutput: null }), /evidence-root-mismatch/);
});

test("Fluid DEX factory empty snapshot is a valid complete zero partition", async () => { const result = await FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(0n)]), new AbortController().signal); assert.deepEqual((result.execution.opaqueResult as { readonly dexes: readonly string[] }).dexes, []); assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true); });

test("Fluid DEX factory rejects duplicate addresses, index splice, and missing evidence", async () => {
  const dex = addr("1"); await assert.rejects(() => FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(2n), addressWord(dex), addressWord(dex)]), new AbortController().signal), /duplicate dexes/); await assert.rejects(() => FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(1n), addressWord(dex)], (observation, request, index) => { if (index === 2) observation.request = { ...request.request, params: [{ to: FLUID_DEX_FACTORY, data: `0x12e366aa${word(2n).slice(2)}` }, "0x64"] }; }), new AbortController().signal), /physical observation binding mismatch/);
  const result = await FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(1n), addressWord(dex)]), new AbortController().signal); const refs = Object.freeze(result.sourceEvidence.refs.slice(0, 1)); const rawLocatorHashes = Object.freeze(refs.map(ref => ref.rawLocatorHash)); const evidenceBase = { plan: result.sourceEvidence.plan, cutoff: result.sourceEvidence.cutoff, refs, rawLocatorHashes }; const sourceEvidence = Object.freeze({ ...result.sourceEvidence, ...evidenceBase, evidenceRoot: sourcePlanEvidenceRoot(evidenceBase) }); const { executionRoot: _old, ...oldExecution } = result.execution; const executionBase = { ...oldExecution, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: sourceEvidence.evidenceRoot }; const execution = Object.freeze({ ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) }); const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes])); await assert.rejects(() => FLUID_DEX_FACTORY_NOMINATION_PROGRAM.evaluate({ execution, sourceEvidence, recent: recent(), rawEvidence: { read(hash) { return raw.get(hash)!; } } }, new AbortController().signal), /evidence cardinality mismatch/);
});
