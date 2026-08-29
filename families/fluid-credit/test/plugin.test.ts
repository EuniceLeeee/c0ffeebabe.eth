import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import { familyCandidateKey, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySearchSourceReadRequestV1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import { sealRecentObservation, type RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
import { FLUID_CREDIT_EVIDENCE_TOPIC, FLUID_CREDIT_FAMILY_ID, FLUID_CREDIT_PROBE_ACTOR, FLUID_CREDIT_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { FLUID_CREDIT_FAMILY_DEFINITION_HASH, FLUID_CREDIT_SOURCE_NOMINATION_PROGRAM, FLUID_CREDIT_SOURCE_PLAN, FLUID_CREDIT_SOURCE_PLAN_RUNTIME } from "../src/public.ts";
import { effectRoot, fluidDebtAmount } from "../src/kernel/math.ts";
import { FLUID_CREDIT_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";
import { FLUID_CREDIT_CONTRACT_PATTERN, buildFluidCreditAction, coarseFluidCredit, compileFluidCreditExecution, decodeFluidCreditCandidate, deriveFluidCreditRoutes, exactFluidCredit, materializeFluidCredit, nominateFluidCredit, verifyFluidCreditIdentityStage } from "../src/stages.ts";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const h = (label: string) => hashDomain("aloha/test/fluid-credit", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = { kind: "log" as const, target: addr("5"), blockNumber: "100", blockHash: cutoff.hash, txHash: h("tx"), logIndex: "0", topic: FLUID_CREDIT_EVIDENCE_TOPIC, rawLocatorHash: h("source-raw"), cutoff };

function fixture() {
  const bytes = Uint8Array.from([1, 2, 3]); const rawHash = sha256Hex(bytes);
  const plan = { ownerRef: h("owner"), sourcePlanRef: h("source-plan"), familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH, completeness: "nomination-only" as const, historyStartBlock: null };
  const sourceEvidenceBase = { plan, cutoff, refs: [], rawLocatorHashes: [rawHash] } as const;
  const sourceEvidence = { kind: "source-plan-evidence" as const, version: 1 as const, ...sourceEvidenceBase, evidenceRoot: sourcePlanEvidenceRoot(sourceEvidenceBase) };
  const executionBase = { kind: "source-plan-execution" as const, version: 1 as const, plan, cutoff, outcome: "positive-only" as const, from: "100", through: "100", previousAppliedThrough: null, resultPartitionRoot: h("partition"), opaqueResult: { kind: "fluid-credit-empty" }, sourceEvidenceRefs: [], rawLocatorHashes: [rawHash], sourceEvidenceRoot: sourceEvidence.evidenceRoot } as const;
  const execution = { ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) };
  return { bytes, rawHash, plan, sourceEvidence, execution, response: { execution, sourceEvidence, rawEvidenceLocators: [{ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: rawHash, bytesHex: "0x010203" }] } };
}

test("Fluid Credit source execution is the fixed 50-block recent window", async () => {
  const { FLUID_CREDIT_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await FLUID_CREDIT_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.outcome, "complete");
  assert.equal(result.execution.executionRoot, result.execution.executionRoot);
});
test("FLUID_CREDIT_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const { FLUID_CREDIT_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await FLUID_CREDIT_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, FLUID_CREDIT_FAMILY_DEFINITION_HASH);
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await FLUID_CREDIT_SOURCE_NOMINATION_PROGRAM.evaluate({
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
  const seed = decodeFluidCreditCandidate(observation, FLUID_CREDIT_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateFluidCredit(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const identity = verifyFluidCreditIdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: addr("5"),
      factory: addr("6"),
      reverseVault: addr("5"),
      vaultId: "17",
      collateralAsset: addr("1"),
      debtAsset: addr("2"),
      collateralDecimals: 0,
      debtDecimals: 0,
      vaultHasCode: true,
      collateralAssetHasCode: true,
      debtAssetHasCode: true,
      activeProbe: {
        actor: FLUID_CREDIT_PROBE_ACTOR,
        collateralAmount: "1000",
        debtAmount: "850",
        nftId: "1",
        finalSupply: "1000",
        finalBorrow: "850",
        collateralDelta: "-1000",
        debtDelta: "850",
      },
    },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeFluidCredit({ identity: identity.identity, read: { cutoff, instanceKey: identity.identity.instanceKey, availableCollateral: "10000", debtCapacity: "10000" } });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("state failed");
  return { identity: identity.identity, state: state.state, route: deriveFluidCreditRoutes(identity.identity)[0]! };
}

function searchInput(objectivePayload: CanonicalJson) {
  const facts = verified();
  const nominationKey = facts.identity.facts.vault;
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson({
    kind: "fluid-credit-identity-memo",
    version: 1,
    familyId: FLUID_CREDIT_FAMILY_ID,
    familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH,
    familyCandidateKey: familyCandidateKey(FLUID_CREDIT_FAMILY_DEFINITION_HASH, nominationKey),
    instanceNominationKey: nominationKey,
    candidateSnapshotHash: facts.identity.candidateSnapshotHash,
    candidateEvidenceRoot: h("search-candidate-evidence"),
    identity: facts.identity,
  }));
  return {
    route: {
      familyId: FLUID_CREDIT_FAMILY_ID,
      familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH,
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
      inputAssetRef: erc20AssetRefV1("1", facts.identity.facts.collateralAsset),
      outputAssetRef: erc20AssetRefV1("1", facts.identity.facts.debtAsset),
      amountIn: "1000",
      recipient: addr("8"),
    },
    readPort: {
      read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
        const balance = request.target === facts.identity.facts.collateralAsset ? 10_000n : 10_000n;
        return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: `0x${balance.toString(16).padStart(64, "0")}` };
      },
    },
  };
}

const searchAdapter = FLUID_CREDIT_SEARCH_RUNTIME_ADAPTER_FACTORY({
  familyDefinitionHash: FLUID_CREDIT_FAMILY_DEFINITION_HASH,
  capabilityRefs: {},
  actionOwnerRefs: { action: asOwnerRef(h("search-action-owner")) },
  composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) },
});

test("Fluid Credit reverse identity and active behavior are chain-proven", () => {
  const seed = decodeFluidCreditCandidate(observation, FLUID_CREDIT_CONTRACT_PATTERN); assert.ok(seed); const nomination = nominateFluidCredit(seed); assert.equal(nomination.status, "nominated"); if (nomination.status !== "nominated") throw new Error("nomination failed");
  const base = { cutoff, target: addr("5"), factory: addr("6"), reverseVault: addr("9"), vaultId: "17", collateralAsset: addr("1"), debtAsset: addr("2"), collateralDecimals: 0, debtDecimals: 0, vaultHasCode: true, collateralAssetHasCode: true, debtAssetHasCode: true, activeProbe: { actor: FLUID_CREDIT_PROBE_ACTOR, collateralAmount: "1000", debtAmount: "850", nftId: "1", finalSupply: "1000", finalBorrow: "850", collateralDelta: "-1000", debtDelta: "850" } } as const;
  assert.deepEqual(verifyFluidCreditIdentityStage({ candidate: nomination.candidate, reads: base }), { status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
  assert.deepEqual(verifyFluidCreditIdentityStage({ candidate: nomination.candidate, reads: { ...base, reverseVault: addr("5"), activeProbe: { ...base.activeProbe, collateralDelta: "0" } } }), { status: "chain-proven-rejected", reasonCode: "inactive-behavior" });
  assert.deepEqual(nominateFluidCredit({ ...seed, evidence: { ...seed.evidence, blockNumber: "50" } }), { status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  assert.equal(decodeFluidCreditCandidate({ ...observation, topic: h("wrong") }, FLUID_CREDIT_CONTRACT_PATTERN), null);
});

test("Fluid Credit binds standing position, effect proof, repayment, final safety, and execution", () => {
  const facts = verified(); const executor = addr("8"); const collateralAmount = "1000"; const debtBps = "8500"; const debtAmount = fluidDebtAmount({ collateralAmount, debtBps, collateralDecimals: facts.identity.facts.collateralDecimals, debtDecimals: facts.identity.facts.debtDecimals });
  const effects = [{ token: facts.identity.facts.collateralAsset, account: "executor" as const, delta: `-${collateralAmount}` }, { token: facts.identity.facts.debtAsset, account: "executor" as const, delta: debtAmount }];
  const proof = { kind: "fluid-credit-effect-proof" as const, cutoff, routeBindingHash: facts.route.routeBindingHash, executor, collateralAmount, debtAmount, nftId: "7", finalSupply: collateralAmount, finalBorrow: debtAmount, effects, effectRoot: effectRoot(effects) };
  const coarse = coarseFluidCredit({ ...facts, collateralAmount, debtBps }); assert.equal(coarse.status, "rankable");
  const exact = exactFluidCredit({ ...facts, collateralAmount, debtBps, executor, effectProof: proof }); assert.equal(exact.status, "rankable"); if (exact.status !== "rankable") throw new Error("exact failed");
  const action = buildFluidCreditAction({ identity: facts.identity, quote: exact.quote, executor }); assert.equal(action.obligationSet.standingPosition.finalSafety, "repayment-and-position-safe"); assert.equal(action.obligationSet.repayment.due, "final-simulation");
  assert.equal(action.calldata.slice(10, 74), "0".repeat(64));
  assert.notEqual(exact.quote.effectProof.nftId, facts.identity.facts.vaultId);
  assert.throws(() => buildFluidCreditAction({ identity: facts.identity, quote: { ...exact.quote, effectProof: { ...exact.quote.effectProof, nftId: "8" } }, executor }), /quote lineage mismatch/);
  const execution = compileFluidCreditExecution({ identity: facts.identity, action }); assert.equal(execution.obligationRoot, action.obligationSet.obligationRoot); assert.equal(execution.finalSafety, "repayment-and-position-safe"); assert.equal(execution.expectedEffects[0]?.delta, `-${collateralAmount}`);
  assert.throws(() => compileFluidCreditExecution({ identity: facts.identity, action: { ...action, obligationSet: { ...action.obligationSet, obligationRoot: h("tampered") } } }), /obligation root mismatch/);
  assert.equal(FLUID_CREDIT_FAMILY_ID, "fluid-credit");
});

test("Fluid Credit search cannot turn caller objective debt or effect proof into credit authority", async () => {
  const forged = await searchAdapter.run(searchInput({ debtBps: "8500", effectProof: { effectRoot: h("forged-effect") } }));
  const unrelated = await searchAdapter.run(searchInput({ kind: "unrelated-objective" }));
  assert.deepEqual(forged, unrelated);
  assert.equal(forged.kind, "unavailable");
  if (forged.kind === "unavailable") {
    assert.equal(forged.stage, "coarse");
    assert.equal(forged.reasonCode, "qualified-credit-terms-not-in-release");
  }
});
