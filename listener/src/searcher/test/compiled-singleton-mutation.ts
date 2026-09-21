import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { CompiledMutationIndex, MutationPricingEntry, UnifiedObservation } from "../venues/adapter-family-plugin.js";
import { balancerV3Pricing } from "../venues/swaps/balancer-v3-family/pricing.js";
import { SWAP_ABI, VAULT, ROUTER, PERMIT2 } from "../venues/swaps/balancer-v3-family/codec.js";
import type { BalancerV3PricingDescriptor, BalancerV3Route } from "../venues/swaps/balancer-v3-family/types.js";
import { ekuboPricing } from "../venues/swaps/ekubo-family/pricing.js";
import { EKUBO_CORE, EKUBO_ROUTER } from "../venues/swaps/ekubo/abi.js";
import type { EkuboPricingDescriptor, EkuboRoute } from "../venues/swaps/ekubo-family/types.js";

type BalEntry = MutationPricingEntry<BalancerV3PricingDescriptor, BalancerV3Route>;
type EkEntry = MutationPricingEntry<EkuboPricingDescriptor, EkuboRoute>;
const address = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const hash = (n: number) => ethers.toBeHex(n, 32);
const source = { number: 101, hash: hash(101), generation: 3 };
const token = address(10), otherToken = address(11), hook = address(12), rate = address(13);
const poolA = address(20), poolB = address(21), outsider = address(99);
const log = (emitter: string, topics: readonly string[] = [hash(1)], data = "0x"): UnifiedObservation =>
  ({ kind: "log", source, address: emitter, topics, data });
const call = (target: string): UnifiedObservation => ({ kind: "call", source, target, data: "0x12345678" });
const sorted = (keys: readonly string[]) => [...new Set(keys)].sort();

// Only mutation-consumed fields are needed: these are local routing fixtures,
// not identity/admission or quote-math substitutes.
function balEntry(pool: string, key: string, dependencies?: readonly string[], hookAddress = hook): BalEntry {
  const route = { routeKey: key } as BalancerV3Route;
  const descriptor = { instance: { pool, binding: { tokens: [token, otherToken],
    hooks: { address: hookAddress }, tokenInfo: [{ rateProvider: rate }, { rateProvider: ethers.ZeroAddress }] } }, route } as unknown as BalancerV3PricingDescriptor;
  return { descriptor, routes: [route], stateKey: key,
    dependencies: dependencies ?? [pool, token, otherToken, hookAddress, rate, VAULT, ROUTER, PERMIT2] };
}
function ekEntry(poolId: string, key: string, dependencies?: readonly string[]): EkEntry {
  const route = { routeKey: key } as EkuboRoute;
  const descriptor = { instance: { poolId, poolKey: { token0: token, token1: otherToken } }, route } as EkuboPricingDescriptor;
  return { descriptor, routes: [route], stateKey: key,
    dependencies: dependencies ?? [EKUBO_CORE, EKUBO_ROUTER, token, otherToken] };
}
function legacy<D, R>(entries: readonly MutationPricingEntry<D, R>[], observation: UnifiedObservation,
  affected: (input: { descriptor: D; routes: readonly R[]; observation: UnifiedObservation }) => readonly string[]) {
  const target = observation.kind === "log" ? observation.address : observation.kind === "call" ? observation.target : null;
  return sorted(entries.filter(entry => target !== null && entry.dependencies.some(d => d.toLowerCase() === target.toLowerCase()))
    .flatMap(entry => [...affected({ descriptor: entry.descriptor, routes: entry.routes, observation })]));
}
let parityCases = 0;
function parity<D, R>(entries: readonly MutationPricingEntry<D, R>[], compiled: CompiledMutationIndex,
  observations: readonly UnifiedObservation[],
  affected: (input: { descriptor: D; routes: readonly R[]; observation: UnifiedObservation }) => readonly string[]) {
  const declared = new Set(entries.flatMap(e => e.dependencies.map(d => d.toLowerCase())));
  assert(compiled.dependencies.every(d => declared.has(d.toLowerCase())), "compiled dependencies cannot widen authority");
  for (const observation of observations) {
    assert.deepEqual(sorted(compiled.affectedStateKeys({ observation })), legacy(entries, observation, affected));
    parityCases++;
  }
}
function swap(pool: string): UnifiedObservation {
  const encoded = SWAP_ABI.encodeEventLog(SWAP_ABI.getEvent("Swap")!, [pool, token, otherToken, 1000n, 999n, 0n, 0n]);
  return log(VAULT, encoded.topics, encoded.data);
}
const balEntries = [balEntry(poolA, "a:0"), balEntry(poolA, "a:1"), balEntry(poolB, "b:0"),
  balEntry(poolB, "b:1"), balEntry(poolA, "a:0")];
