import assert from "node:assert/strict";
import test from "node:test";

import { encodeCanonicalBytes, encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { mergeAndDedupeNominations, sealSourceCoverage, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1, FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { FLUID_CREDIT_FACTORY_NOMINATION_PROGRAM, FLUID_CREDIT_FACTORY_SOURCE_PLAN_RUNTIME, FLUID_CREDIT_FAMILY_AUTHORING_HASH, FLUID_CREDIT_PROBE_ACTOR, FLUID_CREDIT_STAGE_DEFINITIONS, FLUID_VAULT_FACTORY } from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/fluid-credit-factory", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: FLUID_CREDIT_FAMILY_AUTHORING_HASH, completeness: "complete-snapshot", historyStartBlock: null });
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const addr = (digit: string) => `0x${digit.repeat(40)}`;
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;

function recent() {
  const blocks = []; let parentHash = h("block-50");
  for (let number = 51; number <= 100; number += 1) { const hash = number === 100 ? cutoff.hash : h(`block-${number}`); blocks.push({ number: String(number), hash, parentHash, evidence: [] }); parentHash = hash; }
  return sealRecentObservation(cutoff, { from: "51", to: "100" }, blocks, []);
}

function physical(responses: readonly CanonicalJson[], mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1, index: number) => void): FamilySourcePlanPhysicalPortV1 {
  let index = 0;
  return Object.freeze({ async request(request: FamilySourcePlanPhysicalRequestV1) { const response = responses[index++]!; const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h(`request-${index}`), releaseBindingId: h("release"), releaseProvenanceHash: h("provenance"), sourceAuthorityRoot: h("authority"), sourceAnchorRoot: h("anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }; mutate?.(observation, request, index); const bytes = encodeCanonicalBytes(observation); const rawLocatorHash = sha256Hex(bytes); return Object.freeze({ response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: Object.freeze({ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash, bytes }) }); } });
}

const bytesHex = (value: Uint8Array) => `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
function runStage(definition: FamilyStageDefinitionV1, payload: unknown, factValue: CanonicalJson): Record<string, unknown> {
  const decoded = definition.payloadCodec.decodeExact(payload) as { readonly requestId: Hash }; const requestFingerprint = h(`${definition.stage}-program`);
  const program: FrozenProgramEnvelopeV1 = { schemaVersion: 1, kind: "aloha.frozen-program", envelopeSchemaRef: h("envelope"), payloadSchemaRef: definition.schemaHash, capabilityRef: { capabilityId: definition.capabilityId, version: definition.version, schemaHash: definition.schemaHash, interpreterHash: h("interpreter"), ownerRef: h("owner") as never }, issuerRef: h("issuer") as never, source: cutoff, authorityHash: h("authority"), canonicalPayloadBytes: encodeCanonicalJson(payload), payloadHash: h("payload"), requestFingerprint };
  const fact: TransportFactV1 = { kind: "returned", requestId: decoded.requestId, requestFingerprint, dataHex: bytesHex(encodeCanonicalBytes(factValue)), source: { chainId: cutoff.chainId, blockNumber: cutoff.number, blockHash: cutoff.hash, stateRoot: cutoff.stateRoot, executorAuthorityRoot: h("executor"), workerEpoch: "epoch", executorSessionHash: h("session") } };
  const draft = definition.interpret({ program, payload: payload as CanonicalJson, facts: [fact], dependencyRefs: [], factSet: { factSetHash: h("fact-set") } }); if (draft.kind !== "verified") throw new Error(`expected ${definition.stage} verified: ${JSON.stringify(draft)}`); return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

test("Fluid Vault factory snapshot enumerates 1..N and supplies omission authority", async () => {
  const vaults = [addr("1"), addr("2")];
  const result = await FLUID_CREDIT_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(2n), ...vaults.map(addressWord)]), new AbortController().signal);
  assert.deepEqual((result.execution.opaqueResult as { readonly vaults: readonly string[] }).vaults, vaults);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const nominations = await FLUID_CREDIT_FACTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), vaults);
  assert.ok(nominations.every(value => value.evidence.kind === "source-plan"));

  const candidate = mergeAndDedupeNominations(nominations)[0]!;
  const identityDefinition = FLUID_CREDIT_STAGE_DEFINITIONS.find(value => value.stage === "identity")!;
  const identityPayload = identityDefinition.prepareIssueValue({ stage: "identity", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: null, materializationOutput: null });
  const evidenceBytes = raw.get(nominations[0]!.evidence.rawLocatorHash)!;
  const identity = runStage(identityDefinition, identityPayload, { kind: "fluid-credit-identity-facts", version: 1, candidateSnapshotHash: candidate.candidateSubjectHash, candidateEvidenceBytesHex: bytesHex(evidenceBytes), reads: { cutoff, target: vaults[0]!, factory: FLUID_VAULT_FACTORY, reverseVault: vaults[0]!, vaultId: "1", collateralAsset: addr("3"), debtAsset: addr("4"), collateralDecimals: 18, debtDecimals: 6, vaultHasCode: true, collateralAssetHasCode: true, debtAssetHasCode: true, activeProbe: { actor: FLUID_CREDIT_PROBE_ACTOR, collateralAmount: "1000", debtAmount: "500", nftId: "1", finalSupply: "1000", finalBorrow: "500", collateralDelta: "-1000", debtDelta: "500" } } });
  assert.equal(identity.evidenceRoot, candidate.candidateEvidenceRoot);
  const instanceKey = identity.familyInstanceKey as string;
  const materializationDefinition = FLUID_CREDIT_STAGE_DEFINITIONS.find(value => value.stage === "materialization")!;
  const materializationPayload = materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: null });
  const stateFact = { cutoff, instanceKey, availableCollateral: "10000", debtCapacity: "10000" } as const;
  const materialization = runStage(materializationDefinition, materializationPayload, stateFact);
  const projectionDefinition = FLUID_CREDIT_STAGE_DEFINITIONS.find(value => value.stage === "projection")!;
  const projectionPayload = projectionDefinition.prepareIssueValue({ stage: "projection", candidate: candidate as unknown as CanonicalJson, cutoff, identityMemo: identity.identityMemo as CanonicalJson, materializationOutput: materialization as CanonicalJson });
  const publication = runStage(projectionDefinition, projectionPayload, stateFact);
  assert.equal(publication.evidenceRoot, candidate.candidateEvidenceRoot);
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identity, evidenceRoot: h("forged") }), /identity output lineage mismatch/);
});

test("Fluid Vault factory empty snapshot is a valid complete zero partition", async () => {
  const result = await FLUID_CREDIT_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(0n)]), new AbortController().signal);
  assert.deepEqual((result.execution.opaqueResult as { readonly vaults: readonly string[] }).vaults, []);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
});

test("Fluid Vault factory rejects duplicate addresses, index splice, and missing evidence", async () => {
  const vault = addr("1");
  await assert.rejects(() => FLUID_CREDIT_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(2n), addressWord(vault), addressWord(vault)]), new AbortController().signal), /duplicate vaults/);
  await assert.rejects(() => FLUID_CREDIT_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(1n), addressWord(vault)], (observation, request, index) => { if (index === 2) observation.request = { ...request.request, params: [{ to: FLUID_VAULT_FACTORY, data: `0xe6bd26a2${word(2n).slice(2)}` }, "0x64"] }; }), new AbortController().signal), /physical observation binding mismatch/);

  const result = await FLUID_CREDIT_FACTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(1n), addressWord(vault)]), new AbortController().signal);
  const refs = Object.freeze(result.sourceEvidence.refs.slice(0, 1)); const rawLocatorHashes = Object.freeze(refs.map(ref => ref.rawLocatorHash)); const evidenceBase = { plan: result.sourceEvidence.plan, cutoff: result.sourceEvidence.cutoff, refs, rawLocatorHashes }; const sourceEvidence = Object.freeze({ ...result.sourceEvidence, ...evidenceBase, evidenceRoot: sourcePlanEvidenceRoot(evidenceBase) }); const { executionRoot: _old, ...oldExecution } = result.execution; const executionBase = { ...oldExecution, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: sourceEvidence.evidenceRoot }; const execution = Object.freeze({ ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) }); const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  await assert.rejects(() => FLUID_CREDIT_FACTORY_NOMINATION_PROGRAM.evaluate({ execution, sourceEvidence, recent: recent(), rawEvidence: { read(hash) { return raw.get(hash)!; } } }, new AbortController().signal), /evidence cardinality mismatch/);
});
