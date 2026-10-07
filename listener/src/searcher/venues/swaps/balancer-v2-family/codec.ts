import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";

// The Vault is a registry/settlement infrastructure root, not a pool allowlist.
export const VAULT = ethers.getAddress("0xba12222222228d8ba445958a75a0704d566bf2c8");
export const MAX_UINT = ethers.MaxUint256;
export const MAX_INPUT = (1n << 255n) - 1n;
export const VAULT_ABI = new ethers.Interface([
  "function getPool(bytes32 poolId) view returns(address pool,uint8 specialization)",
  "function getPoolTokens(bytes32 poolId) view returns(address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns(int256[] assetDeltas)",
  "function swap((bytes32 poolId,uint8 kind,address assetIn,address assetOut,uint256 amount,bytes userData) singleSwap,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds,uint256 limit,uint256 deadline) payable returns(uint256)",
  "event Swap(bytes32 indexed poolId,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut)",
  "event PoolBalanceChanged(bytes32 indexed poolId,address indexed liquidityProvider,address[] tokens,int256[] deltas,uint256[] protocolFeeAmounts)",
]);
export const POOL_ABI = new ethers.Interface([
  "function getVault() view returns(address)",
  "function getPoolId() view returns(bytes32)",
]);
export const TOKEN_ABI = new ethers.Interface(["function decimals() view returns(uint8)"]);
export const lower = (a: string): string => ethers.getAddress(a).toLowerCase();
export const same = (a: string, b: string): boolean => lower(a) === lower(b);
export function nonzero(a: string): string {
  const value = ethers.getAddress(a);
  if (value === ethers.ZeroAddress) throw new Error("balancer-v2 zero address");
  return value;
}
export function poolIdentity(value: string) {
  if (!ethers.isHexString(value, 32)) throw new Error("balancer-v2 invalid pool id");
  const poolId = value.toLowerCase(), pool = nonzero(poolId.slice(0, 42));
  const specialization = Number(BigInt("0x" + poolId.slice(42, 46)));
  if (specialization > 2) throw new Error("balancer-v2 invalid specialization");
  return { poolId, pool, specialization };
}
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("balancer-v2 noncanonical uint");
  return BigInt(data);
}
export function decodeReturn(name: string, data: string, abi = VAULT_ABI): ethers.Result {
  const value = abi.decodeFunctionResult(name, data);
  if (abi.encodeFunctionResult(name, value).toLowerCase() !== data.toLowerCase()) throw new Error("balancer-v2 noncanonical " + name);
  return value;
}
export function call(id: string, to: string, data: string): AdapterRequest {
  return { id, kind: "eth-call", to, data, completion: "return-or-revert-data" };
}
export function assertSource(actual: CanonicalSource, expected: CanonicalSource): void {
  if (!Number.isSafeInteger(actual.number) || actual.number < 0 || !Number.isSafeInteger(actual.generation) ||
      actual.generation < 0 || !ethers.isHexString(actual.hash, 32) || !ethers.isHexString(expected.hash, 32) ||
      actual.number !== expected.number || actual.generation !== expected.generation ||
      actual.hash.toLowerCase() !== expected.hash.toLowerCase()) throw new Error("balancer-v2 foreign source");
}
export function resultSource(results: readonly AdapterRequestResult[]): CanonicalSource {
  const source = results[0]?.source;
  if (!source) throw new Error("balancer-v2 empty results");
  for (const result of results) assertSource(result.source, source);
  return Object.freeze({ ...source });
}
export function returned(results: readonly AdapterRequestResult[], id: string) {
  const matches = results.filter(r => r.id === id);
  if (matches.length !== 1) throw new Error("balancer-v2 missing/duplicate " + id);
  const read = matches[0];
  if (!read.ok) throw new Error("balancer-v2 unresolved " + id + ": " + read.failure);
  if (read.completion !== "returned") throw new Error("balancer-v2 reverted " + id);
  return read;
}
export function resultSet(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource) {
  const source = resultSource(results);
  if (expected) assertSource(source, expected);
  if (results.length !== ids.length || new Set(results.map(r => r.id)).size !== ids.length ||
      results.some(r => !ids.includes(r.id))) throw new Error("balancer-v2 foreign result set");
  return source;
}
export function poolInfo(data: string) {
  const decoded = decodeReturn("getPoolTokens", data);
  const tokens = Array.from(decoded[0] as readonly string[], nonzero);
  const balances = Array.from(decoded[1] as readonly bigint[], BigInt);
  if (tokens.length < 2 || balances.length !== tokens.length || new Set(tokens.map(lower)).size !== tokens.length) {
    throw new Error("balancer-v2 invalid pool tokens");
  }
  return { tokens, balances, lastChangeBlock: BigInt(decoded[2]) };
}
export function queryData(poolId: string, tokenIn: string, tokenOut: string, amount: bigint, executor: string) {
  return VAULT_ABI.encodeFunctionData("queryBatchSwap", [0, [[poolId, 0, 1, amount, "0x"]],
    [tokenIn, tokenOut], [executor, false, executor, false]]);
}
export function quoteOutput(data: string, amountIn: bigint, allowZero = false): bigint {
  const deltas = decodeReturn("queryBatchSwap", data)[0] as readonly bigint[];
  if (deltas.length !== 2 || deltas[0] !== amountIn || deltas[1] > 0n || deltas[1] < -MAX_INPUT || (!allowZero && deltas[1] === 0n)) throw new Error("balancer-v2 invalid quote deltas");
  return -deltas[1];
}
export function swapData(poolId: string, tokenIn: string, tokenOut: string, amount: bigint, minimum: bigint, executor: string) {
  return VAULT_ABI.encodeFunctionData("swap", [[poolId, 0, tokenIn, tokenOut, amount, "0x"],
    [executor, false, executor, false], minimum, MAX_UINT]);
}
// ABI head: dynamic SingleSwap + four static fund words + limit + deadline.
// Inside SingleSwap, amount is the fifth word. Contract tests decode the patch.
export const SWAP_AMOUNT_OFFSET = 4 + 7 * 32 + 4 * 32;
export function probeAmounts(decimals: number, balance: bigint): readonly bigint[] {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || balance <= 0n) throw new Error("balancer-v2 invalid scale/liquidity");
  const unit = 10n ** BigInt(decimals), liquidity = balance >= 100n ? balance / 100n : balance / 4n;
  const values = [liquidity < unit ? liquidity : unit];
  for (let exponent = 0; exponent <= decimals + 6; exponent += 3) values.push(10n ** BigInt(exponent));
  return [...new Set(values.filter(x => x > 0n && x <= MAX_INPUT))];
}
