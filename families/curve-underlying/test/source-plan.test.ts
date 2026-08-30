import assert from "node:assert/strict";
import test from "node:test";

import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { InstancePublicationV1 } from "../../../packages/catalog/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import { mergeAndDedupeNominations, sealSourceCoverage, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type SourcePlanEvidenceRefV1, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { decodeFamilySourcePlanPhysicalObservation, type FamilySourcePlanPhysicalPortV1, type FamilySourcePlanPhysicalRequestV1, type FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import {
  CURVE_METAREGISTRY,
  CURVE_UNDERLYING_SWAP_ACTION_PORT,
  CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
  CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME,
  CURVE_UNDERLYING_REGISTRY_NOMINATION_PROGRAM,
  CURVE_SEARCH_RUNTIME_ADAPTER_FACTORY,
  CURVE_UNDERLYING_STAGE_DEFINITIONS,
} from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/curve-source-plan", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block-100"), stateRoot: h("state-100") });
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH, completeness: "complete-snapshot", historyStartBlock: null });
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const address = (digit: string) => `0x${digit.repeat(40)}`;
const addressResult = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;

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

function physical(responses: readonly CanonicalJson[], mutate?: (value: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1) => void): FamilySourcePlanPhysicalPortV1 {
  let index = 0;
  return Object.freeze({
    async request(request: FamilySourcePlanPhysicalRequestV1) {
      const response = responses[index++]!;
      const observation: Record<string, unknown> = {
        kind: "family-source-plan-physical-observation",
        version: 1,
        requestId: h(`request-${index}`),
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
      return Object.freeze({ response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: Object.freeze({ kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes }) });
    },
  });
}

function dataHex(value: CanonicalJson): string {
  return `0x${[...encodeCanonicalBytes(value)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function runStage(definition: FamilyStageDefinitionV1, payload: unknown, factValue: CanonicalJson): Record<string, unknown> {
  const decoded = definition.payloadCodec.decodeExact(payload) as { readonly requestId: Hash };
  const requestFingerprint = h(`${definition.stage}-program`);
  const program: FrozenProgramEnvelopeV1 = {
    schemaVersion: 1,
    kind: "aloha.frozen-program",
    envelopeSchemaRef: h("envelope-schema"),
    payloadSchemaRef: h("payload-schema") as never,
    capabilityRef: {} as never,
    issuerRef: h("issuer") as never,
    source: cutoff,
    authorityHash: h("authority"),
    canonicalPayloadBytes: "{}",
    payloadHash: h("payload"),
    requestFingerprint,
  };
  const fact: TransportFactV1 = {
    kind: "returned",
    requestId: decoded.requestId,
    requestFingerprint,
    dataHex: dataHex(factValue),
    source: {
      chainId: cutoff.chainId,
      blockNumber: cutoff.number,
      blockHash: cutoff.hash,
      stateRoot: cutoff.stateRoot,
      executorAuthorityRoot: h("executor-authority"),
      workerEpoch: "epoch-1",
      executorSessionHash: h("executor-session"),
    },
  };
  const draft = definition.interpret({ program, payload: payload as CanonicalJson, facts: [fact], dependencyRefs: [], factSet: { factSetHash: h("fact-set") } });
  if (draft.kind !== "verified") throw new Error(`expected ${definition.stage} verification: ${JSON.stringify(draft)}`);
  return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

async function assertSearchAcceptsRuntimePublication(publicationValue: Record<string, unknown>): Promise<void> {
  const publication = publicationValue as unknown as InstancePublicationV1;
  const transition = publication.transitions[0]!;
  const adapter = CURVE_SEARCH_RUNTIME_ADAPTER_FACTORY({
    familyDefinitionHash: publication.familyDefinitionHash,
    capabilityRefs: {},
    actionOwnerRefs: { swap: asOwnerRef(h("search-action-owner")) },
    composition: { resolveCapability: () => ({}), resolveActionOwner: () => CURVE_UNDERLYING_SWAP_ACTION_PORT },
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
    execution: { transactionOrigin: address("7"), executorAddress: address("8") },
    readPort: { read({ request }) { return { kind: "unavailable", requestId: request.requestId, source: request.source, reasonCode: "runtime-publication-seam-stop" }; } },
  });
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  if (result.kind === "unavailable") assert.equal(result.reasonCode, "runtime-publication-seam-stop");
}

function replaceRegistryRefs(result: Awaited<ReturnType<typeof CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute>>, refsInput: readonly SourcePlanEvidenceRefV1[]) {
  const refs = Object.freeze([...refsInput].sort((left, right) => hashDomain("aloha/source-plan-evidence-ref/v1", left).localeCompare(hashDomain("aloha/source-plan-evidence-ref/v1", right))));
  const rawLocatorHashes = Object.freeze([...new Set(refs.map(ref => ref.rawLocatorHash))].sort());
  const evidenceBase = { plan: result.sourceEvidence.plan, cutoff: result.sourceEvidence.cutoff, refs, rawLocatorHashes };
  const sourceEvidence = Object.freeze({ ...result.sourceEvidence, ...evidenceBase, evidenceRoot: sourcePlanEvidenceRoot(evidenceBase) });
  const { executionRoot: _oldExecutionRoot, ...oldExecution } = result.execution;
  const executionBase = { ...oldExecution, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: sourceEvidence.evidenceRoot };
  return Object.freeze({ sourceEvidence, execution: Object.freeze({ ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) }) });
}

test("Curve MetaRegistry snapshot enumerates every pool and contributes omission authority", async () => {
  const pools = [address("2"), address("1")];
  const result = await CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(2n), ...pools.map(addressResult)]), new AbortController().signal);
  assert.equal(result.execution.outcome, "complete");
  assert.deepEqual((result.execution.opaqueResult as { readonly pools: readonly string[] }).pools, pools);
  assert.equal(result.rawEvidenceLocators.length, 3);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);

  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const poolRefIndices = result.sourceEvidence.refs.flatMap(ref => {
    const observation = decodeFamilySourcePlanPhysicalObservation(raw.get(ref.rawLocatorHash)!);
    const params = observation.request.params as readonly [{ readonly data: string }, string];
    return params[0].data.startsWith("0x3a1d5d8e") ? [BigInt(`0x${params[0].data.slice(10)}`)] : [];
  });
  assert.deepEqual([...poolRefIndices].sort((left, right) => left < right ? -1 : left > right ? 1 : 0), [0n, 1n]);
  const nominations = await CURVE_UNDERLYING_REGISTRY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), pools);
  assert.ok(nominations.every(value => value.evidence.kind === "source-plan"));
  assert.deepEqual(nominations.map(value => {
    const observation = decodeFamilySourcePlanPhysicalObservation(raw.get(value.evidence.rawLocatorHash)!);
    const params = observation.request.params as readonly [{ readonly data: string }, string];
    return BigInt(`0x${params[0].data.slice(10)}`);
  }), [0n, 1n]);
  const nomination = nominations[0]!;
  const alias = { ...nomination, evidence: { ...nomination.evidence, evidenceRef: h("alias-evidence"), rawLocatorHash: h("alias-raw") } };
  const candidate = mergeAndDedupeNominations([alias, nomination]);
  assert.equal(candidate[0]!.evidence.length, 2);
  const prepared = CURVE_UNDERLYING_STAGE_DEFINITIONS.find(value => value.stage === "identity")!.prepareIssueValue({ stage: "identity", candidate: candidate[0]! as unknown as CanonicalJson, cutoff, identityMemo: null, materializationOutput: null });
  assert.equal((prepared as { readonly candidate: { readonly instanceNominationKey: string } }).candidate.instanceNominationKey, pools[0]);

  const currentCandidate = candidate[0]!;
  const identityDefinition = CURVE_UNDERLYING_STAGE_DEFINITIONS.find(value => value.stage === "identity")!;
  const identity = runStage(identityDefinition, prepared, {
    kind: "curve-underlying-identity-facts",
    version: 1,
    candidateSnapshotHash: currentCandidate.candidateSubjectHash,
    reads: {
      cutoff,
      pool: pools[0]!,
      metaRegistry: CURVE_METAREGISTRY,
      registryPool: pools[0]!,
      poolHasCode: true,
      handlers: [address("6")],
      underlyingCoins: [address("3"), address("4")],
      underlyingDecimals: [18, 6],
      verifiedDirections: [{ i: 0, j: 1, selectorVariant: "int128", amountIn: "100", amountOut: "99" }],
    },
  });
  const identityMemo = identity.identityMemo as Record<string, unknown>;
  assert.equal(identityMemo.candidateSubjectHash, currentCandidate.candidateSubjectHash);
  assert.equal(identityMemo.candidateEvidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.equal(identity.evidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identity, evidenceRoot: h("forged-identity-root") }), /identity output lineage mismatch/);
  const forgedSubjectMemo = { ...identityMemo, candidateSubjectHash: h("forged-subject") };
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identity, identityMemo: forgedSubjectMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", forgedSubjectMemo) }), /identity memo lineage mismatch/);

  const materializationDefinition = CURVE_UNDERLYING_STAGE_DEFINITIONS.find(value => value.stage === "materialization")!;
  const forgedEvidenceMemo = { ...identityMemo, candidateEvidenceRoot: h("forged-memo-root") };
  assert.throws(() => materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: currentCandidate as unknown as CanonicalJson, cutoff, identityMemo: forgedEvidenceMemo as CanonicalJson, materializationOutput: null }), /candidate memo lineage mismatch/);
  const materializationPrepared = materializationDefinition.prepareIssueValue({ stage: "materialization", candidate: currentCandidate as unknown as CanonicalJson, cutoff, identityMemo: identityMemo as CanonicalJson, materializationOutput: null });
  const stateFact = {
    kind: "curve-underlying-state-facts",
    version: 1,
    read: { cutoff, pool: pools[0]!, variant: "plain", A: "1000", fee: "30", balances: ["1000000", "2000000"], rates: ["1000000000000000000", "1000000000000000000"], offpegFeeMultiplier: "0" },
  } as const;
  const materialization = runStage(materializationDefinition, materializationPrepared, stateFact);
  assert.equal(materialization.candidateSubjectHash, currentCandidate.candidateSubjectHash);
  assert.equal(materialization.candidateEvidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.throws(() => materializationDefinition.outputCodec.decodeExact({ ...materialization, candidateSubjectHash: h("forged-materialization-subject") }), /materialization lineage mismatch/);

  const projectionDefinition = CURVE_UNDERLYING_STAGE_DEFINITIONS.find(value => value.stage === "projection")!;
  assert.throws(() => projectionDefinition.prepareIssueValue({ stage: "projection", candidate: currentCandidate as unknown as CanonicalJson, cutoff, identityMemo: identityMemo as CanonicalJson, materializationOutput: { ...materialization, candidateEvidenceRoot: h("forged-materialization-root") } as CanonicalJson }), /projection lineage mismatch/);
  const projectionPrepared = projectionDefinition.prepareIssueValue({ stage: "projection", candidate: currentCandidate as unknown as CanonicalJson, cutoff, identityMemo: identityMemo as CanonicalJson, materializationOutput: materialization as CanonicalJson });
  const publication = runStage(projectionDefinition, projectionPrepared, stateFact);
  assert.equal(publication.evidenceRoot, currentCandidate.candidateEvidenceRoot);
  assert.deepEqual(publication.identityMemo, identityMemo);
  await assertSearchAcceptsRuntimePublication(publication);
  assert.throws(() => projectionDefinition.outputCodec.decodeExact({ ...publication, evidenceRoot: h("forged-publication-root") }));
});

test("Curve MetaRegistry nomination rejects duplicate, missing, and value-mismatched pool evidence", async () => {
  const pools = [address("2"), address("1")];
  const result = await CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(2n), ...pools.map(addressResult)]), new AbortController().signal);
  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const byIndex = new Map<bigint, SourcePlanEvidenceRefV1>();
  let countRef: SourcePlanEvidenceRefV1 | null = null;
  for (const ref of result.sourceEvidence.refs) {
    const observation = decodeFamilySourcePlanPhysicalObservation(raw.get(ref.rawLocatorHash)!);
    const params = observation.request.params as readonly [{ readonly data: string }, string];
    if (params[0].data === "0x956aae3a") countRef = ref;
    else byIndex.set(BigInt(`0x${params[0].data.slice(10)}`), ref);
  }
  if (countRef === null || !byIndex.has(0n) || !byIndex.has(1n)) throw new Error("registry fixture evidence is incomplete");
  const rawEvidence = { read(hash: Hash) { const value = raw.get(hash); if (!value) throw new Error("missing raw evidence"); return value; } };
  const poolOneRef = byIndex.get(1n)!;
  const poolOneObservation = decodeFamilySourcePlanPhysicalObservation(raw.get(poolOneRef.rawLocatorHash)!);
  const duplicateObservation = { ...poolOneObservation, request: { ...poolOneObservation.request, params: [{ to: CURVE_METAREGISTRY, data: `0x3a1d5d8e${word(0n).slice(2)}` }, `0x${BigInt(cutoff.number).toString(16)}`] }, response: addressResult(pools[0]!) };
  const duplicateBytes = encodeCanonicalBytes(duplicateObservation);
  const duplicateRawLocatorHash = sha256Hex(duplicateBytes);
  raw.set(duplicateRawLocatorHash, duplicateBytes);
  const duplicateRef = { ...poolOneRef, evidenceRef: h("duplicate-index-evidence"), rawLocatorHash: duplicateRawLocatorHash };
  const duplicate = replaceRegistryRefs(result, [countRef, byIndex.get(0n)!, duplicateRef]);
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_NOMINATION_PROGRAM.evaluate({ ...duplicate, recent: recent(), rawEvidence }, new AbortController().signal), /duplicate pool evidence index/);
  const missing = replaceRegistryRefs(result, [countRef, byIndex.get(0n)!]);
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_NOMINATION_PROGRAM.evaluate({ ...missing, recent: recent(), rawEvidence }, new AbortController().signal), /evidence cardinality mismatch/);

  const opaqueResult = { ...(result.execution.opaqueResult as Record<string, CanonicalJson>), pools: [pools[1]!, pools[0]!] };
  const { executionRoot: _oldExecutionRoot, ...oldExecution } = result.execution;
  const executionBase = { ...oldExecution, opaqueResult, resultPartitionRoot: hashDomain("aloha/curve-underlying/registry-source-partition/v1", opaqueResult) };
  const mismatchedExecution = Object.freeze({ ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) });
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_NOMINATION_PROGRAM.evaluate({ execution: mismatchedExecution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence }, new AbortController().signal), /pool evidence value mismatch/);
});

test("Curve MetaRegistry empty snapshot is complete, not unavailable", async () => {
  const result = await CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(0n)]), new AbortController().signal);
  assert.deepEqual((result.execution.opaqueResult as { readonly pools: readonly string[] }).pools, []);
  assert.equal(result.rawEvidenceLocators.length, 1);
});

test("Curve MetaRegistry rejects malformed ABI, manager mismatch, cutoff mismatch, and raw hash mismatch", async () => {
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical(["0x01"]), new AbortController().signal), /one ABI uint256 word/);
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(0n)], (observation, request) => { observation.request = { ...request.request, manager: address("9") }; }), new AbortController().signal), /binding mismatch/);
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(0n)], observation => { observation.cutoff = { ...cutoff, number: "99" }; }), new AbortController().signal), /binding mismatch/);
  const forged: FamilySourcePlanPhysicalPortV1 = { async request(request) { const bytes = encodeCanonicalBytes({ kind: "family-source-plan-physical-observation", version: 1, requestId: h("forged"), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response: word(0n) }); return { response: word(0n), rawLocatorHash: h("wrong"), evidenceRef: h("evidence"), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash: h("wrong"), bytes } }; } };
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, forged, new AbortController().signal), /raw observation hash mismatch/);
});

test("Curve MetaRegistry rejects a duplicate or zero pool", async () => {
  const pool = address("1");
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(2n), addressResult(pool), addressResult(pool)]), new AbortController().signal), /duplicate pools/);
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([word(1n), word(0n)]), new AbortController().signal), /zero address/);
});

test("Curve MetaRegistry singleton is fail-closed outside Ethereum mainnet", async () => {
  await assert.rejects(() => CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, chainId: "10" }, previousAppliedThrough: null }, physical([]), new AbortController().signal), /binding mismatch/);
  assert.equal(CURVE_METAREGISTRY, "0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc");
});
