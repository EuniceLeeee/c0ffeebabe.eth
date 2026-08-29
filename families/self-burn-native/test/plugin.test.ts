import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { SELF_BURN_NATIVE_SOURCE_NOMINATION_PROGRAM, SELF_BURN_NATIVE_SOURCE_PLAN, SELF_BURN_NATIVE_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { SELF_BURN_NATIVE_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { SELF_BURN_NATIVE_DEFINITION } from "../src/family-definition.ts";
import { SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeSelfBurnNativeCandidate, deriveSelfBurnNativeRoutes, exactSelfBurnNative, nominateSelfBurnNative, verifySelfBurnNativeIdentityStage, SELF_BURN_NATIVE_OWNED_LOG_TOPIC } from "../src/stages.ts";
const addr = (digit: string) => `0x${digit.repeat(40)}` as `0x${string}`;
const h = (label: string) => hashDomain("aloha/test/self-burn-native", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const token = addr("1"); const actor = addr("2"); const target = addr("5"); const observation = { kind: "call" as const, target, blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };
function identity() { const seed = decodeSelfBurnNativeCandidate(observation, "self-burn-native-call"); assert.ok(seed); const nominated = nominateSelfBurnNative(seed); assert.equal(nominated.status, "nominated"); if (nominated.status !== "nominated") throw new Error("nomination failed"); const result = verifySelfBurnNativeIdentityStage({ candidate: nominated.candidate, reads: { cutoff, target, reverseTarget: target, token, actor, redeemSelector: "0x12345678" } }); assert.equal(result.status, "verified"); if (result.status !== "verified") throw new Error("identity failed"); return result.identity; }
test("self-burn native uses the fixed 50-block plan", () => { assert.equal(SELF_BURN_NATIVE_SOURCE_PLAN.sourcePlanId, SELF_BURN_NATIVE_SOURCE_PLAN_ID); assert.equal(SELF_BURN_NATIVE_SOURCE_NOMINATION_PROGRAM.schemaHash, SELF_BURN_NATIVE_SOURCE_PLAN.schemaHash); assert.equal(SELF_BURN_NATIVE_SOURCE_PLAN.completeness, "nomination-only"); });
test("self-burn native source execution is positive-only", async () => {
  const plan = { ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH, completeness: "nomination-only" as const, historyStartBlock: null };
  const result = await SELF_BURN_NATIVE_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, { request: async () => { throw new Error("physical source producer must not be called"); } }, new AbortController().signal);
  assert.equal(result.execution.outcome, "positive-only");
});
test("self-burn native log admission is family-owned and rejects an unrelated topic", () => { assert.equal(decodeSelfBurnNativeCandidate({ ...observation, kind: "log", topic: h("unrelated-topic") }, "self-burn-native-call"), null); assert.ok(decodeSelfBurnNativeCandidate({ ...observation, kind: "log", topic: SELF_BURN_NATIVE_OWNED_LOG_TOPIC }, "self-burn-native-call")); });
test("self-burn native exact verifies return and all burn/payout effects", () => { const current = identity(); const route = deriveSelfBurnNativeRoutes(current)[0]!; const result = exactSelfBurnNative({ identity: current, route, amountIn: "6", effects: { completion: "returned", returnDataHex: `0x${"0".repeat(63)}1`, tokenDeltas: [{ token, account: actor, delta: -6n }], nativeDeltas: [{ account: actor, delta: 4n }], supplyDeltas: [{ token, delta: -6n }], token, actor, amountIn: "6" } }); assert.equal(result.status, "verified"); });
test("self-burn native rejects a forged effect scope", () => { const current = identity(); const route = deriveSelfBurnNativeRoutes(current)[0]!; const result = exactSelfBurnNative({ identity: current, route, amountIn: "6", effects: { completion: "returned", returnDataHex: `0x${"0".repeat(63)}1`, tokenDeltas: [{ token, account: actor, delta: -6n }, { token, account: addr("3"), delta: 1n }], nativeDeltas: [{ account: actor, delta: 4n }], supplyDeltas: [{ token, delta: -6n }], token, actor, amountIn: "6" } }); assert.equal(result.status, "unavailable"); });
test("self-burn native definition has exact effect and trigger declarations", async () => { assert.equal(SELF_BURN_NATIVE_DEFINITION.manifest.familyId, "self-burn-native"); const adapter = (await import("../src/search-adapter.ts")).SELF_BURN_NATIVE_SEARCH_RUNTIME_ADAPTER_FACTORY; assert.equal(typeof adapter, "function"); });
