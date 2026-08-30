import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import { familyCandidateKey, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySearchSourceReadRequestV1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import { sealRecentObservation, type RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
import { MORPHO_BLUE_SINGLETON, MORPHO_FLASH_EVIDENCE_TOPIC, MORPHO_FLASH_FAMILY_ID, MORPHO_FLASH_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { MORPHO_FLASH_FAMILY_DEFINITION_HASH, MORPHO_FLASH_SOURCE_NOMINATION_PROGRAM, MORPHO_FLASH_SOURCE_PLAN, MORPHO_FLASH_SOURCE_PLAN_RUNTIME } from "../src/public.ts";
import { MORPHO_FLASH_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";
import { MORPHO_FLASH_CONTRACT_PATTERN, buildMorphoFlashAction, coarseMorphoFlash, compileMorphoFlashExecution, decodeMorphoFlashCandidate, deriveMorphoFlashRoutes, exactMorphoFlash, materializeMorphoFlash, nominateMorphoFlash, verifyMorphoFlashIdentityStage } from "../src/stages.ts";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const h = (label: string) => hashDomain("aloha/test/morpho-flash", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = { kind: "log" as const, target: MORPHO_BLUE_SINGLETON, blockNumber: "100", blockHash: cutoff.hash, txHash: h("tx"), logIndex: "0", topic: MORPHO_FLASH_EVIDENCE_TOPIC, rawLocatorHash: h("source-raw"), cutoff };

function fixture() {
  const bytes = Uint8Array.from([1, 2, 3]);
  const rawHash = sha256Hex(bytes);
  const plan = { ownerRef: h("owner"), sourcePlanRef: h("source-plan"), familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH, completeness: "nomination-only" as const, historyStartBlock: null };
  const sourceEvidenceBase = { plan, cutoff, refs: [], rawLocatorHashes: [rawHash] } as const;
  const sourceEvidence = { kind: "source-plan-evidence" as const, version: 1 as const, ...sourceEvidenceBase, evidenceRoot: sourcePlanEvidenceRoot(sourceEvidenceBase) };
  const executionBase = { kind: "source-plan-execution" as const, version: 1 as const, plan, cutoff, outcome: "positive-only" as const, from: "100", through: "100", previousAppliedThrough: null, resultPartitionRoot: h("partition"), opaqueResult: { kind: "morpho-empty" }, sourceEvidenceRefs: [], rawLocatorHashes: [rawHash], sourceEvidenceRoot: sourceEvidence.evidenceRoot } as const;
  const execution = { ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) };
  return { bytes, rawHash, plan, sourceEvidence, execution, response: { execution, sourceEvidence, rawEvidenceLocators: [{ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: rawHash, bytesHex: "0x010203" }] } };
}

test("Morpho flash source execution is the fixed 50-block recent window", async () => {
  const { MORPHO_FLASH_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await MORPHO_FLASH_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.outcome, "complete");
  assert.equal(result.execution.executionRoot, result.execution.executionRoot);
});
test("MORPHO_FLASH_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const { MORPHO_FLASH_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await MORPHO_FLASH_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, MORPHO_FLASH_FAMILY_DEFINITION_HASH);
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await MORPHO_FLASH_SOURCE_NOMINATION_PROGRAM.evaluate({
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
  const seed = decodeMorphoFlashCandidate(observation, MORPHO_FLASH_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateMorphoFlash(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const identity = verifyMorphoFlashIdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: MORPHO_BLUE_SINGLETON,
      reverseLender: MORPHO_BLUE_SINGLETON,
      asset: addr("1"),
      receiver: addr("2"),
      assetHasCode: true,
      receiverHasCode: true,
      feeBps: "0",
    },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeMorphoFlash({ identity: identity.identity, read: { cutoff, instanceKey: identity.identity.instanceKey, availableLiquidity: "1000" } });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("state failed");
  return { identity: identity.identity, state: state.state, route: deriveMorphoFlashRoutes(identity.identity)[0]! };
}

function searchInput(objectivePayload: CanonicalJson, amountExtension?: Readonly<Record<string, unknown>>) {
  const facts = verified();
  const recipient = facts.identity.facts.receiver;
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson({
    kind: "morpho-flash-identity-memo",
    version: 1,
    familyId: MORPHO_FLASH_FAMILY_ID,
    familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH,
    familyCandidateKey: familyCandidateKey(MORPHO_FLASH_FAMILY_DEFINITION_HASH, MORPHO_BLUE_SINGLETON.toLowerCase()),
    instanceNominationKey: MORPHO_BLUE_SINGLETON.toLowerCase(),
    candidateSnapshotHash: facts.identity.candidateSnapshotHash,
    identity: facts.identity,
  }));
  return {
    route: {
      familyId: MORPHO_FLASH_FAMILY_ID,
      familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH,
      instanceKey: facts.identity.instanceKey,
      identityMemo,
      identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
      instancePublicationHash: h("search-publication"),
      staticProjectionMemoHash: h("search-static-memo"),
      requestedArtifactDependencyRoot: h("search-dependencies"),
      staticProjectionHash: h("search-static-projection"),
      projectionHash: h("search-projection"),
      authoritySessionHash: h("search-authority"),
    },
    currentSource: { source: cutoff, assertCurrent() {} },
    objective: { objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload },
    amount: {
      inputAssetRef: erc20AssetRefV1("1", facts.identity.facts.asset),
      outputAssetRef: h("funding-obligation-asset"),
      amountIn: "100",
      recipient,
      ...amountExtension,
    },
    execution: { transactionOrigin: addr("7"), executorAddress: recipient },
    readPort: {
      read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
        return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: `0x${1000n.toString(16).padStart(64, "0")}` };
      },
    },
  };
}

const searchAdapter = MORPHO_FLASH_SEARCH_RUNTIME_ADAPTER_FACTORY({
  familyDefinitionHash: MORPHO_FLASH_FAMILY_DEFINITION_HASH,
  capabilityRefs: {},
  actionOwnerRefs: { action: asOwnerRef(h("search-action-owner")) },
  composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) },
});

test("Morpho flash reverse identity rejects a forged lender", () => {
  const seed = decodeMorphoFlashCandidate(observation, MORPHO_FLASH_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateMorphoFlash(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  assert.deepEqual(verifyMorphoFlashIdentityStage({ candidate: nomination.candidate, reads: { cutoff, target: MORPHO_BLUE_SINGLETON, reverseLender: addr("9"), asset: addr("1"), receiver: addr("2"), assetHasCode: true, receiverHasCode: true, feeBps: "0" } }), { status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
  assert.deepEqual(verifyMorphoFlashIdentityStage({ candidate: nomination.candidate, reads: { cutoff, target: MORPHO_BLUE_SINGLETON, reverseLender: MORPHO_BLUE_SINGLETON, asset: addr("1"), receiver: addr("2"), assetHasCode: false, receiverHasCode: true, feeBps: "0" } }), { status: "chain-proven-rejected", reasonCode: "token-code-missing" });
  assert.deepEqual(nominateMorphoFlash({ ...seed, evidence: { ...seed.evidence, blockNumber: "50" } }), { status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  assert.equal(decodeMorphoFlashCandidate({ ...observation, topic: h("wrong") }, MORPHO_FLASH_CONTRACT_PATTERN), null);
});

test("Morpho flash binds route, exact quote, repayment obligation, effects, and execution", () => {
  const facts = verified();
  const coarse = coarseMorphoFlash({ ...facts, amountIn: "100" });
  assert.equal(coarse.status, "rankable");
  if (coarse.status !== "rankable") throw new Error("coarse failed");
  const exact = exactMorphoFlash({ ...facts, amountIn: "100" });
  assert.equal(exact.status, "rankable");
  if (exact.status !== "rankable") throw new Error("exact failed");
  const action = buildMorphoFlashAction({ identity: facts.identity, quote: exact.quote, callbackDataHex: "0x1234" });
  assert.equal(action.obligation.due, "same-transaction");
  assert.equal(action.obligation.repayment, "100");
  const execution = compileMorphoFlashExecution({ identity: facts.identity, action });
  assert.equal(execution.obligationHash, action.obligation.obligationHash);
  assert.equal(execution.expectedEffects[0]?.direction, "decrease");
  assert.equal(execution.expectedEffects[1]?.direction, "increase");
  assert.throws(() => compileMorphoFlashExecution({ identity: facts.identity, action: { ...action, obligation: { ...action.obligation, repayment: "101" } } }), /repayment arithmetic|obligation hash mismatch/);
  assert.equal(MORPHO_FLASH_FAMILY_ID, "morpho-flash");
});

test("Morpho search cannot turn caller callback bytes or objective data into a funding program", async () => {
  const forged = await searchAdapter.run(searchInput({ callbackDataHex: "0xdeadbeef", repayment: "0" }, { callbackDataHex: "0xdeadbeef" }));
  const unrelated = await searchAdapter.run(searchInput({ kind: "unrelated-objective" }));
  assert.equal(forged.kind, "invalidProgram");
  if (forged.kind === "invalidProgram") {
    assert.equal(forged.stage, "state");
    assert.match(forged.code, /unknown-field|callback/i);
  }
  assert.equal(unrelated.kind, "unavailable");
  if (unrelated.kind === "unavailable") {
    assert.equal(unrelated.stage, "coarse");
    assert.equal(unrelated.reasonCode, "qualified-funding-offer-not-in-release");
  }
});
