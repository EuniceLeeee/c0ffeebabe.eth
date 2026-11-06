import assert from "node:assert/strict";
import { ethers } from "ethers";
import { plugin as univ3 } from "../venues/production-families/univ3-standard.production.js";
import { plugin as univ4 } from "../venues/production-families/univ4.production.js";
import { UNIV3_SWAP_TOPIC, UNIV3_MINT_TOPIC, UNIV3_BURN_TOPIC,
  UNIV3_INITIALIZE_TOPIC, PANCAKE_V3_SWAP_TOPIC } from "../venues/swaps/univ3-abi.js";
import { UNIV4_SWAP_TOPIC, UNIV4_INITIALIZE_TOPIC,
  UNIV4_MODIFY_LIQUIDITY_TOPIC } from "../venues/swaps/univ4-abi.js";
import type { UnifiedObservation } from "../venues/adapter-family-plugin.js";

import univ3Definition from "../venues/swaps/univ3-family/univ3.json";
import { compileDeclarativeSwap } from "../venues/declarative-swap.js";

const address = (n: number) => ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const source = { number: 101, hash: hash(101), generation: 2 };
const pool = address(0xabcdef), manager = address(0x123abc), poolId = hash(77);
const v3Topics = [UNIV3_SWAP_TOPIC, UNIV3_MINT_TOPIC, UNIV3_BURN_TOPIC,
  UNIV3_INITIALIZE_TOPIC, PANCAKE_V3_SWAP_TOPIC];
const v4Topics = [UNIV4_SWAP_TOPIC, UNIV4_INITIALIZE_TOPIC, UNIV4_MODIFY_LIQUIDITY_TOPIC];
let v3AddressReads = 0, v4AddressReads = 0;
type V3Input = Parameters<typeof univ3.pricing.mutation.affectedStateKeys>[0];
type V4Input = Parameters<typeof univ4.pricing.mutation.affectedStateKeys>[0];
// Mutation only consumes these descriptor fields. Count access to the expensive
// address branch without changing the production checker or its semantics.
const v3 = { familyId: univ3.manifest.familyId, lineageId: univ3.manifest.supportedLineages[0], token0: address(1), token1: address(2),
  fee: 500n, tickSpacing: 10, factoryBinding: { factory: address(3) }, quoterBinding: {}, swapAccess: {}, instanceKey: pool.toLowerCase(), get pool() { v3AddressReads++; return pool; } } as V3Input["descriptor"];
const v4 = { familyId: univ4.manifest.familyId, lineageId: univ4.manifest.supportedLineages[0], poolId,
  poolKey: { currency0: address(1), currency1: address(2), fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress },
  graphToken0: address(1), graphToken1: address(2), hookPolicy: "no-hook", get managerBinding() { v4AddressReads++; return { manager, stateView: address(4), quoter: address(5) }; } } as V4Input["descriptor"];
const log = (emitter: string, topics: string[]): UnifiedObservation => ({
  kind: "log", source, address: emitter, topics, data: "0x",
});
const call: UnifiedObservation = { kind: "call", source, target: pool, data: "0x" };
const observations = [call, ...[pool, pool.toLowerCase(), manager, address(333)].flatMap(emitter =>
  [...v3Topics, ...v4Topics, hash(999)].flatMap(topic => [
    log(emitter, [topic]), log(emitter, [topic, poolId]), log(emitter, [topic, hash(78)]),
  ]))];
// Reference is the pre-optimization predicate; compare all positive/negative
// canonical event cases, including shared emitters and Pancake V3's topic.
const baseline3 = (o: UnifiedObservation) => o.kind !== "log" ||
  ethers.getAddress(o.address) !== ethers.getAddress(pool) ||
  !v3Topics.includes(o.topics[0]?.toLowerCase() ?? "") ? [] : [pool.toLowerCase()];
const baseline4 = (o: UnifiedObservation) => o.kind !== "log" ||
  ethers.getAddress(o.address) !== ethers.getAddress(manager) ||
  !v4Topics.includes(o.topics[0]?.toLowerCase() ?? "") ||
  o.topics[1]?.toLowerCase() !== poolId ? [] : [poolId];
for (const observation of observations) {
  assert.deepEqual(univ3.pricing.mutation.affectedStateKeys({ descriptor: v3, routes: [{ instanceKey: v3.instanceKey }], observation }), baseline3(observation));
  assert.deepEqual(univ4.pricing.mutation.affectedStateKeys({ descriptor: v4, routes: [{ poolId }], observation }), baseline4(observation));
}
// A Family may bind its mutation identity through the full environment.
const boundDefinition = structuredClone(univ3Definition);
boundDefinition.standard.pricing.mutationPredicate = {
  op: "eq", args: ["$observation.address", "$binding.pool"],
} as typeof boundDefinition.standard.pricing.mutationPredicate;
const boundPricing = compileDeclarativeSwap(boundDefinition).pricing;
const boundInput = { descriptor: v3, routes: [{ instanceKey: v3.instanceKey }] };
assert.deepEqual(boundPricing.mutation.affectedStateKeys({ ...boundInput, observation: log(pool, [hash(999)]) }), [v3.instanceKey]);
assert.deepEqual(boundPricing.mutation.affectedStateKeys({ ...boundInput, observation: log(address(333), [hash(999)]) }), []);
v3AddressReads = 0; v4AddressReads = 0;
for (let i = 0; i < 10_000; i++) {
  univ3.pricing.mutation.affectedStateKeys({ descriptor: v3, routes: [{ instanceKey: v3.instanceKey }], observation: log(pool, [hash(999)]) });
  univ4.pricing.mutation.affectedStateKeys({ descriptor: v4, routes: [{ poolId }], observation: log(manager, [UNIV4_SWAP_TOPIC, hash(78)]) });
  univ4.pricing.mutation.affectedStateKeys({ descriptor: v4, routes: [{ poolId }], observation: log(manager, [hash(999), poolId]) });
}
assert.equal(v3AddressReads, 0, "unrelated V3 topics must not enter address validation");
assert.equal(v4AddressReads, 0, "unrelated V4 topics/poolIds must not enter address validation");
// Matching event shapes still validate addresses; optimization cannot admit a
// wrong emitter or silently accept a malformed address on the matched path.
for (const invalid of ["bad-address", pool.toLowerCase().replace("abcdef", "aBcdef")]) {
  assert.throws(() => univ3.pricing.mutation.affectedStateKeys({ descriptor: v3, routes: [{ instanceKey: v3.instanceKey }],
    observation: log(invalid, [UNIV3_SWAP_TOPIC]) }));
  assert.throws(() => univ4.pricing.mutation.affectedStateKeys({ descriptor: v4, routes: [{ poolId }],
    observation: log(invalid, [UNIV4_SWAP_TOPIC, poolId]) }));
}
console.log(`strict-mutation-hot-path PASS: ${observations.length} canonical observations preserve both touched sets; unrelated address validations=0`);
