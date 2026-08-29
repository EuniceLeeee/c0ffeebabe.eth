import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { GOLDX_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { GOLDX_SOURCE_PLAN } from "../src/source-plan.ts";
import { GOLDX_SOURCE_NOMINATION_PROGRAM, GOLDX_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { GOLDX_DEFINITION, GOLDX_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeGoldxCandidate } from "../src/discovery.ts";
import { nominateGoldx } from "../src/nomination.ts";
import { verifyGoldxIdentityStage } from "../src/identity.ts";
import { deriveGoldxRoutes } from "../src/routes.ts";
import { materializeGoldx } from "../src/instance.ts";
import { coarseGoldx } from "../src/pricing.ts";
import { exactGoldx } from "../src/exact.ts";
import { sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
const addr = (digit: string) => `0x${digit.repeat(40)}`; const h = (label: string) => hashDomain("aloha/test/goldx", label); const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const; const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };
test("GOLDx source is a fixed 50-block nomination-only plan", () => { assert.equal(GOLDX_SOURCE_PLAN.sourcePlanId, GOLDX_SOURCE_PLAN_ID); assert.equal(GOLDX_SOURCE_PLAN.completeness, "nomination-only"); });
test("GOLDx does not claim arbitrary recent logs because its trigger is call-owned", () => { assert.equal(decodeGoldxCandidate({ ...observation, kind: "log", topic: h("unrelated-topic") }, "goldx-call"), null); });
test("GOLDx exact math binds identity, state and route", () => { const seed = decodeGoldxCandidate(observation, "goldx-call"); assert.ok(seed); const nominated = nominateGoldx(seed); assert.equal(nominated.status, "nominated"); if (nominated.status !== "nominated") throw new Error("nomination failed"); const identity = verifyGoldxIdentityStage({ candidate: nominated.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("5"), inputAsset: addr("1"), outputAsset: addr("2") } }); assert.equal(identity.status, "verified"); if (identity.status !== "verified") throw new Error("identity failed"); const state = materializeGoldx({ identity: identity.identity, read: { cutoff, instanceKey: addr("5"), unitWad: "1000000000000000000" } }); assert.equal(state.status, "verified"); if (state.status !== "verified") throw new Error("state failed"); const route = deriveGoldxRoutes(identity.identity)[0]!; const coarseInput = { identity: identity.identity, state: state.state, route, amountIn: "7" }; assert.equal(coarseGoldx(coarseInput).status, "rankable"); assert.equal(exactGoldx(coarseInput).status, "rankable"); assert.equal(GOLDX_DEFINITION.manifest.sourcePlans[0]?.sourcePlanId, GOLDX_SOURCE_PLAN_ID); });

test("GOLDX_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: GOLDX_FAMILY_AUTHORING_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await GOLDX_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, GOLDX_FAMILY_AUTHORING_HASH);
  assert.equal(result.execution.outcome, "positive-only");
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await GOLDX_SOURCE_NOMINATION_PROGRAM.evaluate({
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
