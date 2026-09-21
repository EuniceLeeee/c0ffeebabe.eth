import assert from "node:assert/strict";
import type { MutationPricingEntry, MutationSemantics, UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { astraMultiTokenPricing } from "../venues/protocols/astra-multitoken-family/pricing.js";
import { ASTRA_MULTITOKEN_CHANGE_TOPIC } from "../venues/protocols/astra-multitoken-family/codec.js";
import { eigenpiePricing } from "../venues/protocols/eigenpie-family/pricing.js";
import { erc4626SiloRedeemPricing } from "../venues/protocols/erc4626-silo-redeem-family/pricing.js";
import { etherTokenNativeRedeemPricing } from "../venues/protocols/ethertoken-native-redeem-family/pricing.js";
import { metronomeHgUsdcPricing } from "../venues/protocols/metronome-hgusdc-family/pricing.js";
import { metronomeSynthPricing } from "../venues/protocols/metronome-synth-family/pricing.js";
import { selfBurnNativePricing } from "../venues/protocols/self-burn-native-family/pricing.js";
import { ellaPricing } from "../venues/swaps/ella-exchange-family/pricing.js";
import { curvePlainPricing } from "../venues/swaps/curve-plain-family/pricing.js";
import { univ4FeeHookPricing } from "../venues/swaps/univ4-fee-hook-family/pricing.js";
import { UNIV4_SWAP_TOPIC, UNIV4_INITIALIZE_TOPIC, UNIV4_MODIFY_LIQUIDITY_TOPIC } from "../venues/swaps/univ4-abi.js";

// Routing-only fixtures for Families absent from the full Ready cohort. They
// exercise the actual Family compiler, not identity/admission or quote math.
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const source = { number: 100, hash: hash(100), generation: 1 };
const shared = address(200), oracle = address(201), other = address(202);
type Pricing = { dependencies(input: { descriptor: any; routes: readonly any[] }): readonly string[];
  mutation?: MutationSemantics<any, any> };
const cases: readonly [string, Pricing, (pool: string, key: string) => any][] = [
  ["astra", astraMultiTokenPricing, (target, routeKey) => ({ target, route: { routeKey, tokenIn: shared, tokenOut: other } })],
  ["eigenpie", eigenpiePricing, (target, instanceKey) => ({ target, instanceKey, route: { tokenIn: shared, tokenOut: other } })],
  ["silo", erc4626SiloRedeemPricing, (vault, instanceKey) => ({ vault, payoutToken: shared, underlyingAsset: other, instanceKey })],
  ["ethertoken", etherTokenNativeRedeemPricing, (token, instanceKey) => ({ token, nativeAnchor: shared, instanceKey })],
  ["hg-usdc", metronomeHgUsdcPricing, (router, instanceKey) => ({ router, curve: other, vault: oracle,
    tokenIn: shared, curveIntermediate: address(203), tokenOut: address(204), instanceKey })],
  ["metronome", metronomeSynthPricing, (pool, instanceKey) => ({ pool, tokens: [shared, other], instanceKey })],
  ["self-burn", selfBurnNativePricing, (token, instanceKey) => ({ token, nativeAnchor: shared, instanceKey })],
  ["ella", ellaPricing, (pool, instanceKey) => ({ instance: { pool, token: shared, factory: other, oracle, aggregator: address(203), instanceKey } })],
  ["curve-plain", curvePlainPricing, (pool) => ({ instance: { pool, binding: { coins: [shared, other], registry: oracle } } })],
  ["v4-fee-hook", univ4FeeHookPricing, (_, key) => ({ poolId: key,
    managerBinding: { manager: oracle, stateView: other, quoter: address(203) }, poolKey: { currency0: shared, currency1: other } })],
];
const normalized = (keys: readonly string[]) => [...new Set(keys.map(key => key.toLowerCase()))].sort();
let comparisons = 0;
for (const [name, pricing, descriptor] of cases) {
  const entries: MutationPricingEntry<any, any>[] = [1, 2, 3].map(n => {
    const stateKey = hash(n), routes = [{ routeKey: stateKey }], d = descriptor(address(n), stateKey);
    return { descriptor: d, routes, stateKey, dependencies: pricing.dependencies({ descriptor: d, routes }) };
  });
  const mutation = pricing.mutation!;
  assert.equal(typeof mutation.compile, "function", name);
  const index = mutation.compile!({ entries });
  const addresses = [...new Set([...entries.flatMap(e => e.dependencies), address(999)])];
  const topics = [ASTRA_MULTITOKEN_CHANGE_TOPIC, UNIV4_SWAP_TOPIC, UNIV4_INITIALIZE_TOPIC,
    UNIV4_MODIFY_LIQUIDITY_TOPIC, hash(999)];
  for (const emitter of addresses) {
    const observations: UnifiedObservation[] = [
      { kind: "call", source, target: emitter, data: "0x" },
      { kind: "log", source, address: emitter, topics: [], data: "0x" },
      ...topics.flatMap(topic => [hash(1), hash(2), hash(999)].map(poolId => ({
        kind: "log" as const, source, address: emitter, topics: [topic, poolId], data: "0x",
      }))),
    ];
    for (const observation of observations) {
      const before = entries.flatMap(entry => entry.dependencies.some(d => d.toLowerCase() === emitter.toLowerCase())
        ? mutation.affectedStateKeys({ ...entry, observation }) : []);
      assert.deepEqual(normalized(index.affectedStateKeys({ observation })), normalized(before), `${name}: ${emitter} ${observation.kind}`);
      comparisons++;
    }
  }
}
console.log(`compiled-family-mutation PASS: ${cases.length} absent-Ready Families, ${comparisons} old/new touched-set controls`);
