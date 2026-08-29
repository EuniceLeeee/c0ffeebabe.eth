import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_ID, ETHERTOKEN_NATIVE_REDEEM_CAPABILITY_IDS } from "../src/manifest.ts";
import { ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN } from "../src/source-plan.ts";
import { ETHERTOKEN_NATIVE_REDEEM_SOURCE_NOMINATION_PROGRAM, ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { ETHERTOKEN_NATIVE_REDEEM_DEFINITION, ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeEtherTokenNativeRedeemCandidate, ETHERTOKEN_NATIVE_REDEEM_OWNED_LOG_TOPIC } from "../src/discovery.ts";
import { nominateEtherTokenNativeRedeem } from "../src/nomination.ts";
import { verifyEtherTokenNativeRedeemIdentityStage } from "../src/identity.ts";
import { deriveEtherTokenNativeRedeemRoutes } from "../src/routes.ts";
import { exactEtherTokenNativeRedeem } from "../src/exact.ts";
import { sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
const addr = (digit: string) => `0x${digit.repeat(40)}`; const h = (label: string) => hashDomain("aloha/test/ethertoken", label); const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const; const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };
test("EtherToken source window and absent coarse capability are explicit", () => { assert.equal(ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN.sourcePlanId, ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_ID); assert.equal(ETHERTOKEN_NATIVE_REDEEM_DEFINITION.extensions[ETHERTOKEN_NATIVE_REDEEM_CAPABILITY_IDS.coarse]?.kind, "absent"); });
test("EtherToken log admission is family-owned and rejects an unrelated topic", () => { assert.equal(decodeEtherTokenNativeRedeemCandidate({ ...observation, kind: "log", topic: h("unrelated-topic") }, "ethertoken-native-call"), null); assert.ok(decodeEtherTokenNativeRedeemCandidate({ ...observation, kind: "log", topic: ETHERTOKEN_NATIVE_REDEEM_OWNED_LOG_TOPIC }, "ethertoken-native-call")); });
test("EtherToken exact native effects require empty return and conservation", () => { const seed = decodeEtherTokenNativeRedeemCandidate(observation, "ethertoken-native-call"); assert.ok(seed); const nominated = nominateEtherTokenNativeRedeem(seed); assert.equal(nominated.status, "nominated"); if (nominated.status !== "nominated") throw new Error("nomination failed"); const identity = verifyEtherTokenNativeRedeemIdentityStage({ candidate: nominated.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("5"), token: addr("1"), actor: addr("3") } }); assert.equal(identity.status, "verified"); if (identity.status !== "verified") throw new Error("identity failed"); const route = deriveEtherTokenNativeRedeemRoutes(identity.identity)[0]!; const tokenDeltas = [{ token: addr("1") as `0x${string}`, account: addr("3") as `0x${string}`, delta: -10n }]; const nativeDeltas = [{ account: addr("3") as `0x${string}`, delta: 10n }]; const supplyDeltas = [{ token: addr("1") as `0x${string}`, delta: -10n }]; assert.equal(exactEtherTokenNativeRedeem({ identity: identity.identity, route, returnDataHex: "0x", tokenDeltas, nativeDeltas, supplyDeltas, amountIn: "10" }).status, "verified"); assert.equal(exactEtherTokenNativeRedeem({ identity: identity.identity, route, returnDataHex: "0x00", tokenDeltas, nativeDeltas, supplyDeltas, amountIn: "10" }).status, "chain-proven-rejected"); });

test("ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await ETHERTOKEN_NATIVE_REDEEM_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH);
  assert.equal(result.execution.outcome, "positive-only");
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await ETHERTOKEN_NATIVE_REDEEM_SOURCE_NOMINATION_PROGRAM.evaluate({
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
