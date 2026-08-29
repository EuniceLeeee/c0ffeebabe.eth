import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { METRONOME_HGUSDC_SOURCE_PLAN_ID, METRONOME_HGUSDC_CAPABILITY_IDS } from "../src/manifest.ts";
import { METRONOME_HGUSDC_SOURCE_PLAN } from "../src/source-plan.ts";
import { METRONOME_HGUSDC_SOURCE_NOMINATION_PROGRAM, METRONOME_HGUSDC_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { METRONOME_HGUSDC_DEFINITION } from "../src/family-definition.ts";
import { METRONOME_HGUSDC_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeMetronomeHgUsdcCandidate, nominateMetronomeHgUsdc, verifyMetronomeHgUsdcIdentityStage, deriveMetronomeHgUsdcRoutes } from "../src/stages.ts";
import { sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
const addr = (d: string) => `0x${d.repeat(40)}`; const h = (x: string) => hashDomain("aloha/test/metronome-hgusdc", x); const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const; const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };
test("hgUSDC source and extension absence are explicit", () => { assert.equal(METRONOME_HGUSDC_SOURCE_PLAN.sourcePlanId, METRONOME_HGUSDC_SOURCE_PLAN_ID); assert.equal(METRONOME_HGUSDC_DEFINITION.extensions[METRONOME_HGUSDC_CAPABILITY_IDS.coarse]?.kind, "absent"); });
test("hgUSDC identity uses the Family kernel path projection", () => { const seed = decodeMetronomeHgUsdcCandidate(observation, "metronome-hgusdc-call"); assert.ok(seed); const nomination = nominateMetronomeHgUsdc(seed); assert.equal(nomination.status, "nominated"); if (nomination.status !== "nominated") throw new Error("nomination failed"); const identity = verifyMetronomeHgUsdcIdentityStage({ candidate: nomination.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("5"), router: addr("5"), curve: addr("6"), vault: addr("7"), tokenIn: addr("1"), curveIntermediate: addr("2"), tokenOut: addr("3"), pathHash: h("path") } }); assert.equal(identity.status, "verified"); if (identity.status !== "verified") throw new Error("identity failed"); assert.equal(deriveMetronomeHgUsdcRoutes(identity.identity).length, 1); });

test("METRONOME_HGUSDC_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: METRONOME_HGUSDC_FAMILY_AUTHORING_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await METRONOME_HGUSDC_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, METRONOME_HGUSDC_FAMILY_AUTHORING_HASH);
  assert.equal(result.execution.outcome, "positive-only");
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await METRONOME_HGUSDC_SOURCE_NOMINATION_PROGRAM.evaluate({
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