const bal = balancerV3Pricing.mutation.compile({ entries: balEntries });
const balSwap = swap(poolA) as Extract<UnifiedObservation, { kind: "log" }>;
const balObservations = [
  ...[token, token.toLowerCase(), otherToken, hook, rate, poolA, poolB, outsider, VAULT, ROUTER, PERMIT2, ethers.ZeroAddress]
    .flatMap(a => [call(a), log(a)]),
  swap(poolA), swap(poolB), swap(outsider), log(outsider, balSwap.topics, balSwap.data),
  log(VAULT, [], "0x"), log(VAULT, balSwap.topics, "0x"), log(VAULT, balSwap.topics, "0x01"),
];
parity(balEntries, bal, balObservations, balancerV3Pricing.mutation.affectedStateKeys);
assert.deepEqual(sorted(bal.affectedStateKeys({ observation: swap(poolA) })), ["a:0", "a:1"]);
assert(!bal.dependencies.includes(ROUTER.toLowerCase()) && !bal.dependencies.includes(PERMIT2.toLowerCase()),
  "pure infrastructure dependencies must not schedule zero-work callbacks");
// Vault logs take the special decode branch even if Vault is also a hook/token.
// Calls must still honor a real dependency that aliases Router/Permit2/Vault.
const aliases = [balEntry(poolA, "vault-hook", undefined, VAULT),
  balEntry(poolA, "router-hook", undefined, ROUTER), balEntry(poolB, "permit-hook", undefined, PERMIT2)];
parity(aliases, balancerV3Pricing.mutation.compile({ entries: aliases }), balObservations,
  balancerV3Pricing.mutation.affectedStateKeys);
const restrictedBal = [balEntry(poolA, "restricted", [token]), balEntry(poolB, "vault-only", [VAULT])];
parity(restrictedBal, balancerV3Pricing.mutation.compile({ entries: restrictedBal }), balObservations,
  balancerV3Pricing.mutation.affectedStateKeys);

const ekEntries = [ekEntry(hash(1), "e1:0"), ekEntry(hash(1), "e1:1"), ekEntry(hash(2), "e2:0"),
  ekEntry(hash(2), "e2:1"), ekEntry(hash(1), "e1:0")];
const ek = ekuboPricing.mutation.compile({ entries: ekEntries });
const anonymous = (poolId: string) => log(EKUBO_CORE, [],
  `0x${outsider.slice(2)}${poolId.slice(2)}${"00".repeat(64)}`);
const ekObservations = [
  ...[EKUBO_CORE, EKUBO_ROUTER, token, token.toLowerCase(), otherToken, outsider].flatMap(a => [call(a), log(a)]),
  anonymous(hash(1)), anonymous(hash(2)), anonymous(hash(99)),
  log(EKUBO_CORE, [], "0x"), log(EKUBO_CORE, [], "0x01"), log(EKUBO_CORE, [], `0x${"00".repeat(117)}`),
];
parity(ekEntries, ek, ekObservations, ekuboPricing.mutation.affectedStateKeys);
assert.deepEqual(sorted(ek.affectedStateKeys({ observation: anonymous(hash(1)) })), ["e1:0", "e1:1"]);
assert.deepEqual(sorted(ek.affectedStateKeys({ observation: log(EKUBO_CORE, [], "0x01") })),
  ["e1:0", "e1:1", "e2:0", "e2:1"], "malformed anonymous Core event keeps conservative invalidation");
const restrictedEk = [ekEntry(hash(1), "token-only", [token]), ekEntry(hash(1), "core-only", [EKUBO_CORE])];
parity(restrictedEk, ekuboPricing.mutation.compile({ entries: restrictedEk }), ekObservations,
  ekuboPricing.mutation.affectedStateKeys);

// Count the actual ABI decoder, leaving its implementation and result intact.
const decodeEventLog = SWAP_ABI.decodeEventLog;
let balDecodeCalls = 0;
try {
  SWAP_ABI.decodeEventLog = function (...args: Parameters<typeof decodeEventLog>) {
    balDecodeCalls++;
    return decodeEventLog.apply(this, args);
  };
  legacy(balEntries, balSwap, balancerV3Pricing.mutation.affectedStateKeys);
  assert.equal(balDecodeCalls, balEntries.length);
  balDecodeCalls = 0;
  bal.affectedStateKeys({ observation: balSwap });
  assert.equal(balDecodeCalls, 1, "one real Swap decode for all directions");
} finally { SWAP_ABI.decodeEventLog = decodeEventLog; }
// The actual Core parser receives observation.data once per invocation.
const coreLog = anonymous(hash(1)) as Extract<UnifiedObservation, { kind: "log" }>;
let parserInputs = 0;
const countedCore = { ...coreLog, get data() { parserInputs++; return coreLog.data; } };
legacy(ekEntries, countedCore, ekuboPricing.mutation.affectedStateKeys);
assert.equal(parserInputs, ekEntries.length);
parserInputs = 0;
ek.affectedStateKeys({ observation: countedCore });
assert.equal(parserInputs, 1, "one real anonymous Core parse for all directions");
for (const compiled of [balancerV3Pricing.mutation.compile({ entries: [] }), ekuboPricing.mutation.compile({ entries: [] })]) {
  assert.deepEqual(compiled.dependencies, []);
  assert.deepEqual(compiled.affectedStateKeys({ observation: call(token) }), []);
}
console.log(`compiled-singleton-mutation PASS: ${parityCases} old/new touched-set comparisons; direction dedupe, dependency intersection, Vault precedence, Core malformed fallback; decoders 5 -> 1`);
