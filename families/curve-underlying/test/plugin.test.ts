import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { sealInstancePublication } from "../../../packages/catalog/src/index.ts";
import type { FrameworkFactSetCapabilityV1, TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { mergeAndDedupeNominations, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type CanonicalCutoffV1 } from "../../../packages/discovery/src/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_FAMILY_ID, CURVE_UNDERLYING_I128_SELECTOR, CURVE_UNDERLYING_I128_SWAP_TOPIC, CURVE_UNDERLYING_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { CURVE_UNDERLYING_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeCurveUnderlyingCandidate } from "../src/discovery.ts";
import { nominateCurveUnderlying } from "../src/nomination.ts";
import { curveIdentityDescriptorHash, verifyCurveUnderlyingIdentityStage } from "../src/identity.ts";
import { materializeCurveUnderlying } from "../src/instance.ts";
import { deriveCurveUnderlyingRoutes } from "../src/routes.ts";
import { coarseCurveUnderlying } from "../src/pricing.ts";
import { exactCurveUnderlying } from "../src/exact.ts";
import { buildCurveUnderlyingAction } from "../src/action.ts";
import { CURVE_UNDERLYING_SOURCE_NOMINATION_PROGRAM, CURVE_UNDERLYING_SOURCE_PLAN, CURVE_UNDERLYING_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { CURVE_UNDERLYING_REHYDRATION_DEFINITION } from "../src/runtime/definitions.ts";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const h = (label: string) => hashDomain("aloha/test/curve", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b100"), txHash: h("tx"), logIndex: "0", selector: CURVE_UNDERLYING_I128_SELECTOR, rawLocatorHash: h("raw"), cutoff };

test("Curve source plan is a static Family-owned 50-block declaration", () => {
  assert.equal(CURVE_UNDERLYING_SOURCE_PLAN.sourcePlanId, CURVE_UNDERLYING_SOURCE_PLAN_ID);
  assert.equal(CURVE_UNDERLYING_SOURCE_PLAN.completeness, "nomination-only");
  assert.equal(CURVE_UNDERLYING_SOURCE_PLAN.historyStartBlock, null);
  assert.ok(Object.isFrozen(CURVE_UNDERLYING_SOURCE_PLAN));
});

const sourcePlan = {
  ownerRef: h("owner"),
  sourcePlanRef: h("source-plan"),
  familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
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

test("CURVE_UNDERLYING_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await CURVE_UNDERLYING_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, CURVE_UNDERLYING_FAMILY_AUTHORING_HASH);
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await CURVE_UNDERLYING_SOURCE_NOMINATION_PROGRAM.evaluate({
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
  const seed = decodeCurveUnderlyingCandidate(observation, "curve-underlying-i128-call");
  assert.ok(seed);
  const nomination = nominateCurveUnderlying(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const identity = verifyCurveUnderlyingIdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      pool: addr("5"),
      metaRegistry: CURVE_METAREGISTRY,
      registryPool: addr("5"),
      poolHasCode: true,
      handlers: [addr("6")],
      underlyingCoins: [addr("1"), addr("2")],
      underlyingDecimals: [18, 18],
      verifiedDirections: [{ i: 0, j: 1, selectorVariant: "int128", amountIn: "100", amountOut: "99" }],
    },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeCurveUnderlying({
    identity: identity.identity,
    read: {
      cutoff,
      pool: addr("5"),
      variant: "plain",
      A: "1000",
      fee: "30",
      balances: ["100000000000000000000", "100000000000000000000"],
      rates: ["1000000000000000000", "1000000000000000000"],
    },
  });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("state failed");
  const route = deriveCurveUnderlyingRoutes(identity.identity).find(value => value.i === 0 && value.j === 1);
  assert.ok(route);
  return { identity: identity.identity, state: state.state, route };
}

test("Curve underlying uses a 50-block nomination and rejects wrong call pattern", () => {
  const seed = decodeCurveUnderlyingCandidate(observation, "curve-underlying-i128-call");
  assert.ok(seed);
  assert.equal(nominateCurveUnderlying(seed).status, "nominated");
  assert.deepEqual(nominateCurveUnderlying({ ...seed, evidence: { ...seed.evidence, blockNumber: "49" } }), { status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  assert.equal(decodeCurveUnderlyingCandidate({ ...observation, selector: "0xdeadbeef" }, "curve-underlying-i128-call"), null);
});

test("Curve identity is reverse registry plus complete underlying domain", () => {
  const seed = decodeCurveUnderlyingCandidate(observation, "curve-underlying-i128-call");
  assert.ok(seed);
  const nomination = nominateCurveUnderlying(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const rejected = verifyCurveUnderlyingIdentityStage({ candidate: nomination.candidate, reads: { cutoff, pool: addr("5"), metaRegistry: CURVE_METAREGISTRY, registryPool: addr("7"), poolHasCode: true, handlers: [addr("6")], underlyingCoins: [addr("1"), addr("2")], underlyingDecimals: [18, 18], verifiedDirections: [{ i: 0, j: 1, selectorVariant: "int128", amountIn: "1", amountOut: "1" }] } });
  assert.deepEqual(rejected, { status: "chain-proven-rejected", reasonCode: "registry-reverse-binding-failed" });
  const facts = verified();
  const exact = exactCurveUnderlying({ ...facts, amountIn: "1000000000000000000" });
  assert.equal(exact.status, "verified");
  if (exact.status !== "verified") throw new Error("exact failed");
  const action = buildCurveUnderlyingAction({ identity: facts.identity, route: facts.route, quote: exact.quote, minAmountOut: "1" });
  assert.equal(action.selector, CURVE_UNDERLYING_I128_SELECTOR);
  assert.throws(() => buildCurveUnderlyingAction({ ...facts, quote: { ...exact.quote, routeBindingHash: h("foreign") }, minAmountOut: "1" }), /lineage/);
  assert.equal(CURVE_UNDERLYING_I128_SWAP_TOPIC.length, 66);
});

test("Curve rehydration proves current candidate binding and rejects changed requested dependencies", () => {
  const candidate = mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination" as const,
    version: "2" as const,
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    instanceNominationKey: observation.target,
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
      topic: CURVE_UNDERLYING_I128_SWAP_TOPIC,
      rawLocatorHash: observation.rawLocatorHash,
    },
  }])[0]!;
  const facts = verified();
  const identity = { ...facts.identity, candidateSnapshotHash: candidate.candidateSubjectHash };
  const identityMemo = {
    kind: "curve-underlying-identity-memo" as const,
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    familyCandidateKey: candidate.familyCandidateKey,
    instanceNominationKey: candidate.instanceNominationKey,
    candidateSubjectHash: candidate.candidateSubjectHash,
    candidateEvidenceRoot: candidate.candidateEvidenceRoot,
    identity,
  };
  const descriptorHash = curveIdentityDescriptorHash(identity);
  const publication = sealInstancePublication({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    familyCandidateKey: candidate.familyCandidateKey,
    instanceKey: candidate.instanceNominationKey,
    cutoff,
    identityMemo: identityMemo as unknown as CanonicalJson,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo as unknown as CanonicalJson),
    descriptorHash,
    staticProjectionMemoHash: h("prior-static-projection"),
    requestedArtifactDependencyRoot: hashDomain("aloha/curve-underlying/requested-artifacts/v2", { identityFactsHash: identity.factsHash }),
    validityDependencyRoot: hashDomain("aloha/curve-underlying/identity-validity/v2", { identityFactsHash: identity.factsHash, descriptorHash }),
    transitions: [],
    evidenceRoot: candidate.candidateEvidenceRoot,
  });
  const payload = CURVE_UNDERLYING_REHYDRATION_DEFINITION.prepareIssueValue({
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
  const encoded = encodeCanonicalBytes({ kind: "curve-underlying-rehydration-facts", version: 1, value: payload.referenceHash });
  const fact: TransportFactV1 = { kind: "returned", requestId: payload.requestId, requestFingerprint, dataHex: `0x${Array.from(encoded, byte => byte.toString(16).padStart(2, "0")).join("")}`, source };
  const factSet = Object.freeze({ factSetHash: h("fact-set") }) as FrameworkFactSetCapabilityV1;
  const draft = CURVE_UNDERLYING_REHYDRATION_DEFINITION.interpret({ program, payload: payload as never, facts: [fact], dependencyRefs: [], factSet });
  assert.equal(draft.kind, "verified");
  if (draft.kind !== "verified") throw new Error("rehydration did not verify");
  const proof = CURVE_UNDERLYING_REHYDRATION_DEFINITION.outputCodec.decodeExact(draft.output) as Record<string, unknown>;
  assert.equal(proof.kind, "verifiedMemoReuseProof");
  assert.equal(proof.oldInstancePublicationHash, publication.instancePublicationHash);
  assert.equal(proof.candidateSubjectHash, candidate.candidateSubjectHash);

  const { instancePublicationHash: _oldHash, ...publicationDraft } = publication;
  const changed = sealInstancePublication({
    ...publicationDraft,
    transitions: publication.transitions.map(({ projectionHash: _projectionHash, ...transition }) => transition),
    requestedArtifactDependencyRoot: h("changed-requested-dependencies"),
  });
  assert.throws(() => CURVE_UNDERLYING_REHYDRATION_DEFINITION.prepareIssueValue({
    stage: "rehydration",
    candidate: candidate as unknown as CanonicalJson,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
    reusePublication: changed as unknown as CanonicalJson,
  }), /dependency or identity mismatch/);
});
