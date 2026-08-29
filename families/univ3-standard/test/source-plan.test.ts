import assert from "node:assert/strict";
import test from "node:test";

import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { InstancePublicationV1 } from "../../../packages/catalog/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { mergeAndDedupeNominations, sealSourceCoverage, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySourcePlanExecutionResultV1, FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1, FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { UNIV3_POOL_CREATED_TOPIC, UNIV3_SEARCH_RUNTIME_ADAPTER_FACTORY, UNIV3_STANDARD_FAMILY_AUTHORING_HASH, UNIV3_STANDARD_HISTORY_NOMINATION_PROGRAM, UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME, UNIV3_STAGE_DEFINITIONS } from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/univ3-history-source", value);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const topicAddress = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;
const topicUint = (value: bigint) => `0x${word(value)}`;
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH, completeness: "contiguous-history", historyStartBlock: "0" });

function cutoff(number: string) { return Object.freeze({ chainId: "1", number, hash: h(`block-${number}`), stateRoot: h(`state-${number}`) }); }
function recent(value: ReturnType<typeof cutoff>) {
  const first = BigInt(value.number) - 49n;
  const blocks = [];
  let parentHash = h(`block-${first - 1n}`);
  for (let number = first; number <= BigInt(value.number); number += 1n) { const hash = number === BigInt(value.number) ? value.hash : h(`block-${number}`); blocks.push({ number: number.toString(), hash, parentHash, evidence: [] }); parentHash = hash; }
  return sealRecentObservation(value, { from: first.toString(), to: value.number }, blocks, []);
}

function poolCreated(block: bigint, logIndex: bigint, pool: string, factory = address("f")): CanonicalJson {
  return Object.freeze({ address: factory, blockHash: h(`log-block-${block}`), blockNumber: `0x${block.toString(16)}`, data: `0x${word(60n)}${word(BigInt(pool))}`, logIndex: `0x${logIndex.toString(16)}`, removed: false, topics: Object.freeze([UNIV3_POOL_CREATED_TOPIC, topicAddress(address("1")), topicAddress(address("2")), topicUint(3000n)]), transactionHash: h(`tx-${block}-${logIndex}`), transactionIndex: "0x0" });
}

function physical(respond: (request: FamilySourcePlanPhysicalRequestV1, index: number) => CanonicalJson, mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1, index: number) => void): FamilySourcePlanPhysicalPortV1 {
  let index = 0;
  return Object.freeze({ async request(request: FamilySourcePlanPhysicalRequestV1) { const response = respond(request, index); const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h(`request-${index}`), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch-1", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }; mutate?.(observation, request, index); const bytes = encodeCanonicalBytes(observation); const rawLocatorHash = sha256Hex(bytes); index += 1; return Object.freeze({ response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: Object.freeze({ kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes }) }); } });
}
function predecessor(result: FamilySourcePlanExecutionResultV1) { const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes])); return Object.freeze({ persistedExecutionRoot: h(`persisted-${result.execution.through}`), execution: result.execution, sourceEvidence: result.sourceEvidence, rawEvidence: Object.freeze({ read(hash: Hash) { const bytes = raw.get(hash); if (!bytes) throw new Error("missing predecessor raw"); return bytes; } }) }); }

