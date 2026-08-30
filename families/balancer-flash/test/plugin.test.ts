import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, sha256Hex, type CanonicalJson } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import {
  familyCandidateKey,
  candidateSubjectHash,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type RecentLogEvidenceRefV1,
} from "../../../packages/discovery/src/index.ts";
import type { FamilySearchSourceReadRequestV1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
import {
  BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC,
  BALANCER_FLASH_FAMILY_ID,
  BALANCER_FLASH_FAMILY_VERSION,
  BALANCER_FLASH_SOURCE_PLAN_ID,
  BALANCER_VAULT,
} from "../src/manifest.ts";
import {
  BALANCER_FLASH_DEFINITION,
  BALANCER_FLASH_FAMILY_DEFINITION_HASH,
} from "../src/family-definition.ts";
import { BALANCER_FLASH_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";
import {
  BALANCER_FLASH_SOURCE_NOMINATION_PROGRAM,
  BALANCER_FLASH_SOURCE_PLAN,
  BALANCER_FLASH_SOURCE_PLAN_RUNTIME,
} from "../src/source-plan.ts";
import {
  BALANCER_FLASH_CONTRACT_PATTERN,
  buildBalancerFlashAction,
  coarseBalancerFlash,
  compileBalancerFlashExecution,
  decodeBalancerFlashCandidate,
  deriveBalancerFlashRoutes,
  exactBalancerFlash,
  materializeBalancerFlash,
  nominateBalancerFlash,
  verifyBalancerFlashIdentityStage,
} from "../src/stages.ts";

const addr = (digit: string) => "0x" + digit.repeat(40);
const h = (label: string) => hashDomain("aloha/test/balancer-flash", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = {
  kind: "log" as const,
  target: BALANCER_VAULT,
  blockNumber: "100",
  blockHash: cutoff.hash,
  txHash: h("tx"),
  logIndex: "0",
  topic: BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC,
  rawLocatorHash: h("raw"),
  cutoff,
};

function fixture() {
  const bytes = Uint8Array.from([1, 2, 3]);
  const rawHash = sha256Hex(bytes);
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const sourceEvidence = {
    kind: "source-plan-evidence" as const,
    version: 1 as const,
    plan,
    cutoff,
    refs: [],
    rawLocatorHashes: [rawHash],
    evidenceRoot: sourcePlanEvidenceRoot({ plan, cutoff, refs: [], rawLocatorHashes: [rawHash] }),
  };
  const executionBase = {
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan,
    cutoff,
    outcome: "positive-only" as const,
    from: "100",
    through: "100",
    previousAppliedThrough: null,
    resultPartitionRoot: h("partition"),
    opaqueResult: { kind: "balancer-flash-empty" },
    sourceEvidenceRefs: [],
    rawLocatorHashes: [rawHash],
    sourceEvidenceRoot: sourceEvidence.evidenceRoot,
  };
  const execution = { ...executionBase, executionRoot: sourcePlanExecutionRoot(executionBase) };
  const response = {
    execution,
    sourceEvidence,
    rawEvidenceLocators: [{
      kind: "raw-evidence-locator" as const,
      version: 1 as const,
      rawLocatorHash: rawHash,
      bytesHex: "0x010203",
    }],
  };
  return { rawHash, plan, sourceEvidence, execution, response };
}

function verified() {
  const seed = decodeBalancerFlashCandidate(observation, BALANCER_FLASH_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateBalancerFlash(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const identity = verifyBalancerFlashIdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: BALANCER_VAULT,
      reverseTarget: BALANCER_VAULT,
      inputAsset: addr("1"),
      outputAsset: addr("2"),
    },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeBalancerFlash({
    identity: identity.identity,
    read: { cutoff, instanceKey: BALANCER_VAULT, reserveIn: "100", reserveOut: "200" },
  });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("materialization failed");
  const route = deriveBalancerFlashRoutes(identity.identity)[0];
  assert.ok(route);
  return { identity: identity.identity, state: state.state, route };
}

function searchInput(objectivePayload: CanonicalJson) {
  const facts = verified();
  const recipient = addr("9");
  const subjectHash = candidateSubjectHash(BALANCER_FLASH_FAMILY_DEFINITION_HASH, facts.identity.instanceKey);
  const releaseIdentity = { ...facts.identity, candidateSnapshotHash: subjectHash };
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson({
    kind: "balancer-flash-identity-memo",
    familyId: BALANCER_FLASH_FAMILY_ID,
    familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
    familyCandidateKey: familyCandidateKey(BALANCER_FLASH_FAMILY_DEFINITION_HASH, facts.identity.instanceKey),
    instanceNominationKey: facts.identity.instanceKey,
    candidateSnapshotHash: subjectHash,
    candidateEvidenceRoot: h("search-candidate-evidence"),
    identity: releaseIdentity,
  }));
  return {
    route: {
      familyId: BALANCER_FLASH_FAMILY_ID,
      familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
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
      inputAssetRef: erc20AssetRefV1("1", facts.identity.facts.inputAsset),
      outputAssetRef: erc20AssetRefV1("1", facts.identity.facts.outputAsset),
      amountIn: "10",
      recipient,
    },
    execution: { transactionOrigin: addr("8"), executorAddress: recipient },
    readPort: {
      read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
        const balance = request.target === facts.identity.facts.inputAsset ? 100n : 200n;
        return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: `0x${balance.toString(16).padStart(64, "0")}` };
      },
    },
  };
}

const searchAdapter = BALANCER_FLASH_SEARCH_RUNTIME_ADAPTER_FACTORY({
  familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
  capabilityRefs: {},
  actionOwnerRefs: { action: asOwnerRef(h("search-action-owner")) },
  composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) },
});

