import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";
import { encodeEvmLogObservation, sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { DODO_DECIMAL_ONE } from "../src/kernel/math.ts";
import { DODO_V2_FACTORIES, DODO_V2_HISTORY_SOURCE_PLAN_ID, DODO_V2_QUOTE_ACTOR, DODO_V2_SELL_BASE_SELECTOR, DODO_V2_SELL_QUOTE_SELECTOR, DODO_V2_SWAP_TOPIC, DODO_V2_SOURCE_PLAN_ID } from "../src/manifest.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { decodeDodoCandidate } from "../src/discovery.ts";
import { nominateDodoV2 } from "../src/nomination.ts";
import { verifyDodoIdentityStage } from "../src/identity.ts";
import { materializeDodoV2 } from "../src/instance.ts";
import { deriveDodoRoutes } from "../src/routes.ts";
import { coarseDodoV2 } from "../src/pricing.ts";
import { exactDodoV2 } from "../src/exact.ts";
import { buildDodoAction } from "../src/action.ts";
import { compileDodoExecution } from "../src/execution.ts";
import { DODO_V2_HISTORY_SOURCE_PLAN, DODO_V2_SOURCE_NOMINATION_PROGRAM, DODO_V2_SOURCE_PLAN, DODO_V2_SOURCE_PLAN_RUNTIME } from "../src/source-plan.ts";
import { decodeDodoV2SwapLog } from "../src/swap-log.ts";

const addr = (digit: string) => `0x${digit.repeat(40)}`;
const h = (label: string) => hashDomain("aloha/test/dodo", label);
const cutoff = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const observation = { kind: "call" as const, callType: "CALL" as const, callSucceeded: true, target: addr("5"), blockNumber: "100", blockHash: h("b100"), txHash: h("tx"), logIndex: "0", selector: DODO_V2_SELL_BASE_SELECTOR, rawLocatorHash: h("raw"), cutoff, sellBase: true };
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => `${"0".repeat(24)}${value.slice(2)}`;
const swapData = (soldToken = addr("1"), boughtToken = addr("2"), soldAmount = 100n, boughtAmount = 99n, seller = addr("3"), receiver = addr("4")) => `0x${addressWord(soldToken)}${addressWord(boughtToken)}${word(soldAmount)}${word(boughtAmount)}${addressWord(seller)}${addressWord(receiver)}`;

test("DODO owns a recent 50-block nomination plan and a complete creation-history plan", () => {
  assert.equal(DODO_V2_SOURCE_PLAN.sourcePlanId, DODO_V2_SOURCE_PLAN_ID);
  assert.equal(DODO_V2_SOURCE_PLAN.completeness, "nomination-only");
  assert.equal(DODO_V2_SOURCE_PLAN.historyStartBlock, null);
  assert.ok(Object.isFrozen(DODO_V2_SOURCE_PLAN));
  assert.equal(DODO_V2_HISTORY_SOURCE_PLAN.sourcePlanId, DODO_V2_HISTORY_SOURCE_PLAN_ID);
  assert.equal(DODO_V2_HISTORY_SOURCE_PLAN.completeness, "contiguous-history");
  assert.equal(DODO_V2_HISTORY_SOURCE_PLAN.historyStartBlock, "0");
});

const sourcePlan = {
  ownerRef: h("owner"),
  sourcePlanRef: h("source-plan"),
  familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
  completeness: "nomination-only" as const,
  historyStartBlock: null,
};
test("DODO source runtime is deterministic and nominates only matching recent logs", async () => {
  const result = await DODO_V2_SOURCE_PLAN_RUNTIME.execute(
    { plan: sourcePlan, cutoff, previousAppliedThrough: null },
    { request: async () => { throw new Error("physical source producer must not be called"); } },
    new AbortController().signal,
  );
  assert.equal(result.execution.from, String(BigInt(cutoff.number) - 49n));
  assert.equal(result.execution.through, cutoff.number);
  assert.equal(result.execution.previousAppliedThrough, null);
  assert.equal(result.execution.sourceEvidenceRefs.length, 0);
  assert.equal(result.execution.rawLocatorHashes.length, 0);
  assert.equal(result.sourceEvidence.refs.length, 0);
  assert.equal(result.sourceEvidence.rawLocatorHashes.length, 0);

  const bytes = encodeEvmLogObservation({
    kind: "evm-log",
    version: 1,
    blockNumber: "100",
    blockHash: cutoff.hash,
    transactionHash: h("owned-tx"),
    logIndex: "0",
    address: addr("5"),
    topics: [DODO_V2_SWAP_TOPIC],
    data: swapData(),
  });
  const rawHash = sha256Hex(bytes);
  const evidence = { kind: "recent-log" as const, version: 1 as const, sourcePlanRef: null, ownerRef: null, blockNumber: "100", blockHash: cutoff.hash, txHash: h("owned-tx"), logIndex: "0", address: addr("5"), topic: DODO_V2_SWAP_TOPIC, rawLocatorHash: rawHash };
  const blocks = Array.from({ length: 50 }, (_, index) => {
    const number = String(51 + index);
    return { number, hash: number === "100" ? cutoff.hash : h(`block-${number}`), parentHash: index === 0 ? h("genesis") : h(`block-${Number(number) - 1}`), evidence: number === "100" ? [evidence] : [] };
  });
  const recent = sealRecentObservation(cutoff, { from: "51", to: "100" }, blocks, [{ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: rawHash, bytes }]);
  const reads: string[] = [];
  const nominations = await DODO_V2_SOURCE_NOMINATION_PROGRAM.evaluate({
    execution: result.execution,
    sourceEvidence: result.sourceEvidence,
    recent,
    rawEvidence: { read: hash => { reads.push(hash); return bytes; } },
  }, new AbortController().signal);
  assert.equal(nominations.length, 1);
  assert.deepEqual(reads, [rawHash]);
});

test("DODO decodes the real six-word Swap layout and rejects ABI mutations", () => {
  const realData = "0x000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2000000000000000000000000000000000000000000000000000000000001b7df00000000000000000000000000000000000000000000000000003be1fec1f3c5000000000000000000000000e08d97e151473a848c3d9ca3f323cb720472d015000000000000000000000000e08d97e151473a848c3d9ca3f323cb720472d015";
  assert.deepEqual(decodeDodoV2SwapLog({ topics: [DODO_V2_SWAP_TOPIC], data: realData }), {
    soldToken: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    boughtToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    soldAmount: 112607n,
    boughtAmount: 65841827804101n,
    seller: "0xe08d97e151473a848c3d9ca3f323cb720472d015",
    receiver: "0xe08d97e151473a848c3d9ca3f323cb720472d015",
  });
  assert.throws(() => decodeDodoV2SwapLog({ topics: [DODO_V2_SWAP_TOPIC, h("injected-topic")], data: realData }), /topic layout/);
  assert.throws(() => decodeDodoV2SwapLog({ topics: [DODO_V2_SWAP_TOPIC], data: realData.slice(0, -64) }), /exactly 6 ABI words/);
  assert.throws(() => decodeDodoV2SwapLog({ topics: [DODO_V2_SWAP_TOPIC], data: `0x1${realData.slice(3)}` }), /canonical padded nonzero address/);
  assert.throws(() => decodeDodoV2SwapLog({ topics: [DODO_V2_SWAP_TOPIC], data: swapData(addr("1"), addr("2"), 0n) }), /zero amount/);
  assert.throws(() => decodeDodoV2SwapLog({ topics: [DODO_V2_SWAP_TOPIC], data: swapData(addr("1"), addr("2"), 1n, 1n, addr("0")) }), /canonical padded nonzero address/);
});

function verified() {
  const seed = decodeDodoCandidate(observation, "dodo-v2-sell-base-call");
  assert.ok(seed);
  const nomination = nominateDodoV2(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const pmm = { i: 2n * DODO_DECIMAL_ONE, K: 0n, B: 1_000n, Q: 2_000n, B0: 1_000n, Q0: 2_000n, R: 0 as const };
  const identity = verifyDodoIdentityStage({ candidate: nomination.candidate, reads: { cutoff, pool: addr("5"), factory: DODO_V2_FACTORIES[0]!.address, registry: DODO_V2_FACTORIES[0]!.address, registryPool: addr("5"), baseToken: addr("1"), quoteToken: addr("2"), quoteActor: DODO_V2_QUOTE_ACTOR, pmm, lpFeeRate: (DODO_DECIMAL_ONE / 10n).toString(), mtFeeRate: "0" } });
  assert.equal(identity.status, "verified");
  if (identity.status !== "verified") throw new Error("identity failed");
  const state = materializeDodoV2({ identity: identity.identity, read: { cutoff, pool: addr("5"), quoteActor: DODO_V2_QUOTE_ACTOR, pmm, lpFeeRate: (DODO_DECIMAL_ONE / 10n).toString(), mtFeeRate: "0" } });
  assert.equal(state.status, "verified");
  if (state.status !== "verified") throw new Error("state failed");
  return { identity: identity.identity, state: state.state, route: deriveDodoRoutes(identity.identity)[0]! };
}

test("DODO nomination has a bounded window and exact selector matching", () => {
  const seed = decodeDodoCandidate(observation, "dodo-v2-sell-base-call");
  assert.ok(seed);
  assert.equal(nominateDodoV2(seed).status, "nominated");
  assert.deepEqual(nominateDodoV2({ ...seed, evidence: { ...seed.evidence, blockNumber: "49" } }), { status: "chain-proven-rejected", reasonCode: "evidence-before-window" });
  assert.equal(decodeDodoCandidate({ ...observation, selector: "0xdeadbeef" }, "dodo-v2-sell-base-call"), null);
  assert.equal(decodeDodoCandidate({ ...observation, callType: "DELEGATECALL" }, "dodo-v2-sell-base-call"), null);
  assert.equal(decodeDodoCandidate({ ...observation, callSucceeded: false }, "dodo-v2-sell-base-call"), null);
});

test("DODO reverse registry binding and PMM fee semantics reach action", () => {
  const seed = decodeDodoCandidate(observation, "dodo-v2-sell-base-call");
  assert.ok(seed);
  const nomination = nominateDodoV2(seed);
  assert.equal(nomination.status, "nominated");
  if (nomination.status !== "nominated") throw new Error("nomination failed");
  const rejected = verifyDodoIdentityStage({ candidate: nomination.candidate, reads: { cutoff, pool: addr("5"), factory: DODO_V2_FACTORIES[0]!.address, registry: DODO_V2_FACTORIES[0]!.address, registryPool: addr("8"), baseToken: addr("1"), quoteToken: addr("2"), quoteActor: DODO_V2_QUOTE_ACTOR, pmm: { i: 2n * DODO_DECIMAL_ONE, K: 0n, B: 1_000n, Q: 2_000n, B0: 1_000n, Q0: 2_000n, R: 0 }, lpFeeRate: (DODO_DECIMAL_ONE / 10n).toString(), mtFeeRate: "0" } });
  assert.deepEqual(rejected, { status: "chain-proven-rejected", reasonCode: "registry-reverse-binding-failed" });
  const facts = verified();
  const exact = exactDodoV2({ ...facts, amountIn: "10" });
  assert.equal(exact.status, "verified");
  if (exact.status !== "verified") throw new Error("exact failed");
  const action = buildDodoAction({ identity: facts.identity, route: facts.route, quote: exact.quote, receiver: addr("8") });
  assert.equal(action.selector, DODO_V2_SELL_BASE_SELECTOR);
  assert.throws(() => buildDodoAction({ ...facts, quote: { ...exact.quote, routeBindingHash: h("foreign") }, receiver: addr("8") }), /lineage/);
  assert.equal(compileDodoExecution({ identity: facts.identity, action }).actionHash, action.actionHash);
  assert.equal(DODO_V2_SELL_QUOTE_SELECTOR.length, 10);
  assert.equal(DODO_V2_SWAP_TOPIC.length, 66);
});
