import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { PSM_SOURCE_PLAN_ID, PSM_CAPABILITY_IDS } from "../src/manifest.ts";
import { PSM_SOURCE_PLAN } from "../src/source-plan.ts";
import { PSM_SOURCE_NOMINATION_PROGRAM, PSM_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { PSM_DEFINITION } from "../src/family-definition.ts";
import { PSM_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodePsmCandidate, nominatePsm, verifyPsmIdentityStage, derivePsmRoutes, materializePsm, coarsePsm } from "../src/stages.ts";
import { sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
const addr = (d: string) => `0x${d.repeat(40)}`; const h = (x: string) => hashDomain("aloha/test/psm", x); const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const; const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };
test("PSM source and all release capabilities are explicit", () => { assert.equal(PSM_SOURCE_PLAN.sourcePlanId, PSM_SOURCE_PLAN_ID); assert.equal(PSM_DEFINITION.extensions[PSM_CAPABILITY_IDS.exact]?.kind, "present"); });
test("PSM fee quote is bound through identity, state and route", () => { const seed = decodePsmCandidate(observation, "psm-call"); assert.ok(seed); const nomination = nominatePsm(seed); assert.equal(nomination.status, "nominated"); if (nomination.status !== "nominated") throw new Error("nomination failed"); const identity = verifyPsmIdentityStage({ candidate: nomination.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("5"), inputAsset: addr("1"), outputAsset: addr("2") } }); assert.equal(identity.status, "verified"); if (identity.status !== "verified") throw new Error("identity failed"); const state = materializePsm({ identity: identity.identity, read: { cutoff, instanceKey: addr("5"), feeWad: "10000000000000000", assetScale: "1000000000000" } }); assert.equal(state.status, "verified"); if (state.status !== "verified") throw new Error("state failed"); const route = derivePsmRoutes(identity.identity)[0]!; assert.equal(coarsePsm({ identity: identity.identity, state: state.state, route, amountIn: "1000001" }).status, "rankable"); assert.equal(coarsePsm({ identity: identity.identity, state: state.state, route, amountIn: "-1" }).status, "unavailable"); });

test("PSM_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: PSM_FAMILY_AUTHORING_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await PSM_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, PSM_FAMILY_AUTHORING_HASH);
  assert.equal(result.execution.outcome, "positive-only");
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await PSM_SOURCE_NOMINATION_PROGRAM.evaluate({
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
