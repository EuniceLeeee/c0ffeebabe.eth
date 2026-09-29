import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import type { UnifiedObservation } from "../../adapter-family-plugin.js";
import { decodeEkuboBalanceUpdate, exactInputAmountOut, ekuboRouterIface,
  EKUBO_CORE, EKUBO_ROUTER, EKUBO_POOL_INITIALIZED_TOPIC, EKUBO_ROUTER_SWAP_SELECTOR, EKUBO_ROUTER_MULTIHOP_SELECTOR,
  EKUBO_MAX_EXACT_INPUT } from "../ekubo/abi.js";
import { normalizeEkuboPoolKey, ekuboPoolExtension, ekuboPoolId, ekuboGraphToken, type EkuboPoolKey } from "../ekubo/pool-key.js";
import type { EkuboCandidate } from "./types.js";

// Reuse only the low-level ABI/key codec. No legacy registry, materializer,
// pricing capability or route-leg runtime is an authority for this Family.
export const ERC20 = new ethers.Interface(["function decimals() view returns (uint8)"]);
// Independently observed at block 25988723 (before the target transaction).
// Nomination only: production execution always encodes an explicit receiver.
export const NO_RECEIVER = new ethers.Interface([
  "function swap((address token0,address token1,bytes32 config) poolKey,bool isToken1,int128 amount,uint96 sqrtRatioLimit,uint256 skipAhead,int256 calculatedAmountThreshold) payable returns (bytes32 balanceUpdate)",
]);
export const NO_RECEIVER_SELECTOR = NO_RECEIVER.getFunction("swap")!.selector;
const INIT_TYPES = ["bytes32", "tuple(address token0,address token1,bytes32 config)", "int32", "uint96"];
const abi = ethers.AbiCoder.defaultAbiCoder();
export const lower = (address: string): string => ethers.getAddress(address).toLowerCase();
export const same = (a: string, b: string): boolean => lower(a) === lower(b);
export const MAX_UINT = (1n << 256n) - 1n;
export const MAX_MULTIHOP_HOPS = 32;