function dataHex(value: CanonicalJson): string { return `0x${[...encodeCanonicalBytes(value)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`; }
function runStage(definition: FamilyStageDefinitionV1, payload: unknown, factValue: CanonicalJson, source: ReturnType<typeof cutoff>): Record<string, unknown> {
  const decoded = definition.payloadCodec.decodeExact(payload) as { readonly requestId: Hash };
  const requestFingerprint = h(`${definition.stage}-program`);
  const program: FrozenProgramEnvelopeV1 = { schemaVersion: 1, kind: "aloha.frozen-program", envelopeSchemaRef: h("envelope-schema"), payloadSchemaRef: h("payload-schema") as never, capabilityRef: {} as never, issuerRef: h("issuer") as never, source, authorityHash: h("authority"), canonicalPayloadBytes: "{}", payloadHash: h("payload"), requestFingerprint };
  const fact: TransportFactV1 = { kind: "returned", requestId: decoded.requestId, requestFingerprint, dataHex: dataHex(factValue), source: { chainId: source.chainId, blockNumber: source.number, blockHash: source.hash, stateRoot: source.stateRoot, executorAuthorityRoot: h("executor-authority"), workerEpoch: "epoch-1", executorSessionHash: h("executor-session") } };
  const draft = definition.interpret({ program, payload: payload as CanonicalJson, facts: [fact], dependencyRefs: [], factSet: { factSetHash: h("fact-set") } });
  if (draft.kind !== "verified") throw new Error(`expected ${definition.stage} verification: ${JSON.stringify(draft)}`);
  return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

async function assertSearchAcceptsRuntimePublication(publicationValue: Record<string, unknown>): Promise<void> {
  const publication = publicationValue as unknown as InstancePublicationV1;
  const transition = publication.transitions[0]!;
  const adapter = UNIV3_SEARCH_RUNTIME_ADAPTER_FACTORY({
    familyDefinitionHash: publication.familyDefinitionHash,
    capabilityRefs: {},
    actionOwnerRefs: { swap: asOwnerRef(h("search-action-owner")) },
    composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) },
  });
  const objectivePayload = Object.freeze({ kind: "runtime-publication-search-seam" });
  const result = await adapter.readState({
    route: {
      familyId: publication.familyId,
      familyDefinitionHash: publication.familyDefinitionHash,
      instanceKey: publication.instanceKey,
      identityMemo: publication.identityMemo,
      identityMemoHash: publication.identityMemoHash,
      instancePublicationHash: publication.instancePublicationHash,
      staticProjectionMemoHash: publication.staticProjectionMemoHash,
      requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
      staticProjectionHash: transition.staticProjectionHash,
      projectionHash: transition.projectionHash,
      authoritySessionHash: h("route-authority-session"),
    },
    currentSource: { source: publication.cutoff, assertCurrent() {} },
    objective: { objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload },
    amount: {
      inputAssetRef: transition.inputAssetPorts[0]!.assetRef,
      outputAssetRef: transition.outputAssetPorts[0]!.assetRef,
      amountIn: "1",
      recipient: address("8"),
    },
    readPort: { read({ request }) { return { kind: "unavailable", requestId: request.requestId, source: request.source, reasonCode: "runtime-publication-seam-stop" }; } },
  });
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  if (result.kind === "unavailable") assert.equal(result.reasonCode, "runtime-publication-seam-stop");
}

