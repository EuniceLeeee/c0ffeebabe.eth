import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { ERC4626_SILO_REDEEM_SOURCE_PLAN_ID, ERC4626_SILO_REDEEM_CAPABILITY_IDS } from "../src/manifest.ts";
import { ERC4626_SILO_REDEEM_SOURCE_PLAN } from "../src/source-plan.ts";
import { ERC4626_SILO_REDEEM_SOURCE_NOMINATION_PROGRAM, ERC4626_SILO_REDEEM_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { ERC4626_SILO_REDEEM_DEFINITION, ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeErc4626SiloRedeemCandidate, ERC4626_SILO_REDEEM_OWNED_LOG_TOPIC } from "../src/discovery.ts";
import { nominateErc4626SiloRedeem } from "../src/nomination.ts";
import { verifyErc4626SiloRedeemIdentityStage } from "../src/identity.ts";
import { deriveErc4626SiloRedeemRoutes } from "../src/routes.ts";
import { exactErc4626SiloRedeem } from "../src/exact.ts";
import { sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type RecentLogEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import type { RecentObservationReceiptV1 } from "../../../packages/observation/src/index.ts";
const addr = (digit: string) => `0x${digit.repeat(40)}`; const h = (label: string) => hashDomain("aloha/test/erc4626-silo", label); const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const; const observation = { kind: "call" as const, target: addr("5"), blockNumber: "100", blockHash: h("b"), txHash: h("tx"), logIndex: "0", rawLocatorHash: h("raw"), cutoff };
test("Silo redeem source window and absence slots are explicit", () => { assert.equal(ERC4626_SILO_REDEEM_SOURCE_PLAN.sourcePlanId, ERC4626_SILO_REDEEM_SOURCE_PLAN_ID); assert.equal(ERC4626_SILO_REDEEM_DEFINITION.extensions[ERC4626_SILO_REDEEM_CAPABILITY_IDS.coarse]?.kind, "absent"); });
test("Silo redeem log admission is family-owned and rejects an unrelated topic", () => { assert.equal(decodeErc4626SiloRedeemCandidate({ ...observation, kind: "log", topic: h("unrelated-topic") }, "erc4626-silo-redeem-call"), null); assert.ok(decodeErc4626SiloRedeemCandidate({ ...observation, kind: "log", topic: ERC4626_SILO_REDEEM_OWNED_LOG_TOPIC }, "erc4626-silo-redeem-call")); });
test("Silo redeem exact effects require reverse identity and conservation", () => { const seed = decodeErc4626SiloRedeemCandidate(observation, "erc4626-silo-redeem-call"); assert.ok(seed); const nominated = nominateErc4626SiloRedeem(seed); assert.equal(nominated.status, "nominated"); if (nominated.status !== "nominated") throw new Error("nomination failed"); const identity = verifyErc4626SiloRedeemIdentityStage({ candidate: nominated.candidate, reads: { cutoff, target: addr("5"), reverseTarget: addr("5"), vault: addr("5"), payoutToken: addr("2"), actor: addr("3") } }); assert.equal(identity.status, "verified"); if (identity.status !== "verified") throw new Error("identity failed"); const route = deriveErc4626SiloRedeemRoutes(identity.identity)[0]!; const deltas = [{ token: addr("5") as `0x${string}`, account: addr("3") as `0x${string}`, delta: -10n }, { token: addr("2") as `0x${string}`, account: addr("3") as `0x${string}`, delta: 9n }]; const supply = [{ token: addr("5") as `0x${string}`, delta: -10n }]; assert.equal(exactErc4626SiloRedeem({ identity: identity.identity, route, returnDataHex: `0x${(9n).toString(16).padStart(64, "0")}`, tokenDeltas: deltas, supplyDeltas: supply, amountIn: "10" }).status, "verified"); assert.equal(exactErc4626SiloRedeem({ identity: identity.identity, route, returnDataHex: `0x${(9n).toString(16).padStart(64, "0")}`, tokenDeltas: [{ ...deltas[0]!, delta: -9n }, deltas[1]!], supplyDeltas: supply, amountIn: "10" }).status, "chain-proven-rejected"); });

test("ERC4626_SILO_REDEEM_SOURCE_PLAN_RUNTIME is deterministic and does not call a physical source producer", async () => {
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  };
  const result = await ERC4626_SILO_REDEEM_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.plan.familyDefinitionHash, ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH);
  assert.equal(result.execution.outcome, "positive-only");
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);
  const nominations = await ERC4626_SILO_REDEEM_SOURCE_NOMINATION_PROGRAM.evaluate({
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