// Structural nomination only. Nonzero extensions MUST separately prove the
// supported deployed behavior and reverse Core binding in identity.ts.
export function supportedKey(key: EkuboPoolKey): EkuboPoolKey {
  const normalized = normalizeEkuboPoolKey(key);
  if (same(ekuboGraphToken(normalized.token0), ekuboGraphToken(normalized.token1))) throw new Error("ekubo collapsed native/WETH graph pair");
  if (ekuboPoolExtension(normalized.config) !== ethers.ZeroAddress && (BigInt(normalized.config) & 0xffffffffn) !== 0n) {
    throw new Error("ekubo supported TWAMM requires full-range config");
  }
  return normalized;
}
export function candidate(key: EkuboPoolKey): EkuboCandidate {
  const poolKey = supportedKey(key);
  return Object.freeze({ candidateKind: "ekubo-pool-key", poolKey, poolId: ekuboPoolId(poolKey) });
}
// Source Router.multihopSwap: every hop must consume the complete specified
// input, including when the aggregate threshold is int256.min. No amounts for
// later hops are invented from calldata; actual outputs belong to trace/quote.
export function decodeMultihopCall(observation: UnifiedObservation): readonly EkuboCandidate[] | null {
  if (observation.kind !== "call" || !same(observation.target, EKUBO_ROUTER) ||
      observation.data.slice(0, 10).toLowerCase() !== EKUBO_ROUTER_MULTIHOP_SELECTOR || observation.data.length > 20_000) return null;
  try {
    const decoded = ekuboRouterIface.decodeFunctionData("multihopSwap", observation.data);
    if (ekuboRouterIface.encodeFunctionData("multihopSwap", decoded).toLowerCase() !== observation.data.toLowerCase()) return null;
    const [hops, initial] = decoded[0];
    if (hops.length === 0 || hops.length > MAX_MULTIHOP_HOPS || BigInt(initial[1]) <= 0n || BigInt(initial[1]) > EKUBO_MAX_EXACT_INPUT) return null;
    let token = lower(String(initial[0]));
    const keys: EkuboCandidate[] = [];
    for (const hop of hops) {
      if (BigInt(hop[1]) !== 0n || BigInt(hop[2]) !== 0n) return null;
      const found = candidate({ token0: String(hop[0][0]), token1: String(hop[0][1]), config: String(hop[0][2]) });
      if (same(token, found.poolKey.token0)) token = lower(found.poolKey.token1);
      else if (same(token, found.poolKey.token1)) token = lower(found.poolKey.token0);
      else return null;
      keys.push(found);
    }
    return Object.freeze(keys);
  } catch { return null; }
}
export function decodeSwapCall(observation: UnifiedObservation) {
  if (observation.kind !== "call" || !same(observation.target, EKUBO_ROUTER)) return null;
  const selector = observation.data.slice(0, 10).toLowerCase();
  const iface = selector === EKUBO_ROUTER_SWAP_SELECTOR ? ekuboRouterIface : selector === NO_RECEIVER_SELECTOR ? NO_RECEIVER : null;
  if (!iface) return null;
  try {
    const decoded = iface.decodeFunctionData("swap", observation.data);
    if (iface.encodeFunctionData("swap", decoded).toLowerCase() !== observation.data.toLowerCase()) return null;
    const key = candidate({ token0: String(decoded[0][0]), token1: String(decoded[0][1]), config: String(decoded[0][2]) });
    const amountIn = BigInt(decoded[2]);
    // Exact output, limit-bound/skip-ahead execution and partial fills are not
    // this route contract. Threshold/recipient are observations, never authority.
    if (amountIn <= 0n || amountIn > EKUBO_MAX_EXACT_INPUT || BigInt(decoded[3]) !== 0n || BigInt(decoded[4]) !== 0n) return null;
    return { ...key, isToken1: Boolean(decoded[1]), amountIn };
  } catch { return null; }
}
export function decodeInitialized(log: { readonly address: string; readonly topics: readonly string[]; readonly data: string }): EkuboCandidate | null {
  try {
    if (!same(log.address, EKUBO_CORE) || log.topics.length !== 1 ||
        log.topics[0].toLowerCase() !== EKUBO_POOL_INITIALIZED_TOPIC || !ethers.isHexString(log.data, 192)) return null;
    const decoded = abi.decode(INIT_TYPES, log.data);
    if (abi.encode(INIT_TYPES, decoded).toLowerCase() !== log.data.toLowerCase()) return null;
    const found = candidate({ token0: String(decoded[1][0]), token1: String(decoded[1][1]), config: String(decoded[1][2]) });
    return String(decoded[0]).toLowerCase() === found.poolId && BigInt(decoded[3]) > 0n ? found : null;
  } catch { return null; }
}
export function call(id: string, data: string, to: string = EKUBO_ROUTER): AdapterRequest {
  return { id, kind: "eth-call", to, data, completion: "return-or-revert-data" };
}
export function assertSource(actual: CanonicalSource, expected: CanonicalSource): void {
  if (!Number.isSafeInteger(actual.number) || actual.number < 0 || !Number.isSafeInteger(actual.generation) || actual.generation < 0 ||
      !ethers.isHexString(actual.hash, 32) || !ethers.isHexString(expected.hash, 32) ||
      actual.number !== expected.number || actual.generation !== expected.generation || actual.hash.toLowerCase() !== expected.hash.toLowerCase()) {
    throw new Error("ekubo foreign/invalid source");
  }
}
export function validateResults(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource): CanonicalSource {
  if (results.length !== ids.length || new Set(ids).size !== ids.length ||
      new Set(results.map(r => r.id)).size !== ids.length || results.some(r => !ids.includes(r.id))) throw new Error("ekubo missing/duplicate/unexpected result");
  const source = expected ?? results[0]?.source;
  if (!source) throw new Error("ekubo missing source");
  for (const result of results) assertSource(result.source, source);
  return Object.freeze({ ...source });
}
export function returned(results: readonly AdapterRequestResult[], id: string) {
  const reads = results.filter(r => r.id === id);
  if (reads.length !== 1) throw new Error(`ekubo missing/duplicate result ${id}`);
  const read = reads[0];
  if (!read.ok) throw new Error(`ekubo unresolved ${id}: ${read.failure}`);
  if (read.completion !== "returned") throw new Error(`ekubo ${id} reverted`);
  return read;
}
export function decimals(data: string): number {
  if (!ethers.isHexString(data, 32) || BigInt(data) > 36n) throw new Error("ekubo unsupported/noncanonical decimals");
  return Number(BigInt(data));
}
export function probeAmount(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36) throw new Error("ekubo unsupported scale");
  const amount = 10n ** BigInt(scale) / 10_000n;
  return amount > 0n ? amount : 1n;
}
// A sizing hint is NEVER an Exact result or positive identity proof. A partial
// router quote may only select a smaller request, which must then fill fully.
export function decodeSizingProbe(data: string, isToken1: boolean, amountIn: bigint) {
  if (amountIn <= 0n || amountIn > EKUBO_MAX_EXACT_INPUT || !ethers.isHexString(data, 64)) throw new Error("ekubo noncanonical quote");
  const [update, stateAfter] = ekuboRouterIface.decodeFunctionResult("quote", data);
  if (BigInt(stateAfter) === 0n) throw new Error("ekubo uninitialized quote state");
  const deltas = decodeEkuboBalanceUpdate(String(update));
  const filledAmountIn = isToken1 ? deltas.delta1 : deltas.delta0;
  if (filledAmountIn > amountIn) throw new Error("ekubo overconsumed input");
  return Object.freeze({ filledAmountIn, amountOut: exactInputAmountOut(deltas, isToken1), stateAfter: String(stateAfter).toLowerCase() });
}
export function decodeQuote(data: string, isToken1: boolean, amountIn: bigint) {
  const probe = decodeSizingProbe(data, isToken1, amountIn);
  if (probe.filledAmountIn !== amountIn) throw new Error("ekubo partial fill is not Exact");
  return Object.freeze({ amountOut: probe.amountOut, stateAfter: probe.stateAfter });
}