test("UniV3 PoolCreated history scans bounded contiguous chunks including an empty middle chunk", async () => {
  const source = cutoff("20000");
  const pool0 = address("a");
  const pool1 = address("b");
  const requested: CanonicalJson[] = [];
  const result = await UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, physical((request, index) => { requested.push(request.request.lookback); return index === 0 ? [poolCreated(5n, 0n, pool0)] : index === 1 ? [] : [poolCreated(20000n, 0n, pool1)]; }), new AbortController().signal);
  assert.deepEqual(requested, [{ from: "0", through: "9999" }, { from: "10000", through: "19999" }, { from: "20000", through: "20000" }]);
  assert.equal(result.rawEvidenceLocators.length, 3);
  assert.equal(sealSourceCoverage(source, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const nominations = await UNIV3_STANDARD_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(source), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw"); return value; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), [pool0, pool1]);
  assert.ok(nominations.every(value => value.evidence.kind === "source-plan"));
  const nomination = nominations[0]!;
  const alias = { ...nomination, evidence: { ...nomination.evidence, evidenceRef: h("alias-evidence"), rawLocatorHash: h("alias-raw") } };
  const candidate = mergeAndDedupeNominations([alias, nomination]);
  assert.equal(candidate[0]!.evidence.length, 2);
  const prepared = UNIV3_STAGE_DEFINITIONS.find(value => value.stage === "identity")!.prepareIssueValue({ stage: "identity", candidate: candidate[0]! as unknown as CanonicalJson, cutoff: source, identityMemo: null, materializationOutput: null });
  assert.equal((prepared as { readonly candidate: { readonly instanceNominationKey: string } }).candidate.instanceNominationKey, pool0);

  const currentCandidate = candidate[0]!;
  const identityDefinition = UNIV3_STAGE_DEFINITIONS.find(value => value.stage === "identity")!;
  const identity = runStage(identityDefinition, prepared, { kind: "univ3-identity-facts", version: 1, candidateSnapshotHash: currentCandidate.candidateSubjectHash, reads: { cutoff: source, pool: pool0, factory: address("f"), token0: address("1"), token1: address("2"), fee: "3000", tickSpacing: 60, reversePool: pool0 } }, source);
  const identityMemo = identity.identityMemo as Record<string, unknown>;
  assert.equal(identityMemo.candidateSubjectHash, currentCandidate.candidateSubjectHash);
  assert.equal(identityMemo.candidateEvidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.equal(identity.evidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identity, evidenceRoot: h("forged-identity-root") }), /identity output lineage mismatch/);
  const forgedSubjectMemo = { ...identityMemo, candidateSubjectHash: h("forged-subject") };
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identity, identityMemo: forgedSubjectMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", forgedSubjectMemo) }), /identity memo lineage mismatch/);

  const materializationDefinition = UNIV3_STAGE_DEFINITIONS.find(value => value.stage === "materialization")!;
  const forgedEvidenceMemo = { ...identityMemo, candidateEvidenceRoot: h("forged-memo-root") };
  assert.throws(() => materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: currentCandidate as unknown as CanonicalJson, cutoff: source, identityMemo: forgedEvidenceMemo as CanonicalJson, materializationOutput: null }), /candidate memo lineage mismatch/);
  const materializationPrepared = materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: currentCandidate as unknown as CanonicalJson, cutoff: source, identityMemo: identityMemo as CanonicalJson, materializationOutput: null });
  const stateFact = { kind: "univ3-state-facts", version: 1, read: { cutoff: source, pool: pool0, sqrtPriceX96: "79228162514264337593543950336", tick: 0, liquidity: "1000000", fee: "3000", tickSpacing: 60, tickBitmap: [], ticks: [] } } as const;
  const materialization = runStage(materializationDefinition, materializationPrepared, stateFact, source);
  assert.equal(materialization.candidateSubjectHash, currentCandidate.candidateSubjectHash);
  assert.equal(materialization.candidateEvidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.throws(() => materializationDefinition.outputCodec.decodeExact({ ...materialization, candidateSubjectHash: h("forged-materialization-subject") }), /materialization lineage mismatch/);

  const projectionDefinition = UNIV3_STAGE_DEFINITIONS.find(value => value.stage === "projection")!;
  assert.throws(() => projectionDefinition.prepareIssueValue({ stage: "projection", candidate: currentCandidate as unknown as CanonicalJson, cutoff: source, identityMemo: identityMemo as CanonicalJson, materializationOutput: { ...materialization, candidateEvidenceRoot: h("forged-materialization-root") } as CanonicalJson }), /projection lineage mismatch/);
  const projectionPrepared = projectionDefinition.prepareIssueValue({ stage: "projection", candidate: currentCandidate as unknown as CanonicalJson, cutoff: source, identityMemo: identityMemo as CanonicalJson, materializationOutput: materialization as CanonicalJson });
  const publication = runStage(projectionDefinition, projectionPrepared, stateFact, source);
  assert.equal(publication.evidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.deepEqual(publication.identityMemo, identityMemo);
  await assertSearchAcceptsRuntimePublication(publication);
  assert.throws(() => projectionDefinition.outputCodec.decodeExact({ ...publication, evidenceRoot: h("forged-publication-root") }));
});

