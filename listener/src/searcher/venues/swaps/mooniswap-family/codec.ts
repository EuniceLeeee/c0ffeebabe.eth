import { ethers } from "ethers";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import type { MooniswapBinding, MooniswapDescriptor, MooniswapRoute } from "./types.js";

export const MOONISWAP_ID = familyId("mooniswap");
export const MOONISWAP_LINEAGE = lineageId("mooniswap:verified-v2-runtime");
export const MOONISWAP_ACTION = "mooniswap-swap-for";
export const MAX_UINT = (1n << 256n) - 1n;
export const FEE_DENOMINATOR = 10n ** 18n;
export const POOL = new ethers.Interface([
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function mooniswapFactoryGovernance() view returns(address)",
  "function getReturn(address src,address dst,uint256 amount) view returns(uint256)",
  "function getBalanceForAddition(address token) view returns(uint256)",
  "function getBalanceForRemoval(address token) view returns(uint256)",
  "function fee() view returns(uint256)",
  "function slippageFee() view returns(uint256)",
  "function swap(address src,address dst,uint256 amount,uint256 minReturn,address referral) payable returns(uint256)",
  "function swapFor(address src,address dst,uint256 amount,uint256 minReturn,address referral,address receiver) payable returns(uint256)",
  "event Swapped(address indexed sender,address indexed receiver,address indexed srcToken,address dstToken,uint256 amount,uint256 result,uint256 srcAdditionBalance,uint256 dstRemovalBalance,address referral)",
]);
export const GOVERNANCE = new ethers.Interface(["function isActive() view returns(bool)"]);
export const TOKEN = new ethers.Interface([
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function decimals() view returns(uint8)",
]);
export const lower = (address: string) => ethers.getAddress(address).toLowerCase();
export function nonzero(address: string): string {
  const value = lower(address);
  if (value === ethers.ZeroAddress) throw new Error("mooniswap ERC20-only address is zero");
  return value;
}
export function assertUint(value: bigint, positive = false): void {
  if (typeof value !== "bigint" || value < (positive ? 1n : 0n) || value > MAX_UINT) throw new Error("mooniswap invalid uint256 amount");
}
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("mooniswap noncanonical word");
  return BigInt(data);
}
export function addressWord(data: string): string {
  const value = uint(data);
  if (value >= 1n << 160n) throw new Error("mooniswap noncanonical address word");
  return nonzero(ethers.toBeHex(value, 20));
}
export function assertSource(actual: CanonicalSource, expected: CanonicalSource): void {
  if (!Number.isSafeInteger(actual.number) || actual.number < 0 || !Number.isSafeInteger(actual.generation) || actual.generation < 0 ||
      !ethers.isHexString(actual.hash, 32) || !ethers.isHexString(expected.hash, 32) ||
      actual.number !== expected.number || actual.generation !== expected.generation || actual.hash.toLowerCase() !== expected.hash.toLowerCase()) {
    throw new Error("mooniswap foreign source");
  }
}
export function returned(results: readonly AdapterRequestResult[], id: string, source: CanonicalSource) {
  const matches = results.filter(r => r.id === id);
  if (matches.length !== 1) throw new Error(`mooniswap missing/duplicate ${id}`);
  const r = matches[0]; assertSource(r.source, source);
  if (!r.ok) throw new Error(`mooniswap unresolved ${id}`);
  if (r.completion !== "returned") throw new Error(`mooniswap reverted ${id}`);
  return r;
}
export function binding(d: MooniswapBinding) {
  if (!ethers.isHexString(d.codeHash, 32)) throw new Error("mooniswap invalid runtime fingerprint");
  return { pool: nonzero(d.pool), token0: nonzero(d.token0), token1: nonzero(d.token1), codeHash: d.codeHash.toLowerCase() };
}
export const call = (id: string, to: string, data: string): AdapterRequest => ({ id, kind: "eth-call", to,
  data, caller: { kind: "executor" }, completion: "return-data" });
export function resultSet(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource): CanonicalSource {
  if (results.length !== ids.length || !results.length) throw new Error("mooniswap unexpected result set");
  const source = expected ?? results[0].source;
  assertSource(source, source);
  ids.forEach(id => returned(results, id, source));
  return source;
}
export function routeIdentity(d: MooniswapDescriptor, tokenIn: string, tokenOut: string): string {
  return `${MOONISWAP_ID}:${lower(d.pool)}:${lower(tokenIn)}>${lower(tokenOut)}`;
}
export function assertRoute(d: MooniswapDescriptor, r: MooniswapRoute): void {
  const b = binding(d), key = routeIdentity(d, r.tokenIn, r.tokenOut);
  if (BigInt(b.token0) >= BigInt(b.token1) || d.familyId !== MOONISWAP_ID || d.lineageId !== MOONISWAP_LINEAGE ||
      d.instanceKey !== b.pool || r.instanceKey !== d.instanceKey || r.familyId !== d.familyId || r.lineageId !== d.lineageId ||
      lower(r.pool) !== b.pool || lower(r.tokenIn) === lower(r.tokenOut) ||
      ![b.token0, b.token1].includes(lower(r.tokenIn)) || ![b.token0, b.token1].includes(lower(r.tokenOut)) ||
      r.taxonomy.slotKind !== "swap" || r.taxonomy.protocolAction !== undefined ||
      r.routeKey !== key || r.bindingRef.bindingKey !== key || r.bindingRef.fingerprint !== hashCanonical(b)) {
    throw new Error("mooniswap route binding mismatch");
  }
}
export function swapData(tokenIn: string, tokenOut: string, amountIn: bigint, minOut: bigint, executor: string): string {
  nonzero(tokenIn); nonzero(tokenOut); nonzero(executor); assertUint(amountIn, true); assertUint(minOut);
  if (lower(tokenIn) === lower(tokenOut)) throw new Error("mooniswap identical swap tokens");
  return POOL.encodeFunctionData("swapFor", [tokenIn, tokenOut, amountIn, minOut, ethers.ZeroAddress, executor]);
}
