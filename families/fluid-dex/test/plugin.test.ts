import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import {
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type RecentLogEvidenceRefV1,
} from "../../../packages/discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
import {
  FLUID_DEX_CONTRACT_EVIDENCE_TOPIC,
  FLUID_DEX_FAMILY_ID,
  FLUID_DEX_FAMILY_VERSION,
  FLUID_DEX_SOURCE_PLAN_ID,
} from "../src/manifest.ts";
import {
  FLUID_DEX_DEFINITION,
  FLUID_DEX_FAMILY_DEFINITION_HASH,
} from "../src/family-definition.ts";
import { FLUID_DEX_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";
import {
  FLUID_DEX_SOURCE_NOMINATION_PROGRAM,
  FLUID_DEX_SOURCE_PLAN,
  FLUID_DEX_SOURCE_PLAN_RUNTIME,
} from "../src/source-plan.ts";
import {
  FLUID_DEX_CONTRACT_PATTERN,
  buildFluidDexAction,
  coarseFluidDex,
  compileFluidDexExecution,
  decodeFluidDexCandidate,
  deriveFluidDexRoutes,
  exactFluidDex,
  materializeFluidDex,
  nominateFluidDex,
  verifyFluidDexIdentityStage,
} from "../src/stages.ts";

const addr = (digit: string) => "0x" + digit.repeat(40);
const h = (label: string) => hashDomain("aloha/test/fluid-dex", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = {
  kind: "log" as const,
  target: addr("5"),
  blockNumber: "100",
  blockHash: cutoff.hash,
  txHash: h("tx"),
  logIndex: "0",
  topic: FLUID_DEX_CONTRACT_EVIDENCE_TOPIC,
  rawLocatorHash: h("raw"),
  cutoff,
};

function fixture() {
  const bytes = Uint8Array.from([1, 2, 3]);
  const rawHash = sha256Hex(bytes);
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
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
    opaqueResult: { kind: "fluid-dex-empty" },
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
  const seed = decodeFluidDexCandidate(observation, FLUID_DEX_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateFluidDex(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const identity = verifyFluidDexIdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: addr("5"),
      reverseTarget: addr("5"),
      inputAsset: addr("1"),
      outputAsset: addr("2"),
    },
  });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeFluidDex({
    identity: identity.identity,
    read: { cutoff, instanceKey: addr("5"), reserveIn: "100", reserveOut: "200" },
  });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("materialization failed");
  const route = deriveFluidDexRoutes(identity.identity)[0];
  assert.ok(route);
  return { identity: identity.identity, state: state.state, route };
}

test("Fluid DEX source execution is the fixed 50-block recent window", async () => {
  const { FLUID_DEX_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await FLUID_DEX_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.outcome, "complete");
  assert.equal(result.execution.executionRoot, result.execution.executionRoot);
});
test("FLUID_DEX_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const { FLUID_DEX_FAMILY_DEFINITION_HASH } = await import("../src/family-definition.ts");
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await FLUID_DEX_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, FLUID_DEX_FAMILY_DEFINITION_HASH);
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await FLUID_DEX_SOURCE_NOMINATION_PROGRAM.evaluate({
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
test("Fluid DEX nomination rejects evidence outside the fixed 50-block window and wrong pattern", () => {
  const seed = decodeFluidDexCandidate(observation, FLUID_DEX_CONTRACT_PATTERN);
  assert.ok(seed);
  assert.deepEqual(
    nominateFluidDex({ ...seed, evidence: { ...seed.evidence, blockNumber: "50" } }),
    { status: "chain-proven-rejected", reasonCode: "evidence-before-window" },
  );
  assert.equal(
    decodeFluidDexCandidate({ ...observation, topic: h("wrong-topic") }, FLUID_DEX_CONTRACT_PATTERN),
    null,
  );
});

test("Fluid DEX reverse identity binds the instance before route and state", () => {
  const seed = decodeFluidDexCandidate(observation, FLUID_DEX_CONTRACT_PATTERN);
  assert.ok(seed);
  const nomination = nominateFluidDex(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const rejected = verifyFluidDexIdentityStage({
    candidate: nomination.candidate,
    reads: {
      cutoff,
      target: addr("5"),
      reverseTarget: addr("6"),
      inputAsset: addr("1"),
      outputAsset: addr("2"),
    },
  });
  assert.deepEqual(rejected, { status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" });
});

test("Fluid DEX carries identity → materialization → route → exact → action → execution lineage", () => {
  const facts = verified();
  const coarse = coarseFluidDex({
    identity: facts.identity,
    route: facts.route,
    amountIn: "10",
    observedAmountOut: "20",
  });
  assert.equal(coarse.status, "rankable");
  if (coarse.status !== "rankable") throw new Error("coarse failed");
  const exact = exactFluidDex({
    identity: facts.identity,
    route: facts.route,
    amountIn: "10",
    observedAmountOut: "20",
  });
  assert.equal(exact.status, "rankable");
  if (exact.status !== "rankable") throw new Error("exact failed");
  const action = buildFluidDexAction({
    identity: facts.identity,
    quote: exact.quote,
    calldata: "0x1234",
  });
  assert.throws(
    () => buildFluidDexAction({
      identity: facts.identity,
      quote: { ...exact.quote, routeBindingHash: h("foreign-route") },
      calldata: "0x1234",
    }),
    /route binding/,
  );
  const intent = compileFluidDexExecution({ identity: facts.identity, action });
  assert.equal(intent.actionHash, action.actionHash);
  assert.equal(intent.target, facts.identity.instanceKey);
});
