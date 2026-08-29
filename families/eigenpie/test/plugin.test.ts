import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { EIGENPIE_SOURCE_NOMINATION_PROGRAM, EIGENPIE_SOURCE_PLAN, EIGENPIE_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { EIGENPIE_SOURCE_PLAN_ID, EIGENPIE_CAPABILITY_IDS } from "../src/manifest.ts";
import { EIGENPIE_DEFINITION } from "../src/family-definition.ts";
import { EIGENPIE_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeEigenpieCandidate, EIGENPIE_OWNED_LOG_TOPIC } from "../src/discovery.ts";
import { nominateEigenpie } from "../src/nomination.ts";
import { verifyEigenpieIdentityStage } from "../src/identity.ts";
import { deriveEigenpieRoutes } from "../src/routes.ts";
import { exactEigenpie } from "../src/exact.ts";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const h = (label: string) => hashDomain("aloha/test/eigenpie", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };

test("Eigenpie owns a static nomination-only 50-block source plan", () => { assert.equal(EIGENPIE_SOURCE_PLAN.sourcePlanId, EIGENPIE_SOURCE_PLAN_ID); assert.equal(EIGENPIE_SOURCE_NOMINATION_PROGRAM.schemaHash, EIGENPIE_SOURCE_PLAN.schemaHash); assert.equal(EIGENPIE_SOURCE_PLAN.completeness, "nomination-only"); assert.equal(EIGENPIE_SOURCE_PLAN.historyStartBlock, null); assert.ok(Object.isFrozen(EIGENPIE_SOURCE_PLAN)); });
test("Eigenpie source execution is positive-only", async () => {
  const plan = { ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, completeness: "nomination-only" as const, historyStartBlock: null };
  const result = await EIGENPIE_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, { request: async () => { throw new Error("physical source producer must not be called"); } }, new AbortController().signal);
  assert.equal(result.execution.outcome, "positive-only");
});
test("Eigenpie log admission is family-owned and rejects an unrelated topic", () => { assert.equal(decodeEigenpieCandidate({ ...observation, kind: "log", topic: h("unrelated-topic") }, "eigenpie-quote-observation"), null); assert.ok(decodeEigenpieCandidate({ ...observation, kind: "log", topic: EIGENPIE_OWNED_LOG_TOPIC }, "eigenpie-quote-observation")); });
test("Eigenpie nomination is bounded and identity reverse binding is fail-closed", () => { const seed = decodeEigenpieCandidate(observation, "eigenpie-quote-observation"); assert.ok(seed); const nominated = nominateEigenpie(seed); assert.equal(nominated.status, "nominated"); if (nominated.status !== "nominated") throw new Error("nomination failed"); assert.equal(nominateEigenpie({ ...seed, evidence: { ...seed.evidence, blockNumber: "49" } }).status, "chain-proven-rejected"); const rejected = verifyEigenpieIdentityStage({ candidate: nominated.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("6"), inputAsset: addr("1"), outputAsset: addr("2") } }); assert.deepEqual(rejected, { status: "chain-proven-rejected", reasonCode: "reverse-identity-mismatch" }); });
test("Eigenpie exact quote uses the family kernel and binds the route", () => { const seed = decodeEigenpieCandidate(observation, "eigenpie-quote-observation"); assert.ok(seed); const nominated = nominateEigenpie(seed); assert.equal(nominated.status, "nominated"); if (nominated.status !== "nominated") throw new Error("nomination failed"); const identity = verifyEigenpieIdentityStage({ candidate: nominated.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("5"), inputAsset: addr("1"), outputAsset: addr("2") } }); assert.equal(identity.status, "verified"); if (identity.status !== "verified") throw new Error("identity failed"); const route = deriveEigenpieRoutes(identity.identity)[0]!; const data = `0x${(10n).toString(16).padStart(64, "0")}${addr("2").slice(2).padStart(64, "0")}`; assert.equal(exactEigenpie({ identity: identity.identity, route, quoteDataHex: `0x${data.slice(2)}` }).status, "verified"); assert.equal(EIGENPIE_DEFINITION.extensions[EIGENPIE_CAPABILITY_IDS.state]?.kind, "absent"); });
