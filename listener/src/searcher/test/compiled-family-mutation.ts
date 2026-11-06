import { plugin as eigenpieProductionPlugin } from "../venues/production-families/eigenpie.production.js";
import { plugin as astraMultiTokenProductionPlugin } from "../venues/production-families/astra-multitoken.production.js";
import assert from "node:assert/strict";
import type { MutationPricingEntry, MutationSemantics, UnifiedObservation } from "../venues/adapter-family-plugin.js";

import { ASTRA_MULTITOKEN_CHANGE_TOPIC } from "./fixtures/protocol-json/astra-multitoken-fixture.js";

import { plugin as ellaPlugin } from "../venues/production-families/ella-exchange.production.js";
import { curvePlainPricing } from "../venues/swaps/curve-plain-family/pricing.js";
import { plugin as univ4FeeHook } from "../venues/production-families/univ4-fee-hook.production.js";
import { UNIV4_SWAP_TOPIC, UNIV4_INITIALIZE_TOPIC, UNIV4_MODIFY_LIQUIDITY_TOPIC } from "../venues/swaps/univ4-abi.js";
import { plugin as erc4626SiloRedeemJsonPlugin } from "../venues/production-families/erc4626-silo-redeem.production.js";
import { plugin as etherTokenNativeRedeemJsonPlugin } from "../venues/production-families/ethertoken-native-redeem.production.js";
import { plugin as metronomeHgUsdcJsonPlugin } from "../venues/production-families/metronome-hgusdc.production.js";
import { plugin as metronomeSynthJsonPlugin } from "../venues/production-families/metronome-synth.production.js";
import { plugin as selfBurnNativeJsonPlugin } from "../venues/production-families/self-burn-native.production.js";

const eigenpiePricing = eigenpieProductionPlugin.pricing;

const astraMultiTokenPricing = astraMultiTokenProductionPlugin.pricing;

const erc4626SiloRedeemPricing = erc4626SiloRedeemJsonPlugin.pricing;
const etherTokenNativeRedeemPricing = etherTokenNativeRedeemJsonPlugin.pricing;
const metronomeHgUsdcPricing = metronomeHgUsdcJsonPlugin.pricing;
const metronomeSynthPricing = metronomeSynthJsonPlugin.pricing;
const selfBurnNativePricing = selfBurnNativeJsonPlugin.pricing;


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
  ["ella", ellaPlugin.pricing!, (pool, instanceKey) => ({ instance: { familyId:ellaPlugin.manifest.familyId,lineageId:ellaPlugin.manifest.supportedLineages[0],pool, token: shared, factory: other, oracle, aggregator: address(203), instanceKey } })],
  ["curve-plain", curvePlainPricing, (pool) => ({ instance: { pool, binding: { coins: [shared, other], registry: oracle, codeHash: hash(888) } } })],
  ["v4-fee-hook", univ4FeeHook.pricing, (_, key) => ({ lineageId: univ4FeeHook.manifest.supportedLineages[0], instanceKey: key, poolId: key,
    managerBinding: { manager: oracle, stateView: other, quoter: address(203) }, hookModel: "tiered", graphToken0: shared, graphToken1: other, poolKey: { currency0: shared, currency1: other, fee: 0x800000, tickSpacing: 10, hooks: address(204) } })],
];
const normalized = (keys: readonly string[]) => [...new Set(keys.map(key => key.toLowerCase()))].sort();
let comparisons = 0;
for (const [name, pricing, descriptor] of cases) {
  const entries: MutationPricingEntry<any, any>[] = [1, 2, 3].map(n => {
    const stateKey = hash(n), routes = [{ routeKey: stateKey, instanceKey: stateKey, ...(name === "v4-fee-hook" && { poolId: stateKey }) }], d = descriptor(address(n), stateKey);
    const owner = ({ astra: astraMultiTokenProductionPlugin, eigenpie: eigenpieProductionPlugin, silo: erc4626SiloRedeemJsonPlugin, ethertoken: etherTokenNativeRedeemJsonPlugin, "self-burn": selfBurnNativeJsonPlugin, "hg-usdc": metronomeHgUsdcJsonPlugin, metronome: metronomeSynthJsonPlugin } as Record<string, typeof erc4626SiloRedeemJsonPlugin>)[name];
    const bound = owner ? { ...d, familyId: owner.manifest.familyId, lineageId: owner.manifest.supportedLineages[0] } : d;
    try { return { descriptor: bound, routes, stateKey, dependencies: pricing.dependencies({ descriptor: bound, routes }) }; }
    catch (cause) { throw new Error(`failed to prepare the mutation fixture for ${name}`, { cause }); }
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
