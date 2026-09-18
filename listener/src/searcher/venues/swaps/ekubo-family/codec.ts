import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import type { UnifiedObservation } from "../../adapter-family-plugin.js";
import { decodeEkuboBalanceUpdate, exactInputAmountOut, ekuboRouterIface,
  EKUBO_CORE, EKUBO_ROUTER, EKUBO_POOL_INITIALIZED_TOPIC, EKUBO_ROUTER_SWAP_SELECTOR,
  EKUBO_MAX_EXACT_INPUT } from "../ekubo/abi.js";
import { normalizeEkuboPoolKey, ekuboPoolExtension, ekuboPoolId, type EkuboPoolKey } from "../ekubo/pool-key.js";
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

export function vanillaKey(key: EkuboPoolKey): EkuboPoolKey {
  const normalized = normalizeEkuboPoolKey(key);
  if (normalized.token0 === ethers.ZeroAddress) throw new Error("ekubo native settlement unsupported");
  if (ekuboPoolExtension(normalized.config) !== ethers.ZeroAddress) throw new Error("ekubo extension unsupported");
  return normalized;
}
export function candidate(key: EkuboPoolKey): EkuboCandidate {
  const poolKey = vanillaKey(key);
  return Object.freeze({ candidateKind: "ekubo-pool-key", poolKey, poolId: ekuboPoolId(poolKey) });
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
