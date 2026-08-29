import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { ROCKSOLID_SOURCE_NOMINATION_PROGRAM, ROCKSOLID_SOURCE_PLAN } from "../src/source-plan.ts";
import { ROCKSOLID_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { ROCKSOLID_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { ROCKSOLID_DEFINITION } from "../src/family-definition.ts";
import { ROCKSOLID_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { coarseRocksolid, decodeRocksolidCandidate, deriveRocksolidRoutes, materializeRocksolid, nominateRocksolid, verifyRocksolidIdentityStage } from "../src/stages.ts";
const addr = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;
const h = (value: string) => hashDomain("aloha/test/rocksolid", value);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };
function identity() { const seed = decodeRocksolidCandidate(observation, "rocksolid-call"); assert.ok(seed); const nominated = nominateRocksolid(seed); assert.equal(nominated.status, "nominated"); if (nominated.status !== "nominated") throw new Error("nomination"); const verified = verifyRocksolidIdentityStage({ candidate: nominated.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("5"), asset: addr("1"), receiptToken: addr("2"), depositSelector: "0x12345678" } }); assert.equal(verified.status, "verified"); if (verified.status !== "verified") throw new Error("identity"); return verified.identity; }
test("RockSolid source is fixed 50-block nomination-only", () => { assert.equal(ROCKSOLID_SOURCE_PLAN.sourcePlanId, ROCKSOLID_SOURCE_PLAN_ID); assert.equal(ROCKSOLID_SOURCE_NOMINATION_PROGRAM.schemaHash, ROCKSOLID_SOURCE_PLAN.schemaHash); assert.equal(ROCKSOLID_SOURCE_PLAN.completeness, "nomination-only"); });
test("RockSolid source execution is positive-only", async () => {
  const plan = { ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: ROCKSOLID_FAMILY_AUTHORING_HASH, completeness: "nomination-only" as const, historyStartBlock: null };
  const result = await ROCKSOLID_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, { request: async () => { throw new Error("physical source producer must not be called"); } }, new AbortController().signal);
  assert.equal(result.execution.outcome, "positive-only");
});
test("RockSolid quote binds return word, identity and route", () => { const current = identity(); const route = deriveRocksolidRoutes(current)[0]!; const state = materializeRocksolid({ identity: current, read: { cutoff, instanceKey: addr("5"), stateHash: h("state") } }); assert.equal(state.status, "verified"); assert.equal(coarseRocksolid({ identity: current, route, amountIn: "1", returnDataHex: `0x${"0".repeat(63)}2` }).status, "rankable"); });
test("RockSolid family definition and adapter are explicit", async () => { assert.equal(ROCKSOLID_DEFINITION.manifest.familyId, "rocksolid"); assert.equal(typeof (await import("../src/search-adapter.ts")).ROCKSOLID_SEARCH_RUNTIME_ADAPTER_FACTORY, "function"); });