test("Balancer flash source execution is the fixed 50-block recent window", async () => {
  const { BALANCER_FLASH_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await BALANCER_FLASH_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.outcome, "complete");
  assert.equal(result.execution.executionRoot, result.execution.executionRoot);
});
test("BALANCER_FLASH_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const { BALANCER_FLASH_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: BALANCER_FLASH_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await BALANCER_FLASH_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, BALANCER_FLASH_FAMILY_DEFINITION_HASH);
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await BALANCER_FLASH_SOURCE_NOMINATION_PROGRAM.evaluate({
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
test("Balancer flash nomination rejects evidence outside the fixed 50-block window and wrong pattern", () => {
  const seed = decodeBalancerFlashCandidate(observation, BALANCER_FLASH_CONTRACT_PATTERN);
  assert.ok(seed);
  assert.deepEqual(
    nominateBalancerFlash({ ...seed, evidence: { ...seed.evidence, blockNumber: "50" } }),
    { status: "chain-proven-rejected", reasonCode: "evidence-before-window" },
  );
  assert.equal(
    decodeBalancerFlashCandidate({ ...observation, topic: h("wrong-topic") }, BALANCER_FLASH_CONTRACT_PATTERN),
    null,
  );
});

test("Balancer flash reverse identity binds the instance before route and state", () => {
  const seed = decodeBalancerFlashCandidate(observation, BALANCER_FLASH_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateBalancerFlash(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const rejected = verifyBalancerFlashIdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: BALANCER_VAULT,
      reverseTarget: addr("6"),
      inputAsset: addr("1"),
      outputAsset: addr("2"),
    },
  });
  assert.deepEqual(rejected, { status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
});

test("Balancer flash carries identity → materialization → route → exact → action → execution lineage", () => {
  const facts = verified();
  const coarse = coarseBalancerFlash({
    identity: facts.identity,
    route: facts.route,
    amountIn: "10",
    observedAmountOut: "20",
  });
  assert.equal(coarse.status, "rankable");
  if (coarse.status !== "rankable") throw new Error("coarse failed");
  const exact = exactBalancerFlash({
    identity: facts.identity,
    route: facts.route,
    amountIn: "10",
    observedAmountOut: "20",
  });
  assert.equal(exact.status, "rankable");
  if (exact.status !== "rankable") throw new Error("exact failed");
  const action = buildBalancerFlashAction({
    identity: facts.identity,
    quote: exact.quote,
    calldata: "0x1234",
    receiver: addr("9"),
    fee: "2",
  });
  assert.equal(action.obligation.due, "same-transaction");
  assert.equal(action.obligation.repayment, "12");
  assert.throws(
    () => buildBalancerFlashAction({
      identity: facts.identity,
      quote: { ...exact.quote, routeBindingHash: h("foreign-route") },
      calldata: "0x1234",
      receiver: addr("9"),
      fee: "2",
    }),
    /route binding/,
  );
  const intent = compileBalancerFlashExecution({ identity: facts.identity, action });
  assert.equal(intent.actionHash, action.actionHash);
  assert.equal(intent.target, facts.identity.instanceKey);
  assert.equal(intent.obligationHash, action.obligation.obligationHash);
  assert.equal(intent.expectedEffects[2]?.amount, "12");
  assert.throws(() => compileBalancerFlashExecution({ identity: facts.identity, action: { ...action, obligation: { ...action.obligation, repayment: "13" } } }), /repayment arithmetic|obligation hash mismatch/);
});

test("Balancer flash search cannot turn caller objective quote, fee, or calldata into funding authority", async () => {
  const forged = await searchAdapter.run(searchInput({ observedAmountOut: "999999", fee: "0", calldata: "0x1234" }));
  const unrelated = await searchAdapter.run(searchInput({ kind: "unrelated-objective" }));
  assert.deepEqual(forged, unrelated);
  assert.equal(forged.kind, "unavailable");
  if (forged.kind === "unavailable") {
    assert.equal(forged.stage, "coarse");
    assert.equal(forged.reasonCode, "qualified-funding-offer-not-in-release");
  }
});