test("UniV3 successor scans only delta and retains the complete prior inventory for empty and non-empty deltas", async () => {
  const poolA = address("a"); const poolB = address("b");
  const firstCutoff = cutoff("99");
  const first = await UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: firstCutoff, previousAppliedThrough: null }, physical(() => [poolCreated(95n, 0n, poolA)]), new AbortController().signal);
  const emptyCutoff = cutoff("100");
  const empty = await UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: emptyCutoff, previousAppliedThrough: "99", predecessor: predecessor(first) }, physical(request => { assert.deepEqual(request.request.lookback, { from: "100", through: "100" }); return []; }), new AbortController().signal);
  assert.equal(empty.execution.from, "100"); assert.equal(empty.execution.previousAppliedThrough, "99");
  const emptyRaw = new Map(empty.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const emptyNominations = await UNIV3_STANDARD_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: empty.execution, sourceEvidence: empty.sourceEvidence, recent: recent(emptyCutoff), rawEvidence: { read(hash) { return emptyRaw.get(hash)!; } } }, new AbortController().signal);
  assert.deepEqual(emptyNominations.map(value => value.instanceNominationKey), [poolA]);
  const nextCutoff = cutoff("101");
  const next = await UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: nextCutoff, previousAppliedThrough: "100", predecessor: predecessor(empty) }, physical(() => [poolCreated(101n, 0n, poolB)]), new AbortController().signal);
  const nextRaw = new Map(next.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const nextNominations = await UNIV3_STANDARD_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: next.execution, sourceEvidence: next.sourceEvidence, recent: recent(nextCutoff), rawEvidence: { read(hash) { return nextRaw.get(hash)!; } } }, new AbortController().signal);
  assert.deepEqual(nextNominations.map(value => value.instanceNominationKey), [poolA, poolB]);
});

test("UniV3 history rejects a physical chunk gap and a log crossing its chunk range", async () => {
  const source = cutoff("10000");
  await assert.rejects(() => UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, physical(() => [], (observation, request, index) => { if (index === 1) observation.request = { ...request.request, lookback: { from: "10001", through: "10000" } }; }), new AbortController().signal), /binding mismatch/);
  await assert.rejects(() => UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, physical((_request, index) => index === 0 ? [poolCreated(10000n, 0n, address("a"))] : []), new AbortController().signal), /outside the requested range/);
});

test("UniV3 history rejects unordered logs, malformed ABI, and duplicate pools across chunks", async () => {
  const source = cutoff("10000");
  await assert.rejects(() => UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, physical((_request, index) => index === 0 ? [poolCreated(2n, 0n, address("a")), poolCreated(1n, 0n, address("b"))] : []), new AbortController().signal), /strict chain order/);
  await assert.rejects(() => UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, physical((_request, index) => index === 0 ? [{ ...(poolCreated(1n, 0n, address("a")) as object), data: "0x" } as CanonicalJson] : []), new AbortController().signal), /exactly 2 ABI words/);
  const pool = address("a");
  await assert.rejects(() => UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, physical((_request, index) => index === 0 ? [poolCreated(1n, 0n, pool)] : [poolCreated(10000n, 0n, pool)]), new AbortController().signal), /duplicate pool across chunks/);
});

test("UniV3 history rejects manager/target injection and a forged raw hash", async () => {
  const source = cutoff("1");
  await assert.rejects(() => UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, physical(() => [], (observation, request) => { observation.request = { ...request.request, manager: address("9") }; }), new AbortController().signal), /binding mismatch/);
  const forged: FamilySourcePlanPhysicalPortV1 = { async request(request) { const response: CanonicalJson = []; const bytes = encodeCanonicalBytes({ kind: "family-source-plan-physical-observation", version: 1, requestId: h("forged"), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }); return { response, rawLocatorHash: h("wrong"), evidenceRef: h("evidence"), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash: h("wrong"), bytes } }; } };
  await assert.rejects(() => UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: source, previousAppliedThrough: null }, forged, new AbortController().signal), /raw locator mismatch/);
});
