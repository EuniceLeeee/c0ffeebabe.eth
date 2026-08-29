import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { sealInstancePublication } from "../../../packages/catalog/src/index.ts";
import type { FrameworkFactSetCapabilityV1, TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { mergeAndDedupeNominations, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type CanonicalCutoffV1 } from "../../../packages/discovery/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { UNIV3_POOL_CREATED_TOPIC, UNIV3_STANDARD_FAMILY_ID, UNIV3_SWAP_SELECTOR, UNIV3_SWAP_TOPIC, UNIV3_STANDARD_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { UNIV3_STANDARD_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeUniV3Candidate } from "../src/discovery.ts";
import { nominateUniV3 } from "../src/nomination.ts";
import { identityDescriptorHash, verifyUniV3IdentityStage } from "../src/identity.ts";
import { materializeUniV3 } from "../src/instance.ts";
import { deriveUniV3Routes } from "../src/routes.ts";
import { coarseUniV3 } from "../src/pricing.ts";
import { exactUniV3 } from "../src/exact.ts";
import { buildUniV3Action } from "../src/action.ts";
import { compileUniV3Execution } from "../src/execution.ts";
import { getSqrtRatioAtTick } from "../src/kernel/math.ts";
import { UNIV3_STANDARD_SOURCE_NOMINATION_PROGRAM, UNIV3_STANDARD_SOURCE_PLAN, UNIV3_STANDARD_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { UNIV3_REHYDRATION_DEFINITION } from "../src/runtime/definitions.ts";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const h = (label: string) => hashDomain("aloha/test/univ3", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = { kind: "log" as const, target: addr("5"), blockNumber: "99", blockHash: h("b99"), txHash: h("tx"), logIndex: "0", topic0: UNIV3_SWAP_TOPIC, rawLocatorHash: h("raw"), cutoff };

test("UniV3 source plan is a static Family-owned 50-block declaration", () => {
  assert.equal(UNIV3_STANDARD_SOURCE_PLAN.sourcePlanId, UNIV3_STANDARD_SOURCE_PLAN_ID);
  assert.equal(UNIV3_STANDARD_SOURCE_PLAN.completeness, "nomination-only");
  assert.equal(UNIV3_STANDARD_SOURCE_PLAN.historyStartBlock, null);
  assert.ok(Object.isFrozen(UNIV3_STANDARD_SOURCE_PLAN));
});

const sourcePlan = {
  ownerRef: h("owner"),
  sourcePlanRef: h("source-plan"),
  familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
  completeness: "nomination-only" as const,
  historyStartBlock: null,
};
const physicalBytes = Uint8Array.from([1, 2, 3]);
const physicalRawHash = sha256Hex(physicalBytes);
const physicalResponse = (physicalCutoff: CanonicalCutoffV1 = cutoff, executionRootOverride?: ReturnType<typeof h>) => {
  const sourceEvidenceBase = { plan: sourcePlan, cutoff: physicalCutoff, refs: [], rawLocatorHashes: [physicalRawHash] } as const;
  const sourceEvidence = {
    kind: "source-plan-evidence" as const,
    version: 1 as const,
    ...sourceEvidenceBase,
    evidenceRoot: sourcePlanEvidenceRoot(sourceEvidenceBase),
  };
  const executionBase = {
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan: sourcePlan,
    cutoff: physicalCutoff,
    outcome: "positive-only" as const,
    from: physicalCutoff.number,
    through: physicalCutoff.number,
    previousAppliedThrough: null,
    resultPartitionRoot: h("partition"),
    opaqueResult: { kind: "empty" } as const,
    sourceEvidenceRefs: [],
    rawLocatorHashes: [physicalRawHash],
    sourceEvidenceRoot: sourceEvidence.evidenceRoot,
  } as const;
  const execution = { ...executionBase, executionRoot: executionRootOverride ?? sourcePlanExecutionRoot(executionBase) };
  return {
    execution,
    sourceEvidence,
    rawEvidenceLocators: [{ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: physicalRawHash, bytesHex: "0x010203" }],
  } as unknown as CanonicalJson;
};

test("UNIV3_STANDARD_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await UNIV3_STANDARD_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, UNIV3_STANDARD_FAMILY_AUTHORING_HASH);
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await UNIV3_STANDARD_SOURCE_NOMINATION_PROGRAM.evaluate({
    execution: result.execution,
    sourceEvidence: result.sourceEvidence,
    recent: {
      kind: "recent-observation",
      version: 1,
      cutoff,
      range: { from: result.execution.from, to: result.execution.through },
      orderedHeaders: [],
      evidence: [],
      rawLocatorHashes: [],
      observationRoot: h("empty-recent"),
    },
    rawEvidence: { read: () => { throw new Error("no raw read for an empty routed set"); } },
  }, new AbortController().signal);
  assert.deepEqual(nominations, []);
});

function verified() {
  const seed = decodeUniV3Candidate(observation, "univ3-swap-log");
  assert.ok(seed);
  const nomination = nominateUniV3(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const identity = verifyUniV3IdentityStage({
    candidate: nomination.candidate,
    reads: { cutoff, pool: addr("5"), factory: addr("6"), token0: addr("1"), token1: addr("2"), fee: "3000", tickSpacing: 60, reversePool: addr("5") },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeUniV3({ identity: identity.identity, read: { cutoff, pool: addr("5"), sqrtPriceX96: getSqrtRatioAtTick(600).toString(10), tick: 600, liquidity: "1000000", fee: "3000", tickSpacing: 60, tickBitmap: [{ word: 0, bits: "0" }], ticks: [] } });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("state failed");
  return { identity: identity.identity, state: state.state, route: deriveUniV3Routes(identity.identity)[0]! };
}

test("UniV3 plugin keeps nomination at the fixed 50-block window", () => {
  const seed = decodeUniV3Candidate(observation, "univ3-swap-log");
  assert.ok(seed);
  assert.equal(nominateUniV3(seed).status, "nominated");
  const stale = nominateUniV3({ ...seed, evidence: { ...seed.evidence, blockNumber: "50" } });
  assert.deepEqual(stale, { status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  assert.equal(decodeUniV3Candidate({ ...observation, topic0: h("wrong-topic") }, "univ3-swap-log"), null);
});

test("UniV3 nomination rejects evidence without a real topic", () => {
  const seed = decodeUniV3Candidate(observation, "univ3-swap-log");
  assert.ok(seed);
  assert.deepEqual(
    nominateUniV3({ ...seed, evidence: { ...seed.evidence, topic0: undefined } }),
    { status: "chain-proven-rejected", reasonCode: "evidence-topic-missing" },
  );
});

test("UniV3 reverse factory binding is load-bearing and action lineage is exact", () => {
  const seed = decodeUniV3Candidate(observation, "univ3-swap-log");
  assert.ok(seed);
  const nomination = nominateUniV3(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const rejected = verifyUniV3IdentityStage({ candidate: nomination.candidate, reads: { cutoff, pool: addr("5"), factory: addr("6"), token0: addr("1"), token1: addr("2"), fee: "3000", tickSpacing: 1, reversePool: addr("7") } });
  assert.deepEqual(rejected, { status: "chain-proven-rejected", reasonCode: "factory-reverse-binding-failed" });
  const facts = verified();
  const coarse = coarseUniV3({ ...facts, amountIn: "1000" });
  assert.equal(coarse.status, "rankable");
  if (coarse.status !== "rankable") throw new Error("coarse failed");
  const exact = exactUniV3({ ...facts, amountIn: "1000" });
  assert.equal(exact.status, "verified");
  if (exact.status !== "verified") throw new Error("exact failed");
  const action = buildUniV3Action({ identity: facts.identity, route: facts.route, quote: exact.quote, recipient: addr("8"), minAmountOut: "1" });
  const intent = compileUniV3Execution({ identity: facts.identity, action });
  assert.equal(intent.actionHash, action.actionHash);
  assert.throws(() => buildUniV3Action({ ...facts, quote: { ...exact.quote, routeBindingHash: h("foreign") }, recipient: addr("8"), minAmountOut: "1" }), /lineage/);
  assert.equal(action.selector, UNIV3_SWAP_SELECTOR);
});

test("UniV3 rehydration proves current candidate binding and rejects changed requested dependencies", () => {
  const seed = decodeUniV3Candidate(observation, "univ3-swap-log");
  assert.ok(seed);
  const nomination = nominateUniV3(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const candidate = mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination" as const,
    version: "2" as const,
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    instanceNominationKey: nomination.candidate.instanceNominationKey,
    evidence: {
      kind: "recent-log" as const,
      version: 1 as const,
      sourcePlanRef: null,
      ownerRef: null,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash,
      txHash: observation.txHash,
      logIndex: observation.logIndex,
      address: observation.target,
      topic: observation.topic0,
      rawLocatorHash: observation.rawLocatorHash,
    },
  }])[0]!;
  const facts = verified();
  const identity = { ...facts.identity, candidateSnapshotHash: candidate.candidateSubjectHash };
  const identityMemo = {
    kind: "univ3-identity-memo" as const,
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    familyCandidateKey: candidate.familyCandidateKey,
    instanceNominationKey: candidate.instanceNominationKey,
    candidateSubjectHash: candidate.candidateSubjectHash,
    candidateEvidenceRoot: candidate.candidateEvidenceRoot,
    identity,
  };
  const descriptorHash = identityDescriptorHash(identity);
  const publication = sealInstancePublication({
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    familyCandidateKey: candidate.familyCandidateKey,
    instanceKey: candidate.instanceNominationKey,
    cutoff,
    identityMemo: identityMemo as unknown as CanonicalJson,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo as unknown as CanonicalJson),
    descriptorHash,
    staticProjectionMemoHash: h("prior-static-projection"),
    requestedArtifactDependencyRoot: hashDomain("aloha/univ3-standard/requested-artifacts/v2", { identityFactsHash: identity.factsHash }),
    validityDependencyRoot: hashDomain("aloha/univ3-standard/identity-validity/v2", { identityFactsHash: identity.factsHash, descriptorHash }),
    transitions: [],
    evidenceRoot: candidate.candidateEvidenceRoot,
  });
  const payload = UNIV3_REHYDRATION_DEFINITION.prepareIssueValue({
    stage: "rehydration",
    candidate: candidate as unknown as CanonicalJson,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
    reusePublication: publication as unknown as CanonicalJson,
  }) as { readonly requestId: Hash; readonly referenceHash: Hash };
  const requestFingerprint = h("rehydration-program");
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
  const source = { chainId: cutoff.chainId, blockNumber: cutoff.number, blockHash: cutoff.hash, stateRoot: cutoff.stateRoot, executorAuthorityRoot: h("executor"), workerEpoch: "epoch-1", executorSessionHash: h("session") };
  const encoded = encodeCanonicalBytes({ kind: "univ3-rehydration-facts", version: 1, value: payload.referenceHash });
  const fact: TransportFactV1 = { kind: "returned", requestId: payload.requestId, requestFingerprint, dataHex: `0x${Array.from(encoded, byte => byte.toString(16).padStart(2, "0")).join("")}`, source };
  const factSet = Object.freeze({ factSetHash: h("fact-set") }) as FrameworkFactSetCapabilityV1;
  const draft = UNIV3_REHYDRATION_DEFINITION.interpret({ program, payload: payload as never, facts: [fact], dependencyRefs: [], factSet });
  assert.equal(draft.kind, "verified");
  if (draft.kind !== "verified") throw new Error("rehydration did not verify");
  const proof = UNIV3_REHYDRATION_DEFINITION.outputCodec.decodeExact(draft.output) as Record<string, unknown>;
  assert.equal(proof.kind, "verifiedMemoReuseProof");
  assert.equal(proof.oldInstancePublicationHash, publication.instancePublicationHash);
  assert.equal(proof.candidateSubjectHash, candidate.candidateSubjectHash);

  const { instancePublicationHash: _oldHash, ...publicationDraft } = publication;
  const changed = sealInstancePublication({
    ...publicationDraft,
    transitions: publication.transitions.map(({ projectionHash: _projectionHash, ...transition }) => transition),
    requestedArtifactDependencyRoot: h("changed-requested-dependencies"),
  });
  assert.throws(() => UNIV3_REHYDRATION_DEFINITION.prepareIssueValue({
    stage: "rehydration",
    candidate: candidate as unknown as CanonicalJson,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
    reusePublication: changed as unknown as CanonicalJson,
  }), /dependency or identity mismatch/);
});
