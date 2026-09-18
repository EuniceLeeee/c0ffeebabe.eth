import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";

// Infrastructure identities, never a list of admitted pools.
export const VAULT = ethers.getAddress("0xbA1333333333a1BA1108E8412f11850A5C319bA9");
export const ROUTER = ethers.getAddress("0xAE563E3f8219521950555F5962419C8919758Ea2");
export const PERMIT2 = ethers.getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const VAULT_ABI = new ethers.Interface([
  "function isPoolRegistered(address pool) view returns (bool)",
  "function getPoolTokenInfo(address pool) view returns (address[] tokens,tuple(uint8 tokenType,address rateProvider,bool paysYieldFees)[] tokenInfo,uint256[] balancesRaw,uint256[] lastBalancesLiveScaled18)",
  "function getHooksConfig(address pool) view returns (tuple(bool enableHookAdjustedAmounts,bool shouldCallBeforeInitialize,bool shouldCallAfterInitialize,bool shouldCallComputeDynamicSwapFee,bool shouldCallBeforeSwap,bool shouldCallAfterSwap,bool shouldCallBeforeAddLiquidity,bool shouldCallAfterAddLiquidity,bool shouldCallBeforeRemoveLiquidity,bool shouldCallAfterRemoveLiquidity,address hooksContract) hooksConfig)",
]);
export const POOL_ABI = new ethers.Interface(["function getVault() view returns (address)"]);
export const TOKEN_ABI = new ethers.Interface(["function decimals() view returns (uint8)"]);
export const ROUTER_ABI = new ethers.Interface([
  "function getPermit2() view returns (address)",
  "function swapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,uint256 minAmountOut,uint256 deadline,bool wethIsEth,bytes userData) payable returns (uint256 amountOut)",
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
]);
export const SWAP_ABI = new ethers.Interface([
  "function swap((uint8 kind,address pool,address tokenIn,address tokenOut,uint256 amountGivenRaw,uint256 limitRaw,bytes userData) params) returns (uint256 amountCalculatedRaw,uint256 amountInRaw,uint256 amountOutRaw)",
  "event Swap(address indexed pool,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 swapFeePercentage,uint256 swapFeeAmount)",
]);
export const MAX_UINT = (1n << 256n) - 1n;
export const MAX_INPUT = (1n << 160n) - 1n;
export const MAX_EXPIRATION = (1n << 48n) - 1n;
export const PERMIT2_ABI = new ethers.Interface([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);
export const lower = (address: string): string => ethers.getAddress(address).toLowerCase();
export const same = (a: string, b: string): boolean => lower(a) === lower(b);
export function nonzero(address: string): string {
  const value = ethers.getAddress(address);
  if (value === ethers.ZeroAddress) throw new Error("balancer-v3 zero address");
  return value;
}
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("balancer-v3 noncanonical uint256");
  return BigInt(data);
}
export function addressWord(data: string): string {
  if (!ethers.isHexString(data, 32) || data.slice(2, 26) !== "0".repeat(24)) {
    throw new Error("balancer-v3 noncanonical address");
  }
  return ethers.getAddress(`0x${data.slice(-40)}`);
}
export function bool(data: string): boolean {
  const value = uint(data);
  if (value !== 0n && value !== 1n) throw new Error("balancer-v3 noncanonical boolean");
  return value === 1n;
}
export function decodeReturn(iface: ethers.Interface, name: string, data: string): ethers.Result {
  const decoded = iface.decodeFunctionResult(name, data);
  if (iface.encodeFunctionResult(name, decoded).toLowerCase() !== data.toLowerCase()) {
    throw new Error(`balancer-v3 noncanonical ${name} result`);
  }
  return decoded;
}
export function call(id: string, to: string, data: string): AdapterRequest {
  return { id, kind: "eth-call", to, data, completion: "return-or-revert-data" };
}
export function result(results: readonly AdapterRequestResult[], id: string) {
  const matches = results.filter(read => read.id === id);
  if (matches.length !== 1) throw new Error(`balancer-v3 missing/duplicate result ${id}`);
  const read = matches[0];
  if (!read.ok) throw new Error(`balancer-v3 unresolved ${id}: ${read.failure}`);
  return read;
}
export function returned(results: readonly AdapterRequestResult[], id: string) {
  const read = result(results, id);
  if (read.completion !== "returned") throw new Error(`balancer-v3 ${id} reverted`);
  return read;
}
export function assertSource(actual: CanonicalSource, expected: CanonicalSource): void {
  if (!Number.isSafeInteger(actual.number) || actual.number < 0 || !Number.isSafeInteger(actual.generation) ||
      actual.generation < 0 || !ethers.isHexString(actual.hash, 32) || !ethers.isHexString(expected.hash, 32) ||
      actual.number !== expected.number || actual.generation !== expected.generation ||
      actual.hash.toLowerCase() !== expected.hash.toLowerCase()) throw new Error("balancer-v3 foreign source");
}
export function resultSource(results: readonly AdapterRequestResult[]): CanonicalSource {
  const source = results[0]?.source;
  if (!source) throw new Error("balancer-v3 empty results");
  for (const read of results) assertSource(read.source, source);
  return Object.freeze({ ...source });
}
export function poolInfo(data: string) {
  const decoded = decodeReturn(VAULT_ABI, "getPoolTokenInfo", data);
  const tokens = Array.from(decoded[0] as readonly string[], nonzero);
  const tokenInfo = Array.from(decoded[1] as readonly ethers.Result[], item => ({
    tokenType: Number(item[0]), rateProvider: ethers.getAddress(String(item[1])), paysYieldFees: Boolean(item[2]),
  }));
  const balances = Array.from(decoded[2] as readonly bigint[], BigInt);
  const liveBalances = Array.from(decoded[3] as readonly bigint[], BigInt);
  if (tokens.length < 2 || tokens.length > 8 || new Set(tokens.map(lower)).size !== tokens.length ||
      [tokenInfo.length, balances.length, liveBalances.length].some(n => n !== tokens.length) ||
      tokenInfo.some(t => (t.tokenType !== 0 && t.tokenType !== 1) ||
        (t.tokenType === 1 && t.rateProvider === ethers.ZeroAddress))) {
    throw new Error("balancer-v3 malformed pool token info");
  }
  return { tokens, tokenInfo, balances };
}
export function hooksConfig(data: string) {
  const hooks = decodeReturn(VAULT_ABI, "getHooksConfig", data)[0] as ethers.Result;
  const flags = Array.from({ length: 10 }, (_, i) => Boolean(hooks[i]));
  const address = ethers.getAddress(String(hooks[10]));
  if (flags.some(Boolean) && address === ethers.ZeroAddress) throw new Error("balancer-v3 malformed hook config");
  return { address, flags };
}
export const UNSUPPORTED_SWAP_HOOK = "unsupported-swap-hook-caller-context";
export function hasSwapHooks(hooks: { readonly flags: readonly boolean[] }): boolean {
  // Execution now uses the same Router as query, but arbitrary hooks may still
  // distinguish query mode, sender/tx.origin or settlement state. Their equality
  // is unproven: retain the typed exclusion rather than broadening admission.
  return [0, 3, 4, 5].some(index => hooks.flags[index]);
}
export function assertRouterQuoteCompatible(hooks: { readonly flags: readonly boolean[] }): void {
  if (hooks.flags.length !== 10 || hasSwapHooks(hooks)) throw new Error(UNSUPPORTED_SWAP_HOOK);
}
export function queryData(pool: string, tokenIn: string, tokenOut: string, amountIn: bigint, sender: string): string {
  return ROUTER_ABI.encodeFunctionData("querySwapSingleTokenExactIn", [pool, tokenIn, tokenOut, amountIn, sender, "0x"]);
}
export function probeAmounts(decimals: number, balance: bigint): readonly bigint[] {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || balance <= 0n) {
    throw new Error("balancer-v3 invalid scale/liquidity");
  }
  const unit = 10n ** BigInt(decimals);
  const liquidityProbe = balance >= 100n ? balance / 100n : balance / 4n;
  const candidates = [liquidityProbe < unit ? liquidityProbe : unit];
  for (let exponent = 0; exponent <= decimals + 6; exponent += 3) candidates.push(10n ** BigInt(exponent));
  return Object.freeze([...new Set(candidates.filter(amount => amount > 0n && amount <= MAX_INPUT))]);
}
